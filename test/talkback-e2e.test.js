/* End-to-end test of the audio proxy and the talkback relay with a real FFmpeg, without HomeKit or a Doorbird.
 *
 * An FFmpeg plays the part of the iPhone: it sends an Opus SRTP stream (payload type 110, 20 ms frames, RTCP on the same port) to the return port.
 * A local HTTP server plays the part of the Doorbird's audio-transmit.cgi. We check that the relay opens the POST lazily on the first packet,
 * delivers mu-law audio, closes the POST after the idle timeout, reopens it on the next talk burst, and ignores packets from other addresses and
 * packets that fail SRTP authentication.
 *
 * FFmpeg's Opus RTP muxer stamps a 48 kHz clock while the iPhone uses the negotiated 16 kHz clock, so the proxy (configured for 16 kHz) scales these
 * timestamps by 3. The decoder doesn't mind; audio-proxy-e2e.test.js covers the exact 16 kHz clock.
 *
 * Run with: npm run build && node test/talkback-e2e.test.js
 */
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const dgram = require("node:dgram");
const http = require("node:http");
const util = require("node:util");
const { DoorbirdApi } = require("../dist/doorbird-api");
const { DoorbirdAudioProxy } = require("../dist/doorbird-audio-proxy");
const { SrtpEncryptContext, deriveSrtpSessionKeys } = require("../dist/doorbird-rtp");
const { DoorbirdTalkback } = require("../dist/doorbird-talkback");

const ffmpegPath = require("ffmpeg-for-homebridge") || "ffmpeg";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Send a few seconds of a 1 kHz tone the way HomeKit sends return audio.
function talk(port, srtp, seconds) {
  const args = ("-hide_banner -loglevel error -re -f lavfi -i sine=frequency=1000:sample_rate=16000 -t " + seconds +
    " -c:a libopus -application lowdelay -ac 1 -ar 16k -b:a 24k -frame_duration 20 -payload_type 110 -ssrc 4242" +
    " -f rtp -srtp_out_suite AES_CM_128_HMAC_SHA1_80 -srtp_out_params " + srtp.toString("base64") +
    " srtp://127.0.0.1:" + port + "?rtcpport=" + port + "&pkt_size=188").split(" ");

  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: [ "ignore", "ignore", "inherit" ] });
    p.on("error", reject);
    p.on("exit", (code) => code === 0 ? resolve() : reject(new Error("sender exited with " + code)));
  });
}

// The audio proxy for a streaming session from 127.0.0.1 at 16 kHz, with two-way audio.
function openProxy(options) {
  const { dbApi, debug = () => {}, log, returnPort, srtp } = options;

  return DoorbirdAudioProxy.open({
    address: "127.0.0.1", audioPort: 9, debug, log, name: "Test", payloadType: 110, returnPort, sampleRate: 16000, srtp,
    talkback: new DoorbirdTalkback({
      debug, idleSeconds: 1, log, name: "Test", openTransmit: () => dbApi.audioTransmitRequest(), payloadType: 110, videoProcessor: ffmpegPath
    })
  });
}

test("talkback relays HomeKit audio to the Doorbird and releases the channel when idle", { timeout: 60000 }, async () => {
  const requests = [];

  // Our fake Doorbird.
  const server = http.createServer((req, res) => {
    const entry = { bytes: [], closed: false, headers: req.headers, method: req.method, opened: Date.now(), url: req.url };
    requests.push(entry);
    req.on("data", (chunk) => entry.bytes.push(chunk));
    req.on("close", () => { entry.closed = Date.now(); });
    res.on("error", () => {});
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const doorbirdPort = server.address().port;
  const dbApi = new DoorbirdApi({ debug: () => {}, log: () => {} }, "Test", "127.0.0.1:" + doorbirdPort, "user", "pa:ss");

  const srtp = crypto.randomBytes(30);
  const returnPort = 30000 + Math.floor(Math.random() * 20000);
  const logLines = [];
  const log = (...args) => logLines.push(args.join(" "));
  log.error = (...args) => logLines.push("ERROR " + args.join(" "));

  const debugLines = [];
  const talkback = await openProxy({ dbApi, debug: (...args) => debugLines.push(util.format(...args)), log, returnPort, srtp });

  try {
    await sleep(200);

    // Nothing happens until someone talks.
    assert.equal(requests.length, 0);

    // RTCP alone must not open the channel.
    const rtcp = Buffer.alloc(8); rtcp[0] = 0x80; rtcp[1] = 201; rtcp.writeUInt16BE(1, 2);
    const s = dgram.createSocket("udp4");
    await new Promise((resolve) => s.send(rtcp, returnPort, "127.0.0.1", resolve));
    s.close();
    await sleep(300);
    assert.equal(requests.length, 0, "RTCP must not start talking");

    // First talk burst.
    await talk(returnPort, srtp, 3);
    assert.equal(requests.length, 1, "one POST per talk burst");

    // Wait for the idle timeout to release the channel.
    await sleep(1800);

    const first = requests[0];
    assert.equal(first.method, "POST");
    assert.equal(first.url, "/bha-api/audio-transmit.cgi");
    assert.equal(first.headers["content-type"], "audio/basic");
    assert.equal(first.headers["content-length"], "9999999");
    assert.equal(first.headers.authorization, "Basic " + Buffer.from("user:pa:ss").toString("base64"));
    assert.ok(first.closed, "POST closed after the idle timeout");

    const audio = Buffer.concat(first.bytes);
    console.log("# first burst: %d bytes of mu-law in %d ms, POST open for %d ms", audio.length, 3000, first.closed - first.opened);

    // 3 s at 8 kB/s, minus FFmpeg's startup.
    assert.ok(audio.length > 12000, "received " + audio.length + " bytes");
    assert.ok(audio.length <= 3 * 8000 + 1000, "received " + audio.length + " bytes");

    // A 1 kHz tone is not silence (0xff / 0x7f in mu-law).
    const loud = audio.filter((b) => (b & 0x7f) < 0x60).length;
    assert.ok(loud > audio.length / 4, "audio looks like silence");

    // And it is our 1 kHz tone: in mu-law, the top bit is the (inverted) sign, so count sign changes in the middle of the burst (~2000 per second).
    const middle = audio.subarray(4000, 12000);
    let crossings = 0;
    for(let i = 1; i < middle.length; i++) {
      crossings += ((middle[i] ^ middle[i - 1]) & 0x80) ? 1 : 0;
    }
    console.log("# sign changes per second: %d", crossings);
    assert.ok(crossings > 1800 && crossings < 2200, "unexpected frequency: " + crossings + " sign changes per second");

    // Second burst reopens the channel.
    await talk(returnPort, srtp, 2);
    await sleep(1800);
    assert.equal(requests.length, 2, "a new POST for the second burst");
    assert.ok(requests[1].closed, "second POST closed after the idle timeout");
    assert.ok(Buffer.concat(requests[1].bytes).length > 6000);

    // Packets that fail authentication (another key, a forged tag) don't open the channel.
    const forger = new SrtpEncryptContext(deriveSrtpSessionKeys(crypto.randomBytes(30)));
    const forgerSocket = dgram.createSocket("udp4");
    for(let i = 0; i < 20; i++) {
      const rtp = Buffer.alloc(60); rtp[0] = 0x80; rtp[1] = 110; rtp.writeUInt16BE(i, 2); rtp.writeUInt32BE(4242, 8);
      await new Promise((resolve) => forgerSocket.send(forger.encrypt(rtp), returnPort, "127.0.0.1", resolve));
    }
    forgerSocket.close();
    await sleep(500);
    assert.equal(requests.length, 2, "unauthenticated packets are ignored");
    assert.ok(debugLines.some((l) => l.includes("SRTP authentication failed")), "authentication failures are logged");

    // Packets from anybody else are ignored.
    const intruder = dgram.createSocket("udp4");
    await new Promise((resolve) => intruder.bind(0, "127.0.0.2", resolve));
    const fakeRtp = Buffer.alloc(100); fakeRtp[0] = 0x80; fakeRtp[1] = 110;
    for(let i = 0; i < 10; i++) {
      await new Promise((resolve) => intruder.send(fakeRtp, returnPort, "127.0.0.1", resolve));
    }
    intruder.close();
    await sleep(500);
    assert.equal(requests.length, 2, "packets from other addresses are ignored");

    // A talk burst that is still running when the session ends is torn down.
    const sender = talk(returnPort, srtp, 3);
    await sleep(1500);
    assert.equal(requests.length, 3);
    talkback.close();
    await sleep(300);
    assert.ok(requests[2].closed, "close() releases the channel");
    await sender;

    assert.deepEqual(logLines.filter((l) => l.startsWith("ERROR")), []);
    assert.equal(logLines.filter((l) => l.includes("Two-way audio started")).length, 3);
    assert.equal(logLines.filter((l) => l.includes("Two-way audio stopped")).length, 3);

    // The proxy summarizes what it saw.
    const summary = debugLines.find((l) => l.includes("Audio proxy stopped"));
    console.log("# " + summary);
    assert.match(summary, /failed authentication/);
    assert.ok(debugLines.some((l) => /Two-way audio: receiving SSRC 0x1092, payload type 110/.test(l)));
  } finally {
    talkback.close();
    server.close();
    server.closeAllConnections();
  }
});

test("a Doorbird that rejects us is reported once per talk burst and doesn't crash", { timeout: 30000 }, async () => {
  let posts = 0;
  const server = http.createServer((req, res) => { posts++; res.statusCode = 401; res.end(); req.resume(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const dbApi = new DoorbirdApi({ debug: () => {}, log: () => {} }, "Test", "127.0.0.1:" + server.address().port, "user", "wrong");
  const srtp = crypto.randomBytes(30);
  const returnPort = 30000 + Math.floor(Math.random() * 20000);
  const errors = [];
  const log = () => {};
  log.error = (...args) => errors.push(args.join(" "));

  const talkback = await openProxy({ dbApi, log, returnPort, srtp });

  try {
    await sleep(200);
    await talk(returnPort, srtp, 2);
    await sleep(1500);
    assert.equal(posts, 1, "no retries during the same talk burst");
    assert.equal(errors.length, 1);
    assert.match(errors[0], /401/);

    // The next burst tries again.
    await talk(returnPort, srtp, 1);
    await sleep(1500);
    assert.equal(posts, 2);

    // Refused connections are handled too.
    server.close();
    server.closeAllConnections();
    await sleep(100);
    await talk(returnPort, srtp, 1);
    await sleep(1500);
    assert.equal(errors.length, 3);
    assert.match(errors[2], /ECONNREFUSED/);
  } finally {
    talkback.close();
    server.close();
  }
});
