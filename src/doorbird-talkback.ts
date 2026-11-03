/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * doorbird-talkback.ts: HomeKit two-way audio (talkback) support for Doorbird.
 *
 * HomeKit sends the return audio as an SRTP stream (Opus, rtcp-mux) to the audio port we hand out in prepareStream, but only while the Talk button
 * is pressed. The audio proxy (doorbird-audio-proxy.ts) authenticates and decrypts it and hands us plain Opus RTP with 48 kHz timestamps. We forward it
 * to a loopback port where an FFmpeg instance decodes it and transcodes it to G.711 mu-law, which we stream to the Doorbird's audio-transmit API with a
 * long-lived HTTP POST.
 *
 * The Doorbird has a single speech channel: while our POST is open, nobody else (e.g. the Doorbird app) can talk. We therefore start FFmpeg and the
 * POST lazily on the first RTP packet and tear both down again once the controller stops sending audio for a little while.
 *
 * This module is inspired by the two-way audio implementations in homebridge-camera-ffmpeg and homebridge-unifi-protect (RtpDemuxer).
 */
import { ChildProcess, spawn } from "child_process";
import { ClientRequest, IncomingMessage } from "http";
import { Socket, createSocket } from "dgram";
import { redactUrl } from "./doorbird-util.js";

// Parameters for the SDP description we hand to the talkback FFmpeg.
export interface TalkbackSdpOptions {
  payloadType: number;
  port: number;
}

// Everything a talkback session needs to know. We deliberately keep this decoupled from the rest of the plugin.
export interface TalkbackOptions extends Omit<TalkbackSdpOptions, "port"> {
  debug: (message: string, ...parameters: unknown[]) => void;
  idleSeconds: number; // Stop talking after this many seconds without RTP packets.
  log: {
    (message: string, ...parameters: unknown[]): void;
    error(message: string, ...parameters: unknown[]): void;
  };
  name: string;
  openTransmit: () => ClientRequest; // Opens the HTTP POST to the Doorbird audio-transmit API.
  videoProcessor: string; // FFmpeg binary.
}

// Build the SDP description for the talkback FFmpeg: plain Opus RTP from loopback. Opus always uses a 48 kHz RTP clock and is announced as stereo
// (RFC 7587), whatever the stream actually contains; the decoder works that out by itself. RTP goes to port and, following the RTP convention FFmpeg
// uses, RTCP goes to port + 1.
export function buildTalkbackSdp(options: TalkbackSdpOptions): string {
  const pt = options.payloadType.toString();

  return [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=Talk",
    "c=IN IP4 127.0.0.1",
    "t=0 0",
    "m=audio " + options.port.toString() + " RTP/AVP " + pt,
    "a=rtpmap:" + pt + " opus/48000/2"
  ].join("\r\n") + "\r\n";
}

// The FFmpeg command line that decodes the return audio and transcodes it to what the Doorbird expects: G.711 mu-law, 8 kHz, mono.
export const TALKBACK_FFMPEG_COMMAND = "-hide_banner -nostats -loglevel warning -protocol_whitelist pipe,udp,rtp" +
  " -fflags nobuffer -flags low_delay -max_delay 0 -reorder_queue_size 0 -f sdp -c:a libopus -i pipe:0" +
  " -map 0:a:0 -vn -acodec pcm_mulaw -ar 8000 -ac 1 -flush_packets 1 -f mulaw pipe:1";

// Bind a UDP socket to a port to see whether it's available.
function probeUdpPort(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");

    socket.once("error", () => {
      socket.close();
      resolve(null);
    });

    socket.bind(port, () => {
      const boundPort = socket.address().port;
      socket.close();
      resolve(boundPort);
    });
  });
}

// Find two consecutive free UDP ports: FFmpeg binds RTP on the port given in the SDP and RTCP on the next one.
export async function reserveRtpPortPair(): Promise<number> {
  for(let attempt = 0; attempt < 10; attempt++) {
    const port = await probeUdpPort(0); // eslint-disable-line no-await-in-loop

    if(!port || (port >= 65535)) {
      continue;
    }

    if(await probeUdpPort(port + 1)) { // eslint-disable-line no-await-in-loop
      return port;
    }
  }

  throw new Error("Unable to find two consecutive free UDP ports.");
}

// A talkback relay for a single HomeKit streaming session.
export class DoorbirdTalkback {
  private closed = false;
  private failed = false;
  private ffmpeg: ChildProcess | null = null;
  private readonly forwardSocket: Socket;
  private generation = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly options: TalkbackOptions;
  private request: ClientRequest | null = null;
  private rtpPort = 0;
  private talking = false;

  constructor(options: TalkbackOptions) {
    this.options = options;

    // Packets go to FFmpeg on loopback.
    this.forwardSocket = createSocket("udp4");
    this.forwardSocket.on("error", (error: Error) => {
      this.options.debug("%s: Two-way audio forwarding error: %s.", this.options.name, redactUrl(error.message));
    });
  }

  // Process a decrypted Opus RTP packet from the controller: keep the session alive, start talking if we aren't, and forward the packet to FFmpeg.
  public handleRtp(packet: Buffer): void {

    if(this.closed) {
      return;
    }

    // Reset our idle timer.
    if(this.idleTimer) {
      this.idleTimer.refresh();
    } else {
      this.idleTimer = setTimeout(() => this.idle(), this.options.idleSeconds * 1000);
    }

    // A failed talk session stays down until the controller stops sending audio, so we don't hammer the Doorbird on every packet.
    if(this.failed) {
      return;
    }

    if(!this.talking) {
      this.startTalking();
      return;
    }

    // FFmpeg is still starting up - packets that arrive before it's listening are lost either way.
    if(!this.rtpPort) {
      return;
    }

    this.forwardSocket.send(packet, this.rtpPort, "127.0.0.1");
  }

  // The controller stopped sending audio.
  private idle(): void {
    this.idleTimer = null;
    this.failed = false;

    if(this.talking) {
      this.options.debug("%s: No two-way audio received for %s seconds.", this.options.name, this.options.idleSeconds);
      this.stopTalking();
    }
  }

  // Start FFmpeg and the HTTP POST to the Doorbird.
  private startTalking(): void {
    const generation = ++this.generation;

    this.talking = true;
    this.rtpPort = 0;

    reserveRtpPortPair().then((port: number) => {

      // We were stopped while looking for ports.
      if(this.closed || !this.talking || (generation !== this.generation)) {
        return;
      }

      this.rtpPort = port;
      this.launch(generation);
    }).catch((error: unknown) => {
      this.fail(generation, error instanceof Error ? error.message : String(error));
    });
  }

  // Launch FFmpeg and connect it to the Doorbird.
  private launch(generation: number): void {
    const sdp = buildTalkbackSdp({ payloadType: this.options.payloadType, port: this.rtpPort });

    this.options.debug("%s: Two-way audio ffmpeg command: %s %s", this.options.name, this.options.videoProcessor, TALKBACK_FFMPEG_COMMAND);
    this.options.debug("%s: Two-way audio SDP: %s", this.options.name, sdp.replace(/\r\n/g, " | "));

    let lastError = "";

    const ffmpeg = spawn(this.options.videoProcessor, TALKBACK_FFMPEG_COMMAND.split(/\s+/), { env: process.env });

    this.ffmpeg = ffmpeg;

    ffmpeg.on("error", (error: Error) => {
      this.fail(generation, "unable to start FFmpeg: " + error.message);
    });

    ffmpeg.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.options.debug("%s: Two-way audio ffmpeg exited with code: %s and signal: %s.", this.options.name, code, signal);
      this.fail(generation, "FFmpeg exited unexpectedly with code " + String(code) + (lastError ? ": " + lastError : "."));
    });

    ffmpeg.stderr?.on("data", (data: Buffer) => {
      data.toString().split(/\n/).forEach((line: string) => {
        if(line.trim().length) {
          lastError = line.trim();
          this.options.debug("%s: Two-way audio ffmpeg: %s", this.options.name, line);
        }
      });
    });

    ffmpeg.stdin?.on("error", (error: Error) => {
      if(!error.message.includes("EPIPE")) {
        this.options.debug("%s: Two-way audio ffmpeg stdin error: %s.", this.options.name, redactUrl(error.message));
      }
    });

    ffmpeg.stdout?.on("error", (error: Error) => {
      this.options.debug("%s: Two-way audio ffmpeg stdout error: %s.", this.options.name, redactUrl(error.message));
    });

    // Hand FFmpeg the session description.
    ffmpeg.stdin?.end(sdp);

    // Open the speech channel on the Doorbird.
    let request: ClientRequest;

    try {
      request = this.options.openTransmit();
    } catch(error) {
      this.fail(generation, "unable to connect to the Doorbird: " + (error instanceof Error ? error.message : String(error)));
      return;
    }

    this.request = request;

    request.on("error", (error: Error) => {
      this.fail(generation, "unable to send audio to the Doorbird: " + error.message);
    });

    request.on("response", (response: IncomingMessage) => {
      response.resume();

      if(response.statusCode === 401) {
        this.fail(generation, "the Doorbird rejected our credentials (HTTP 401). Does this user have the permission to use the speaker?");
      } else if(response.statusCode !== 200) {
        this.fail(generation, "the Doorbird responded with HTTP " + String(response.statusCode) + ".");
      } else {
        this.options.debug("%s: The Doorbird responded with HTTP 200 to the audio transmission.", this.options.name);
      }
    });

    request.setNoDelay(true);
    request.flushHeaders();

    ffmpeg.stdout?.pipe(request, { end: false });

    this.options.log("%s: Two-way audio started.", this.options.name);
  }

  // Something went wrong with the current talk session. Log it once and tear the session down until the controller goes idle.
  private fail(generation: number, reason: string): void {

    // Ignore errors from sessions we have already torn down, including the ones caused by tearing them down.
    if(this.closed || !this.talking || (generation !== this.generation)) {
      return;
    }

    this.options.log.error("%s: Two-way audio error: %s", this.options.name, redactUrl(reason));
    this.failed = true;
    this.stopTalking();
  }

  // Stop FFmpeg and close the speech channel on the Doorbird.
  private stopTalking(): void {

    if(!this.talking) {
      return;
    }

    const wasRunning = this.ffmpeg !== null;

    // Invalidate any callbacks of the current session.
    this.generation++;
    this.talking = false;
    this.rtpPort = 0;

    if(this.ffmpeg) {
      this.ffmpeg.stdout?.unpipe();
      this.ffmpeg.kill("SIGKILL");
      this.ffmpeg = null;
    }

    if(this.request) {
      this.request.destroy();
      this.request = null;
    }

    if(wasRunning) {
      this.options.log("%s: Two-way audio stopped.", this.options.name);
    }
  }

  // Tear everything down at the end of the streaming session.
  public close(): void {

    if(this.closed) {
      return;
    }

    this.stopTalking();
    this.closed = true;

    if(this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    try {
      this.forwardSocket.close();
    } catch {
      // The socket is already closed.
    }
  }
}
