/* Copyright(C) 2026, Andreas Kurtz. All rights reserved.
 *
 * doorbird-snapshot.ts: HomeKit snapshots from the livestream buffer.
 *
 * On a ring, HomeKit asks for a snapshot for the notification exactly when the Doorbird is busy with the ring, and the Doorbird then fails about a
 * third of its image.cgi requests (503, or a malformed response Node's HTTP parser rejects). When the livestream buffer is already running, it holds
 * the Doorbird's video anyway: we decode a JPEG from its last keyframe with FFmpeg instead of asking the Doorbird.
 */
import { spawn } from "child_process";

// What the source decision needs to know about the livestream buffer.
export interface SnapshotBufferState {
  isReady: boolean;
  videoAge: number;
}

export type SnapshotSource = { age: number, source: "buffer" } | { reason: string, source: "doorbird" };

// Decide where a snapshot comes from: the buffer when it is ready and its last keyframe is fresh, the Doorbird otherwise. We never start the buffer for
// a snapshot: that would open an RTSP session on the Doorbird for every refresh of a tile in the Home app.
export function snapshotSource(livestream: SnapshotBufferState | null, maxAge: number): SnapshotSource {
  if(!livestream) {
    return { reason: "the livestream buffer is disabled", source: "doorbird" };
  }

  if(!livestream.isReady) {
    return { reason: "the livestream buffer is not running", source: "doorbird" };
  }

  const age = livestream.videoAge;

  if(!(age < maxAge)) {
    return { reason: "the buffer's last keyframe is " + (Number.isFinite(age) ? Math.round(age).toString() + " ms" : "too") + " old", source: "doorbird" };
  }

  return { age: Math.round(age), source: "buffer" };
}

export interface SnapshotDecodeOptions {
  // Fragmented MP4: the init segment followed by the fragments from a keyframe onwards.
  data: Buffer;
  // FFmpeg binary.
  ffmpeg: string;
  // The height HomeKit asked for. The width follows the video's aspect ratio, and we never scale up.
  height: number;
  // Hard limit for the decode, in milliseconds. FFmpeg is killed when it runs out.
  timeout: number;
}

// The JPEG start of image marker.
const JPEG_SOI = Buffer.from([ 0xff, 0xd8 ]);

// Decode the first video frame of a fragmented MP4 into a JPEG. Resolves to null when FFmpeg fails, times out, or produces no JPEG; never rejects.
export function decodeSnapshot(options: SnapshotDecodeOptions): Promise<Buffer | null> {
  const height = Math.max(Math.round(options.height / 2) * 2, 2).toString();
  const args = [
    "-hide_banner",
    "-nostats",
    "-loglevel", "error",
    "-fflags", "+discardcorrupt",
    "-err_detect", "ignore_err",
    "-f", "mp4",
    "-i", "pipe:0",
    "-map", "0:v:0",
    "-an",
    "-frames:v", "1",
    "-vf", "scale=-2:min(ih\\," + height + ")",
    "-q:v", "3",
    "-c:v", "mjpeg",
    "-f", "image2",
    "pipe:1"
  ];

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const ffmpeg = spawn(options.ffmpeg, args, { env: process.env, stdio: [ "pipe", "pipe", "ignore" ] });

    const finish = (image: Buffer | null): void => {
      if(settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      if(ffmpeg.exitCode === null) {
        ffmpeg.kill("SIGKILL");
      }

      resolve(image);
    };

    const timer = setTimeout(() => finish(null), options.timeout);

    ffmpeg.on("error", () => finish(null));
    ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.stdout.on("error", () => finish(null));

    // FFmpeg stops reading once it has its frame, so a write error (EPIPE) on the rest of the buffer is expected.
    ffmpeg.stdin.on("error", () => { /* Handled through the exit code. */ });

    ffmpeg.on("close", (code: number | null) => {
      const image = Buffer.concat(chunks);

      finish(((code === 0) && (image.length > JPEG_SOI.length) && image.subarray(0, JPEG_SOI.length).equals(JPEG_SOI)) ? image : null);
    });

    ffmpeg.stdin.end(options.data);
  });
}
