/* audio-relay.test.js: the audio relay keeps a steady 8 kHz byte stream across Doorbird reconnects and gaps.
 *
 * A fake Doorbird serves µ-law blocks of 1024 bytes every 128 ms, ends the connection after a while like the real one does, and replays a
 * burst on reconnect. The relay's client must see about 8000 bytes per second regardless.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import net from "node:net";
import { DoorbirdAudioRelay } from "../dist/doorbird-audio-relay.js";

const quietLog = Object.assign(() => {}, { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} });

// A fake audio-receive.cgi: real-time blocks, optional end after N bytes, a burst of backlog on connect.
function fakeDoorbird({ endAfter = Infinity, burst = 0 }) {
  const state = { connections: 0 };
  const server = http.createServer((request, response) => {
    state.connections++;
    response.writeHead(200, { "Content-Type": "audio/basic", "Content-Length": "9999999" });

    let sent = 0;
    let value = 0;

    const block = (size) => {
      const data = Buffer.alloc(size);
      for(let i = 0; i < size; i++) {
        data[i] = value = (value + 1) & 0x7F; // never 0xFF, so silence is distinguishable
      }
      return data;
    };

    if(burst) {
      response.write(block(burst));
      sent += burst;
    }

    const timer = setInterval(() => {
      if(sent >= endAfter) {
        clearInterval(timer);
        // The real Doorbird closes the connection short of the announced length.
        response.end();
        request.socket.destroy();
        return;
      }
      response.write(block(1024));
      sent += 1024;
    }, 128);

    response.on("close", () => clearInterval(timer));
  });

  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port })));
}

async function collect(relay, ms) {
  const port = Number(relay.url.split(":").pop());
  const socket = net.connect(port, "127.0.0.1");
  const chunks = [];
  const start = Date.now();

  socket.on("data", (chunk) => chunks.push(chunk));
  await new Promise((resolve) => setTimeout(resolve, ms));
  const elapsed = Date.now() - start;
  socket.destroy();

  return { data: Buffer.concat(chunks), elapsed };
}

test("relay paces audio at 8000 bytes per second", async () => {
  const doorbird = await fakeDoorbird({});
  const relay = new DoorbirdAudioRelay({ debug: () => {}, log: quietLog, name: "Test",
    openReceive: () => http.request({ hostname: "127.0.0.1", port: doorbird.port, path: "/bha-api/audio-receive.cgi", method: "GET" }) });

  await relay.start();
  const { data, elapsed } = await collect(relay, 2000);
  relay.stop();
  doorbird.server.close();

  // 200 ms priming, then 8000 B/s. Allow for timer granularity.
  const expected = ((elapsed - 200) / 1000) * 8000;
  assert.ok(Math.abs(data.length - expected) < 1600, `got ${data.length} bytes, expected about ${Math.round(expected)}`);
  assert.equal(data.indexOf(0xFF), -1, "no silence was padded while the Doorbird kept sending");
});

test("relay reconnects when the Doorbird ends the stream and keeps the byte count on schedule", async () => {
  // End after ~0.5 s of audio, replay 3 s of backlog on every connect, like the real Doorbird.
  const doorbird = await fakeDoorbird({ endAfter: 4096, burst: 24000 });
  const relay = new DoorbirdAudioRelay({ debug: () => {}, log: quietLog, name: "Test",
    openReceive: () => http.request({ hostname: "127.0.0.1", port: doorbird.port, path: "/bha-api/audio-receive.cgi", method: "GET" }) });

  await relay.start();
  const { data, elapsed } = await collect(relay, 3000);
  relay.stop();
  doorbird.server.close();

  assert.ok(doorbird.state.connections >= 3, `expected several reconnects, saw ${doorbird.state.connections}`);
  const expected = ((elapsed - 200) / 1000) * 8000;
  assert.ok(Math.abs(data.length - expected) < 2400, `got ${data.length} bytes, expected about ${Math.round(expected)}`);
});

test("relay pads silence when the Doorbird goes quiet", async () => {
  const doorbird = await fakeDoorbird({ endAfter: 2048 });
  let allowConnections = 1;
  const relay = new DoorbirdAudioRelay({ debug: () => {}, log: quietLog, name: "Test",
    openReceive: () => http.request({ hostname: "127.0.0.1", port: allowConnections-- > 0 ? doorbird.port : 1, path: "/", method: "GET" }) });

  await relay.start();
  const { data, elapsed } = await collect(relay, 2500);
  relay.stop();
  doorbird.server.close();

  const expected = ((elapsed - 200) / 1000) * 8000;
  assert.ok(Math.abs(data.length - expected) < 2400, `got ${data.length} bytes, expected about ${Math.round(expected)}`);
  const silence = data.filter((byte) => byte === 0xFF).length;
  assert.ok(silence > 8000, `expected at least a second of padded silence, got ${silence} bytes`);
});
