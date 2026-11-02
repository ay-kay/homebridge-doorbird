/* Unit tests for the RTP and SRTP helpers. Run with: npm run build && node test/rtp-unit.test.js */
"use strict";

import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import {
  OPUS_RTP_CLOCK_RATE, RtpTimestampScaler, SrtpDecryptContext, SrtpEncryptContext, classifyRtpPacket, deriveSrtpKey, deriveSrtpSessionKeys,
  rtpHeaderLength, rtpPayloadType, scaleRtpTimestamp
} from "../dist/doorbird-rtp.js";

const hex = (s) => Buffer.from(s.replace(/\s+/g, ""), "hex");

// An RTP packet: version 2, payload type 110, the given sequence number, timestamp and SSRC.
function rtpPacket(sequence, timestamp = 0, ssrc = 0x11223344, payload = Buffer.from("opus frame payload")) {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = 110;
  header.writeUInt16BE(sequence, 2);
  header.writeUInt32BE(timestamp, 4);
  header.writeUInt32BE(ssrc, 8);

  return Buffer.concat([ header, payload ]);
}

test("SRTP key derivation (RFC 3711, appendix B.3)", () => {
  const masterKey = hex("E1F97A0D3E018BE0D64FA32C06DE4139");
  const masterSalt = hex("0EC675AD498AFEEBB6960B3AABE6");

  assert.equal(deriveSrtpKey(masterKey, masterSalt, 0, 16).toString("hex"), "c61e7a93744f39ee10734afe3ff7a087");
  assert.equal(deriveSrtpKey(masterKey, masterSalt, 2, 14).toString("hex"), "30cbbc08863d8c85d49db34a9ae1");
  assert.equal(deriveSrtpKey(masterKey, masterSalt, 1, 20).toString("hex"), "cebe321f6ff7716b6fd4ab49af256a156d38baa4");

  // HomeKit hands out the key followed by the salt.
  const keys = deriveSrtpSessionKeys(Buffer.concat([ masterKey, masterSalt ]));
  assert.equal(keys.key.toString("hex"), "c61e7a93744f39ee10734afe3ff7a087");
  assert.equal(keys.salt.toString("hex"), "30cbbc08863d8c85d49db34a9ae1");
  assert.equal(keys.authKey.toString("hex"), "cebe321f6ff7716b6fd4ab49af256a156d38baa4");

  assert.throws(() => deriveSrtpSessionKeys(Buffer.alloc(29)));
});

test("SRTP AES-CM keystream (RFC 3711, appendix B.2)", () => {
  const keys = { authKey: Buffer.alloc(20), key: hex("2B7E151628AED2A6ABF7158809CF4F3C"), salt: hex("F0F1F2F3F4F5F6F7F8F9FAFBFCFD") };
  const packet = rtpPacket(0, 0, 0, Buffer.alloc(48));
  const srtp = new SrtpEncryptContext(keys).encrypt(packet);

  // Encrypting zeros reveals the keystream. The header stays in the clear, the 10 byte tag is appended.
  assert.equal(srtp.length, 12 + 48 + 10);
  assert.deepEqual(srtp.subarray(0, 12), packet.subarray(0, 12));
  assert.equal(srtp.subarray(12, 60).toString("hex"),
    "e03ead0935c95e80e166b16dd92b4eb4d23513162b02d0f72a43a2fe4a5f97ab41e95b3bb0a2e8dd477901e4fca894c0");
});

test("SRTP encrypt / decrypt round trip, tampering and other keys", () => {
  const master = crypto.randomBytes(30);
  const sender = new SrtpEncryptContext(deriveSrtpSessionKeys(master));
  const receiver = new SrtpDecryptContext(deriveSrtpSessionKeys(master));

  for(let seq = 1000; seq < 1010; seq++) {
    const packet = rtpPacket(seq, seq * 320);
    const srtp = sender.encrypt(packet);

    assert.equal(srtp.length, packet.length + 10);
    assert.notDeepEqual(srtp.subarray(12, packet.length), packet.subarray(12));
    assert.deepEqual(receiver.decrypt(srtp), packet);
  }

  // Any modified bit, in the header, the payload or the tag, is rejected.
  const srtp = sender.encrypt(rtpPacket(1010, 1010 * 320));
  for(const offset of [ 1, 4, 8, 12, srtp.length - 11, srtp.length - 1 ]) {
    const tampered = Buffer.from(srtp);
    tampered[offset] ^= 0x01;
    assert.equal(receiver.decrypt(tampered), null, "tampered byte " + offset);
  }

  // Too short.
  assert.equal(receiver.decrypt(srtp.subarray(0, 21)), null);

  // A different key.
  assert.equal(new SrtpDecryptContext(deriveSrtpSessionKeys(crypto.randomBytes(30))).decrypt(srtp), null);

  // The rejected packets didn't change our state: the original still decrypts.
  assert.deepEqual(receiver.decrypt(srtp), rtpPacket(1010, 1010 * 320));

  // CSRCs and header extensions stay in the clear.
  const extended = Buffer.concat([ hex("9100006f0000000011223344" + "aaaaaaaa" + "bede0001" + "01020304"), Buffer.from("payload") ]);
  assert.equal(rtpHeaderLength(extended), 24);
  const encrypted = sender.encrypt(extended);
  assert.deepEqual(encrypted.subarray(0, 24), extended.subarray(0, 24));
  assert.deepEqual(receiver.decrypt(encrypted), extended);
});

test("SRTP rollover counter across the sequence number wrap", () => {
  const keys = deriveSrtpSessionKeys(crypto.randomBytes(30));
  const sender = new SrtpEncryptContext(keys);
  const receiver = new SrtpDecryptContext(keys);
  const packets = [];

  for(const seq of [ 65533, 65534, 65535, 0, 1, 2 ]) {
    packets.push(sender.encrypt(rtpPacket(seq)));
  }

  assert.equal(sender.rolloverCounter, 1);

  // A receiver that joins after the wrap doesn't know about it and can't authenticate the packet: the ROC is part of the tag.
  assert.equal(new SrtpDecryptContext(keys).decrypt(packets[3]), null);

  // A forged packet right after the wrap doesn't advance the receiver's ROC.
  receiver.decrypt(packets[0]);
  const forged = Buffer.from(packets[3]);
  forged[forged.length - 1] ^= 0xff;
  assert.equal(receiver.decrypt(forged), null);
  assert.equal(receiver.rolloverCounter, 0);

  for(let i = 1; i < packets.length; i++) {
    assert.ok(receiver.decrypt(packets[i]), "packet " + i);
  }

  assert.equal(receiver.rolloverCounter, 1);
  assert.equal(receiver.decrypt(packets[5]).readUInt16BE(2), 2);
});

test("Opus timestamps: 48 kHz to the negotiated clock and back", () => {
  // Outbound: FFmpeg stamps at 48 kHz, HomeKit expects 16 or 24 kHz.
  assert.equal(scaleRtpTimestamp(960, OPUS_RTP_CLOCK_RATE, 16000), 320);
  assert.equal(scaleRtpTimestamp(960, OPUS_RTP_CLOCK_RATE, 24000), 480);
  assert.equal(scaleRtpTimestamp(4294967295, OPUS_RTP_CLOCK_RATE, 16000), 1431655765);

  // Return path: the iPhone stamps at 16 kHz, FFmpeg expects 48 kHz. This wraps modulo 2^32 and stays continuous, because 3 * 2^32 = 0 (mod 2^32).
  assert.equal(scaleRtpTimestamp(320, 16000, OPUS_RTP_CLOCK_RATE), 960);
  assert.equal(scaleRtpTimestamp(4294967295, 16000, OPUS_RTP_CLOCK_RATE), 4294967293);
  assert.equal(scaleRtpTimestamp(0, 16000, OPUS_RTP_CLOCK_RATE), 0);
  assert.equal(scaleRtpTimestamp(4294967295, 24000, OPUS_RTP_CLOCK_RATE), 4294967294);

  // The stream scaler is identical as long as nothing wraps...
  const outbound = new RtpTimestampScaler(OPUS_RTP_CLOCK_RATE, 16000);
  for(let ts = 123456789; ts < 123456789 + (960 * 100); ts += 960) {
    assert.equal(outbound.scale(ts), scaleRtpTimestamp(ts, OPUS_RTP_CLOCK_RATE, 16000));
  }

  // ...and stays continuous when the 48 kHz clock wraps, where plain scaling would jump back by 2^32 / 3.
  const wrapping = new RtpTimestampScaler(OPUS_RTP_CLOCK_RATE, 16000);
  const input = [ 4294967296 - 1920, 4294967296 - 960, 0, 960, 1920 ];
  const output = input.map((ts) => wrapping.scale(ts));
  for(let i = 1; i < output.length; i++) {
    assert.equal((output[i] - output[i - 1] + 4294967296) % 4294967296, 320, "step " + i + ": " + output.join(", "));
  }

  // Reordered packets go back in time instead of jumping by 2^32.
  const reordered = new RtpTimestampScaler(OPUS_RTP_CLOCK_RATE, 24000);
  assert.equal(reordered.scale(960), 480);
  assert.equal(reordered.scale(2880), 1440);
  assert.equal(reordered.scale(1920), 960);
  assert.equal(reordered.scale(0), 0);

  // A scaler that starts before zero wraps around to the top.
  assert.equal(reordered.scale(4294967296 - 960), 4294967296 - 480);

  // The return path across the iPhone's 16 kHz wrap.
  const inbound = new RtpTimestampScaler(16000, OPUS_RTP_CLOCK_RATE);
  assert.equal(inbound.scale(4294967296 - 320), 4294967296 - 960);
  assert.equal(inbound.scale(0), 0);
  assert.equal(inbound.scale(320), 960);
});

test("RTP / RTCP classification (RFC 5761)", () => {
  const rtp = (byte1, length = 12) => { const b = Buffer.alloc(length); b[0] = 0x80; b[1] = byte1; return b; };

  // RTP, payload type 110, with and without the marker bit.
  assert.equal(classifyRtpPacket(rtp(110)), "rtp");
  assert.equal(classifyRtpPacket(rtp(0x80 | 110)), "rtp");
  assert.equal(rtpPayloadType(rtp(0x80 | 110)), 110);

  // RTCP: SR (200), RR (201), SDES (202), BYE (203), APP (204) and the edges of the range.
  for(const pt of [ 192, 200, 201, 202, 203, 204, 223 ]) {
    assert.equal(classifyRtpPacket(rtp(pt, 8)), "rtcp", "PT " + pt);
  }

  // Just outside of the RTCP range.
  assert.equal(classifyRtpPacket(rtp(191)), "rtp");
  assert.equal(classifyRtpPacket(rtp(224)), "rtp");

  // Garbage.
  assert.equal(classifyRtpPacket(Buffer.alloc(0)), "invalid");
  assert.equal(classifyRtpPacket(Buffer.from([ 0x80, 110, 0, 1 ])), "invalid");
  assert.equal(classifyRtpPacket(rtp(110, 10)), "invalid");

  const v1 = rtp(110);
  v1[0] = 0x40;
  assert.equal(classifyRtpPacket(v1), "invalid");

  // Header length with CSRCs and an extension that doesn't fit.
  assert.equal(rtpHeaderLength(rtp(110)), 12);
  const csrc = rtp(110, 20); csrc[0] = 0x82;
  assert.equal(rtpHeaderLength(csrc), 20);
  csrc[0] = 0x83;
  assert.equal(rtpHeaderLength(csrc), -1);
  const ext = rtp(110, 16); ext[0] = 0x90; ext.writeUInt16BE(1, 14);
  assert.equal(rtpHeaderLength(ext), -1);
});
