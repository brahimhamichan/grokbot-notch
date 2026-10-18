<div align="center">

# ✦ GrokBot Notch

**Talk to your Grok Bots from your Mac's notch.** Realtime voice calls, voice notes and quick chat, with your session kept on your Mac.

[![macOS 13+](https://img.shields.io/badge/macOS-13%2B-000?logo=apple)](#requirements)
[![Apple Silicon](https://img.shields.io/badge/Apple%20Silicon-arm64-000?logo=apple)](#requirements)
[![Swift](https://img.shields.io/badge/Swift-AppKit%20%2B%20WebKit-F05138?logo=swift&logoColor=white)](macos/NotchApp.swift)
[![Node.js bundled](https://img.shields.io/badge/Node.js-24%20bundled-339933?logo=nodedotjs&logoColor=white)](scripts/build-mac-app.sh)
[![Zero dependencies](https://img.shields.io/badge/npm%20deps-0-brightgreen)](package.json)
[![No open ports](https://img.shields.io/badge/network%20listeners-none-blueviolet)](SECURITY.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Forked from robzilla1738/grokbot-notch](https://img.shields.io/badge/fork%20of-robzilla1738%2Fgrokbot--notch-lightgrey?logo=github)](https://github.com/robzilla1738/grokbot-notch)

<img src="docs/screenshots/idle.png" width="320" alt="GrokBot Notch with the Trio agent">

</div>

---

## About this fork

This is a security-hardened, extended fork of [**robzilla1738/grokbot-notch**](https://github.com/robzilla1738/grokbot-notch) by Robert Courson. Credit for the original idea, the notch UI and the Motion Lab characters goes to him.

The original runs a local server on `127.0.0.1:4789` with CORS `*` that forwards your Grok Bot session token, which any website you visit could reach. This fork removes that server entirely. See [SECURITY.md](SECURITY.md) and the [changelog](CHANGELOG.md).

## Screenshots

| Ready | Recording a voice note | Settings |
| :---: | :---: | :---: |
| ![Ready](docs/screenshots/idle.png) | ![Recording](docs/screenshots/recording.png) | ![Settings](docs/screenshots/settings.png) |

## Features

- **Voice calls** with any of your bots over xAI Realtime, with echo cancellation, barge-in and mute.
- **Voice notes**: hold Space, talk, release to send. You can turn on review to listen, discard or re-record first. Transcribed on-device.
- **Chat**: start typing and press Enter.
- **Lives in the notch** on every screen, at menu-bar height, with your agent's photo and a live waveform.
- **Hover to peek**, click outside to close. Unsent drafts keep it open.
- **Settings inside the notch**: voice, speed, sounds, hover, swipe, review voice notes, all screens. Open Grok Bot and Quit are there too, so there's no menu-bar icon.

## Install

Requires [Desktop Grok Bot](#requirements), signed in.

```bash
git clone https://github.com/brahimhamichan/grokbot-notch.git ~/grokbot-notch
cd ~/grokbot-notch
npm run install:app
```

This builds `GrokBot Notch.app`, installs it in `/Applications` and launches it. On first run macOS asks for **Keychain** access (choose *Always Allow*), and later for **Microphone** and **Speech Recognition**.

Prefer to let your Grok Bot do it? See [GROKBOT_SETUP.md](GROKBOT_SETUP.md).

## Shortcuts

| Action | Shortcut |
| :--- | :--- |
| Open / close the notch | `⌥Space`, click, or hover |
| Switch bot | `←` / `→` |
| Start / end a call | `Enter` (when not typing) or `⌘⇧G` |
| Mute during a call | `⌘⇧M` |
| Voice note | Hold `Space`, or tap the mic |
| Type a message | Just start typing, then `Enter` |
| Settings | `⌘,` or the gear |
| Close | `Esc` or click outside |

## How it works

```text
┌────────────── GrokBot Notch.app ──────────────┐
│  WKWebView (gbnotch://, strict CSP)           │
│        ▲  postMessage                          │
│  Swift: panels, hotkeys, audio, Keychain       │
│        ▲  stdin / stdout (JSON lines)          │
│  Bundled Node bridge (server.mjs)              │
└────────┬──────────────────────────┬───────────┘
         ▼                          ▼
  https://api2.cursor.sh     wss://api.x.ai (voice)
```

| Path | What it is |
| :--- | :--- |
| `macos/NotchApp.swift` | Native app: panels, scheme handler, bridge, audio, voice notes, hotkeys |
| `server.mjs` | Zero-dependency bridge to Grok Bot's ConnectRPC API |
| `public/` | Notch UI and Motion Lab character engine |
| `scripts/` | Setup, build and launch |

## Requirements

- macOS 13+ on Apple Silicon. The bundled Node.js is arm64.
- Desktop Grok Bot installed at `/Applications/Grok Bot.app` and signed in.
- Xcode Command Line Tools (`xcode-select --install`).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately per [SECURITY.md](SECURITY.md).

## Disclaimer

An unofficial community project. It is not affiliated with or endorsed by xAI, Grok or Cursor. It uses your own local Grok Bot session.

## License

[MIT](LICENSE). Original work © Robert Courson, fork changes © Brahim Hamichan.
