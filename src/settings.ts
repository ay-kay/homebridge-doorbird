/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * settings.ts: Settings and constants for homebridge-doorbird.
 */
// The name of our plugin.
export const PLUGIN_NAME = "homebridge-doorbird";

// The platform the plugin creates.
export const PLATFORM_NAME = "Doorbird";

// FFmpeg options.
export const DOORBIRD_FFMPEG_OPTIONS = "-probesize 32 -analyzeduration 0 -fflags nobuffer -preset veryfast -refs 1 -x264-params intra-refresh=1:bframes=0";

// Doorbird API response time, in seconds. This setting drives how responsive we appear to be to end users for things like night vision.
export const DOORBIRD_API_RESPONSE_TIME = 3;

// Doorbird monitor events API has a heartbeat interval of roughly every 20 seconds. We pad a little, just in case.
export const DOORBIRD_HEARTBEAT_INTERVAL = 25;

// Doorbird motion event duration, in seconds. This is set by the Doorbird itself and is not user configurable.
export const DOORBIRD_MOTION_DURATION = 30;

// Doorbird night vision infrared light duration, in seconds. This is set by the Doorbird itself and is not user configurable.
export const DOORBIRD_NIGHTVISION_DURATION = 180;

// Doorbird takes about 2 minutes to reboot.
export const DOORBIRD_REBOOT_DURATION = 120;

// Two-way audio: stop talking to the Doorbird after this many seconds without audio from HomeKit. HomeKit only sends audio while the Talk button is pressed,
// and the Doorbird has a single speech channel that we must release as soon as possible.
export const DOORBIRD_TALKBACK_IDLE_TIMEOUT = 3;

// Doorbird unlock relay duration, in seconds. This can be configured within the Doorbird app, but rarely customized by users.
export const DOORBIRD_UNLOCK_DURATION = 5;

// How often and how quickly we retry a video stream that FFmpeg could not start, e.g. because the Doorbird was busy with a ring.
export const STREAM_RETRIES = 2;
export const STREAM_RETRY_DELAY = 1500;

// Delay before we retry a failed snapshot request.
export const SNAPSHOT_RETRY_DELAY = 600;

// Audio relay: the one connection to the Doorbird's audio, served to FFmpeg locally. Times in milliseconds.
export const AUDIO_RELAY_GAP_TOLERANCE = 300;   // How long we wait for the Doorbird before we fill the gap with silence.
export const AUDIO_RELAY_MAX_QUEUE = 500;       // How much audio we keep queued at most; the Doorbird replays a few seconds on every reconnect.
export const AUDIO_RELAY_PRIME = 200;           // How much audio we gather before playback to a new client starts.
export const AUDIO_RELAY_RECONNECT_MAX = 10000; // Longest pause between reconnect attempts after repeated failures.
export const AUDIO_RELAY_TICK = 32;             // How often we pace audio out to FFmpeg.

// Livestream buffer: one FFmpeg per Doorbird turns the RTSP video and the relayed audio into fragmented MP4 that feeds the live view and
// HomeKit Secure Video. Times in milliseconds.
export const LIVESTREAM_SEGMENT_LENGTH = 100;         // Fragment length. Smaller is more precise for HKSV at trivial cost.
export const LIVESTREAM_BUFFER_DURATION = 10000;      // How much we keep: at least two Doorbird keyframe intervals (3 s at night) plus the HKSV prebuffer.
export const LIVESTREAM_IDLE_TIMEOUT = 60000;         // How long the buffer keeps running after the last consumer is gone.
export const LIVESTREAM_MAX_START_BACKLOG = 1000;      // A live view starts from the last keyframe only if it is at most this old, else it waits for the next.
export const LIVESTREAM_READY_TIMEOUT = 8000;         // How long a live view waits for the buffer to deliver its first keyframe before falling back.
export const LIVESTREAM_RESTART_DELAY = 2000;         // Pause before we restart FFmpeg after it died, with nobody waiting.
export const LIVESTREAM_RESTART_DELAY_ACTIVE = 500;   // ... and with consumers waiting.
export const LIVESTREAM_RESTART_DELAY_MAX = 30000;    // Longest pause between restarts after repeated failures.
export const LIVESTREAM_FAILURE_LOG_THRESHOLD = 3;    // Consecutive failures before we warn.
