/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * doorbird-platform.ts: homebridge-doorbird platform class.
 */
import daynight from "daynight";
import { DoorbirdStation } from "./doorbird-station.js";
import { DoorbirdConfig } from "./doorbird-types.js";
import { API, APIEvent, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from "homebridge";
import { FfmpegCodecs, FfmpegOptions, HomebridgePluginLogging } from "homebridge-plugin-utils";
import { DOORBIRD_FFMPEG_OPTIONS } from "./settings.js";
import { DoorbirdStreamingDelegate } from "./doorbird-stream.js";
import util from "util";

export class DoorbirdPlatform implements DynamicPlatformPlugin {
  accessories: PlatformAccessory[] = [];
  config: DoorbirdConfig;
  debugMode = false;
  readonly log: Logging;
  readonly api: API;
  private readonly doorbirds: DoorbirdStation[] = [];
  private ffmpegCodecs?: Promise<FfmpegCodecs | null>;

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.api = api;

    // Force this to DoorbirdConfig.
    this.config = config as any;
    this.log = log;

    // We can't start without being configured.
    if(!config) {
      return;
    }

    // We need a Doorbird configured to do anything.
    if(!config.doorbirds) {
      this.log("No Doorbirds have been configured.");
      return;
    }

    // Capture configuration parameters.
    if(config.debug) {
      this.debugMode = config.debug === true;
      this.debug("Debug logging on. Expect a lot of data.");
    }

    // Additional ffmpeg options, in case the user wants to override the defaults. This option may be removed in a future release.
    if(!config.ffmpegOptions) {
      config.ffmpegOptions = DOORBIRD_FFMPEG_OPTIONS;
    }

    // Avoid a prospective race condition by waiting to configure our Doorbirds until Homebridge is done
    // loading all the cached accessories it knows about, and calling configureAccessory() on each.
    api.on(APIEvent.DID_FINISH_LAUNCHING, this.launchDoorbirds.bind(this));
  }

  // This gets called when homebridge restores cached accessories at startup. We
  // intentionally avoid doing anything significant here, and save all that logic
  // for device discovery.
  configureAccessory(accessory: PlatformAccessory): void {

    // Add this to the accessory array so we can track it.
    this.accessories.push(accessory);
  }

  // Launch Doorbirds.
  private launchDoorbirds(): void {

    // Loop through each configured Doorbird and instantiate it.
    for(const doorbirdStationConfig of this.config.doorbirds) {

      // We need an IP address, or there's nothing to do.
      if(!doorbirdStationConfig.ip) {
        this.log("No host or IP address has been configured.");
        return;
      }

      // We need login credentials or we're skipping this one.
      if(!doorbirdStationConfig.username || !doorbirdStationConfig.password) {
        this.log("No Doorbird login credentials have been configured.");
        return;
      }

      // Validate our night vision settings.
      doorbirdStationConfig.nightVisionDoorbell = doorbirdStationConfig.nightVisionDoorbell === true;
      doorbirdStationConfig.nightVisionSnapshot = doorbirdStationConfig.nightVisionSnapshot === true;
      doorbirdStationConfig.nightVisionVideo = doorbirdStationConfig.nightVisionVideo === true;
      doorbirdStationConfig.nightVisionDoorbellNight = doorbirdStationConfig.nightVisionDoorbellNight === true;
      doorbirdStationConfig.nightVisionSnapshotNight = doorbirdStationConfig.nightVisionSnapshotNight === true;
      doorbirdStationConfig.nightVisionVideoNight = doorbirdStationConfig.nightVisionVideoNight === true;

      this.doorbirds.push(new DoorbirdStation(this, doorbirdStationConfig));
    }
  }

  // FFmpeg options for homebridge-plugin-utils' FFmpeg processes. FFmpeg is probed once for all Doorbirds.
  async ffmpegOptions(name: string): Promise<FfmpegOptions | null> {
    const log = this.pluginLogger();

    this.ffmpegCodecs ??= FfmpegCodecs.probe({ ffmpegExec: DoorbirdStreamingDelegate.videoProcessor(this), log }).catch((error: unknown) => {
      this.log.error("Unable to probe FFmpeg: %s", error instanceof Error ? error.message : error);
      return null;
    });

    const codecSupport = await this.ffmpegCodecs;

    if(!codecSupport) {
      return null;
    }

    return new FfmpegOptions({ codecSupport, debug: this.debugMode, hardwareDecoding: false, hardwareTranscoding: false, log, name: () => name });
  }

  // A logger for homebridge-plugin-utils that never prints Doorbird credentials: its FFmpeg command lines contain the RTSP URL.
  private pluginLogger(): HomebridgePluginLogging {
    const redact = (message: string): string => message.replace(/(\w+:\/\/)[^@\s/]+@/g, "$1<redacted>@");
    const wrap = (level: "debug" | "error" | "info" | "warn") => (message: string, ...parameters: unknown[]): void => {
      const text = redact(util.format(message, ...parameters));

      if(level === "debug") {
        this.debug(text);
      } else {
        this.log[level](text);
      }
    };

    return { debug: wrap("debug"), error: wrap("error"), info: wrap("info"), warn: wrap("warn") };
  }

  // Utility function to determine whether it's day or night.
  isNight(): boolean {
    // daynight is a CommonJS module with a default export; under ESM the import is the module namespace.
    const dayNight = daynight.default();

    // If we can't figure out if it's night, always assume it's day.
    return dayNight.error ? false : dayNight.dark;
  }

  // Utility for debug logging.
  debug(message: string, ...parameters: any[]) {
    if(this.debugMode) {
      this.log(util.format(message, ...parameters));
    }
  }
}
