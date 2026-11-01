/* Copyright(C) 2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * doorbird-types.ts: Type definitions for Doorbird.
 */

// An complete description of the Doorbird device information JSON (the contents of BHA.VERSION[0] returned by info.cgi).
export interface DoorbirdDeviceDetailInterface {
  BUILD_NUMBER: string,
  "DEVICE-TYPE": string,
  FIRMWARE: string,
  PRIMARY_MAC_ADDR: string,
  RELAYS: string[],
  WIFI_MAC_ADDR: string
}

// The full JSON response returned by the Doorbird info.cgi API call.
export interface DoorbirdDeviceInformationInterface {
  BHA: {
    RETURNCODE: string,
    VERSION: DoorbirdDeviceDetail[]
  }
}

// Plugin configuration options.
export interface DoorbirdConfigInterface {
  ffmpegOptions: string,
  doorbirds: DoorbirdStationConfig[],
  videoProcessor: string
}

// NVR configuration options.
export interface DoorbirdStationConfigInterface {
  cmdDoorbell: string,
  cmdMotion: string,
  ip: string,
  name: string,
  nightVisionDoorbell: boolean,
  nightVisionSnapshot: boolean,
  nightVisionVideo: boolean,
  nightVisionDoorbellNight: boolean,
  nightVisionSnapshotNight: boolean,
  nightVisionVideoNight: boolean,
  options: string[],
  primaryRelay: string,
  relayNames?: { [relay: string]: string },
  snapshotUrl: string,
  talkbackIdleSeconds?: number,
  username: string,
  password: string
}

// We use types instead of interfaces here because we can more easily set the entire thing as readonly.
// Unfortunately, interfaces can't be quickly set as readonly in Typescript without marking each and
// every property as readonly along the way.
export type DoorbirdDeviceDetail = Readonly<DoorbirdDeviceDetailInterface>;
export type DoorbirdDeviceInformation = Readonly<DoorbirdDeviceInformationInterface>;
export type DoorbirdConfig = Readonly<DoorbirdConfigInterface>;
export type DoorbirdStationConfig = DoorbirdStationConfigInterface;
