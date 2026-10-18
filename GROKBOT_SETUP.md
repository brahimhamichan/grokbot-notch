# Setting Up GrokBot Notch with Your Grok Bot

Your **Grok Bot** can install, build and launch GrokBot Notch for you.

## Copy-paste prompt

Paste this into a Grok Bot chat that has local shell tools enabled:

```text
Set up and launch GrokBot Notch on my Mac from https://github.com/brahimhamichan/grokbot-notch — clone it to ~/grokbot-notch, read AGENTS.md, run `npm run install:app`, then confirm ~/Library/Logs/GrokBotNotch/bridge.log shows my bots loaded and the notch is visible at the top of my screen.
```

## What it will do

1. Clone the repo to `~/grokbot-notch`.
2. Check that `swiftc` (Xcode Command Line Tools) is available.
3. Download Node.js at a pinned version, check its SHA-256, and bundle it inside the app.
4. Build `GrokBot Notch.app`, sign it, and copy it to `/Applications`.
5. Launch it. macOS will ask once for Keychain access (choose **Always Allow**), then for Microphone and Speech Recognition when you first use them.

The app opens no network port. See [SECURITY.md](SECURITY.md).
