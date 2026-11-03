/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * doorbird-stream.ts: Homebridge camera streaming delegate implementation for Doorbird.
 *
 * This module is heavily inspired by the homebridge and homebridge-camera-ffmpeg source code and
 * borrows heavily from both. Thank you for your contributions to the HomeKit world.
 */
import { DoorbirdAudioProxy, opusFfmpegOutput } from "./doorbird-audio-proxy.js";
import { FfmpegProcess } from "./doorbird-ffmpeg.js";
import { DoorbirdPlatform } from "./doorbird-platform.js";
import { ClientRequest } from "http";
import { DoorbirdStation } from "./doorbird-station.js";
import { DoorbirdTalkback } from "./doorbird-talkback.js";
import { DOORBIRD_TALKBACK_IDLE_TIMEOUT, LIVESTREAM_MAX_START_BACKLOG, LIVESTREAM_READY_TIMEOUT, SNAPSHOT_RETRY_DELAY, STREAM_RETRIES, STREAM_RETRY_DELAY } from "./settings.js";
import { BackpressureWriter, FfmpegOptions, isKeyframe } from "homebridge-plugin-utils";
import { DoorbirdLivestream } from "./doorbird-livestream.js";
import { DoorbirdRecordingDelegate } from "./doorbird-recording.js";
import getPort from "get-port";
// A precompiled ffmpeg binary that meets our requirements, if available.
import pathToFfmpeg from "ffmpeg-for-homebridge";
import {
  API,
  APIEvent,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  CameraController,
  CameraControllerOptions,
  CameraRecordingOptions,
  CameraStreamingDelegate,
  HAP,
  Logging,
  PrepareStreamCallback,
  PrepareStreamRequest,
  PrepareStreamResponse,
  SnapshotRequest,
  SnapshotRequestCallback,
  SRTPCryptoSuites,
  StartStreamRequest,
  StreamingRequest,
  StreamRequestCallback,
  StreamRequestTypes
} from "homebridge";
import { redactUrl } from "./doorbird-util.js";


type SessionInfo = {
  address: string; // Address of the HAP controller.

  videoPort: number;
  videoReturnPort: number;
  videoCryptoSuite: SRTPCryptoSuites; // This should be saved if multiple suites are supported.
  videoSRTP: Buffer; // Key and salt concatenated.
  videoSSRC: number; // RTP synchronisation source.

  audioPort: number;
  audioReturnPort: number;
  audioCryptoSuite: SRTPCryptoSuites;
  audioSRTP: Buffer;
  audioSSRC: number;
};

// What the streaming delegate needs for HomeKit Secure Video. Both are null when the livestream buffer is disabled or FFmpeg could not be queried.
export interface StreamingDelegateOptions {
  ffmpegOptions: FfmpegOptions | null;
  livestream: DoorbirdLivestream | null;
}

// Camera streaming delegate implementation for Doorbird.
export class DoorbirdStreamingDelegate implements CameraStreamingDelegate {
  private readonly api: API;
  private readonly doorbird: DoorbirdStation;
  private debug: (message: string, ...parameters: any[]) => void;
  private readonly hap: HAP;
  private readonly log: Logging;
  readonly name: string;
  needNightVision: boolean;
  readonly platform: DoorbirdPlatform;
  readonly twoWayAudio: boolean;
  readonly videoProcessor: string;
  private readonly interfaceName = "public";
  controller: CameraController;
  public readonly recordingDelegate: DoorbirdRecordingDelegate | null = null;

  // Keep track of streaming sessions.
  pendingSessions: Record<string, SessionInfo> = {};
  ongoingSessions: Record<string, FfmpegProcess> = {};
  audioSessions: Record<string, DoorbirdAudioProxy> = {};
  private launches: Record<string, { attempts: number, command: string, videoReturnPort: number }> = {};
  private bufferSessions: Record<string, { livestream: DoorbirdLivestream, onFragment: (data: Buffer) => void, onRestart: () => void, writer: BackpressureWriter }> = {};

  constructor(doorbird: DoorbirdStation, twoWayAudio = false, streamingOptions: StreamingDelegateOptions = { ffmpegOptions: null, livestream: null }) {
    this.api = doorbird.api;
    this.doorbird = doorbird;
    this.debug = doorbird.debug.bind(doorbird.platform);
    this.hap = doorbird.api.hap;
    this.log = doorbird.platform.log;
    this.name = doorbird.name;
    this.needNightVision = false;
    this.platform = doorbird.platform;
    this.twoWayAudio = twoWayAudio;
    this.videoProcessor = DoorbirdStreamingDelegate.videoProcessor(doorbird.platform);

    this.api.on(APIEvent.SHUTDOWN, () => {
      for(const session of new Set([ ...Object.keys(this.ongoingSessions), ...Object.keys(this.audioSessions) ])) {
        this.stopStream(session);
      }
    });

    // Setup for our camera controller.
    const options: CameraControllerOptions = {
      cameraStreamCount: 2, // HomeKit requires at least 2 streams, and HomeKit Secure Video requires 1.
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [this.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: [
            // Width, height, framerate.
            [1920, 1080, 30],
            [1280, 960, 30],
            [1280, 720, 30],
            [1024, 768, 30],
            [640, 480, 30],
            [640, 360, 30],
            [480, 360, 30],
            [480, 270, 30],
            [320, 240, 30],
            [320, 240, 15],   // Apple Watch requires this configuration
            [320, 180, 30]
          ],
          codec: {
            profiles: [this.hap.H264Profile.BASELINE, this.hap.H264Profile.MAIN, this.hap.H264Profile.HIGH],
            levels: [this.hap.H264Level.LEVEL3_1, this.hap.H264Level.LEVEL3_2, this.hap.H264Level.LEVEL4_0]
          }
        },
        audio: {
          // Opus, like Home Assistant's HomeKit Bridge. With AAC-ELD, iOS played the audio distorted and the video lagged.
          codecs: [
            {
              type: AudioStreamingCodecType.OPUS,
              samplerate: AudioStreamingSamplerate.KHZ_24
            },
            {
              type: AudioStreamingCodecType.OPUS,
              samplerate: AudioStreamingSamplerate.KHZ_16
            }
          ],
          // Two-way audio adds the speaker service, which gives us the Talk button in the Home app.
          twoWayAudio: twoWayAudio
        }
      }
    };

    // HomeKit Secure Video records from the livestream buffer, so we need it and a working FFmpeg.
    const { ffmpegOptions, livestream } = streamingOptions;

    if(this.doorbird.options.includes("VIDEO.HKSV.DISABLE")) {
      this.log.info("%s: HomeKit Secure Video disabled.", this.name);
    } else if(!ffmpegOptions || !livestream) {
      this.log.info("%s: HomeKit Secure Video disabled. It requires the livestream buffer.", this.name);
    } else {
      this.recordingDelegate = new DoorbirdRecordingDelegate({
        accessory: doorbird.accessory,
        audioSupport: ffmpegOptions.config.codecSupport.hasEncoder("aac", "libfdk_aac"),
        debug: this.debug,
        ffmpegOptions,
        fps: 15,
        hap: this.hap,
        livestream,
        log: this.log,
        name: this.name,
        verbose: this.platform.debugMode
      });

      const recordingOptions: CameraRecordingOptions = {
        audio: {
          codecs: [
            {
              audioChannels: 1,
              bitrateMode: this.hap.AudioBitrate.VARIABLE,
              samplerate: [this.hap.AudioRecordingSamplerate.KHZ_16],
              type: this.hap.AudioRecordingCodecType.AAC_LC
            }
          ]
        },
        mediaContainerConfiguration: [
          {
            fragmentLength: 4000,
            type: this.hap.MediaContainerType.FRAGMENTED_MP4
          }
        ],
        overrideEventTriggerOptions: [this.hap.EventTriggerOption.MOTION, this.hap.EventTriggerOption.DOORBELL],
        prebufferLength: 4000,
        video: {
          parameters: {
            levels: [this.hap.H264Level.LEVEL3_1, this.hap.H264Level.LEVEL3_2, this.hap.H264Level.LEVEL4_0],
            profiles: [this.hap.H264Profile.BASELINE, this.hap.H264Profile.MAIN, this.hap.H264Profile.HIGH]
          },
          resolutions: [
            // Width, height, framerate.
            [1280, 720, 15],
            [640, 360, 15],
            [320, 180, 15]
          ],
          type: this.hap.VideoCodecType.H264
        }
      };

      // HomeKit records on motion, so the controller needs our motion sensor. The station creates it before the camera.
      options.recording = { delegate: this.recordingDelegate, options: recordingOptions };
      options.sensors = { motion: doorbird.accessory.getService(this.hap.Service.MotionSensor) ?? true };

      this.log.info("%s: HomeKit Secure Video available.", this.name);
    }

    this.controller = new this.hap.CameraController(options);

    if(this.recordingDelegate) {
      this.recordingDelegate.controller = this.controller;
    }
  }

  // The FFmpeg binary we use: the user's choice, our bundled version from ffmpeg-for-homebridge, or whatever is in the path.
  static videoProcessor(platform: DoorbirdPlatform): string {
    return platform.config.videoProcessor || (pathToFfmpeg as string | undefined) || "ffmpeg";
  }

  // HomeKit image snapshot request handler.
  async handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): Promise<void> {
    this.debug("%s: HomeKit snapshot request: %sx%s. Retrieving image from Doorbird: %s", this.name, request.width, request.height,
      redactUrl(this.doorbird.snapshotUrl));

    // Should we use night vision?
    if(this.doorbird.config.nightVisionSnapshot || (this.doorbird.config.nightVisionSnapshotNight && this.platform.isNight())) {
      await this.doorbird.activateNightVision();
    }

    let response = await this.doorbird.dbApi.fetch(this.doorbird.snapshotUrl);

    // The Doorbird briefly refuses snapshots while it handles its own events (ring, motion). Try once more before giving up.
    if(!response || !response.ok) {
      await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_RETRY_DELAY));
      response = await this.doorbird.dbApi.fetch(this.doorbird.snapshotUrl);
    }

    if(!response || !response.ok) {
      this.log("%s: Unable to retrieve snapshot.", this.name);
      callback(new Error(this.name + ": Unable to retrieve snapshot."));
      return;
    }

    try {
      const buffer = await response.buffer();
      callback(undefined, buffer);
    } catch(error) {
      // The error text from node-fetch contains the snapshot URL with the credentials. HAP may log what we hand back, so mask it there as well.
      const message = redactUrl((error instanceof Error) ? error.message : String(error));

      this.log.error("%s: An error occurred while making a snapshot request: %s.", this.name, message);
      callback(new Error(message));
    }
  }

  // Prepare to launch the video stream.
  async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {
    const videoReturnPort = await getPort();
    const videoSSRC = this.hap.CameraController.generateSynchronisationSource();
    const audioReturnPort = await getPort();
    const audioSSRC = this.hap.CameraController.generateSynchronisationSource();

    const sessionInfo: SessionInfo = {
      address: request.targetAddress,

      videoPort: request.video.port,
      videoReturnPort: videoReturnPort,
      videoCryptoSuite: request.video.srtpCryptoSuite,
      videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
      videoSSRC: videoSSRC,

      audioPort: request.audio.port,
      audioReturnPort: audioReturnPort,
      audioCryptoSuite: request.audio.srtpCryptoSuite,
      audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
      audioSSRC: audioSSRC
    };

    const response: PrepareStreamResponse = {
      video: {
        port: videoReturnPort,
        ssrc: videoSSRC,

        srtp_key: request.video.srtp_key,
        srtp_salt: request.video.srtp_salt
      },

      audio: {
        port: audioReturnPort,
        ssrc: audioSSRC,

        srtp_key: request.audio.srtp_key,
        srtp_salt: request.audio.srtp_salt
      }
    };

    // Add it to the pending session queue so we're ready to start when we're called upon.
    this.pendingSessions[request.sessionID] = sessionInfo;

    // Should we use night vision?
    if(this.doorbird.config.nightVisionVideo || (this.doorbird.config.nightVisionVideoNight && this.platform.isNight())) {
      await this.doorbird.activateNightVision();
      this.needNightVision = true;
    }

    callback(undefined, response);
  }

  // Launch the Doorbird video stream.
  private async startStream(request: StartStreamRequest, callback: StreamRequestCallback): Promise<void> {
    const sessionInfo = this.pendingSessions[request.sessionID];

    // Set our packet size to be 188 * 5 = 940.
    // We do this primarily for speed and interactivity at the expense of some minor additional overhead. In
    // testing, this produces the best combination of instantaneous response with the right level of quality.
    const videomtu = 188 * 5;

    // Validate that we have a version of FFmpeg that supports libopus for audio support.
    let audioProxy: DoorbirdAudioProxy | null = null;

    if((request.audio.codec === AudioStreamingCodecType.OPUS) && await FfmpegProcess.codecEnabled(this.videoProcessor, "libopus")) {

      // FFmpeg sends the audio to our proxy, so the proxy has to be up and running before we can assemble the command line.
      audioProxy = await this.startAudioProxy(request, sessionInfo);
    }

    // The stream was stopped while we were getting ready.
    if(this.pendingSessions[request.sessionID] !== sessionInfo) {
      audioProxy?.close();
      callback(new Error(this.name + ": The stream was stopped before it started."));
      return;
    }

    // The proxy lives as long as the stream, stopStream tears it down.
    if(audioProxy) {
      this.audioSessions[request.sessionID] = audioProxy;
    }

    // Prefer the livestream buffer: it already holds the Doorbird's video and audio, so the view starts from the last keyframe right away,
    // even while the Doorbird is busy with a ring, and the Doorbird's single audio channel stays with the buffer.
    const livestream = this.doorbird.livestream;
    let useBuffer = false;

    if(livestream) {
      livestream.acquire("live:" + request.sessionID);
      useBuffer = await livestream.whenReady(LIVESTREAM_READY_TIMEOUT);

      // The stream was stopped while we were waiting.
      if(this.pendingSessions[request.sessionID] !== sessionInfo) {
        livestream.release("live:" + request.sessionID);
        callback(new Error(this.name + ": The stream was stopped before it started."));
        return;
      }

      if(!useBuffer) {
        this.log.warn("%s: The livestream buffer is not ready, streaming directly from the Doorbird.", this.name);
        livestream.release("live:" + request.sessionID);
      }
    }

    // Low-latency input options: without them FFmpeg analyzes the inputs for several seconds, then flushes the backlog in a burst. The
    // iPhone plays video sequentially from that burst and stays 2-3 s behind for the whole session (measured: first packet after 6.4 s
    // and a 3 s backlog, versus 1.3 s and no backlog with these options).
    const lowLatency = "-fflags nobuffer -flags low_delay -probesize 32 -analyzeduration 0";
    let fcmd: string;

    if(useBuffer) {
      // Fragmented MP4 from the buffer on standard input: video to copy, PCM audio to encode.
      fcmd = lowLatency + " -f mp4 -i pipe:0";
    } else {
      fcmd = lowLatency + " -rtsp_transport tcp -i " + this.doorbird.cameraUrl;

      // Grab the audio URL and add it to the input pipeline.
      if(audioProxy) {
        fcmd += " " + lowLatency + " -f mulaw -ar 8000 -ac 1 -i " + this.doorbird.audioUrl;
      }
    }

    this.log("%s: HomeKit video stream requested: %sx%s, %s fps, %s kbps.",
      this.name, request.video.width, request.video.height, request.video.fps, request.video.max_bit_rate);

    // Configure our video parameters.
    const ffmpegVideoArgs =
      " -map 0:v:0" +
      // The DoorBird already delivers H.264 that HomeKit plays back directly. Re-encoding added 1-2 s of latency and, because the DoorBird
      // delivers ~20 fps while announcing 30, two thirds of the frames were duplicates. Passing the stream through is what Home Assistant does.
      " -vcodec copy" +
      " -payload_type " + request.video.pt;

    // Add the required RTP settings and encryption for the stream.
    const ffmpegVideoStream =
      " -ssrc " + sessionInfo.videoSSRC +
      " -f rtp" +
      " -srtp_out_suite AES_CM_128_HMAC_SHA1_80" +
      " -srtp_out_params " + sessionInfo.videoSRTP.toString("base64") +
      " srtp://" + sessionInfo.address + ":" + sessionInfo.videoPort +
      "?rtcpport=" + sessionInfo.videoPort +"&localrtcpport=" + sessionInfo.videoPort + "&pkt_size=" + videomtu;

    // Assemble the final video command line.
    fcmd += ffmpegVideoArgs;
    fcmd += ffmpegVideoStream;

    // Configure the audio portion of the command line, but only if our version of FFmpeg supports libopus. FFmpeg encodes Opus and sends it as plain
    // RTP to our audio proxy, which rewrites the timestamps to the negotiated clock and encrypts the stream for HomeKit.
    if(audioProxy) {
      fcmd += (useBuffer ? " -map 0:a:0 " : " -map 1:a:0 ") + opusFfmpegOutput({
        bitrate: request.audio.max_bit_rate,
        packetTime: request.audio.packet_time,
        payloadType: request.audio.pt,
        port: audioProxy.ffmpegPort,
        sampleRate: request.audio.sample_rate,
        ssrc: sessionInfo.audioSSRC
      });
    }

    // Additional logging, but only if we're debugging.
    if(this.platform.debugMode) {
      fcmd += " -loglevel debug"; // " -loglevel level+verbose";
    }

    // Remember how we launched this session so we can retry if the Doorbird is busy. Sessions fed from the buffer need no retries.
    if(!useBuffer) {
      this.launches[request.sessionID] = { attempts: 0, command: fcmd, videoReturnPort: sessionInfo.videoReturnPort };
    }

    // Combine everything and start an instance of FFmpeg.
    const ffmpeg = new FfmpegProcess(this, request.sessionID, fcmd, sessionInfo.videoReturnPort, callback);

    // Some housekeeping for our FFmpeg sessions.
    this.ongoingSessions[request.sessionID] = ffmpeg;
    delete this.pendingSessions[request.sessionID];

    if(useBuffer && livestream) {
      this.feedFromBuffer(request.sessionID, ffmpeg, livestream);
    }
  }

  // Feed a live session from the livestream buffer: the init segment and everything since the last keyframe first, then each fragment as it arrives.
  // If the last keyframe is too old to start from without lagging behind live, we wait for the next one instead.
  private feedFromBuffer(sessionId: string, ffmpeg: FfmpegProcess, livestream: DoorbirdLivestream): void {
    const writer = new BackpressureWriter(() => ffmpeg.stdin);
    const head = livestream.fromLastKeyframe(LIVESTREAM_MAX_START_BACKLOG);
    let started = false;

    if(head) {
      started = true;
      writer.write(head).catch(() => { /* FFmpeg is gone, the exit handler ends the session. */ });
    } else {
      this.debug("%s: Waiting for the next keyframe to start the live view.", this.name);
    }

    const onFragment = (data: Buffer): void => {
      if(!started) {
        if(!isKeyframe(data) || !livestream.initSegment) {
          return;
        }

        started = true;
        writer.write(livestream.initSegment).catch(() => { /* FFmpeg is gone, the exit handler ends the session. */ });
      }

      writer.write(data).catch(() => { /* FFmpeg is gone, the exit handler ends the session. */ });
    };

    // The buffer's FFmpeg died: its timeline ends here, so does this session. HomeKit reconnects on its own if the user is still watching.
    const onRestart = (): void => {
      this.log.info("%s: The livestream buffer restarted, ending the live view.", this.name);
      this.controller.forceStopStreamingSession(sessionId);
      this.stopStream(sessionId);
    };

    livestream.on("fragment", onFragment);
    livestream.once("restarting", onRestart);
    this.bufferSessions[sessionId] = { livestream, onFragment, onRestart, writer };
  }

  // Start the audio proxy for a streaming session: it encrypts our audio for HomeKit, and relays the return audio to the Doorbird if two-way audio is
  // enabled. Without the proxy, we stream video only.
  private async startAudioProxy(request: StartStreamRequest, sessionInfo: SessionInfo): Promise<DoorbirdAudioProxy | null> {
    let talkback: DoorbirdTalkback | null = null;

    if(this.twoWayAudio) {
      const idleSeconds = Number(this.doorbird.config.talkbackIdleSeconds);

      talkback = new DoorbirdTalkback({
        debug: this.debug,
        // FFmpeg gives up on an RTP input after 10 seconds without packets, so we stay below that.
        idleSeconds: (Number.isFinite(idleSeconds) && (idleSeconds > 0)) ? Math.min(idleSeconds, 10) : DOORBIRD_TALKBACK_IDLE_TIMEOUT,
        log: this.log,
        name: this.name,
        openTransmit: (): ClientRequest => this.doorbird.dbApi.audioTransmitRequest(),
        payloadType: request.audio.pt,
        videoProcessor: this.videoProcessor
      });
    }

    try {
      return await DoorbirdAudioProxy.open({
        address: sessionInfo.address,
        audioPort: sessionInfo.audioPort,
        debug: this.debug,
        log: this.log,
        name: this.name,
        payloadType: request.audio.pt,
        returnPort: sessionInfo.audioReturnPort,
        sampleRate: request.audio.sample_rate * 1000,
        srtp: sessionInfo.audioSRTP,
        talkback: talkback
      });
    } catch(error) {
      talkback?.close();
      this.log.error("%s: Audio is unavailable for this session: %s", this.name, redactUrl(error instanceof Error ? error.message : String(error)));
      return null;
    }
  }

  // Process incoming stream requests.
  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {

    switch(request.type) {
      case StreamRequestTypes.START:
        // Node 22 terminates the process on unhandled promise rejections, so make sure a failure here (e.g. FFmpeg not found) is handled.
        this.startStream(request, callback).catch((error: unknown) => {
          const message = redactUrl((error instanceof Error) ? error.message : String(error));

          this.log.error("%s: Unable to start the video stream: %s", this.name, message);
          callback(new Error(message));
        });
        break;

      case StreamRequestTypes.RECONFIGURE:
        // Once ffmpeg is updated to support this, we'll enable this one.
        this.debug("%s: Ignoring request to reconfigure: %sx%s, %s fps, %s kbps.",
          this.name, request.video.width, request.video.height, request.video.fps, request.video.max_bit_rate);
        callback();
        break;

      case StreamRequestTypes.STOP:
      default:
        this.stopStream(request.sessionID);
        callback();
        break;
    }
  }

  // Close a video stream.
  // Retry a stream whose FFmpeg exited before it produced anything. The Doorbird has few concurrent stream slots and refuses new
  // streams while it handles a ring or motion event itself, which otherwise leaves HomeKit without video for 10-20 seconds.
  public retryStream(sessionId: string, callback: StreamRequestCallback): boolean {
    const launch = this.launches[sessionId];

    if(!launch || !this.ongoingSessions[sessionId] || (launch.attempts >= STREAM_RETRIES)) {
      return false;
    }

    launch.attempts++;
    this.log.info("%s: Retrying the video stream in %s ms (attempt %s of %s).", this.name, STREAM_RETRY_DELAY, launch.attempts, STREAM_RETRIES);

    setTimeout(() => {

      // The session was stopped in the meantime.
      if(!this.ongoingSessions[sessionId] || (this.launches[sessionId] !== launch)) {
        return;
      }

      this.ongoingSessions[sessionId] = new FfmpegProcess(this, sessionId, launch.command, launch.videoReturnPort, callback);
    }, STREAM_RETRY_DELAY);

    return true;
  }

  public stopStream(sessionId: string): void {
    try {
      delete this.pendingSessions[sessionId];
      delete this.launches[sessionId];

      const bufferSession = this.bufferSessions[sessionId];

      if(bufferSession) {
        bufferSession.livestream.off("fragment", bufferSession.onFragment);
        bufferSession.livestream.off("restarting", bufferSession.onRestart);
        bufferSession.writer.abort();
        bufferSession.livestream.release("live:" + sessionId);
        delete this.bufferSessions[sessionId];
      }

      if(this.audioSessions[sessionId]) {
        this.audioSessions[sessionId].close();
        delete this.audioSessions[sessionId];
      }

      if (this.ongoingSessions[sessionId]) {
        const ffmpegProcess = this.ongoingSessions[sessionId];
        if(ffmpegProcess) {
          ffmpegProcess.stop();
        }
      }
      delete this.ongoingSessions[sessionId];
      this.log.info("%s: Stopped video stream.", this.name);
    } catch(error) {
      this.log.error("%s: Error occurred terminating video process: %s", this.name, redactUrl(String(error)));
    } finally {
      this.needNightVision = false;
    }
  }
}
