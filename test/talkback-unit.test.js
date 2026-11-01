/* Unit tests for the talkback and audio proxy helpers. Run with: npm run build && node test/talkback-unit.test.js */
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { TALKBACK_FFMPEG_COMMAND, buildTalkbackSdp, reserveRtpPortPair } = require("../dist/doorbird-talkback");
const { opusFfmpegOutput } = require("../dist/doorbird-audio-proxy");

test("SDP for the talkback FFmpeg: plain Opus RTP on the 48 kHz clock", () => {
  assert.equal(buildTalkbackSdp({ payloadType: 110, port: 50000 }), [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=Talk",
    "c=IN IP4 127.0.0.1",
    "t=0 0",
    "m=audio 50000 RTP/AVP 110",
    "a=rtpmap:110 opus/48000/2",
    ""
  ].join("\r\n"));

  // The payload type comes from the request.
  const sdp = buildTalkbackSdp({ payloadType: 99, port: 40000 });

  assert.match(sdp, /^m=audio 40000 RTP\/AVP 99$/m);
  assert.match(sdp, /^a=rtpmap:99 opus\/48000\/2$/m);
  assert.doesNotMatch(sdp, /crypto/);
});

test("Talkback FFmpeg decodes Opus without crypto and keeps the low latency options", () => {
  assert.match(TALKBACK_FFMPEG_COMMAND, /-protocol_whitelist pipe,udp,rtp /);
  assert.match(TALKBACK_FFMPEG_COMMAND, /-fflags nobuffer -flags low_delay -max_delay 0 -reorder_queue_size 0 -f sdp -c:a libopus -i pipe:0/);
  assert.match(TALKBACK_FFMPEG_COMMAND, /-acodec pcm_mulaw -ar 8000 -ac 1 .* -f mulaw pipe:1$/);
});

test("FFmpeg Opus output for the audio proxy", () => {
  const output = { bitrate: 24, packetTime: 20, payloadType: 110, port: 45678, sampleRate: 16, ssrc: 12345 };

  assert.equal(opusFfmpegOutput(output),
    "-vn -c:a libopus -application lowdelay -ac 1 -ar 16k -b:a 24k -bufsize 96k -frame_duration 20 -payload_type 110 -ssrc 12345" +
    " -rtpflags skip_rtcp -f rtp rtp://127.0.0.1:45678?pkt_size=188");

  assert.match(opusFfmpegOutput({ ...output, packetTime: 60, sampleRate: 24 }), / -ar 24k .* -frame_duration 60 /);

  // libopus can't do 30 ms frames.
  assert.match(opusFfmpegOutput({ ...output, packetTime: 30 }), / -frame_duration 20 /);
});

test("Consecutive port pair for FFmpeg's RTP and RTCP sockets", async () => {
  const port = await reserveRtpPortPair();

  assert.ok(port > 0 && port < 65535);
});
