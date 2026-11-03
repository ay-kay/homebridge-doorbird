/* Copyright(C) 2026, Andreas Kurtz. All rights reserved.
 *
 * doorbird-livestream.ts: One stream per Doorbird, buffered, for the live view and HomeKit Secure Video.
 *
 * The buffer logic follows the timeshift buffer in homebridge-unifi-protect (Copyright(C) 2017-2026, HJD, ISC license, see "Third-party code" in README.md): FFmpeg turns the Doorbird's
 * RTSP video and the relayed audio into fragmented MP4 in 100 ms fragments, we keep the last few seconds of them, flag the ones that start with a
 * keyframe, and hand consumers the init segment plus fragments from a keyframe onwards followed by the live fragments as they arrive.
 */
import {
  LIVESTREAM_BUFFER_DURATION,
  LIVESTREAM_FAILURE_LOG_THRESHOLD,
  LIVESTREAM_IDLE_TIMEOUT,
  LIVESTREAM_RESTART_DELAY,
  LIVESTREAM_RESTART_DELAY_ACTIVE,
  LIVESTREAM_RESTART_DELAY_MAX,
  LIVESTREAM_RTSP_TIMEOUT,
  LIVESTREAM_SEGMENT_LENGTH,
  LIVESTREAM_VIDEO_STALL_TIMEOUT
} from "./settings.js";
import { FfmpegOptions, LivestreamProcess, LivestreamProcessFactory, isKeyframe, livestreamProcessFactory } from "homebridge-plugin-utils";
import { DoorbirdAudioRelay } from "./doorbird-audio-relay.js";
import { EventEmitter } from "events";
import { Logging } from "homebridge";
import { redactUrl } from "./doorbird-util.js";

export type SegmentRole = "blob" | "live";

interface LivestreamEvents {
  // A new timeline is established after a restart: the first keyframe of the new FFmpeg has arrived. Transmitting consumers restart on it.
  discontinuity: [];
  // Every fragment as it is buffered. Live views write these straight through to their FFmpeg.
  fragment: [ data: Buffer ];
  // FFmpeg died and will be restarted. Live consumers end their sessions, the old timeline is gone.
  restarting: [];
  // Fragments for the transmitting consumer (HKSV): the initial blob (init segment plus buffered fragments) and then live fragments.
  segment: [ data: Buffer, role: SegmentRole ];
  // The buffer stopped, by demand or because it gave up.
  stopped: [];
  // The buffer stopped while a consumer was transmitting.
  terminated: [];
}

interface BufferedFragment {
  data: Buffer;
  isKeyframe: boolean;
}

export interface KeyframeAlignedStart {
  seekOffsetMs: number;
  startIndex: number;
}

export interface LivestreamOptions {
  audioRelay: DoorbirdAudioRelay;
  debug: (message: string, ...parameters: unknown[]) => void;
  ffmpegOptions: FfmpegOptions;
  log: Logging;
  name: string;
  // Builds the FFmpeg process. Tests substitute a double; production uses homebridge-plugin-utils' factory.
  processFactory?: LivestreamProcessFactory;
  rtspUrl: string;
  // No keyframe for this long while FFmpeg runs means the video is gone and FFmpeg is restarted.
  videoStallTimeout?: number;
}

export class DoorbirdLivestream extends EventEmitter<LivestreamEvents> {
  private readonly audioRelay: DoorbirdAudioRelay;
  private readonly debug: (message: string, ...parameters: unknown[]) => void;
  private readonly demands = new Set<string>();
  private failures = 0;
  private readonly ffmpegOptions: FfmpegOptions;
  private fragments: BufferedFragment[] = [];
  private generation = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private _initSegment: Buffer | null = null;
  private lastKeyframe = 0;
  private readonly log: Logging;
  private readonly name: string;
  private pendingDiscontinuity = false;
  private process: LivestreamProcess | null = null;
  private readonly processFactory: LivestreamProcessFactory;
  private restartTimer: NodeJS.Timeout | null = null;
  private readonly rtspUrl: string;
  private running = false;
  private readonly segmentCount = Math.max(Math.ceil(LIVESTREAM_BUFFER_DURATION / LIVESTREAM_SEGMENT_LENGTH), 1);
  private stalled = false;
  private stallTimer: NodeJS.Timeout | null = null;
  private transmitting = false;
  private readonly videoStallTimeout: number;

  constructor(options: LivestreamOptions) {
    super();

    this.audioRelay = options.audioRelay;
    this.debug = options.debug;
    this.ffmpegOptions = options.ffmpegOptions;
    this.log = options.log;
    this.name = options.name;
    this.processFactory = options.processFactory ?? livestreamProcessFactory;
    this.rtspUrl = options.rtspUrl;
    this.videoStallTimeout = options.videoStallTimeout ?? LIVESTREAM_VIDEO_STALL_TIMEOUT;
  }

  // Consumers announce themselves. The buffer runs while anyone needs it and for a while after.
  public acquire(reason: string): void {
    this.demands.add(reason);

    if(this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if(!this.running) {
      this.start();
    }
  }

  public release(reason: string): void {
    this.demands.delete(reason);

    if(this.demands.size || !this.running || this.idleTimer) {
      return;
    }

    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;

      if(!this.demands.size) {
        this.debug("%s: Livestream buffer idle, stopping.", this.name);
        this.stop();
      }
    }, LIVESTREAM_IDLE_TIMEOUT);
  }

  // Start the buffer: the audio relay first, then FFmpeg.
  private start(): void {
    if(this.running) {
      return;
    }

    this.running = true;
    this.failures = 0;
    this.debug("%s: Starting the livestream buffer.", this.name);
    void this.launch();
  }

  // Stop the buffer and release the Doorbird.
  public stop(): void {
    if(!this.running) {
      return;
    }

    this.running = false;
    this.generation++;

    if(this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if(this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    const wasTransmitting = this.transmitting;

    this.transmitting = false;
    this.stalled = false;
    this.disarmStallWatchdog();
    void this.process?.[Symbol.asyncDispose]();
    this.process = null;
    this.audioRelay.stop();
    this.clearBuffer();
    this._initSegment = null;

    if(wasTransmitting) {
      this.emit("terminated");
    }

    this.emit("stopped");
  }

  // Launch FFmpeg and consume its fragments until it dies.
  private async launch(): Promise<void> {
    const generation = ++this.generation;

    try {
      await this.audioRelay.start();
    } catch(error) {
      this.log.error("%s: Unable to start the audio relay: %s", this.name, redactUrl(error instanceof Error ? error.message : String(error)));
    }

    if(!this.running || (generation !== this.generation)) {
      return;
    }

    const process = this.processFactory.create(this.ffmpegOptions, {
      args: this.ffmpegArguments(),
      livestream: { url: this.rtspUrl }
    });

    this.process = process;

    try {
      const init = await process.getInitSegment();

      if(!this.running || (generation !== this.generation)) {
        return;
      }

      this._initSegment = init;
      this.debug("%s: Livestream buffer connected.", this.name);
      this.armStallWatchdog(process);

      for await (const fragment of process.segments()) {
        if(!this.running || (generation !== this.generation)) {
          return;
        }

        this.processFragment(fragment);
      }
    } catch(error) {
      if(this.running && (generation === this.generation)) {
        this.debug("%s: Livestream buffer iteration ended: %s", this.name, redactUrl(error instanceof Error ? error.message : String(error)));
      }
    } finally {
      if(this.running && (generation === this.generation)) {
        this.handleExit(process);
      }
    }
  }

  // FFmpeg is gone. Tell the consumers and try again.
  private handleExit(process: LivestreamProcess): void {
    const produced = this._initSegment !== null;

    this.disarmStallWatchdog();
    this.process = null;
    this.failures = produced ? 0 : this.failures + 1;
    this.pendingDiscontinuity = true;
    this.clearBuffer();
    this._initSegment = null;

    if(this.failures === LIVESTREAM_FAILURE_LOG_THRESHOLD) {
      this.log.warn("%s: The livestream buffer cannot start, retrying. Last FFmpeg output:", this.name);
      ("stderrLog" in process ? (process as { stderrLog: string[] }).stderrLog : []).slice(-5)
        .forEach((line) => this.log.warn("%s: ffmpeg: %s", this.name, redactUrl(line)));
    } else if(produced) {
      this.debug("%s: Livestream buffer ended, restarting.", this.name);
    }

    this.emit("restarting");

    const delay = this.failures ? Math.min(LIVESTREAM_RESTART_DELAY * Math.pow(2, this.failures - 1), LIVESTREAM_RESTART_DELAY_MAX) :
      ((this.transmitting || this.demands.size) ? LIVESTREAM_RESTART_DELAY_ACTIVE : LIVESTREAM_RESTART_DELAY);

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;

      if(this.running) {
        void this.launch();
      }
    }, delay);
  }

  // Buffer a fragment, flag keyframes, and pass it on.
  private processFragment(data: Buffer): void {
    const keyframe = isKeyframe(data);

    if(keyframe) {
      this.lastKeyframe = Date.now();

      if(this.stalled) {
        this.stalled = false;
        this.log.info("%s: Video from the Doorbird is back.", this.name);
      }
    }

    if(keyframe && this.pendingDiscontinuity) {
      this.pendingDiscontinuity = false;
      this.emit("discontinuity");
    }

    // After a restart, nothing is usable before the first keyframe.
    if(this.pendingDiscontinuity) {
      return;
    }

    this.fragments.push({ data, isKeyframe: keyframe });

    if(this.fragments.length > this.segmentCount) {
      this.fragments.shift();
    }

    this.emit("fragment", data);

    if(this.transmitting) {
      this.emit("segment", data, "live");
    }
  }

  private clearBuffer(): void {
    this.fragments = [];
  }

  // The Doorbird can drop its video while FFmpeg's RTSP connection stays open and the audio keeps flowing: FFmpeg then produces audio-only fragments
  // forever, live views wait for a keyframe that never comes, and HKSV records nothing. Measured once as a connection that went silent for 80
  // minutes. If no keyframe arrives for a while, we end FFmpeg and the restart logic reconnects.
  private armStallWatchdog(process: LivestreamProcess): void {
    this.disarmStallWatchdog();
    this.lastKeyframe = Date.now();

    this.stallTimer = setInterval(() => {
      const silence = Date.now() - this.lastKeyframe;

      if((silence < this.videoStallTimeout) || (this.process !== process)) {
        return;
      }

      if(this.stalled) {
        this.debug("%s: Still no video from the Doorbird after %s seconds, restarting the stream again.", this.name, Math.round(silence / 1000));
      } else {
        this.stalled = true;
        this.log.warn("%s: No video from the Doorbird for %s seconds, restarting the stream.", this.name, Math.round(silence / 1000));
      }

      this.disarmStallWatchdog();
      void process[Symbol.asyncDispose]();
    }, Math.max(Math.floor(this.videoStallTimeout / 3), 50));
  }

  private disarmStallWatchdog(): void {
    if(this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
  }

  // The FFmpeg command line: low-latency inputs, video copied, audio as PCM so consumers encode it exactly once, 100 ms fragments.
  private ffmpegArguments(): string[] {
    return [
      "-hide_banner",
      "-nostats",
      "-fflags", "+discardcorrupt+nobuffer",
      "-err_detect", "ignore_err",
      "-flags", "low_delay",
      "-probesize", "32",
      "-analyzeduration", "0",
      "-rtsp_transport", "tcp",
      // Give up on an RTSP connection that falls silent instead of blocking forever on a dead socket.
      "-timeout", (LIVESTREAM_RTSP_TIMEOUT * 1000).toString(),
      "-i", this.rtspUrl,
      "-fflags", "nobuffer",
      "-flags", "low_delay",
      "-probesize", "32",
      "-analyzeduration", "0",
      "-f", "mulaw",
      "-ar", "8000",
      "-ac", "1",
      "-i", this.audioRelay.url,
      "-map", "0:v:0",
      "-codec:v", "copy",
      "-map", "1:a:0",
      "-codec:a", "pcm_s16le",
      // Do not let the muxer hold video back for long if the audio stalls; the relay pads gaps after 300 ms anyway.
      "-max_interleave_delta", "1000000",
      "-frag_duration", (LIVESTREAM_SEGMENT_LENGTH * 1000).toString(),
      "-movflags", "default_base_moof+empty_moov+frag_keyframe+skip_sidx+skip_trailer",
      "-flush_packets", "1",
      "-reset_timestamps", "1",
      "-f", "mp4",
      "pipe:1"
    ];
  }

  // The init segment (ftyp + moov) every consumer needs first.
  public get initSegment(): Buffer | null {
    return this._initSegment;
  }

  public get isStarted(): boolean {
    return this.running;
  }

  // Ready means a consumer can start right now: we have the init segment and at least one keyframe in the buffer.
  public get isReady(): boolean {
    return (this._initSegment !== null) && this.fragments.some((fragment) => fragment.isKeyframe);
  }

  public get isTransmitting(): boolean {
    return this.transmitting;
  }

  // Milliseconds since the last video keyframe arrived, Infinity if FFmpeg is not producing.
  public get videoAge(): number {
    return (this.process && this._initSegment) ? Date.now() - this.lastKeyframe : Infinity;
  }

  // How much is buffered, in milliseconds.
  public get time(): number {
    return this.fragments.length * LIVESTREAM_SEGMENT_LENGTH;
  }

  public get configuredDuration(): number {
    return this.segmentCount * LIVESTREAM_SEGMENT_LENGTH;
  }

  public get segmentLength(): number {
    return LIVESTREAM_SEGMENT_LENGTH;
  }

  // Wait until the buffer is ready, or give up after the timeout.
  public whenReady(timeout: number): Promise<boolean> {
    if(this.isReady) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      const check = (): void => {
        if(this.isReady) {
          cleanup();
          resolve(true);
        }
      };
      const fail = (): void => {
        cleanup();
        resolve(false);
      };
      const timer = setTimeout(fail, timeout);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.off("fragment", check);
        this.off("stopped", fail);
      };

      this.on("fragment", check);
      this.on("stopped", fail);
    });
  }

  // Init segment plus everything from the most recent keyframe: the quickest clean start for a live view. A keyframe older than maxAgeMs is not
  // worth it: the viewer would stay that far behind live for the whole session, better to wait for the next one.
  public fromLastKeyframe(maxAgeMs = Infinity): Buffer | null {
    if(!this._initSegment) {
      return null;
    }

    for(let i = this.fragments.length - 1; i >= 0; i--) {
      if(this.fragments[i].isKeyframe) {
        if(((this.fragments.length - 1 - i) * LIVESTREAM_SEGMENT_LENGTH) > maxAgeMs) {
          return null;
        }

        return Buffer.concat([ this._initSegment, ...this.fragments.slice(i).map((fragment) => fragment.data) ]);
      }
    }

    return null;
  }

  // Init segment plus the last duration milliseconds.
  public getLast(duration: number): Buffer | null {
    if(!this._initSegment || !this.fragments.length) {
      return null;
    }

    const requested = Math.min(Math.ceil(duration / LIVESTREAM_SEGMENT_LENGTH), this.fragments.length);

    return Buffer.concat([ this._initSegment, ...this.fragments.slice(-requested).map((fragment) => fragment.data) ]);
  }

  // Find the keyframe at or before the start of the prebuffer. The distance to it becomes the recording's seek offset, so the recording still begins
  // exactly prebufferMs before now while the decoder starts on a clean frame.
  public getKeyframeAlignedStart(prebufferMs: number): KeyframeAlignedStart | null {
    const prebufferStartIndex = Math.max(this.fragments.length - Math.ceil(prebufferMs / LIVESTREAM_SEGMENT_LENGTH), 0);

    for(let i = prebufferStartIndex; i >= 0; i--) {
      if(this.fragments[i]?.isKeyframe) {
        return { seekOffsetMs: (prebufferStartIndex - i) * LIVESTREAM_SEGMENT_LENGTH, startIndex: i };
      }
    }

    return null;
  }

  // Start transmitting to the recording consumer: emit the buffered fragments from startIndex as one blob, then live fragments as they come.
  public transmitStart(startIndex?: number): number | null {
    if(!this._initSegment) {
      return null;
    }

    const sliced = ((startIndex !== undefined) && (startIndex > 0) && (startIndex < this.fragments.length)) ? this.fragments.slice(startIndex) : this.fragments;

    this.emit("segment", Buffer.concat([ this._initSegment, ...sliced.map((fragment) => fragment.data) ]), "blob");
    this.transmitting = true;

    return sliced.length;
  }

  public transmitStop(): void {
    this.transmitting = false;
  }
}
