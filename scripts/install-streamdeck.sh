#!/bin/bash
# Installs the GrokBot Notch Stream Deck plugin into the Stream Deck app.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)/streamdeck/com.brahimhamichan.grokbotnotch.sdPlugin"
DST="$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.brahimhamichan.grokbotnotch.sdPlugin"
(cd "$SRC" && npm install --silent --no-audit --no-fund --omit=dev)
rm -rf "$DST"
cp -R "$SRC" "$DST"
echo "Installed. Restart Stream Deck if the GrokBot Notch actions don't appear."
