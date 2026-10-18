# Security

## Model

GrokBot Notch handles your Grok Bot session token, so it is built to keep it on your Mac and in as few places as possible.

| Concern | How it's handled |
| :--- | :--- |
| Other websites or apps reaching your session | No HTTP server or open port. The UI and the Node bridge talk over private stdin/stdout pipes. |
| The page being hijacked | UI loads from an app-private `gbnotch://` scheme with a strict CSP (`connect-src 'self' wss://api.x.ai`). Navigation away is blocked and website data isn't persisted. |
| Token sent to the wrong host | Outbound requests carrying it are allowlisted to `https://api2.cursor.sh`. Environment overrides are disabled. |
| Keychain key at rest | Read by the signed app via the macOS Keychain prompt, passed over the pipe, held in memory only. Old on-disk copies are deleted on start. |
| Microphone | Only the `gbnotch://` page may use it. Voice-note transcription runs on-device where macOS supports it, and only the text is sent. |
| Supply chain | No npm dependencies. Node.js is bundled at a pinned version, verified by SHA-256. |

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's **Report a vulnerability** button under the repo's Security tab, or email brahim@scalingadventures.com. You'll get a reply within a few days.
