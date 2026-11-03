/* Tests for the Doorbird events API monitor: retry with backoff after a refused connection, against a local server that plays monitor.cgi. */
"use strict";

import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { format } from "node:util";
import { DoorbirdApi } from "../dist/doorbird-api.js";

function capturingLog() {
  const lines = { debug: [], error: [], info: [], warn: [] };
  const log = (message, ...parameters) => lines.info.push(format(message, ...parameters));

  for(const level of Object.keys(lines)) {
    log[level] = (message, ...parameters) => lines[level].push(format(message, ...parameters));
  }

  return { lines, log };
}

test("The events monitor retries after HTTP 401 with the configured delay and then delivers events", async () => {
  const requests = [];
  const responses = [];
  const server = http.createServer((request, response) => {
    requests.push({ time: Date.now(), url: request.url });

    if(requests.length === 1) {
      response.writeHead(401);
      response.end();
      return;
    }

    responses.push(response);
    response.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=--ioboundary" });
    setTimeout(() => response.write("--ioboundary\r\nContent-Type: text/plain\r\n\r\nmotionsensor:H\r\n"), 50);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { lines, log } = capturingLog();
  const platform = { debug: (message, ...parameters) => lines.debug.push(format(message, ...parameters)), log };
  const api = new DoorbirdApi(platform, "Test", "127.0.0.1:" + server.address().port.toString(), "user", "secret",
    { eventRetryDelay: 100, eventRetryDelayMax: 400 });

  try {
    const motion = new Promise((resolve) => {
      api.events.motionsensor = resolve;
    });

    api.launchEventMonitor();

    // A second launch while the first connection is being opened must not start another monitor.
    api.launchEventMonitor();

    let timer;

    await Promise.race([ motion, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("no motion event")), 3000);
    }) ]).finally(() => clearTimeout(timer));

    assert.equal(requests.length, 2, "one refused request, one reconnect");
    assert.ok(requests.every((entry) => entry.url === "/bha-api/monitor.cgi?ring=doorbell,motionsensor"));

    const retryAfter = requests[1].time - requests[0].time;

    assert.ok((retryAfter >= 90) && (retryAfter < 1000), "the retry used the configured delay, took " + retryAfter.toString() + " ms");

    assert.equal(lines.warn.length, 1);
    assert.match(lines.warn[0], /^Test: Unable to connect to the Doorbird events API \(HTTP 401\)\. Check the user's permissions in the Doorbird app\.$/);
    assert.ok(lines.info.includes("Test: Connected to the Doorbird events API."));
    assert.ok(lines.warn.concat(lines.info, lines.debug, lines.error).every((line) => !line.includes("secret")), "credentials never reach the log");
  } finally {
    api.stopEventMonitor();
    responses.forEach((response) => response.destroy());
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("A lost events connection reconnects exactly once, and repeated identical failures are only logged at debug level", async () => {
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests++;

    // First connection: deliver the boundary, then end the stream. Afterwards the Doorbird is rebooting.
    if(requests === 1) {
      response.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=--ioboundary" });
      response.write("--ioboundary\r\nContent-Type: text/plain\r\n\r\ndoorbell:L\r\n");
      setTimeout(() => response.end(), 30);
      return;
    }

    response.writeHead(503);
    response.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { lines, log } = capturingLog();
  const platform = { debug: (message, ...parameters) => lines.debug.push(format(message, ...parameters)), log };
  const api = new DoorbirdApi(platform, "Test", "127.0.0.1:" + server.address().port.toString(), "user", "secret",
    { eventRetryDelay: 40, eventRetryDelayMax: 80 });

  try {
    api.launchEventMonitor();

    // Lost (40 ms), 503 (80 ms), 503 (80 ms): four requests after roughly 200 ms plus round trips.
    const deadline = Date.now() + 3000;

    while((requests < 4) && (Date.now() < deadline)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.ok(requests >= 4, "the monitor keeps retrying");
    assert.equal(lines.warn.filter((line) => line.includes("has been lost")).length, 1, "one lost connection, one warning");
    assert.equal(lines.warn.filter((line) => line.includes("(HTTP 503), retrying in")).length, 1, "the same failure is warned about once");
    assert.ok(lines.debug.some((line) => line.includes("(HTTP 503), retrying in 0.08 seconds")), "repeats go to debug, the backoff is capped");
  } finally {
    // Stop the retry loop before the server goes away.
    api.stopEventMonitor();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
