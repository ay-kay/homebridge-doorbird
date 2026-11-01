<SPAN ALIGN="CENTER">

[![homebridge-doorbird: Native HomeKit support for Doorbird](https://raw.githubusercontent.com/brownad/homebridge-doorbird/master/homebridge-doorbird.svg)](https://github.com/brownad/homebridge-doorbird)

# Homebridge Doorbird

[![Downloads](https://img.shields.io/npm/dt/homebridge-doorbird?color=38A8E0&style=for-the-badge)](https://www.npmjs.com/package/homebridge-doorbird)
[![Version](https://img.shields.io/npm/v/homebridge-doorbird?label=homebridge-doorbird&color=38A8E0&style=for-the-badge)](https://www.npmjs.com/package/homebridge-doorbird)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## HomeKit support for Doorbird video doorbells using [Homebridge](https://homebridge.io).
</SPAN>

`homebridge-doorbird` is a plugin for Homebridge intended to give you an integrated experience with your [Doorbird](https://www.doorbird.com) devices.

It provides the HomeKit video doorbell service which includes a camera, lock, motion sensor, and infrared light service, using the excellent [homebridge-camera-ffmpeg](https://github/KhaosT/homebridge-camera-ffmpeg) as a foundation.

## Requirements and Limitations
* Audio requires a version of [FFmpeg](https://ffmpeg.org) that is compiled with `libopus` support (`fdk-aac` is no longer needed). This plugin uses [ffmpeg-for-homebridge](https://github.com/homebridge/ffmpeg-for-homebridge), which includes `libopus`, to streamline this for some of the more common operating systems. Check the [ffmpeg-for-homebridge](https://github.com/homebridge/ffmpeg-for-homebridge) page for details on supported operating systems. If your operating system isn't supported, most FFmpeg packages (e.g. Debian's and Homebrew's) come with `libopus` too. See [audio](#audio).

* Two-way audio (the Talk button in the Home app) also requires `libopus` support in FFmpeg. See [two-way audio](#two-way-audio).

## Installation

If you are new to Homebridge, please first read the Homebridge [documentation](https://www.npmjs.com/package/homebridge).

1. Install Homebridge:
```sh
sudo npm install -g --unsafe-perm homebridge
```

2. Install homebridge-doorbird:
```sh
sudo npm install -g --unsafe-perm homebridge-doorbird
```

## Plugin configuration
Add the platform in `config.json` in your home directory inside `.homebridge` and edit the required fields. If you want audio support, make sure to enable the feature option `Audio.Enable` in `options`.

```js
"platforms": [
  {
    "platform": "Doorbird",

    "doorbirds": [
      {
        "name": "Doorbird 1",
        "ip": "your.doorbird.ip",
        "username": "some-doorbird-user (or create a new one just for homebridge)",
        "password": "some-doorbird-password",
        "options": [ "Relay.Hide.2" ]
      }
    ]
  }
]
```

### Feature Options
Feature options allow you to enable or disable certain features in this plugin. Feature options are specific to individual Doorbirds.

The feature options for individual Doorbird devices can be customized using the `options` setting inside the `doorbirds` section. Available options:

* <CODE>Relay.Hide.<I>relay</I></CODE> - hide the relay named *relay* from being shown in HomeKit.
* <CODE>Audio.TwoWay.Disable</CODE> - disable two-way audio (the Talk button in the Home app) for this Doorbird.

### <A NAME="audio"></A>Audio
The plugin streams the Doorbird's microphone to HomeKit as [Opus](https://opus-codec.org), at the sample rate the Home app asks for (24 or 16 kHz), the same way Home Assistant's HomeKit Bridge does. Earlier versions used AAC-ELD, which iOS played back distorted and with lagging video.

How it works: FFmpeg encodes the audio with `libopus` and sends it to the plugin, which encrypts it for HomeKit (SRTP). The plugin does the encryption itself because FFmpeg stamps Opus with a 48 kHz clock, while HomeKit expects the clock of the negotiated sample rate. The audio is available whenever FFmpeg has `libopus`; there's nothing to configure.

### <A NAME="two-way-audio"></A>Two-way audio
Pressing the Talk button in the live view of the Home app plays your voice on the Doorbird's speaker. Two-way audio is enabled by default whenever FFmpeg supports audio, and can be disabled per Doorbird with the `Audio.TwoWay.Disable` feature option. Enabling or disabling it adds or removes the speaker in HomeKit after a restart of Homebridge.

How it works: HomeKit sends your voice to Homebridge as encrypted Opus audio, and only while the Talk button is pressed. The plugin decrypts it, then starts an FFmpeg process that decodes the audio and streams it to the Doorbird's `audio-transmit.cgi` API as G.711 mu-law. A couple of seconds after you release the Talk button (`talkbackIdleSeconds`, default: 3), the plugin stops FFmpeg and closes the connection to the Doorbird again.

Requirements and caveats:

* FFmpeg must be compiled with `libopus` (the bundled [ffmpeg-for-homebridge](https://github.com/homebridge/ffmpeg-for-homebridge) is). The log tells you at startup whether two-way audio is enabled.
* The Doorbird user configured for this plugin must be allowed to talk through the Doorbird. If the Doorbird rejects the audio, the plugin logs a "Two-way audio error" with the HTTP status.
* The Doorbird has a single speech channel. While someone is talking through HomeKit, nobody can talk through the Doorbird app (and vice versa). The channel is released `talkbackIdleSeconds` after you release the Talk button, and when you close the live view.
* There is no echo cancellation. If the Home app plays the Doorbird's audio while you talk, you may hear yourself with a delay. Muting the live view audio or using headphones helps.
* Audio from the Home app reaches the Doorbird with a small delay (FFmpeg startup and buffering), and the first fraction of a second of each talk burst may be lost.

### Night vision
Depending on your situation, you might benefit from having Doorbird's infrared light (aka night vision) turn on automatically for you.

This plugin supports the ability to enable night vision when the doorbell rings, HomeKit requests snapshots, or stream video. Night vision can be always-on or activated only at night, for supported events.

See [advanced configuration](#advanced-config) for more details, or configure this plugin using the Homebridge webUI.

### Command line scripts.
If you would like to configure a command line to execute when motion or doorbell events are triggered, you can configure the `cmdDoorbell` and `cmdMotion`, respectively.

### Relays and peripheral devices

The default for this plugin is to lock or unlock the first relay (relay 1) in the Doorbird. This is typically a door strike that unlocks a gate or door.

Support for multiple relays is available on some Doorbird devices and on the following optionally attached peripheral devices:

* A1081 E/A Controller (https://www.doorbird.com/downloads/manual_a1081_en_de.pdf) - TESTED
* A1101 Indoor Station (https://www.doorbird.com/downloads/datasheet/datasheet_a1101_en.pdf) - UNTESTED

All relays found on the Doorbird, including peripherals, will be made available in HomeKit and the Home app.

You may switch the default relay using the `primaryRelay` configuration parameter.
To identify the relay names to use, review the homebridge log and look for log entries beginning with `detected relay: xxxx` to identify the relay you wish to use by default.
In the previous example, you would use `"primaryRelay": "xxxx"` to set `xxxx` as the default relay to unlock.

Example configuration for an alternate relay as the default:
```js
"primaryRelay": "2"
```

Another example configuration using a relay on a peripheral device:
```js
"primaryRelay": "gggggg@1"
```

The name of the controller or station can be found in the App:
Administration > Peripherals > Device (6-letter word)

#### Relay names
By default, each relay appears in HomeKit as `<Doorbird name> Relay <relay>`. HomeKit only accepts names made of letters, numbers, spaces and apostrophes that start and end with a letter or number, so any other characters are replaced with a space (e.g. relay `gggggg@1` becomes `Front Door Relay gggggg 1`).

You can give individual relays their own name using the optional `relayNames` setting, which maps a relay (as shown in the `detected relay: xxxx` log entries) to a name:
```js
"relayNames": { "1": "Gate", "gggggg@1": "Front Door" }
```
Configured names are sanitized in the same way. Renaming a relay does not change its identity in HomeKit, so existing automations keep working.

### <A NAME="advanced-config"></A>Advanced configuration (optional)
This step is not required. For those that prefer to tailor the defaults to their liking, here are the supported parameters.

```js
"platforms": [
  {
    "platform": "Doorbird",
    "name": "Doorbird",
    "videoProcessor": "/usr/local/bin/ffmpeg",
    "ffmpegOptions": "-probesize 32 -analyzeduration 0 -fflags nobuffer -preset veryfast -refs 1 -x264-params intra-refresh=1:bframes=0",

    "doorbirds": [
      {
        "ip": "your.doorbird.ip",
        "username": "some-doorbird-user (or create a new one just for homebridge)",
        "password": "some-doorbird-password",
        "name": "My Doorbird",
        "nightVisionDoorbell": false,
        "nightVisionSnapshot": false,
        "nightVisionVideo": false,
        "nightVisionDoorbellNight": false,
        "nightVisionSnapshotNight": false,
        "nightVisionVideoNight": false,
        "primaryRelay": "1",
        "cmdDoorbell": "/some/doorbell/script",
        "cmdMotion": "/some/motion/script",
        "talkbackIdleSeconds": 3,
        "options": [ "Relay.Hide.2" ]
      }
    ]
  }
]
```

Platform-level configuration parameters:

| Fields                 | Description                                             | Default                                                                               | Required |
|------------------------|---------------------------------------------------------|---------------------------------------------------------------------------------------|----------|
| platform               | Must always be `Doorbird`.                              |                                                                                       | Yes      |
| name                   | Name to use for the Doorbird platform.                  |                                                                                       | No       |
| videoProcessor         | Specify path of ffmpeg or avconv.                       | "ffmpeg"                                                                              | No       |
| ffmpegOptions          | Additional parameters to pass ffmpeg to render video.   | "-probesize 32 -analyzeduration 0 -fflags nobuffer -preset veryfast -refs 1 -x264-params intra-refresh=1:bframes=0"      | No       |
| debug                  | Enable debug logging.                                   | false                                                                                 | No       |

`doorbirds` configuration parameters:

| Fields                 | Description                                             | Default                                                                               | Required |
|------------------------|---------------------------------------------------------|---------------------------------------------------------------------------------------|----------|
| ip                     | IP address of your Doorbird                             |                                                                                       | Yes      |
| username               | Your Doorbird username.                                 |                                                                                       | Yes      |
| password               | Your Doorbird password.                                 |                                                                                       | Yes      |
| name                   | Name to use for this Doorbird.                          |                                                                                       | No       |
| nightVisionDoorbell    | Always activate night vision when the doorbell rings.   | false                                                                                 | No       |
| nightVisionSnapshot    | Always activate night vision when taking snapshots.     | false                                                                                 | No       |
| nightVisionVideo       | Always activate night vision when streaming video.      | false                                                                                 | No       |
| nightVisionDoorbellNight | Activate night vision when the doorbell rings at night. | false                                                                               | No       |
| nightVisionSnapshotNight | Activate night vision when taking snapshots at night. | false                                                                                 | No       |
| nightVisionVideoNight    | Activate night vision when streaming video at night.  | false                                                                                 | No       |
| primaryRelay           | Default relay to use for doorbell lock events.          | "1"                                                                                   | No       |
| relayNames             | Map of relay to the name to show in HomeKit, e.g. `{ "gggggg@1": "Front Door" }`. See [relay names](#relay-names). |                    | No       |
| cmdDoorbell            | Command line to execute when a doorbell event is triggered. |                                                                                   | No       |
| cmdMotion              | Command line to execute when a motion event is triggered. |                                                                                     | No       |
| talkbackIdleSeconds    | Seconds without audio from the Talk button after which the Doorbird speaker is released (at most 10). See [two-way audio](#two-way-audio). | 3 | No       |
| options                | Configure [feature options](#feature-options) for this Doorbird. |                                                                              | No       |

## Credits
* [homebridge-videodoorbell](https://github.com/Samfox2/homebridge-videodoorbell)
* [homebridge-camera-ffmpeg](https://github.com/KhaosT/homebridge-camera-ffmpeg)
* [hjdhjd](https://github.com/hjdhjd)
