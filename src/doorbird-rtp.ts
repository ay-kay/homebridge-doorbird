/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * doorbird-rtp.ts: RTP and SRTP (AES_CM_128_HMAC_SHA1_80) helpers for the HomeKit audio proxy.
 *
 * HomeKit streams audio as SRTP with the AES_CM_128_HMAC_SHA1_80 suite (RFC 3711). FFmpeg can encrypt and decrypt SRTP itself, but with Opus we have
 * to rewrite the RTP timestamps (FFmpeg always stamps Opus with a 48 kHz clock, HomeKit expects the negotiated 16 or 24 kHz clock), and the
 * timestamp is covered by the authentication tag. So we encrypt and decrypt in Node, the same way Home Assistant's HomeKit Bridge does.
 */
import { createCipheriv, createHmac, timingSafeEqual } from "crypto";

// The classification of a datagram arriving on an rtcp-mux port.
export type RtpPacketKind = "invalid" | "rtcp" | "rtp";

// The SRTP session keys derived from a master key and salt.
export interface SrtpSessionKeys {
  authKey: Buffer; // HMAC-SHA1 key, 20 bytes.
  key: Buffer; // AES-128 key, 16 bytes.
  salt: Buffer; // Session salt, 14 bytes.
}

// FFmpeg (and RFC 7587) always use a 48 kHz RTP clock for Opus, whatever the actual sample rate is.
export const OPUS_RTP_CLOCK_RATE = 48000;

// The length of the fixed RTP header.
export const RTP_HEADER_LENGTH = 12;

// AES_CM_128_HMAC_SHA1_80 truncates the HMAC-SHA1 to 80 bits.
const SRTP_AUTH_TAG_LENGTH = 10;

// A sequence number that jumps back by more than this is a rollover, RFC 3711 appendix A.
const SRTP_SEQUENCE_ROLLOVER_THRESHOLD = 0x8000;

const UINT32_RANGE = 0x100000000;

// Classify a datagram received on an rtcp-mux port. RFC 5761, section 4: RTCP packet types 192 - 223 occupy the second octet of the packet, where RTP
// keeps its marker bit and payload type. HomeKit uses dynamic payload types (e.g. 110) that can never collide with that range.
export function classifyRtpPacket(packet: Buffer): RtpPacketKind {

  // Both RTP and RTCP are version 2 and carry at least an 8 byte header.
  if((packet.length < 8) || ((packet[0] >> 6) !== 2)) {
    return "invalid";
  }

  if((packet[1] >= 192) && (packet[1] <= 223)) {
    return "rtcp";
  }

  // An RTP header is at least 12 bytes.
  return (packet.length >= RTP_HEADER_LENGTH) ? "rtp" : "invalid";
}

// Return the payload type of an RTP packet.
export function rtpPayloadType(packet: Buffer): number {
  return packet[1] & 0x7f;
}

// Return the length of an RTP header, including CSRCs and a header extension, or -1 if the packet is too short to hold it.
export function rtpHeaderLength(packet: Buffer): number {

  if(packet.length < RTP_HEADER_LENGTH) {
    return -1;
  }

  let length = RTP_HEADER_LENGTH + ((packet[0] & 0x0f) * 4);

  // Header extension.
  if(packet[0] & 0x10) {

    if(packet.length < length + 4) {
      return -1;
    }

    length += 4 + (packet.readUInt16BE(length + 2) * 4);
  }

  return (length <= packet.length) ? length : -1;
}

// Rescale an RTP timestamp from one clock rate to another, e.g. ts * 16000 / 48000. We use the same integer math as Home Assistant. The intermediate
// product stays below 2^53, so it's exact.
export function scaleRtpTimestamp(timestamp: number, fromRate: number, toRate: number): number {
  return Math.floor((timestamp * toRate) / fromRate) % UINT32_RANGE;
}

// Rescale the RTP timestamps of a stream from one clock rate to another. Unlike scaleRtpTimestamp, this follows the timestamp across its 32-bit wrap,
// so the rescaled stream stays continuous when the source clock wraps (2^32 is not a multiple of 3, so 48 kHz to 16 kHz would jump otherwise). Until
// the source timestamp wraps, the result is identical to scaleRtpTimestamp.
export class RtpTimestampScaler {
  private extended: number | null = null;
  private readonly fromRate: number;
  private last = 0;
  private readonly toRate: number;

  constructor(fromRate: number, toRate: number) {
    this.fromRate = fromRate;
    this.toRate = toRate;
  }

  public scale(timestamp: number): number {

    if(this.extended === null) {
      this.extended = timestamp;
    } else {

      // The signed difference to the previous timestamp, modulo 2^32. Reordered packets go back in time.
      let delta = (timestamp - this.last + UINT32_RANGE) % UINT32_RANGE;

      if(delta >= UINT32_RANGE / 2) {
        delta -= UINT32_RANGE;
      }

      this.extended += delta;
    }

    this.last = timestamp;

    const scaled = Math.floor((this.extended * this.toRate) / this.fromRate) % UINT32_RANGE;

    return (scaled + UINT32_RANGE) % UINT32_RANGE;
  }
}

// AES-128 in counter mode. Encryption and decryption are the same operation.
function aesCm(key: Buffer, iv: Buffer, data: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ctr", key, iv);

  return Buffer.concat([ cipher.update(data), cipher.final() ]);
}

// Derive an SRTP session key, RFC 3711 section 4.3.1, with a key derivation rate of 0: x = (label << 48) XOR master salt, and the key is the AES-CM
// keystream for the IV x * 2^16.
export function deriveSrtpKey(masterKey: Buffer, masterSalt: Buffer, label: number, length: number): Buffer {
  const iv = Buffer.alloc(16);

  masterSalt.copy(iv, 0, 0, 14);

  // The salt is a 112 bit number, so label << 48 is the eighth byte.
  iv[7] ^= label;

  return aesCm(masterKey, iv, Buffer.alloc(length));
}

// Derive the SRTP session keys from the master key and salt HomeKit hands out (the 16 byte key followed by the 14 byte salt).
export function deriveSrtpSessionKeys(masterKeyAndSalt: Buffer): SrtpSessionKeys {

  if(masterKeyAndSalt.length < 30) {
    throw new Error("SRTP key material must be at least 30 bytes, got " + masterKeyAndSalt.length.toString() + ".");
  }

  const masterKey = masterKeyAndSalt.subarray(0, 16);
  const masterSalt = masterKeyAndSalt.subarray(16, 30);

  return {
    authKey: deriveSrtpKey(masterKey, masterSalt, 1, 20),
    key: deriveSrtpKey(masterKey, masterSalt, 0, 16),
    salt: deriveSrtpKey(masterKey, masterSalt, 2, 14)
  };
}

// The AES-CM IV for an RTP packet: (salt * 2^16) XOR (SSRC * 2^64) XOR (packet index * 2^16), RFC 3711 section 4.1.1.
function srtpIv(salt: Buffer, ssrc: number, rolloverCounter: number, sequence: number): Buffer {
  const iv = Buffer.alloc(16);

  // The packet index is ROC * 2^16 + SEQ, a 48 bit number.
  iv.writeUInt32BE(ssrc, 4);
  iv.writeUInt16BE(rolloverCounter >>> 16, 8);
  iv.writeUInt32BE((((rolloverCounter & 0xffff) * 0x10000) + sequence) >>> 0, 10);

  for(let i = 0; i < 14; i++) {
    iv[i] ^= salt[i];
  }

  return iv;
}

// The authentication tag: the first 80 bits of the HMAC-SHA1 over the packet and the rollover counter, RFC 3711 section 4.2.
function srtpAuthTag(authKey: Buffer, packet: Buffer, rolloverCounter: number): Buffer {
  const roc = Buffer.alloc(4);

  roc.writeUInt32BE(rolloverCounter >>> 0, 0);

  return createHmac("sha1", authKey).update(packet).update(roc).digest().subarray(0, SRTP_AUTH_TAG_LENGTH);
}

// Encrypt and authenticate RTP packets of a single stream.
export class SrtpEncryptContext {
  private readonly keys: SrtpSessionKeys;
  private lastSequence = 0;
  private roc = 0;

  constructor(keys: SrtpSessionKeys) {
    this.keys = keys;
  }

  // The current rollover counter.
  public get rolloverCounter(): number {
    return this.roc;
  }

  // Turn an RTP packet into an SRTP packet. Returns null for a malformed packet.
  public encrypt(packet: Buffer): Buffer | null {
    const headerLength = rtpHeaderLength(packet);

    if(headerLength < 0) {
      return null;
    }

    const sequence = packet.readUInt16BE(2);

    // Track the rollover counter across sequence number wraps.
    if((sequence < this.lastSequence) && ((this.lastSequence - sequence) > SRTP_SEQUENCE_ROLLOVER_THRESHOLD)) {
      this.roc = (this.roc + 1) >>> 0;
    }

    this.lastSequence = sequence;

    const iv = srtpIv(this.keys.salt, packet.readUInt32BE(8), this.roc, sequence);
    const srtp = Buffer.concat([ packet.subarray(0, headerLength), aesCm(this.keys.key, iv, packet.subarray(headerLength)) ]);

    return Buffer.concat([ srtp, srtpAuthTag(this.keys.authKey, srtp, this.roc) ]);
  }
}

// Authenticate and decrypt SRTP packets of a single stream (one SSRC).
export class SrtpDecryptContext {
  private readonly keys: SrtpSessionKeys;
  private lastSequence: number | null = null;
  private roc = 0;

  constructor(keys: SrtpSessionKeys) {
    this.keys = keys;
  }

  // The current rollover counter.
  public get rolloverCounter(): number {
    return this.roc;
  }

  // Turn an SRTP packet back into an RTP packet. Returns null if the packet is malformed or fails authentication. Our state (the rollover counter)
  // only changes for authenticated packets, so forged or corrupted packets can't throw us off.
  public decrypt(packet: Buffer): Buffer | null {

    if(packet.length < RTP_HEADER_LENGTH + SRTP_AUTH_TAG_LENGTH) {
      return null;
    }

    const srtp = packet.subarray(0, packet.length - SRTP_AUTH_TAG_LENGTH);
    const tag = packet.subarray(packet.length - SRTP_AUTH_TAG_LENGTH);
    const sequence = srtp.readUInt16BE(2);
    let roc = this.roc;

    // Guess the rollover counter of this packet.
    if((this.lastSequence !== null) && (sequence < this.lastSequence) && ((this.lastSequence - sequence) > SRTP_SEQUENCE_ROLLOVER_THRESHOLD)) {
      roc = (roc + 1) >>> 0;
    }

    if(!timingSafeEqual(srtpAuthTag(this.keys.authKey, srtp, roc), tag)) {
      return null;
    }

    const headerLength = rtpHeaderLength(srtp);

    if(headerLength < 0) {
      return null;
    }

    // The packet is authentic, commit our state.
    this.roc = roc;
    this.lastSequence = sequence;

    const iv = srtpIv(this.keys.salt, srtp.readUInt32BE(8), roc, sequence);

    return Buffer.concat([ srtp.subarray(0, headerLength), aesCm(this.keys.key, iv, srtp.subarray(headerLength)) ]);
  }
}
