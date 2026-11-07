/* Copyright(C) 2026, Andreas Kurtz. All rights reserved.
 *
 * doorbird-recording.ts: HomeKit Secure Video recording delegate for Doorbird.
 *
 * The flow follows the recording delegate in homebridge-unifi-protect (Copyright(C) 2017-2026, HJD, ISC license, see "Third-party code" in README.md): when HomeKit asks for a recording,
 * we hand the livestream buffer's fragments from the keyframe before the prebuffer start into an FFmpeg that transcodes them into the fragmented MP4
 * HomeKit requested, and yield its init segment and 4 s fragments, paced so HomeKit's 5 s timer never runs out.
 */
import { BackpressureWriter, FfmpegOptions, FfmpegRecordingProcess, HKSV_TIMEOUT } from "homebridge-plugin-utils";
import { CameraController, CameraRecordingConfiguration, CameraRecordingDelegate, HAP, HDSProtocolSpecificErrorReason, Logging, PlatformAccessory, RecordingPacket }
  from "homebridge";
import { DoorbirdLivestream, SegmentRole } from "./doorbird-livestream.js";
import { RECORDING_EARLY_END_WARNING, RECORDING_VIDEO_AGE_WARNING } from "./settings.js";
import { redactUrl } from "./doorbird-util.js";

// A single zero byte with isLast tells HomeKit there is nothing to record.
const END_OF_STREAM = Buffer.alloc(1, 0);

// FFmpeg output lines that look like an error rather than a description of its streams.
const FFMPEG_ERROR_LINE = /error|invalid|fail|no frame|corrupt/i;

export interface RecordingDelegateOptions {
  accessory: PlatformAccessory;
  audioSupport: boolean;
  debug: (message: string, ...parameters: unknown[]) => void;
  ffmpegOptions: FfmpegOptions;
  fps: number;
  hap: HAP;
  livestream: DoorbirdLivestream;
  log: Logging;
  name: string;
  verbose: boolean;
}

export class DoorbirdRecordingDelegate implements CameraRecordingDelegate {
  private readonly accessory: PlatformAccessory;
  private readonly audioSupport: boolean;
  private config?: CameraRecordingConfiguration;
  public controller?: CameraController;
  private readonly debug: (message: string, ...parameters: unknown[]) => void;
  private eventId = 0;
  private readonly ffmpegOptions: FfmpegOptions;
  private readonly fps: number;
  private readonly hap: HAP;
  private readonly livestream: DoorbirdLivestream;
  private readonly log: Logging;
  private readonly name: string;
  private process?: FfmpegRecordingProcess;
  private recordingActive = false;
  private segmentListener?: (data: Buffer, role: SegmentRole) => void;
  private session = { declined: false, endedByUs: false, id: 0, segmentsIn: 0, segmentsOut: 0, started: 0 };
  private earlyEnds = 0;
  private transmitting = false;
  private readonly verbose: boolean;
  private writer?: BackpressureWriter;

  constructor(options: RecordingDelegateOptions) {
    this.accessory = options.accessory;
    this.audioSupport = options.audioSupport;
    this.debug = options.debug;
    this.ffmpegOptions = options.ffmpegOptions;
    this.fps = options.fps;
    this.hap = options.hap;
    this.livestream = options.livestream;
    this.log = options.log;
    this.name = options.name;
    this.verbose = options.verbose;
  }

  // HomeKit turns recording on or off (also with the Home/Away modes). The buffer runs for as long as recording is on.
  public updateRecordingActive(active: boolean): void {
    if(active === this.recordingActive) {
      return;
    }

    this.recordingActive = active;

    if(active) {
      this.log.info("%s: HomeKit Secure Video recording enabled.", this.name);
      this.livestream.acquire("hksv");
      return;
    }

    this.log.info("%s: HomeKit Secure Video recording disabled.", this.name);
    this.stopTransmitting();
    this.livestream.release("hksv");
    this.accessory.getService(this.hap.Service.MotionSensor)?.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);
  }

  // HomeKit tells us what it wants recorded: resolution, bitrate, audio codec, prebuffer and fragment length.
  public updateRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined): void {
    this.config = configuration;

    if(configuration) {
      this.log.info("%s: HKSV configuration: %sx%s at %s fps, %s kbps, prebuffer %s ms, fragments %s ms, audio %s.", this.name,
        configuration.videoCodec.resolution[0], configuration.videoCodec.resolution[1], configuration.videoCodec.resolution[2],
        configuration.videoCodec.parameters.bitRate, configuration.prebufferLength, configuration.mediaContainerConfiguration.fragmentLength,
        configuration.audioCodec.type === this.hap.AudioRecordingCodecType.AAC_LC ? "AAC-LC" : "AAC-ELD");
    }
  }

  // A recording event: HomeKit saw motion and wants video from prebufferLength ago until it closes the stream.
  public async *handleRecordingStreamRequest(streamId: number, signal?: AbortSignal): AsyncGenerator<RecordingPacket> {
    this.session = { declined: false, endedByUs: false, id: ++this.eventId, segmentsIn: 0, segmentsOut: 0, started: Date.now() };

    let lastYield = this.session.started;

    // We need the whole buffer: the keyframe before the prebuffer start can be up to one Doorbird keyframe interval (3 s at night) further back.
    const declineReason = !this.recordingActive ? "recording is not active" : !this.config ? "HomeKit has not selected a recording configuration" :
      !this.livestream.isReady ? "the livestream buffer is not ready" :
        (this.livestream.time < this.livestream.configuredDuration) ? "the livestream buffer is still filling" : null;

    if(declineReason || !this.startTransmitting()) {
      this.stopTransmitting();
      this.session.declined = true;
      this.log.warn("%s: Declining HKSV recording event: %s.", this.name, declineReason ?? "FFmpeg could not be started");
      yield { data: END_OF_STREAM, isLast: true };
      return;
    }

    this.log.info("%s: HKSV recording event started.", this.name);

    const pacingInterval = HKSV_TIMEOUT - 500;
    let abort = new AbortController();
    let discontinuity = false;
    let terminated = false;

    const onDiscontinuity = (): void => {
      this.debug("%s: Livestream discontinuity during HKSV event %s, restarting FFmpeg.", this.name, this.session.id);
      discontinuity = true;
      this.process?.abort();
      abort.abort();
    };
    const onTerminated = (): void => {
      this.debug("%s: Livestream ended during HKSV event %s.", this.name, this.session.id);
      terminated = true;
      this.process?.abort();
      abort.abort();
    };

    this.livestream.on("discontinuity", onDiscontinuity);
    this.livestream.on("terminated", onTerminated);

    try {
      do {
        if(discontinuity) {
          discontinuity = false;
          abort = new AbortController();
          this.livestream.transmitStop();

          if(!this.startTransmitting(true)) {
            terminated = true;
            break;
          }
        }

        const process = this.process;

        if(!process) {
          break;
        }

        const combined = signal ? AbortSignal.any([ signal, abort.signal ]) : abort.signal;

        for await (const segment of process.stream({ signal: combined })) {
          if(!this.transmitting || discontinuity || terminated) {
            break;
          }

          if(segment.kind === "media") {
            this.session.segmentsOut++;
          }

          // HomeKit resets its 5 s timer with every fragment. Hand them over at a steady 4 s pace so FFmpeg's output queues up as a reserve.
          const delay = (lastYield + pacingInterval) - Date.now();

          if(delay > 0) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, delay);

              combined.addEventListener("abort", () => {
                clearTimeout(timer);
                resolve();
              }, { once: true });
            });
          }

          if(!this.transmitting || signal?.aborted) {
            break;
          }

          yield { data: segment.bytes, isLast: false };
          lastYield = Date.now();
        }
      } while(discontinuity && !terminated && this.transmitting);
    } finally {
      this.livestream.off("discontinuity", onDiscontinuity);
      this.livestream.off("terminated", onTerminated);

      // HomeKit aborts the signal before it tells us why it closed the stream. A stream that ends without that came to an end on our side: FFmpeg
      // exited or the buffer went away.
      if(!signal?.aborted) {
        this.session.endedByUs = true;
      }
    }

    if(terminated || this.process?.isTimedOut) {
      yield { data: END_OF_STREAM, isLast: true };
    }
  }

  public acknowledgeStream(): void {
    this.stopTransmitting();
  }

  public closeRecordingStream(streamId: number, reason: HDSProtocolSpecificErrorReason | undefined): void {
    this.stopTransmitting(reason);
  }

  // Start FFmpeg on the buffer: the fragments from the keyframe before the prebuffer start, then live fragments as they come.
  private startTransmitting(isRestart = false): boolean {
    this.teardownProcess();

    if(!this.config || !this.livestream.initSegment) {
      return false;
    }

    const alignment = this.livestream.getKeyframeAlignedStart(this.config.prebufferLength);

    if(!alignment && !isRestart) {
      this.debug("%s: No keyframe in the buffer before the prebuffer start.", this.name);
    }

    this.process = new FfmpegRecordingProcess(this.ffmpegOptions, {
      recording: {
        audioStream: 0,
        codec: "h264",
        enableAudio: this.isAudioActive,
        fps: this.fps,
        timeshift: alignment?.seekOffsetMs ?? Math.max(this.livestream.time - this.config.prebufferLength, 0),
        transcodeAudio: true,
        // The Doorbird's frame rate follows the light (8 to 20 fps) and the encoder's keyframe interval is counted in frames. Force the frame rate
        // HomeKit selected so a keyframe, and with it a fragment, comes every four seconds. Without this, recordings time out at night.
        videoFilters: [ "fps=" + this.config.videoCodec.resolution[2].toString() ]
      },
      recordingConfig: this.config,
      verbose: this.verbose
    });

    this.transmitting = true;
    this.writer = new BackpressureWriter(() => this.process?.stdin ?? null);
    this.segmentListener = (data: Buffer): void => {
      this.session.segmentsIn++;
      this.writer?.write(data).catch(() => { /* FFmpeg is gone; the stream loop ends. */ });
    };
    this.livestream.on("segment", this.segmentListener);

    const fragments = this.livestream.transmitStart(alignment?.startIndex);

    if(fragments === null) {
      this.teardownProcess();
      this.transmitting = false;
      return false;
    }

    this.debug("%s: HKSV event %s: recording from %s buffered fragments (seek %s ms).", this.name, this.session.id, fragments, alignment?.seekOffsetMs ?? 0);

    return true;
  }

  private teardownProcess(): void {
    if(this.segmentListener) {
      this.livestream.off("segment", this.segmentListener);
      this.segmentListener = undefined;
    }

    this.writer?.abort();
    this.writer = undefined;
    this.process?.abort();
    this.process = undefined;
  }

  // Stop transmitting. HomeKit may close a stream more than once, so this must be safe to repeat.
  private stopTransmitting(reason?: HDSProtocolSpecificErrorReason): void {
    if(!this.transmitting) {
      return;
    }

    const timedOut = this.process?.isTimedOut ?? false;
    const stderr = this.process?.stderrLog ?? [];

    this.livestream.transmitStop();
    this.teardownProcess();
    this.transmitting = false;

    if(this.session.declined) {
      return;
    }

    const seconds = (this.session.segmentsIn * this.livestream.segmentLength) / 1000;

    if(reason === this.hap.HDSProtocolSpecificErrorReason.NORMAL) {
      this.earlyEnds = 0;
      this.log.info("%s: HKSV: recorded %s seconds for HomeKit.", this.name, Math.round(seconds));
      return;
    }

    if((reason === undefined) || ((Date.now() - this.session.started) < 100)) {
      return;
    }

    this.earlyEnds++;

    const descriptions: Record<number, string> = {
      [this.hap.HDSProtocolSpecificErrorReason.BUSY]: "the home hub was busy.",
      [this.hap.HDSProtocolSpecificErrorReason.CANCELLED]: "HomeKit cancelled the request.",
      [this.hap.HDSProtocolSpecificErrorReason.TIMEOUT]: "the request timed out.",
      [this.hap.HDSProtocolSpecificErrorReason.UNEXPECTED_FAILURE]: "the request was slow to respond."
    };

    // HomeKit ended the session itself when it closed with one of these reasons while we were still delivering fragments. It usually re-requests right
    // away, and the Doorbird's video is not to blame. We failed to deliver when FFmpeg exited or timed out, or when not a single fragment went out.
    const homeKitReasons: number[] = [ this.hap.HDSProtocolSpecificErrorReason.BUSY, this.hap.HDSProtocolSpecificErrorReason.CANCELLED,
      this.hap.HDSProtocolSpecificErrorReason.TIMEOUT, this.hap.HDSProtocolSpecificErrorReason.UNEXPECTED_FAILURE ];
    const endedByHomeKit = homeKitReasons.includes(reason) && !this.session.endedByUs && !timedOut && (this.session.segmentsOut > 0);

    // An occasional early end is normal. A run of them gets a hint at the cause instead of repeating that it can be ignored: a buffer without video,
    // the home hub when HomeKit ended the sessions, our recording FFmpeg falling behind the buffer (it timed out, typically while the Doorbird handles
    // a ring and the buffer's video is fine), or FFmpeg exiting.
    const videoAge = this.livestream.videoAge;
    const repeated = "That is " + this.earlyEnds.toString() + " early ends in a row";
    const hint = (videoAge > RECORDING_VIDEO_AGE_WARNING) ?
      " The buffer has had no video from the Doorbird for " + (Number.isFinite(videoAge) ? Math.round(videoAge / 1000).toString() + " seconds." : "a while.") :
      (this.earlyEnds < RECORDING_EARLY_END_WARNING) ? " This happens occasionally and can be ignored." :
        endedByHomeKit ? " " + repeated + " from HomeKit. If it keeps happening, check the home hub's network connection." :
          timedOut ? " " + repeated + ": the recording fell behind the Doorbird's video, which often happens while the Doorbird handles a ring. HomeKit " +
            "retries on its own." :
            " " + repeated + ", FFmpeg stopped delivering video.";

    this.log.warn("%s: HKSV recording event ended early after %s seconds: %s%s", this.name, Math.round(seconds),
      descriptions[reason] ?? ("reason " + reason.toString() + "."), hint);

    // After a timeout, FFmpeg's last lines are usually just the description of its output stream (encoder, handler_name, side data). Only lines that
    // look like an error are worth a warning.
    if(timedOut || this.verbose) {
      for(const line of stderr.slice(-5)) {
        if(FFMPEG_ERROR_LINE.test(line)) {
          this.log.warn("%s: ffmpeg: %s", this.name, redactUrl(line));
        } else {
          this.debug("%s: ffmpeg: %s", this.name, redactUrl(line));
        }
      }
    }
  }

  // HomeKit lets the user switch recording audio off separately.
  private get isAudioActive(): boolean {
    return this.audioSupport &&
      (this.controller?.recordingManagement?.recordingManagementService.getCharacteristic(this.hap.Characteristic.RecordingAudioActive).value === 1);
  }

  public get isRecording(): boolean {
    return this.recordingActive;
  }
}
