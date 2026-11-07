/* Tests for snapshots from the livestream buffer: where a snapshot comes from, and the JPEG decode with the bundled FFmpeg if it runs here. */
"use strict";

import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { decodeSnapshot, snapshotSource } from "../dist/doorbird-snapshot.js";
import assert from "node:assert/strict";
import { isKeyframe } from "homebridge-plugin-utils";
import { join } from "node:path";
import pathToFfmpeg from "ffmpeg-for-homebridge";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { tmpdir } from "node:os";

const ffmpeg = pathToFfmpeg;
const ffmpegRuns = !!ffmpeg && existsSync(ffmpeg) && (spawnSync(ffmpeg, [ "-hide_banner", "-version" ]).status === 0);
const skipFfmpeg = ffmpegRuns ? false : "the bundled FFmpeg does not run on this machine";

// Fragmented MP4 shaped like the livestream buffer's: 1280x720 H.264 with a keyframe every second, PCM audio, 100 ms fragments.
function bufferLikeMp4(seconds = 1) {
  const result = spawnSync(ffmpeg, [ "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=15", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", seconds.toString(),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "15", "-c:a", "pcm_s16le",
    "-frag_duration", "100000", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1" ], { maxBuffer: 64 * 1024 * 1024 });

  assert.equal(result.status, 0, result.stderr?.toString());

  return result.stdout;
}

// Split a fragmented MP4 like the buffer does: the init segment (ftyp + moov) and one buffer per moof + mdat.
function splitMp4(data) {
  const boxes = [];

  for(let offset = 0; offset < data.length; ) {
    const size = data.readUInt32BE(offset);

    boxes.push({ data: data.subarray(offset, offset + size), type: data.toString("latin1", offset + 4, offset + 8) });
    offset += size;
  }

  const firstMoof = boxes.findIndex((box) => box.type === "moof");
  const fragments = [];

  for(let i = firstMoof; i < boxes.length; i++) {
    if(boxes[i].type === "moof") {
      fragments.push([]);
    }

    fragments.at(-1).push(boxes[i].data);
  }

  return { fragments: fragments.map((parts) => Buffer.concat(parts)), init: Buffer.concat(boxes.slice(0, firstMoof).map((box) => box.data)) };
}

test("Snapshots come from the buffer only when it is ready and its last keyframe is fresh", () => {
  assert.deepEqual(snapshotSource({ isReady: true, videoAge: 1200.4 }, 5000), { age: 1200, source: "buffer" });

  assert.equal(snapshotSource(null, 5000).source, "doorbird");
  assert.match(snapshotSource(null, 5000).reason, /disabled/);
  assert.match(snapshotSource({ isReady: false, videoAge: 100 }, 5000).reason, /not running/);
  assert.match(snapshotSource({ isReady: true, videoAge: 7000 }, 5000).reason, /7000 ms old/);
  assert.equal(snapshotSource({ isReady: true, videoAge: 5000 }, 5000).source, "doorbird");
  assert.equal(snapshotSource({ isReady: true, videoAge: Infinity }, 5000).source, "doorbird");
});

test("A JPEG is decoded from the buffer at the requested height", { skip: skipFfmpeg }, async () => {
  const data = bufferLikeMp4();

  const small = await decodeSnapshot({ data, ffmpeg, height: 360, timeout: 3000 });

  assert.ok(small, "no image");
  assert.equal(small[0], 0xff);
  assert.equal(small[1], 0xd8);
  assert.ok(small.length > 1000, "image too small: " + small.length.toString());

  // HomeKit may ask for more than the Doorbird delivers; we do not scale up.
  const large = await decodeSnapshot({ data, ffmpeg, height: 1080, timeout: 3000 });

  assert.ok(large && (large[0] === 0xff) && (large[1] === 0xd8));
});

test("A JPEG is decoded from a later keyframe, the way fromLastKeyframe() hands it out", { skip: skipFfmpeg }, async () => {
  const { fragments, init } = splitMp4(bufferLikeMp4(2.5));
  const last = fragments.findLastIndex((fragment) => isKeyframe(fragment));

  assert.ok(last > 0, "no keyframe after the first fragment");

  const image = await decodeSnapshot({ data: Buffer.concat([ init, ...fragments.slice(last) ]), ffmpeg, height: 720, timeout: 3000 });

  assert.ok(image && (image[0] === 0xff) && (image[1] === 0xd8) && (image.length > 1000));
});

test("Garbage input yields null within the timeout, without throwing", { skip: skipFfmpeg }, async () => {
  const started = Date.now();

  assert.equal(await decodeSnapshot({ data: Buffer.alloc(64 * 1024, 7), ffmpeg, height: 360, timeout: 3000 }), null);
  assert.ok((Date.now() - started) < 3000);
});

test("A missing FFmpeg yields null", async () => {
  assert.equal(await decodeSnapshot({ data: Buffer.alloc(16), ffmpeg: "/nonexistent/ffmpeg", height: 360, timeout: 3000 }), null);
});

test("An FFmpeg that hangs is killed at the timeout", { skip: (process.platform === "win32") ? "needs a shell script" : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "doorbird-snapshot-"));
  const hanging = join(dir, "ffmpeg");

  writeFileSync(hanging, "#!/bin/sh\nexec sleep 30\n");
  chmodSync(hanging, 0o755);

  try {
    const started = Date.now();

    assert.equal(await decodeSnapshot({ data: Buffer.alloc(16), ffmpeg: hanging, height: 360, timeout: 300 }), null);

    const elapsed = Date.now() - started;

    assert.ok((elapsed >= 280) && (elapsed < 2000), "elapsed " + elapsed.toString() + " ms");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
