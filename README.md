<div align="center">

<img src="web/favicon.svg" width="72" height="72" alt="">

# streamFree

**A free, local, open-source live-streaming studio.**
Invite guests from a link, add your branding, and stream to YouTube, Twitch,
Facebook and any RTMP server at once, while recording to your computer.
One small download, no account, no watermark, no time limits.

**[Website and downloads](https://iamvinbas.github.io/streamFree/)** · **English** · [Italiano](README.it.md)

</div>

![streamFree studio with two people on stage, a banner and the branding panel](docs/assets/studio.png)

## Features

- **Browser studio** on your own computer: camera, microphone, screen sharing with its audio, video clips.
- **Guests join from a link** in any modern browser, nothing to install. They wait backstage until you add them, hear the show without echo (per-guest *mix-minus*), see the live program, and can chat with you privately.
- **Multistreaming** to as many RTMP/RTMPS destinations as your upload allows. Each destination reconnects on its own, and a slow one never holds the others back.
- **Local recording** to MP4 (H.264 + AAC). Recording is crash-safe: if the computer dies, the file still plays up to the last second or two.
- **Layouts**: solo, grid, side by side, leader, picture in picture, presentation, cinema.
- **Branding**: logo, full-screen overlays, colour or image backgrounds, name tags in your colours.
- **Banners and ticker**: prepare lower thirds before the show, put them on screen with one click.
- **Comments on screen**: Twitch chat with no login, or type in any question.
- **720p or 1080p at 30 or 60 fps**, encoded with your computer's hardware encoder through WebCodecs.
- **Private by design**: the studio listens on `127.0.0.1` only, stream keys never leave your computer, and there is no telemetry.

See [docs/feature-spec.md](docs/feature-spec.md) for the full feature map, including what is planned.

## Install

**macOS and Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/iamvinbas/streamFree/main/install.sh | sh
```

**Windows** (PowerShell)

```powershell
irm https://raw.githubusercontent.com/iamvinbas/streamFree/main/install.ps1 | iex
```

This installs the **streamFree app** and the `streamfree` command:

| System | Where the app appears |
|---|---|
| macOS | `~/Applications`, so Launchpad and Spotlight find it |
| Windows | Start menu and desktop shortcuts |
| Linux | Applications menu |

Or download the file for your system from [Releases](https://github.com/iamvinbas/streamFree/releases) and unpack it.
On macOS, drag `streamFree.app` into Applications. The app is not notarized, so the first time:

- right-click it and choose **Open**;
- if macOS still blocks it, go to **System Settings → Privacy & Security** and choose **Open Anyway**.

The install script above avoids this step.

## Quick start

1. Open the **streamFree** app. It has its own window, Dock/taskbar icon and menu; closing the window quits it.
   - On macOS and Windows the studio runs in the system's web engine (WebKit on macOS, WebView2 on Windows), like Slack or VS Code: no browser needed.
   - On Linux the app window needs Chrome, Edge or Brave.
   - Guests can use any modern browser.
   - From a terminal, `streamfree` opens the studio as a tab in your default browser instead.
2. Allow camera and microphone.
3. Optional: open **Destinations** and add YouTube, Twitch or another RTMP server with its stream key.
4. Press **Record** to record only, or **Go live** to stream (and record) everywhere at once.
5. Recordings go to `~/Movies/streamFree` on macOS, `~/Videos/streamFree` on Windows and Linux.

## Inviting guests

Browsers only allow cameras on secure (HTTPS) pages, except on `localhost`. Pick one of these:

| Where are your guests? | Start streamFree with | What guests do |
|---|---|---|
| On this computer (testing) | `streamfree` | Open the invite link |
| On your home or office network | `streamfree --lan` | Open the link and accept the self-signed certificate warning once |
| Anywhere on the internet | `streamfree --tunnel` | Open the `https://….trycloudflare.com` link |
| Behind your own HTTPS proxy | `streamfree --public-url https://studio.example.com` | Open the link |

- `--tunnel` needs [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) installed. It creates a free temporary HTTPS address. Only the guest page and its signaling travel through it; the media goes directly between browsers.
- If some guests cannot connect (strict company or mobile networks), add a TURN server under **Settings → Guests → ICE servers**.

## Command-line options

```text
streamfree [--app [--browser]] [--port 8787] [--lan] [--tunnel] [--public-url URL]
           [--data-dir DIR] [--recordings-dir DIR] [--no-open]
```

`--app` opens the studio in streamFree's own window and quits when it is closed (what the app icon does). For example, `streamfree --app --lan` starts the app with guests on your network. Add `--browser` to use a Chrome/Edge/Brave window instead.

Settings, destinations and uploaded images live in the data directory:

- `~/Library/Application Support/streamFree` on macOS;
- `%APPDATA%\streamFree` on Windows;
- `~/.local/share/streamFree` on Linux.

## How it works

The host's browser captures, composites and encodes (WebCodecs, hardware H.264 and AAC) in a background worker. The Rust binary receives the encoded stream and does what a browser cannot:

- mux and publish it over RTMP/RTMPS to every destination;
- write the MP4 recording;
- relay WebRTC signaling between you and your guests.

Details: [docs/architecture.md](docs/architecture.md). Standards and papers behind the design: [docs/references.md](docs/references.md).

## Status and limits

streamFree is young. What is verified, and how:

| Area | How it was tested |
|---|---|
| Recording, two simultaneous RTMP destinations, WebRTC guests, A/V sync | Automated tests on macOS with Google Chrome |
| RTMP output | Checked against FFmpeg's RTMP server |
| Twitch chat connection | Checked live |

Still unverified:

- **Real platform ingest** (YouTube, Twitch, Facebook…) has not been verified by the authors yet. Please report what works for you.
- **Hosting needs an AAC encoder in the web engine.** Verified with the macOS app (WebKit) and Chrome on macOS. Windows (WebView2, Chrome, Edge) is expected to work through the system encoder but is untested. Chrome on Linux appears to ship no AAC encoder, so on Linux streamFree works for guests but not yet for hosting; it shows a clear error if so.
- **Hidden windows**: the macOS app keeps 30 fps with its window minimized (checked with the built-in smoke test). A background browser tab is not covered by an automated test.

Planned work is listed in [docs/feature-spec.md](docs/feature-spec.md): per-guest multi-track recordings, scenes, vertical output, YouTube chat, background blur and local captions.

## Build from source

```sh
git clone https://github.com/iamvinbas/streamFree && cd streamFree
cargo build --release          # binary in target/release/streamfree
cargo test                     # unit tests (+ FFmpeg-oracle tests if ffmpeg is installed)
cd tests/e2e && npm install && npm test   # browser tests (needs Google Chrome and ffmpeg)
```

Requires Rust 1.88 or newer (the minimum declared by the dependencies; developed with 1.99). The web studio is plain HTML/CSS/JavaScript in `web/`, embedded into the binary at build time.

## License

[MIT](LICENSE). streamFree is an independent project, not affiliated with any streaming service. Platform names are trademarks of their owners.
