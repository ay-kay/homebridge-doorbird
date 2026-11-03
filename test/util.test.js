/* Tests for the helpers in doorbird-util.ts. */
"use strict";

import assert from "node:assert/strict";
import { test } from "node:test";
import { redactUrl } from "../dist/doorbird-util.js";

test("redactUrl masks the credentials in an HTTP URL", () => {
  assert.equal(redactUrl("FetchError: Invalid response body while trying to fetch http://user:secret@192.168.1.20/bha-api/image.cgi: Premature close"),
    "FetchError: Invalid response body while trying to fetch http://<redacted>@192.168.1.20/bha-api/image.cgi: Premature close");
});

test("redactUrl masks the credentials in an RTSP URL", () => {
  assert.equal(redactUrl("-rtsp_transport tcp -i rtsp://ghxyz0001:p4ss@doorbird.local:8557/mpeg/media.amp -an"),
    "-rtsp_transport tcp -i rtsp://<redacted>@doorbird.local:8557/mpeg/media.amp -an");
});

test("redactUrl masks a password that contains an @", () => {
  assert.equal(redactUrl("http://user:se@cret@10.0.0.2/bha-api/info.cgi"), "http://<redacted>@10.0.0.2/bha-api/info.cgi");
});

test("redactUrl leaves text without credentials unchanged", () => {
  const text = "Connected to http://10.0.0.2/bha-api/monitor.cgi?ring=doorbell,motionsensor, mail me at someone@example.com.";

  assert.equal(redactUrl(text), text);
  assert.equal(redactUrl(""), "");
});

test("redactUrl masks every URL in a string", () => {
  assert.equal(redactUrl("ffmpeg -i rtsp://a:b@host:8557/x -i http://c:d@host/bha-api/audio-receive.cgi -f mp4 pipe:1"),
    "ffmpeg -i rtsp://<redacted>@host:8557/x -i http://<redacted>@host/bha-api/audio-receive.cgi -f mp4 pipe:1");
});
