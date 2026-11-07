/* Tests for the HKSV early-end hint: whom it blames depends on which side ended the recording. No FFmpeg needed. */
"use strict";

import assert from "node:assert/strict";
import { test } from "node:test";
import { format } from "node:util";
import { DoorbirdRecordingDelegate } from "../dist/doorbird-recording.js";

// The values of HAP's HDSProtocolSpecificErrorReason.
const HDSProtocolSpecificErrorReason = { BAD_DATA: 7, BUSY: 2, CANCELLED: 3, NORMAL: 0, TIMEOUT: 6, UNEXPECTED_FAILURE: 5 };

function makeDelegate() {
  const lines = { debug: [], error: [], info: [], warn: [] };
  const log = (message, ...parameters) => lines.info.push(format(message, ...parameters));

  for(const level of Object.keys(lines)) {
    log[level] = (message, ...parameters) => lines[level].push(format(message, ...parameters));
  }

  const livestream = { off: () => {}, segmentLength: 100, transmitStop: () => {}, videoAge: 200 };
  const debug = (message, ...parameters) => lines.debug.push(format(message, ...parameters));
  const delegate = new DoorbirdRecordingDelegate({ accessory: {}, audioSupport: false, debug, ffmpegOptions: {}, fps: 15,
    hap: { HDSProtocolSpecificErrorReason }, livestream, log, name: "Test", verbose: false });

  // Play one recording event that HomeKit closes with the given reason after some fragments went out. A timed out recording FFmpeg leaves its
  // stderr behind.
  const end = (reason, { endedByUs = false, segmentsOut = 3, stderrLog = [], timedOut = false } = {}) => {
    delegate.session = { declined: false, endedByUs, id: 1, segmentsIn: 150, segmentsOut, started: Date.now() - 15000 };
    delegate.process = { abort: () => {}, isTimedOut: timedOut, stderrLog };
    delegate.transmitting = true;
    delegate.stopTransmitting(reason);
  };

  return { end, lines, livestream };
}

test("Repeated early ends that HomeKit initiated point at the home hub, not the Doorbird", () => {
  const { end, lines } = makeDelegate();

  end(HDSProtocolSpecificErrorReason.UNEXPECTED_FAILURE);
  end(HDSProtocolSpecificErrorReason.UNEXPECTED_FAILURE);
  end(HDSProtocolSpecificErrorReason.CANCELLED);

  assert.match(lines.warn[0], /the request was slow to respond\. This happens occasionally and can be ignored\.$/);
  assert.match(lines.warn[1], /That is 2 early ends in a row from HomeKit\. If it keeps happening, check the home hub's network connection\.$/);
  assert.match(lines.warn[2], /HomeKit cancelled the request\. That is 3 early ends in a row from HomeKit\./);
  assert.ok(lines.warn.every((line) => !line.includes("check the Doorbird's video")));
});

test("Repeated early ends on our side where FFmpeg stopped say so, and a complete recording resets the count", () => {
  const { end, lines } = makeDelegate();

  end(HDSProtocolSpecificErrorReason.CANCELLED, { endedByUs: true });
  end(HDSProtocolSpecificErrorReason.CANCELLED, { endedByUs: true });
  end(HDSProtocolSpecificErrorReason.UNEXPECTED_FAILURE, { segmentsOut: 0 });
  end(HDSProtocolSpecificErrorReason.BAD_DATA);

  assert.match(lines.warn[1], /That is 2 early ends in a row, FFmpeg stopped delivering video\.$/);
  assert.match(lines.warn[2], /That is 3 early ends in a row, FFmpeg stopped delivering video\.$/);
  assert.match(lines.warn[3], /reason 7\. That is 4 early ends in a row, FFmpeg stopped delivering video\.$/);

  end(HDSProtocolSpecificErrorReason.NORMAL);
  end(HDSProtocolSpecificErrorReason.CANCELLED);

  assert.match(lines.info.at(-1), /recorded 15 seconds for HomeKit/);
  assert.match(lines.warn.at(-1), /This happens occasionally and can be ignored\.$/);
});

test("A buffer without video is named first", () => {
  const { end, lines, livestream } = makeDelegate();

  livestream.videoAge = 12000;
  end(HDSProtocolSpecificErrorReason.CANCELLED);

  assert.match(lines.warn[0], /The buffer has had no video from the Doorbird for 12 seconds\.$/);
});

test("Repeated timeouts of the recording FFmpeg say it fell behind, and only error-like stderr lines are warnings", () => {
  const { end, lines } = makeDelegate();
  const stderrLog = [
    "      encoder         : Lavc61.19.100 libx264",
    "      handler_name    : VideoHandler",
    "      Side data:",
    "[h264 @ 0x5581] error while decoding MB 12 30, bytestream -5",
    "        cpb: bitrate max/min/avg: 0/0/2000000 buffer size: 4000000 vbv_delay: N/A"
  ];

  end(HDSProtocolSpecificErrorReason.UNEXPECTED_FAILURE, { stderrLog, timedOut: true });
  end(HDSProtocolSpecificErrorReason.UNEXPECTED_FAILURE, { stderrLog, timedOut: true });

  const ends = lines.warn.filter((line) => line.includes("ended early"));

  assert.match(ends[0], /This happens occasionally and can be ignored\.$/);
  assert.match(ends[1], /That is 2 early ends in a row: the recording fell behind the Doorbird's video, which often happens while the Doorbird handles a ring\./);
  assert.ok(lines.warn.every((line) => !line.includes("check the Doorbird's video") && !line.includes("home hub")));

  // Per event: the decoding error is a warning, the four stream description lines go to the debug log.
  const ffmpegWarnings = lines.warn.filter((line) => line.includes("ffmpeg:"));

  assert.equal(ffmpegWarnings.length, 2);
  assert.ok(ffmpegWarnings.every((line) => line.includes("error while decoding")));
  assert.equal(lines.debug.filter((line) => line.includes("ffmpeg:")).length, 8);
});
