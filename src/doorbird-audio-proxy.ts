/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * doorbird-audio-proxy.ts: SRTP proxy for the HomeKit Opus audio stream, in both directions.
 *
 * FFmpeg's RTP muxer always stamps Opus with a 48 kHz clock, but HomeKit expects timestamps on the clock it negotiated (16 or 24 kHz). Since the
 * timestamp is covered by the SRTP authentication tag, FFmpeg sends plain RTP to us on loopback, and we rewrite the timestamps, encrypt the packets
 * and send them to the controller. The return audio (the Talk button) arrives on the same socket: we authenticate and decrypt it, rescale its
 * timestamps to 48 kHz and hand plain RTP to the talkback relay. This is what Home Assistant's HomeKit Bridge does.
 *
 * We use a single socket, bound to the audio port we hand out in prepareStream, for both directions: the controller sends its audio there, and
 * sending from it means the controller sees our audio coming from the port it expects.
 */
import {
  OPUS_RTP_CLOCK_RATE,
  RtpTimestampScaler,
  SrtpDecryptContext,
  SrtpEncryptContext,
  SrtpSessionKeys,
  classifyRtpPacket,
  deriveSrtpSessionKeys,
  rtpPayloadType
} from "./doorbird-rtp";
import { RemoteInfo, Socket, createSocket } from "dgram";
import { isIPv6 } from "net";

// Whoever consumes the decrypted return audio.
export interface AudioProxyTalkback {
  close(): void;
  handleRtp(packet: Buffer): void;
}

// Everything an audio proxy for a single streaming session needs to know.
export interface AudioProxyOptions {
  address: string; // Address of the HomeKit controller. We send our audio there and only accept return audio from it.
  audioPort: number; // The controller's audio port.
  debug: (message: string, ...parameters: unknown[]) => void;
  log: {
    (message: string, ...parameters: unknown[]): void;
    error(message: string, ...parameters: unknown[]): void;
  };
  name: string;
  payloadType: number; // The negotiated payload type.
  returnPort: number; // Our audio port, the one we hand out in prepareStream.
  sampleRate: number; // The negotiated sample rate (and RTP clock), in Hz.
  srtp: Buffer; // SRTP master key and salt concatenated. HomeKit uses the same key in both directions.
  talkback?: AudioProxyTalkback | null; // Receives the return audio. Without it, we ignore the return audio.
}

// The parameters of the Opus stream FFmpeg sends to the audio proxy, as negotiated with HomeKit.
export interface OpusOutputOptions {
  bitrate: number; // In kbps (the controller's max_bit_rate).
  packetTime: number; // In ms.
  payloadType: number;
  port: number; // The proxy's FFmpeg port.
  sampleRate: number; // In kHz.
  ssrc: number;
}

// The FFmpeg output options that encode the audio input as Opus and send it as plain RTP to the audio proxy. This follows Home Assistant's HomeKit
// Bridge, which we verified against iOS. The caller maps the audio input in front of these.
export function opusFfmpegOutput(options: OpusOutputOptions): string {

  // libopus supports frames of 2.5, 5, 10, 20, 40 and 60 ms. HomeKit asks for 20 ms; a packet time libopus can't do (30 ms) would stop FFmpeg.
  const packetTime = [ 10, 20, 40, 60 ].includes(options.packetTime) ? options.packetTime : 20;

  return [
    "-vn",
    "-c:a libopus",
    "-application lowdelay",
    "-ac 1",
    "-ar " + options.sampleRate.toString() + "k",
    "-b:a " + options.bitrate.toString() + "k",
    "-bufsize " + (4 * options.bitrate).toString() + "k",
    "-frame_duration " + packetTime.toString(),
    "-payload_type " + options.payloadType.toString(),
    "-ssrc " + options.ssrc.toString(),
    // The audio and the video come from two independent Doorbird sources without a common clock, so the RTCP sender reports FFmpeg would emit per
    // stream describe an A/V offset that does not exist. iOS tries to lip-sync against them and the audio stutters.
    "-rtpflags skip_rtcp",
    // Plain RTP to our proxy, which rewrites the timestamps to the negotiated clock and encrypts the stream for HomeKit. 188 bytes as before.
    "-f rtp",
    "rtp://127.0.0.1:" + options.port.toString() + "?pkt_size=188"
  ].join(" ");
}

// Statistics for the debug log.
interface AudioProxyStatistics {
  authFailures: number;
  foreign: number;
  inbound: number;
  invalid: number;
  outbound: number;
  rtcp: number;
  sendErrors: number;
}

// Normalize an address for comparisons: IPv4 addresses may show up as IPv4-mapped IPv6 addresses on dual-stack sockets.
function normalizeAddress(address: string): string {
  return address.replace(/^::ffff:/i, "").toLowerCase();
}

// The audio proxy for a single streaming session.
export class DoorbirdAudioProxy {
  private closed = false;
  private readonly controllerSocket: Socket;
  private decryptContext: SrtpDecryptContext | null = null;
  private decryptSsrc: number | null = null;
  private readonly encryptContext: SrtpEncryptContext;
  private ffmpegSender: string | null = null;
  private readonly ffmpegSocket: Socket;
  private inboundScaler: RtpTimestampScaler;
  private readonly keys: SrtpSessionKeys;
  private readonly options: AudioProxyOptions;
  private readonly outboundScaler: RtpTimestampScaler;
  private readonly statistics: AudioProxyStatistics = { authFailures: 0, foreign: 0, inbound: 0, invalid: 0, outbound: 0, rtcp: 0, sendErrors: 0 };
  private readonly talkback: AudioProxyTalkback | null;
  private unexpectedPayloadType = false;

  private constructor(options: AudioProxyOptions) {
    this.options = options;
    this.keys = deriveSrtpSessionKeys(options.srtp);
    this.encryptContext = new SrtpEncryptContext(this.keys);
    this.inboundScaler = new RtpTimestampScaler(options.sampleRate, OPUS_RTP_CLOCK_RATE);
    this.outboundScaler = new RtpTimestampScaler(OPUS_RTP_CLOCK_RATE, options.sampleRate);
    this.talkback = options.talkback ?? null;

    this.controllerSocket = createSocket(isIPv6(options.address) ? "udp6" : "udp4");
    this.ffmpegSocket = createSocket("udp4");
  }

  // Create an audio proxy and bind its sockets. Once this resolves, FFmpeg can send its RTP to ffmpegPort.
  public static async open(options: AudioProxyOptions): Promise<DoorbirdAudioProxy> {
    const proxy = new DoorbirdAudioProxy(options);

    try {
      await proxy.bind();
    } catch(error) {
      proxy.close();
      throw error;
    }

    return proxy;
  }

  // The loopback port FFmpeg sends its plain Opus RTP to.
  public get ffmpegPort(): number {
    return this.ffmpegSocket.address().port;
  }

  // Bind both sockets and start listening.
  private async bind(): Promise<void> {

    await Promise.all([
      DoorbirdAudioProxy.bindSocket(this.controllerSocket, this.options.returnPort),
      DoorbirdAudioProxy.bindSocket(this.ffmpegSocket, 0, "127.0.0.1")
    ]);

    // Errors after we're up and running end the audio for this session, but not the video.
    this.controllerSocket.on("error", (error: Error) => {
      this.options.log.error("%s: Audio is unavailable for the rest of this session: socket error on port %s: %s.",
        this.options.name, this.options.returnPort, error.message);
      this.close();
    });

    this.ffmpegSocket.on("error", (error: Error) => {
      this.options.log.error("%s: Audio is unavailable for the rest of this session: socket error: %s.", this.options.name, error.message);
      this.close();
    });

    this.controllerSocket.on("message", (packet: Buffer, rinfo: RemoteInfo) => this.handleControllerPacket(packet, rinfo));
    this.ffmpegSocket.on("message", (packet: Buffer, rinfo: RemoteInfo) => this.handleFfmpegPacket(packet, rinfo));

    this.options.debug("%s: Audio proxy: FFmpeg sends Opus to 127.0.0.1:%s, we send SRTP from port %s to %s:%s at %s Hz%s.",
      this.options.name, this.ffmpegPort, this.options.returnPort, this.options.address, this.options.audioPort, this.options.sampleRate,
      this.talkback ? ", listening for two-way audio" : "");
  }

  // Bind a socket, resolving once it's bound and rejecting if it can't be.
  private static bindSocket(socket: Socket, port: number, address?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error);

      socket.once("error", onError);

      socket.bind(port, address, () => {
        socket.removeListener("error", onError);
        resolve();
      });
    });
  }

  // Outbound: an Opus RTP packet from FFmpeg. Rewrite the timestamp to the negotiated clock, encrypt it, and send it to the controller.
  private handleFfmpegPacket(packet: Buffer, rinfo: RemoteInfo): void {
    const sender = rinfo.address + ":" + rinfo.port.toString();

    // Lock on to the first sender, that's our FFmpeg.
    if(!this.ffmpegSender) {
      this.ffmpegSender = sender;
      this.options.debug("%s: Audio proxy: receiving Opus from FFmpeg at %s.", this.options.name, sender);
    } else if(sender !== this.ffmpegSender) {
      return;
    }

    // We only forward RTP. FFmpeg's RTCP is suppressed (and would go to the next port anyway), but we make sure.
    if(classifyRtpPacket(packet) !== "rtp") {
      return;
    }

    const rtp = Buffer.from(packet);

    rtp.writeUInt32BE(this.outboundScaler.scale(rtp.readUInt32BE(4)), 4);

    const srtp = this.encryptContext.encrypt(rtp);

    if(!srtp) {
      return;
    }

    this.statistics.outbound++;

    this.controllerSocket.send(srtp, this.options.audioPort, this.options.address, (error: Error | null) => {

      if(error && (this.statistics.sendErrors++ === 0)) {
        this.options.debug("%s: Audio proxy: unable to send audio to the controller: %s.", this.options.name, error.message);
      }
    });
  }

  // Inbound: a packet from the controller. That's either RTCP, which we don't need, or the return audio while the Talk button is pressed.
  private handleControllerPacket(packet: Buffer, rinfo: RemoteInfo): void {

    // Only accept packets from the controller we're streaming to.
    if(normalizeAddress(rinfo.address) !== normalizeAddress(this.options.address)) {

      if(this.statistics.foreign++ === 0) {
        this.options.debug("%s: Audio proxy: ignoring packets from %s:%s.", this.options.name, rinfo.address, rinfo.port);
      }

      return;
    }

    switch(classifyRtpPacket(packet)) {
      case "rtcp":
        this.statistics.rtcp++;
        return;

      case "rtp":
        break;

      default:
        this.statistics.invalid++;
        return;
    }

    // Two-way audio is disabled.
    if(!this.talkback) {
      return;
    }

    this.statistics.inbound++;

    // We keep one decryption context, for the SSRC of the last authenticated packet. A new context is only kept once a packet authenticates with it,
    // so we can't be made to create contexts for arbitrary SSRCs.
    const ssrc = packet.readUInt32BE(8);
    const context = (ssrc === this.decryptSsrc) && this.decryptContext ? this.decryptContext : new SrtpDecryptContext(this.keys);
    const rtp = context.decrypt(packet);

    if(!rtp) {
      this.statistics.authFailures++;

      if([ 1, 10, 100, 1000 ].includes(this.statistics.authFailures)) {
        this.options.debug("%s: Two-way audio: SRTP authentication failed (SSRC 0x%s, payload type %s). %s", this.options.name,
          ssrc.toString(16), rtpPayloadType(packet), this.statisticsSummary());
      }

      return;
    }

    if(context !== this.decryptContext) {
      this.options.debug("%s: Two-way audio: receiving SSRC 0x%s, payload type %s%s.", this.options.name, ssrc.toString(16), rtpPayloadType(rtp),
        (this.decryptSsrc !== null) ? " (replacing SSRC 0x" + this.decryptSsrc.toString(16) + ")" : "");

      this.decryptContext = context;
      this.decryptSsrc = ssrc;
      this.inboundScaler = new RtpTimestampScaler(this.options.sampleRate, OPUS_RTP_CLOCK_RATE);
    }

    if((rtpPayloadType(rtp) !== this.options.payloadType) && !this.unexpectedPayloadType) {
      this.unexpectedPayloadType = true;
      this.options.debug("%s: Two-way audio: the controller sends payload type %s instead of %s.", this.options.name, rtpPayloadType(rtp),
        this.options.payloadType);
    }

    // The controller stamps on the negotiated clock, the talkback FFmpeg expects the 48 kHz Opus clock. We also normalize the payload type.
    rtp.writeUInt32BE(this.inboundScaler.scale(rtp.readUInt32BE(4)), 4);
    rtp[1] = (rtp[1] & 0x80) | this.options.payloadType;

    this.talkback.handleRtp(rtp);
  }

  // A summary of what we've seen, for the debug log.
  private statisticsSummary(): string {
    const s = this.statistics;

    return "Sent " + s.outbound.toString() + " packets (" + s.sendErrors.toString() + " send errors), received " + s.inbound.toString() +
      " RTP packets (" + s.authFailures.toString() + " failed authentication), " + s.rtcp.toString() + " RTCP packets, " + s.invalid.toString() +
      " invalid packets, and ignored " + s.foreign.toString() + " packets from other addresses.";
  }

  // Tear everything down at the end of the streaming session.
  public close(): void {

    if(this.closed) {
      return;
    }

    this.closed = true;

    this.talkback?.close();

    for(const socket of [ this.controllerSocket, this.ffmpegSocket ]) {
      try {
        socket.close();
      } catch {
        // The socket was never bound or is already closed.
      }
    }

    this.options.debug("%s: Audio proxy stopped. %s", this.options.name, this.statisticsSummary());
  }
}
