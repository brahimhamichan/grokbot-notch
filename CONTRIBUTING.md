# Contributing to GrokBot Notch

Bug reports and pull requests are welcome.

## Project structure

- `macos/NotchApp.swift`: AppKit panels (one per screen), WKWebView with the private `gbnotch://` scheme, Node bridge over stdio, Keychain read, AVAudioEngine voice I/O, voice-note recording and on-device transcription, Carbon hotkeys.
- `server.mjs`: zero-dependency Node bridge. Reads requests from stdin, writes responses to stdout, and proxies `GrokBotService` ConnectRPC calls to the allowlisted backend only.
- `public/`: notch UI (`index.html`, `styles.css`, `app.js`) and the Motion Lab character engine (`motion-lab.js`).
- `scripts/`: `setup.sh`, `build-mac-app.sh`, `launch.sh`.

## Development workflow

```bash
npm run build:mac && npm start
```

Bridge logs are in `~/Library/Logs/GrokBotNotch/bridge.log`. There is no localhost server, so the UI can't be opened in a browser.

## Ground rules

- Don't add network listeners, CORS, or new outbound hosts without discussing it in an issue first.
- Never write tokens or Keychain-derived keys to disk or logs.
- Scripts must stop only processes they started (no `pkill`, `killall`, `kill -9`).
- Report security problems privately (see [SECURITY.md](SECURITY.md)).
