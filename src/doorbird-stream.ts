/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * doorbird-stream.ts: Homebridge camera streaming delegate implementation for Doorbird.
 *
 * This module is heavily inspired by the homebridge and homebridge-camera-ffmpeg source code and
 * borrows heavily from both. Thank you for your contributions to the HomeKit world.
 */
import { FfmpegProcess } from "./doorbird-ffmpeg";
import { DoorbirdPlatform } from "./doorbird-platform";
import { DoorbirdStation } from "./doorbird-station";
import getPort from "get-port";
import {
  API,
  APIEvent,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  CameraController,
  CameraControllerOptions,
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

// Bring in a precompiled ffmpeg binary that meets our requirements, if available.
const pathToFfmpeg = require("ffmpeg-for-homebridge"); // eslint-disable-line @typescript-eslint/no-var-requires

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
  readonly videoProcessor: string;
  private readonly interfaceName = "public";
  controller: CameraController;

  // Keep track of streaming sessions.
  pendingSessions: Record<string, SessionInfo> = {};
  ongoingSessions: Record<string, FfmpegProcess> = {};

  constructor(doorbird: DoorbirdStation) {
    this.api = doorbird.api;
    this.doorbird = doorbird;
    this.debug = doorbird.debug.bind(doorbird.platform);
    this.hap = doorbird.api.hap;
    this.log = doorbird.platform.log;
    this.name = doorbird.name;
    this.needNightVision = false;
    this.platform = doorbird.platform;
    this.videoProcessor = doorbird.platform.config.videoProcessor || pathToFfmpeg || "ffmpeg";

    this.api.on(APIEvent.SHUTDOWN, () => {
      for(const session in this.ongoingSessions) {
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
          codecs: [
            {
              type: AudioStreamingCodecType.AAC_ELD,
              samplerate: AudioStreamingSamplerate.KHZ_16
            }
          ]
        }
      }
    };
    this.controller = new this.hap.CameraController(options);
  }

  // HomeKit image snapshot request handler.
  async handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): Promise<void> {
    this.debug("%s: HomeKit snapshot request: %sx%s. Retrieving image from Doorbird: %s", this.name, request.width, request.height, this.doorbird.snapshotUrl);

    // Should we use night vision?
    if(this.doorbird.config.nightVisionSnapshot || (this.doorbird.config.nightVisionSnapshotNight && this.platform.isNight())) {
      await this.doorbird.activateNightVision();
    }

    const response = await this.doorbird.dbApi.fetch(this.doorbird.snapshotUrl);

    if(!response || !response.ok) {
      this.log("%s: Unable to retrieve snapshot.", this.name);
      callback(new Error(this.name + ": Unable to retrieve snapshot."));
      return;
    }

    try {
      const buffer = await response.buffer();
      callback(undefined, buffer);
    } catch(error) {
      this.log.error("%s: An error occurred while making a snapshot request: %s.", this.name, error);
      callback(error instanceof Error ? error : new Error(String(error)));
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
    const audiomtu = 188 * 1;

    // Validate that we have a version of FFmpeg that supports libfdk_aac for audio support. We save what
    // we discovered so we don't unencessarily repeat this check multiple times for one streaming session.
    let audioSupport = 0;
    if(await FfmpegProcess.codecEnabled(this.videoProcessor, "libfdk_aac")) {
      audioSupport = 1;
    }

    let fcmd = "-rtsp_transport tcp -i " + this.doorbird.cameraUrl;

    // Grab the audio URL and add it to the input pipeline.
    if(audioSupport) {
      fcmd += " -f mulaw -ar 8000 -ac 1 -i " + this.doorbird.audioUrl;
    }

    this.log("%s: HomeKit video stream requested: %sx%s, %s fps, %s kbps.",
      this.name, request.video.width, request.video.height, request.video.fps, request.video.max_bit_rate);

    // Configure our video parameters.
    const ffmpegVideoArgs =
      " -map 0:0" +
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

    // Configure the audio portion of the command line, but only if our version of FFmpeg supports libfdk_aac.
    if(audioSupport) {
      // Configure our video parameters.
      const ffmpegAudioArgs =
        " -map 1:0" +
        " -acodec libfdk_aac" +
        " -profile:a aac_eld" +
        " -flags +global_header" +
        " -f null" +
        " -ar " + request.audio.sample_rate + "k" +
        // Keep the controller's bitrate: higher AAC-ELD bitrates produce frames larger than one RTP packet and iOS drops fragmented frames.
        " -b:a " + request.audio.max_bit_rate + "k -afterburner 1" +
        " -bufsize " + (2 * request.audio.max_bit_rate) + "k" +
        " -ac 1" +
        " -payload_type " + request.audio.pt +
        // Video and audio come from two independent DoorBird sources without a common clock, so the RTCP sender reports ffmpeg
        // would emit per stream describe an A/V offset that does not exist. iOS tries to lip-sync against them and the audio stutters.
        " -rtpflags skip_rtcp";

      // Add the required RTP settings and encryption for the stream.
      const ffmpegAudioStream =
        " -ssrc " + sessionInfo.audioSSRC +
        " -f rtp" +
        " -srtp_out_suite AES_CM_128_HMAC_SHA1_80" +
        " -srtp_out_params " + sessionInfo.audioSRTP.toString("base64") +
        " srtp://" + sessionInfo.address + ":" + sessionInfo.audioPort +
        "?rtcpport=" + sessionInfo.audioPort + "&localrtcpport=" + sessionInfo.audioPort + "&pkt_size=" + audiomtu;

      fcmd += ffmpegAudioArgs;
      fcmd += ffmpegAudioStream;
    }

    // Additional logging, but only if we're debugging.
    if(this.platform.debugMode) {
      fcmd += " -loglevel debug"; // " -loglevel level+verbose";
    }

    // Combine everything and start an instance of FFmpeg.
    const ffmpeg = new FfmpegProcess(this, request.sessionID, fcmd, sessionInfo.videoReturnPort, callback);

    // Some housekeeping for our FFmpeg sessions.
    this.ongoingSessions[request.sessionID] = ffmpeg;
    delete this.pendingSessions[request.sessionID];
  }

  // Process incoming stream requests.
  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {

    switch(request.type) {
      case StreamRequestTypes.START:
        // Node 22 terminates the process on unhandled promise rejections, so make sure a failure here (e.g. FFmpeg not found) is handled.
        this.startStream(request, callback).catch((error: unknown) => {
          this.log.error("%s: Unable to start the video stream: %s", this.name, error instanceof Error ? error.message : error);
          callback(error instanceof Error ? error : new Error(String(error)));
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
  public stopStream(sessionId: string): void {
    try {
      if (this.ongoingSessions[sessionId]) {
        const ffmpegProcess = this.ongoingSessions[sessionId];
        if(ffmpegProcess) {
          ffmpegProcess.stop();
        }
      }
      delete this.ongoingSessions[sessionId];
      this.log.info("%s: Stopped video stream.", this.name);
    } catch(error) {
      this.log.error("%s: Error occurred terminating video process: %s", this.name, error);
    } finally {
      this.needNightVision = false;
    }
  }
}
