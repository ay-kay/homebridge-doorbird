/* Tests for the livestream buffer's video stall watchdog, without FFmpeg: the process double from homebridge-plugin-utils stands in for it. */
"use strict";

import assert from "node:assert/strict";
import { test } from "node:test";
import { format } from "node:util";
import { DoorbirdLivestream } from "../dist/doorbird-livestream.js";
import { TestLivestreamProcessFactory, makeBox, makeContainer, makeTrunBox, waitUntil } from "homebridge-plugin-utils/testing";

const initSegment = Buffer.concat([ makeBox("ftyp", Buffer.from("isom")), makeContainer("moov", [ makeBox("mvhd", Buffer.alloc(8)) ]) ]);
const fragment = (sampleFlagsValue) => Buffer.concat([
  makeContainer("moof", [ makeContainer("traf", [ makeTrunBox({ sampleFlagsValue, useFirstSampleFlags: true }) ]) ]),
  makeBox("mdat", Buffer.alloc(16))
]);
const keyframeFragment = fragment(0);
const nonKeyframeFragment = fragment(0x00010000); // SAMPLE_FLAG_NON_SYNC: what the buffer produces while the Doorbird sends no video.

function capturingLog() {
  const lines = { debug: [], error: [], info: [], warn: [] };
  const log = (message, ...parameters) => lines.info.push(format(message, ...parameters));

  for(const level of Object.keys(lines)) {
    log[level] = (message, ...parameters) => lines[level].push(format(message, ...parameters));
  }

  return { lines, log };
}

test("A buffer whose video stops is restarted, and the live view is told", async () => {
  const factory = new TestLivestreamProcessFactory();
  const { lines, log } = capturingLog();
  const relay = { start: async () => {}, stop: () => {}, url: "tcp://127.0.0.1:1" };
  const livestream = new DoorbirdLivestream({ audioRelay: relay, debug: () => {}, ffmpegOptions: {}, log, name: "Test", processFactory: factory,
    rtspUrl: "rtsp://doorbird/stream", videoStallTimeout: 300 });

  let restarts = 0;
  let discontinuities = 0;

  livestream.on("restarting", () => restarts++);
  livestream.on("discontinuity", () => discontinuities++);

  livestream.acquire("test");
  await waitUntil(() => factory.createCalls.length === 1, { description: "FFmpeg launched", timeoutMs: 2000 });

  // The RTSP input must not block forever on a dead socket.
  const args = factory.createCalls[0].init.args;

  assert.equal(args[args.indexOf("-timeout") + 1], "10000000");
  assert.ok(args.indexOf("-timeout") < args.indexOf("-i"), "the socket timeout is an input option");

  const first = factory.createCalls[0].process;

  first.resolveInit(initSegment);
  first.feed(keyframeFragment);
  await waitUntil(() => livestream.isReady, { description: "buffer ready", timeoutMs: 2000 });
  assert.ok(livestream.videoAge < 300);

  // The Doorbird's video goes away: audio-only fragments keep coming, keyframes do not.
  const audioOnly = setInterval(() => {
    try {
      first.feed(nonKeyframeFragment);
    } catch {
      clearInterval(audioOnly);
    }
  }, 50);

  try {
    await waitUntil(() => factory.createCalls.length === 2, { description: "FFmpeg restarted after the stall", timeoutMs: 3000 });
  } finally {
    clearInterval(audioOnly);
  }

  assert.equal(restarts, 1);
  assert.equal(lines.warn.filter((line) => /No video from the Doorbird for \d+ seconds, restarting the stream/.test(line)).length, 1);
  assert.equal(livestream.isReady, false, "the stalled timeline is gone");

  // Video returns with the new FFmpeg: the consumers get a discontinuity, the log an all-clear.
  const second = factory.createCalls[1].process;

  second.resolveInit(initSegment);
  second.feed(keyframeFragment);
  await waitUntil(() => livestream.isReady, { description: "buffer ready again", timeoutMs: 2000 });

  assert.equal(discontinuities, 1);
  assert.ok(lines.info.some((line) => line.includes("Video from the Doorbird is back")));

  livestream.stop();
});
