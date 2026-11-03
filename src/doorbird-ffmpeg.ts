/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * doorbird-ffmpeg.ts: FFmpeg capability validation and process control.
 *
 * This module is heavily inspired by the homebridge and homebridge-camera-ffmpeg source code and
 * borrows heavily from both. Thank you for your contributions to the HomeKit world.
 */
import { ChildProcess, spawn } from "child_process";
import { Socket, createSocket } from "dgram";
import { Writable } from "stream";
import execa from "execa";
import { Logging, StreamRequestCallback } from "homebridge";
import { DoorbirdStreamingDelegate } from "./doorbird-stream.js";
import { FFMPEG_STDERR_TAIL } from "./settings.js";
import { redactUrl } from "./doorbird-util.js";

export class FfmpegProcess {
  private readonly debug: (message: string, ...parameters: any[]) => void;
  private readonly log: Logging;
  private readonly process: ChildProcess;
  private killing = false;
  private readonly socket: Socket;
  private stderrTail: string[] = [];
  private timeout?: NodeJS.Timeout;
  private delegate: DoorbirdStreamingDelegate;

  constructor(delegate: DoorbirdStreamingDelegate, sessionId: string, command: string, returnPort: number, callback: StreamRequestCallback) {
    this.debug = delegate.platform.debug.bind(delegate.platform);
    this.delegate = delegate;
    this.log = delegate.platform.log;

    let started = false;

    // Never log the Doorbird credentials embedded in the stream URLs.
    this.debug("%s: ffmpeg command: %s %s", delegate.name, delegate.videoProcessor, redactUrl(command));

    const socket = createSocket("udp4");

    this.socket = socket;

    // Handle network errors.
    socket.on("error", (error: Error) => {
      this.log.error("%s: Socket error: ", delegate.name, error.name);
      delegate.stopStream(sessionId);
    });

    // Kill zombie video streams.
    socket.on("message", () => {
      if(this.timeout) {
        clearTimeout(this.timeout);
      }

      this.timeout = setTimeout(() => {
        delegate.platform.log.info("%s: Device appears to be inactive for over 5 seconds. Stopping stream.", delegate.name);
        delegate.controller.forceStopStreamingSession(sessionId);
        delegate.stopStream(sessionId);
      }, 5000);
    });

    socket.bind(returnPort);

    // Execute the command line.
    this.process = spawn(delegate.videoProcessor, command.split(/\s+/), { env: process.env });

    if(this.process.stdin) {
      this.process.stdin.on("error", (error: Error) => {
        if(!error.message.includes("EPIPE")) {
          this.log.error("%s: FFmpeg error: %s", delegate.name, redactUrl(error.message));
        }
      });
    }

    if(this.process.stderr) {
      this.process.stderr.on("data", (data) => {
        if(!started) {
          started = true;
          this.debug("%s: Received the first frame.", delegate.name);

          // Always remember to execute the callback once we're setup.
          if(callback) {
            callback();
          }
        }

        // Keep the last few lines so we can explain an unexpected exit even without debug logging.
        redactUrl((data as Buffer).toString()).split(/\n/).forEach((line: string) => {
          if(line.trim().length) {
            this.stderrTail = this.stderrTail.concat(line.trim()).slice(-FFMPEG_STDERR_TAIL);
          }

          // Debugging and additional logging, if requested.
          if(delegate.platform.debugMode) {
            this.log(line);
          }
        });
      });
    }

    // Error handling.
    this.process.on("error", (error: Error) => {
      this.log.error("%s: Unable to start stream: %s.", delegate.name, redactUrl(error.message));
      if(callback) {
        callback(new Error("ffmpeg process creation failed!"));
        delegate.stopStream(sessionId);
      }
    });

    // Handle the end of our process - graceful and otherwise.
    this.process.on("exit", (code: number, signal: NodeJS.Signals) => {
      const message = "%s: ffmpeg exited with code: " + code + " and signal: " + signal;

      if(code === null || code === 255) {
        if(this.killing) {
          this.debug(message + " (Expected)", delegate.name);
        } else {
          this.log.error(message + " (Unexpected)", delegate.name);
        }
      } else {
        this.log.error(message + " (Error)", delegate.name);
        this.stderrTail.forEach((line: string) => this.log.error("%s: ffmpeg: %s", delegate.name, line));

        // Release the watchdog socket so a retry can bind the same return port.
        this.closeSocket();

        // The Doorbird refuses new streams while it is busy with its own events (ring, motion). Give it another chance before we fail.
        if(!started && callback && delegate.retryStream(sessionId, callback)) {
          return;
        }

        delegate.stopStream(sessionId);

        if(!started && callback) {
          callback(new Error(message));
        } else {
          delegate.controller.forceStopStreamingSession(sessionId);
        }
      }
    });
  }

  // FFmpeg's standard input, for sessions fed from the livestream buffer.
  public get stdin(): Writable | null {
    return this.process.stdin;
  }

  // Close the watchdog socket.
  private closeSocket(): void {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }

  // Cleanup.
  public stop(): void {
    this.killing = true;
    if(this.timeout) {
      clearTimeout(this.timeout);
    }
    this.closeSocket();
    this.process.kill("SIGKILL");
  }

  // Validate whether or not we have a specific codec available to us in FFmpeg.
  static async codecEnabled(videoProcessor: string, codec: string): Promise<boolean> {
    const output = await execa(videoProcessor, ["-codecs"]);
    return output.stdout.includes(codec);
  }
}
