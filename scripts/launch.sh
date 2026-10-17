#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_BUNDLE="/Applications/GrokBot Notch.app"
[ -d "$APP_BUNDLE" ] || APP_BUNDLE="$ROOT_DIR/GrokBot Notch.app"

if [ ! -d "$APP_BUNDLE" ]; then
  "$ROOT_DIR/scripts/build-mac-app.sh"
fi

# The app starts its own private Node bridge over stdio; there is no server or port to manage.
osascript -e 'quit app id "com.rcourson.grokbot-notch"' 2>/dev/null || true
open "$APP_BUNDLE"
echo "GrokBot Notch.app is now running at the top of your screen!"
