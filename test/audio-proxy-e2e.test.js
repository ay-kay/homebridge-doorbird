/* End-to-end tests of the outbound audio path with a real FFmpeg, without HomeKit.
 *
 * 1. An FFmpeg encodes a 1 kHz tone with the exact output options of the live stream and sends it to the audio proxy, which plays its part for a
 *    16 kHz session. We capture what the proxy sends to the "controller", check the clock, the sequence numbers and the authentication tags with a
 *    second decryption context, and hand the packets to another FFmpeg that decrypts (a=crypto) and decodes them.
 * 2. The same stream goes through a second proxy that plays the part of the receiving end of a session with two-way audio: that's the return path
 *    with the exact 16 kHz clock the iPhone uses, through the talkback FFmpeg into a fake Doorbird.
 *
 * Run with: npm run build && node test/audio-proxy-e2e.test.js
 */
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const dgram = require("node:dgram");
const http = require("node:http");
const { DoorbirdApi } = require("../dist/doorbird-api");
const { DoorbirdAudioProxy, opusFfmpegOutput } = require("../dist/doorbird-audio-proxy");
const { SrtpDecryptContext, deriveSrtpSessionKeys } = require("../dist/doorbird-rtp");
const { DoorbirdTalkback, reserveRtpPortPair } = require("../dist/doorbird-talkback");

const ffmpegPath = require("ffmpeg-for-homebridge") || "ffmpeg";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomPort = () => 30000 + Math.floor(Math.random() * 20000);
const noLog = () => {};
noLog.error = (...args) => { throw new Error(args.join(" ")); };

// Encode a 1 kHz tone from the Doorbird's 8 kHz mu-law microphone format exactly like the live stream does, and send it to the proxy.
function sendTone(port, seconds, ssrc) {
  const args = ("-hide_banner -loglevel error -re -f lavfi -i sine=frequency=1000:sample_rate=8000 -t " + seconds + " -map 0:0 " +
    opusFfmpegOutput({ bitrate: 24, packetTime: 20, payloadType: 110, port, sampleRate: 16, ssrc })).split(" ");

  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: [ "ignore", "ignore", "inherit" ] });
    p.on("error", reject);
    p.on("exit", (code) => code === 0 ? resolve() : reject(new Error("sender exited with " + code)));
  });
}

// Count the sign changes per second in signed 16 bit little endian samples.
function signChanges(samples, rate) {
  let crossings = 0;
  for(let i = 2; i + 1 < samples.length; i += 2) {
    crossings += ((samples.readInt16LE(i) < 0) !== (samples.readInt16LE(i - 2) < 0)) ? 1 : 0;
  }
  return crossings / ((samples.length / 2) / rate);
}

test("outbound: FFmpeg Opus through the proxy becomes SRTP on the 16 kHz clock that FFmpeg can decrypt", { timeout: 30000 }, async () => {
  const srtp = crypto.randomBytes(30);
  const receiverPort = await reserveRtpPortPair();
  const debugLines = [];

  // FFmpeg plays the controller: it decrypts and decodes the SRTP stream.
  const sdp = [
    "v=0", "o=- 0 0 IN IP4 127.0.0.1", "s=HomeKit", "c=IN IP4 127.0.0.1", "t=0 0",
    "m=audio " + receiverPort + " RTP/AVP 110",
    "a=rtpmap:110 opus/48000/2",
    "a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:" + srtp.toString("base64"), ""
  ].join("\r\n");

  const receiver = spawn(ffmpegPath, ("-hide_banner -loglevel warning -protocol_whitelist pipe,udp,rtp,crypto -f sdp -i pipe:0" +
    " -ac 1 -ar 16000 -f s16le pipe:1").split(" "));
  const decoded = [];
  let receiverLog = "";
  receiver.stdout.on("data", (chunk) => decoded.push(chunk));
  receiver.stderr.on("data", (chunk) => { receiverLog += chunk.toString(); });
  receiver.stdin.end(sdp);
  const receiverExit = new Promise((resolve) => receiver.on("exit", resolve));

  // The controller's audio port: capture what the proxy sends and pass it on to the FFmpeg above.
  const captured = [];
  const tap = dgram.createSocket("udp4");
  const relay = dgram.createSocket("udp4");
  tap.on("message", (packet, rinfo) => {
    captured.push({ packet, rinfo });
    relay.send(packet, receiverPort, "127.0.0.1");
  });
  await new Promise((resolve) => tap.bind(0, "127.0.0.1", resolve));

  const returnPort = randomPort();
  const proxy = await DoorbirdAudioProxy.open({
    address: "127.0.0.1", audioPort: tap.address().port, debug: (...args) => debugLines.push(args.join(" ")), log: noLog, name: "Test",
    payloadType: 110, returnPort, sampleRate: 16000, srtp
  });

  try {
    await sleep(500);
    await sendTone(proxy.ffmpegPort, 3, 12345);
    await sleep(300);
  } finally {
    proxy.close();
    receiver.kill("SIGINT");
    await receiverExit;
    tap.close();
    relay.close();
  }

  // 3 s of 20 ms frames.
  console.log("# proxy sent %d packets", captured.length);
  assert.ok(captured.length >= 140 && captured.length <= 152, captured.length + " packets");

  // We send from our audio port, the one HomeKit sends its return audio to.
  assert.ok(captured.every(({ rinfo }) => rinfo.port === returnPort));

  // A second context authenticates and decrypts every packet. The clock advances 320 per 20 ms frame (16 kHz), the sequence numbers by one.
  const decryptor = new SrtpDecryptContext(deriveSrtpSessionKeys(srtp));
  const rtp = captured.map(({ packet }) => decryptor.decrypt(packet));
  assert.ok(rtp.every((packet) => packet !== null), "every packet authenticates");
  for(let i = 1; i < rtp.length; i++) {
    assert.equal((rtp[i].readUInt16BE(2) - rtp[i - 1].readUInt16BE(2) + 65536) % 65536, 1);
    assert.equal((rtp[i].readUInt32BE(4) - rtp[i - 1].readUInt32BE(4) + 4294967296) % 4294967296, 320, "timestamp step at packet " + i);
  }
  assert.ok(rtp.every((packet) => (packet[1] & 0x7f) === 110 && packet.readUInt32BE(8) === 12345 && packet.length <= 188));

  // FFmpeg decrypted the stream without authentication errors, and it is our 1 kHz tone (~2000 sign changes per second).
  assert.doesNotMatch(receiverLog, /HMAC|srtp|decrypt/i, receiverLog);
  const audio = Buffer.concat(decoded);
  const middle = audio.subarray(16000, 64000);
  console.log("# receiver decoded %d ms of audio, %d sign changes per second", audio.length / 32, Math.round(signChanges(middle, 16000)));
  assert.ok(audio.length >= 2.5 * 32000, audio.length + " bytes decoded");
  assert.ok(Math.abs(signChanges(middle, 16000) - 2000) < 100);
});

test("return path at 16 kHz: proxy to proxy, through the talkback FFmpeg, into the Doorbird", { timeout: 30000 }, async () => {
  const srtp = crypto.randomBytes(30);
  const requests = [];

  // Our fake Doorbird.
  const server = http.createServer((req, res) => {
    const entry = { bytes: [], closed: false };
    requests.push(entry);
    req.on("data", (chunk) => entry.bytes.push(chunk));
    req.on("close", () => { entry.closed = true; });
    res.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dbApi = new DoorbirdApi({ debug: () => {}, log: () => {} }, "Test", "127.0.0.1:" + server.address().port, "user", "pass");

  const log = () => {};
  const errors = [];
  log.error = (...args) => errors.push(args.join(" "));

  // The "iPhone" end encrypts at 16 kHz, exactly like our outbound path, and sends to the plugin's end.
  const iphonePort = randomPort();
  const pluginPort = iphonePort + 1;
  const iphone = await DoorbirdAudioProxy.open({
    address: "127.0.0.1", audioPort: pluginPort, debug: () => {}, log, name: "iPhone", payloadType: 110, returnPort: iphonePort, sampleRate: 16000, srtp
  });
  const plugin = await DoorbirdAudioProxy.open({
    address: "127.0.0.1", audioPort: iphonePort, debug: () => {}, log, name: "Test", payloadType: 110, returnPort: pluginPort, sampleRate: 16000, srtp,
    talkback: new DoorbirdTalkback({
      debug: () => {}, idleSeconds: 1, log, name: "Test", openTransmit: () => dbApi.audioTransmitRequest(), payloadType: 110, videoProcessor: ffmpegPath
    })
  });

  try {
    await sendTone(iphone.ffmpegPort, 3, 4242);
    await sleep(1800);

    assert.equal(requests.length, 1);
    assert.ok(requests[0].closed, "POST closed after the idle timeout");

    // mu-law: count the sign changes in the middle of the burst (~2000 per second for a 1 kHz tone).
    const audio = Buffer.concat(requests[0].bytes);
    const middle = audio.subarray(4000, 12000);
    let crossings = 0;
    for(let i = 1; i < middle.length; i++) {
      crossings += ((middle[i] ^ middle[i - 1]) & 0x80) ? 1 : 0;
    }
    console.log("# %d bytes of mu-law, %d sign changes per second", audio.length, crossings);
    assert.ok(audio.length > 16000, audio.length + " bytes");
    assert.ok(crossings > 1800 && crossings < 2200);
    assert.deepEqual(errors, []);
  } finally {
    iphone.close();
    plugin.close();
    server.close();
    server.closeAllConnections();
  }
});

test("the proxy refuses to start if its port is taken, and releases everything", async () => {
  const blocker = dgram.createSocket("udp4");
  await new Promise((resolve) => blocker.bind(0, resolve));

  let closed = 0;
  await assert.rejects(DoorbirdAudioProxy.open({
    address: "127.0.0.1", audioPort: 9, debug: () => {}, log: noLog, name: "Test", payloadType: 110, returnPort: blocker.address().port,
    sampleRate: 16000, srtp: crypto.randomBytes(30), talkback: { close: () => closed++, handleRtp: () => {} }
  }), /EADDRINUSE/);

  assert.equal(closed, 1, "the talkback relay is closed");
  blocker.close();
});
