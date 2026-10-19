# Changelog

## Unreleased
- Stream Deck plugin: Call Agent (press to call, hold to mute, animated key with live waveform), Mute and Open Notch actions, over a private owner-only Unix socket.
- Keyboard Shortcuts screen in settings: change the open-notch and call shortcuts, set a shortcut per agent to call it directly, and see every in-notch key.

## 1.1.0 (hardened fork)

### Security
- Replaced the `127.0.0.1:4789` HTTP server (CORS `*`) with a private stdio bridge and `gbnotch://` scheme.
- Keychain key read natively and kept in memory only; legacy on-disk copy purged.
- Outbound host allowlist, strict CSP, blocked navigation, mic restricted to the app page.
- Pinned, checksum-verified bundled Node.js; removed `NSAllowsArbitraryLoads`; no process-killing in scripts.

### Features
- Two-way voice calls with echo cancellation, mute (`⌘⇧M`) and `⌘⇧G` to start or end a call.
- Voice notes: hold Space or tap the mic. Sends on release, or review first (listen, discard, re-record, send).
- Live waveforms that follow call audio and stay still when idle.
- Real agent profile photos.
- Hover to open and close, click outside to close; unsent drafts keep it open.
- Notch on every screen, at menu-bar height.
- In-notch settings (`⌘,`): voice, speed, sounds, hover, swipe to switch, review voice notes, all screens. Open Grok Bot and Quit from the notch.

## 1.0.0
- Initial release by [Robert Courson](https://github.com/robzilla1738/grokbot-notch).
