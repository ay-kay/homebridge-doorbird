/* Copyright(C) 2026, Andreas Kurtz. All rights reserved.
 *
 * doorbird-audio-relay.ts: The one and only connection to the Doorbird's audio stream, served to FFmpeg over a local TCP socket.
 *
 * The Doorbird allows a single consumer of audio-receive.cgi: a new connection kicks the previous one out. It also closes the connection after
 * 9,999,999 bytes (every 20 minutes and 50 seconds) and bursts about three seconds of buffered audio on connect. The relay owns that connection,
 * reconnects immediately when it ends, and hands FFmpeg a steady byte stream at exactly the sample rate on a local TCP port, so FFmpeg never sees the
 * reconnects and the audio timeline stays aligned with wall-clock time (and thus with the video).
 */
import { AUDIO_RELAY_GAP_TOLERANCE, AUDIO_RELAY_MAX_QUEUE, AUDIO_RELAY_PRIME, AUDIO_RELAY_RECONNECT_MAX, AUDIO_RELAY_TICK } from "./settings.js";
import { ClientRequest, IncomingMessage } from "http";
import { Server, Socket, createServer } from "net";
import { Logging } from "homebridge";
import { redactUrl } from "./doorbird-util.js";

// G.711 µ-law at 8 kHz: one byte per sample.
const BYTES_PER_SECOND = 8000;
const SILENCE = 0xFF;

export interface AudioRelayOptions {
  debug: (message: string, ...parameters: unknown[]) => void;
  log: Logging;
  name: string;
  openReceive: () => ClientRequest;
}

export class DoorbirdAudioRelay {
  private client: Socket | null = null;
  private readonly debug: (message: string, ...parameters: unknown[]) => void;
  private emptySince = 0;
  private epoch = 0;
  private failures = 0;
  private readonly log: Logging;
  private readonly name: string;
  private readonly openReceive: () => ClientRequest;
  private queue: Buffer[] = [];
  private queued = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private request: ClientRequest | null = null;
  private response: IncomingMessage | null = null;
  private sent = 0;
  private server: Server | null = null;
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;

  // Statistics for the debug log.
  private statistics = { dropped: 0, padded: 0, received: 0, reconnects: 0 };

  constructor(options: AudioRelayOptions) {
    this.debug = options.debug;
    this.log = options.log;
    this.name = options.name;
    this.openReceive = options.openReceive;
  }

  // Start serving: listen on a local port and connect to the Doorbird.
  public async start(): Promise<void> {
    if(!this.stopped) {
      return;
    }

    this.stopped = false;
    this.statistics = { dropped: 0, padded: 0, received: 0, reconnects: 0 };

    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.acceptClient(socket));

      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        server.on("error", (error: Error) => this.log.error("%s: Audio relay socket error: %s", this.name, error.message));
        this.server = server;
        resolve();
      });
    });

    this.connect();
  }

  // Stop serving and release the Doorbird's audio channel.
  public stop(): void {
    if(this.stopped) {
      return;
    }

    this.stopped = true;
    this.clearReconnect();
    this.stopTicking();
    this.closeReceive();
    this.client?.destroy();
    this.client = null;
    this.server?.close();
    this.server = null;
    this.queue = [];
    this.queued = 0;

    this.debug("%s: Audio relay stopped (received %s KiB, padded %s ms, dropped %s ms, reconnects %s).", this.name,
      Math.round(this.statistics.received / 1024), Math.round(this.statistics.padded / 8), Math.round(this.statistics.dropped / 8), this.statistics.reconnects);
  }

  // The URL FFmpeg reads the audio from.
  public get url(): string {
    const address = this.server?.address();

    return "tcp://127.0.0.1:" + ((address && (typeof address !== "string")) ? address.port.toString() : "0");
  }

  public get isRunning(): boolean {
    return !this.stopped;
  }

  // Open the connection to the Doorbird.
  private connect(): void {
    if(this.stopped || this.request) {
      return;
    }

    const request = this.openReceive();

    this.request = request;

    request.on("response", (response: IncomingMessage) => {
      if(this.request !== request) {
        response.destroy();
        return;
      }

      if(response.statusCode !== 200) {
        this.log.error("%s: The Doorbird refused the audio stream (HTTP %s).", this.name, response.statusCode);
        response.destroy();
        this.scheduleReconnect(true);
        return;
      }

      this.response = response;
      this.failures = 0;

      response.on("data", (chunk: Buffer) => this.enqueue(chunk));

      // The Doorbird ends the stream every 9,999,999 bytes by closing the connection short of its announced length, which Node reports as an
      // aborted response. Reconnect right away: the Doorbird's connect burst covers the gap.
      response.on("end", () => this.scheduleReconnect(false));
      response.on("close", () => this.scheduleReconnect(false));
      response.on("error", (error: Error) => {
        if(error.message === "aborted") {
          this.scheduleReconnect(false);
          return;
        }

        this.debug("%s: Audio stream error: %s", this.name, redactUrl(error.message));
        this.scheduleReconnect(true);
      });
    });

    request.on("error", (error: Error) => {
      if(this.request !== request) {
        return;
      }

      this.debug("%s: Unable to connect to the Doorbird audio stream: %s", this.name, redactUrl(error.message));
      this.scheduleReconnect(true);
    });

    request.end();
  }

  private closeReceive(): void {
    this.response?.removeAllListeners("end");
    this.response?.removeAllListeners("close");
    this.response?.removeAllListeners("error");
    this.response?.destroy();
    this.response = null;
    this.request?.removeAllListeners("error");
    this.request?.destroy();
    this.request = null;
  }

  private scheduleReconnect(failed: boolean): void {
    this.closeReceive();

    if(this.stopped || this.reconnectTimer) {
      return;
    }

    this.statistics.reconnects++;

    // A clean end gets an immediate reconnect, failures back off up to a limit.
    const delay = failed ? Math.min(1000 * Math.pow(2, this.failures++), AUDIO_RELAY_RECONNECT_MAX) : 0;

    if(failed && (this.failures === 3)) {
      this.log.warn("%s: The Doorbird audio stream keeps failing, retrying every %s seconds.", this.name, AUDIO_RELAY_RECONNECT_MAX / 1000);
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnect(): void {
    if(this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // Queue audio from the Doorbird. The queue is capped: after a reconnect the Doorbird replays a few seconds we have already padded with silence.
  private enqueue(chunk: Buffer): void {
    this.statistics.received += chunk.length;
    this.queue.push(chunk);
    this.queued += chunk.length;

    this.trimQueue((AUDIO_RELAY_MAX_QUEUE / 1000) * BYTES_PER_SECOND);
  }

  // Drop the oldest audio until at most limit bytes are queued.
  private trimQueue(limit: number): void {
    while((this.queued > limit) && this.queue.length) {
      const excess = this.queued - limit;
      const head = this.queue[0];

      if(head.length <= excess) {
        this.queue.shift();
        this.queued -= head.length;
        this.statistics.dropped += head.length;
      } else {
        this.queue[0] = head.subarray(excess);
        this.queued -= excess;
        this.statistics.dropped += excess;
      }
    }
  }

  // A new FFmpeg client. There is only ever one; a newcomer replaces the old one.
  private acceptClient(socket: Socket): void {
    this.client?.destroy();
    this.client = socket;
    this.sent = 0;
    this.emptySince = 0;

    // Start close to live: whatever queued up while nobody was listening is history.
    this.trimQueue((AUDIO_RELAY_PRIME / 1000) * BYTES_PER_SECOND);

    // Playback starts once a little audio has been primed, then the byte count follows the wall clock.
    this.epoch = Date.now() + AUDIO_RELAY_PRIME;

    socket.on("error", () => { /* The client went away, the close handler cleans up. */ });
    socket.on("close", () => {
      if(this.client === socket) {
        this.client = null;
        this.stopTicking();
      }
    });

    this.startTicking();
  }

  private startTicking(): void {
    if(!this.timer) {
      this.timer = setInterval(() => this.tick(), AUDIO_RELAY_TICK);
    }
  }

  private stopTicking(): void {
    if(this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Send the bytes that are due by the wall clock: real audio when we have it, silence when the Doorbird has left us dry for too long.
  private tick(): void {
    const client = this.client;

    if(!client) {
      return;
    }

    const now = Date.now();
    let due = Math.floor(((now - this.epoch) / 1000) * BYTES_PER_SECOND) - this.sent;

    if(due <= 0) {
      return;
    }

    const parts: Buffer[] = [];

    while((due > 0) && this.queue.length) {
      const head = this.queue[0];

      if(head.length <= due) {
        parts.push(head);
        this.queue.shift();
        this.queued -= head.length;
        due -= head.length;
      } else {
        parts.push(head.subarray(0, due));
        this.queue[0] = head.subarray(due);
        this.queued -= due;
        due = 0;
      }
    }

    if(this.queue.length) {
      this.emptySince = 0;
    } else if(due > 0) {
      // Nothing left. Give the Doorbird a moment before we fill the gap with silence, its blocks arrive every 128 ms.
      if(!this.emptySince) {
        this.emptySince = now;
      }

      if((now - this.emptySince) >= AUDIO_RELAY_GAP_TOLERANCE) {
        parts.push(Buffer.alloc(due, SILENCE));
        this.statistics.padded += due;
        due = 0;
      }
    }

    if(!parts.length) {
      return;
    }

    const data = parts.length === 1 ? parts[0] : Buffer.concat(parts);

    this.sent += data.length;
    client.write(data);
  }
}
