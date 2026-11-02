# HomeKit Secure Video for homebridge-doorbird: design notes

Status: draft, 2026-11-02. Goal: recordings and object detection in the Home app (HomeKit Secure Video, HKSV) for the
DoorBird, without breaking the live view, two-way audio and the relay lock that already work.

## 1. What we measured on the DoorBird (D2101FV, firmware as of 2026-11)

| Fact | Consequence |
|---|---|
| RTSP `mpeg/media.amp` is H.264 Main profile, level 4.0, 1280x720, video only. | Video can be copied for live view. Recording needs a transcode (see 3.4). |
| Keyframe every 24 frames, SPS/PPS repeated before each IDR. | GOP is 1.2 s in daylight (20 fps) and 3 s at night (8 fps). The buffer must hold at least two GOPs plus the prebuffer. |
| Frame rate follows the light: ~20 fps by day, 10 fps at dusk, 8 fps with IR at night. | Advertise 15 fps to HomeKit and use an `fps` filter when transcoding. Never assume a fixed rate for timing. |
| A single RTSP session ran 12.5 h without a drop, through two doorbell rings and three live views. | Multiple RTSP sessions are fine; an existing one survives the "busy" phases in which the DoorBird refuses new ones. |
| About one corrupt NAL unit every 4 minutes (type 0, invalid header), also garbage parsed as data partitions. | Decoders must run with `-fflags +discardcorrupt -err_detect ignore_err`. For copied video this is what the live view already does today. |
| `audio-receive.cgi` (G.711 µ-law, 8 kHz) allows exactly one consumer; a new connection kicks the old one out. | Exactly one process may ever hold the audio connection. Everything else gets audio from it. |
| The DoorBird closes `audio-receive.cgi` after 9,999,999 bytes, every 20 min 50 s, with a clean EOF. On connect it bursts ~3 s of buffered audio. | The holder must reconnect at once and keep the byte stream continuous for its consumers. |

## 2. HomeKit side (HAP-NodeJS 2.2.2, Homebridge 2.4)

- `CameraController` gets `recording: { options, delegate }` and `sensors: { motion }`. HAP-NodeJS does the HomeKit Data
  Stream, the `RecordingManagement` and `CameraOperatingMode` services and all the characteristics.
- We implement `CameraRecordingDelegate`: `updateRecordingActive`, `updateRecordingConfiguration`,
  `handleRecordingStreamRequest` (an async generator of fMP4 packets), `acknowledgeStream`, `closeRecordingStream`.
- Container is fragmented MP4 only. Audio is AAC-LC or AAC-ELD. HomeKit only enables HKSV when the advertised
  `fragmentLength` is 4000 ms and the resolutions use 15, 24 or 30 fps. The home hub drops the connection when no
  fragment arrives for about 5 s, so fragments must be about 4 s long and each one must start on a keyframe.
- The home hub only ever enables the motion trigger. Doorbell rings therefore also trip the motion sensor for a few
  seconds, so rings get recorded (configurable).
- The recording must start exactly `prebufferLength` before the event, otherwise the timeline in the Home app is off.
  The buffer therefore starts at the keyframe before the prebuffer start and trims the difference with `-ss`.

## 3. Architecture

```
                     DoorBird
         RTSP video      audio-receive.cgi (one consumer)
             |                    |
             |            DoorbirdAudioRelay  (Node: http reader, reconnect, byte-rate governor,
             |                    |            serves µ-law on tcp://127.0.0.1:<port>)
             v                    v
     FfmpegLivestreamProcess (homebridge-plugin-utils): video copy + pcm_s16le, fMP4, 100 ms fragments
                              |
                   DoorbirdTimeshiftBuffer  (ring of 10 s of fragments, keyframe flags, init segment)
                    /                 \
   live view ffmpeg (ours)        FfmpegRecordingProcess (homebridge-plugin-utils)
   video copy -> SRTP               libx264 veryfast, 4 s fragments, AAC-LC
   pcm -> Opus -> audio proxy       -> DoorbirdRecordingDelegate -> HAP (HKSV)
```

### 3.1 Dependencies

- `homebridge-plugin-utils` (hjdhjd, ISC, ESM only, Node >= 22.20): `FfmpegProcess`, `FfmpegLivestreamProcess`,
  `FfmpegRecordingProcess`, `Mp4SegmentAssembler`, `isKeyframe`, `FfmpegCodecs`, `FfmpegOptions`, `BackpressureWriter`.
  Its livestream builder already models "RTSP video plus a separate raw audio input" and names the DoorBird as the use case.
- The plugin therefore switches to ES modules (`"type": "module"`, `module: nodenext`), like hjdhjd's other plugins.
  Engines become Node ^22.20 || ^24.
- `homebridge-unifi-protect` (ISC) is the template for the timeshift buffer and the recording delegate; code taken from it
  keeps its copyright line. Scrypted (MIT HomeKit plugin, Apache prebuffer, unlicensed DoorBird plugin) is a reference only.

### 3.2 DoorbirdAudioRelay

- Owns the only connection to `audio-receive.cgi`. Reconnects immediately on EOF or error (backoff on repeated failure).
- Listens on `127.0.0.1:<ephemeral>` and hands the URL to ffmpeg as `-f mulaw -ar 8000 -ac 1 -i tcp://127.0.0.1:<port>`.
  One ffmpeg client at a time (the livestream process); a new client replaces the old one.
- Byte-rate governor: the stream must deliver 8000 bytes per second of wall clock. The DoorBird's connect burst covers the
  reconnect gap; whatever is still missing after a short settle time is filled with µ-law silence (0xFF), surplus is dropped.
  Tolerance about 100 ms, so audio and video stay aligned over hours.
- Talkback keeps its own `audio-transmit.cgi` connection; the DoorBird mutes its own audio out while talking, nothing to do here.

### 3.3 Livestream and buffer

- `FfmpegLivestreamProcess` with our own argument list: low-latency input flags, `-rtsp_transport tcp`, video copy,
  audio `pcm_s16le` (ISO/IEC 23003-5 PCM in MP4; verified on the VM with ffmpeg 8 that a second ffmpeg can demux it from a pipe),
  `-frag_duration 100000 -movflags default_base_moof+empty_moov+frag_keyframe+skip_sidx+skip_trailer -flush_packets 1`.
- `DoorbirdTimeshiftBuffer` (port of homebridge-unifi-protect's timeshift buffer): 100 ms fragments, 10 s depth, keyframe flag per
  fragment, init segment, `getLast(ms)`, `getKeyframeAlignedStart(prebufferMs)`, discontinuity handling (clear, wait for keyframe).
- Lifecycle: the buffer runs while HomeKit has recording active with a configuration, or while a live view is open. When
  neither is true it stops after an idle period, so the DoorBird is not streamed around the clock for nothing. Reconnect
  with short backoff; transmitting sessions get the fastest retry.

### 3.4 Recording (HKSV)

- Advertised: `prebufferLength` 4000, `fragmentLength` 4000, H.264 Baseline/Main/High (levels 3.1, 3.2, 4.0), resolutions 1280x720,
  640x360, 320x180 at 15 fps, audio AAC-LC at 16 kHz (the source is 8 kHz; HomeKit picks from what we offer).
- Video is transcoded with libx264 (`veryfast`, `fps=<selected>`, GOP 4 s, bitrate as requested by HomeKit) because
  the DoorBird's own keyframe cadence (1.2 to 3 s) does not give 4 s fragments. Measured on the VM: 720p at 15 fps costs
  about a quarter of one vCPU while a recording runs. A `copy` mode stays available as a feature option for experiments.
- Audio from the buffer's PCM is encoded to AAC-LC per request; `RecordingAudioActive` is honoured at event start.
- Flow per event (from homebridge-unifi-protect): decline with a single `isLast` byte while the buffer is not full; find the
  keyframe-aligned start; feed init + fragments into ffmpeg stdin and keep feeding live fragments through a backpressure writer;
  yield the init segment, then each `moof+mdat` fragment, paced at 4 s; on `closeRecordingStream` stop idempotently;
  on a buffer discontinuity restart ffmpeg on the recovery keyframe and keep the stream open.

### 3.5 Live view from the buffer

- The live ffmpeg reads fMP4 from stdin instead of opening RTSP and HTTP itself: init segment plus fragments from the most recent
  keyframe, then live fragments. Output stays as today (video copy to SRTP, Opus through the audio proxy, talkback unchanged).
- Expected gains: live view starts at once even while the DoorBird is busy after a ring, no retries, no second audio connection.
- Risk: added latency from the fragment pipeline and the backlog since the last keyframe. To be measured; a feature option can
  keep video on a direct RTSP session while audio still comes from the relay.

### 3.6 Configuration

- Feature options (existing mechanism): `Video.HKSV.Disable`, `Video.HKSV.Copy` (experimental video copy), `Motion.Ring.Disable`
  (do not trip motion on rings), `Video.LiveFromBuffer.Disable`. Defaults: HKSV on, transcode, rings trip motion, live from buffer.

## 4. Phases

1. Switch the plugin to ES modules, add `homebridge-plugin-utils`, keep behaviour identical. Deploy, verify live view and talk.
2. Audio relay plus livestream and timeshift buffer, live view fed from the buffer. Deploy, measure start time and latency.
3. Recording delegate, motion on ring, operating-mode handling. Deploy, enable recording in Home, test with walks past the door
   and rings. Watch Homebridge log for close reasons.
4. Hardening: discontinuity restarts, reconnect storms, CPU on the one-core VM, documentation, upstream-ready split of commits.

## 5. Open risks

- HomeKit's acceptance of our fragments is only testable end to end on the real home hub.
- One vCPU on the VM: libx264 recording plus Opus live encoding at the same time is the worst case. Measure in phase 3.
- Audio/video drift of the governor over very long sessions; the 21-minute reconnect is the critical moment.
