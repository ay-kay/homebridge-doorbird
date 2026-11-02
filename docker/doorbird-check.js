/* doorbird-check.js: check that the Doorbirds in config.json are reachable and that their users have the permissions this plugin needs.
 *
 * Runs inside the container and reads the same config.json as Homebridge, so credentials never end up on the command line:
 *
 *   docker exec homebridge-doorbird node /opt/homebridge/doorbird-check.js
 *
 * It only reads from the Doorbird: it doesn't trigger relays or the infrared light.
 */
"use strict";

const fetch = require("node-fetch");

const configPath = process.env.HOMEBRIDGE_CONFIG || "/data/config.json";
const TIMEOUT = 5000;

// Fetch a Doorbird API URL with a timeout. Credentials go in the URL, the same way the plugin sends them.
async function get(doorbird, path, auth = true) {
  const credentials = auth ? doorbird.username + ":" + doorbird.password + "@" : "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  const start = Date.now();

  try {
    const response = await fetch("http://" + credentials + doorbird.ip + path, { signal: controller.signal });
    const body = await response.buffer();

    return { body, ms: Date.now() - start, status: response.status, type: response.headers.get("content-type") };
  } catch(error) {
    return { error: error.name === "AbortError" ? "no answer within " + TIMEOUT + " ms" : (error.code || error.message), ms: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

function report(ok, label, detail, warning = false) {
  console.log("  " + (ok ? "OK  " : (warning ? "WARN" : "FAIL")) + "  " + label + (detail ? ": " + detail : ""));

  return ok;
}

async function check(doorbird) {
  console.log((doorbird.name || "Doorbird") + " (" + doorbird.ip + ")");

  if(!doorbird.ip || !doorbird.username || !doorbird.password) {
    return report(false, "config", "ip, username and password are required");
  }

  // Without credentials, a reachable Doorbird answers 401.
  const reach = await get(doorbird, "/bha-api/info.cgi", false);

  if(!report(reach.status === 401, "reachable", reach.error || ("HTTP " + reach.status + ", " + reach.ms + " ms"))) {
    return false;
  }

  // Login: the plugin reads the device information first and gives up after 3 seconds.
  const info = await get(doorbird, "/bha-api/info.cgi");
  let device = null;

  try {
    device = JSON.parse(info.body.toString()).BHA.VERSION[0];
  } catch(error) {
    device = null;
  }

  if(info.status === 401) {
    return report(false, "login", "invalid username or password");
  }

  if(!report(info.status === 200 && device, "login", info.error || ("HTTP " + info.status + ", " + info.ms + " ms" +
    (device ? ", " + device["DEVICE-TYPE"] + ", firmware " + device.FIRMWARE + ", relays " + device.RELAYS.join(" ") : "")))) {
    return false;
  }

  // Slow answers are a warning: the plugin waits 3000 ms for the Doorbird and may give up on a slow network.
  if(info.ms > 3000) {
    report(false, "response time", info.ms + " ms, the plugin waits 3000 ms", true);
  }

  // Snapshots and live video need the "watch always" permission. Without it, the Doorbird answers 204 with no image.
  const image = await get(doorbird, "/bha-api/image.cgi");

  if(image.status === 204) {
    return report(false, "snapshot", "HTTP 204, the user lacks the \"watch always\" (live view) permission");
  }

  return report(image.status === 200 && image.body.length > 0, "snapshot", image.error || ("HTTP " + image.status + ", " + image.type + ", " +
    image.body.length + " bytes, " + image.ms + " ms"));
}

(async () => {
  let doorbirds;

  try {
    doorbirds = require(configPath).platforms.find((platform) => platform.platform === "Doorbird").doorbirds;
  } catch(error) {
    console.log("No Doorbird platform found in " + configPath + ": " + error.message);
    process.exit(2);
  }

  let ok = true;

  for(const doorbird of doorbirds) {
    ok = (await check(doorbird)) && ok;
  }

  process.exit(ok ? 0 : 1);
})();
