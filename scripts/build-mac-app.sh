#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_BUNDLE="$ROOT_DIR/GrokBot Notch.app"
CONTENTS_DIR="$APP_BUNDLE/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

echo "[build] Building GrokBot Notch.app..."
rm -rf "$APP_BUNDLE"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR/app"

cp "$ROOT_DIR/macos/Info.plist" "$CONTENTS_DIR/Info.plist"
if [ -f "/Applications/Grok Bot.app/Contents/Resources/icon.icns" ]; then
  cp "/Applications/Grok Bot.app/Contents/Resources/icon.icns" "$RESOURCES_DIR/icon.icns"
fi

# Security: bundle a pinned Node.js release, verified against its official SHA-256, instead of trusting PATH.
NODE_VERSION="v24.22.0"
NODE_SHA256="6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5"
NODE_DIST="node-$NODE_VERSION-darwin-arm64"
VENDOR_DIR="$ROOT_DIR/vendor"
if [ "$(uname -m)" != "arm64" ]; then
  echo "[error] This build bundles Node.js for Apple Silicon (arm64) only."
  exit 1
fi
if [ ! -x "$VENDOR_DIR/$NODE_DIST/bin/node" ]; then
  mkdir -p "$VENDOR_DIR"
  echo "[build] Downloading Node.js $NODE_VERSION..."
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$NODE_DIST.tar.gz" -o "$VENDOR_DIR/$NODE_DIST.tar.gz"
  echo "$NODE_SHA256  $VENDOR_DIR/$NODE_DIST.tar.gz" | shasum -a 256 -c -
  tar -xzf "$VENDOR_DIR/$NODE_DIST.tar.gz" -C "$VENDOR_DIR"
  rm "$VENDOR_DIR/$NODE_DIST.tar.gz"
fi
mkdir -p "$RESOURCES_DIR/node/bin"
cp "$VENDOR_DIR/$NODE_DIST/bin/node" "$RESOURCES_DIR/node/bin/node"

cp "$ROOT_DIR/server.mjs" "$RESOURCES_DIR/app/server.mjs"
cp "$ROOT_DIR/package.json" "$RESOURCES_DIR/app/package.json"
cp -R "$ROOT_DIR/public" "$RESOURCES_DIR/app/public"

swiftc -O \
  -framework Cocoa \
  -framework WebKit \
  -framework AVFoundation \
  -framework Carbon \
  "$ROOT_DIR/macos/NotchApp.swift" \
  -o "$MACOS_DIR/GrokBotNotch"

# Auto-detect Developer ID / Apple Development certificate, or fall back to ad-hoc signing
SIGN_ID="${CODESIGN_IDENTITY:-}"
if [ -z "$SIGN_ID" ]; then
  SIGN_ID="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -n 1 || true)"
fi
if [ -z "$SIGN_ID" ]; then
  SIGN_ID="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' | head -n 1 || true)"
fi

if [ -n "$SIGN_ID" ]; then
  echo "[build] Signing with $SIGN_ID..."
  codesign --force --options runtime \
    --entitlements "$ROOT_DIR/macos/entitlements.plist" \
    --sign "$SIGN_ID" \
    "$APP_BUNDLE"
else
  echo "[build] Signing ad-hoc with entitlements..."
  codesign --force \
    --entitlements "$ROOT_DIR/macos/entitlements.plist" \
    --sign - \
    "$APP_BUNDLE"
fi

echo "[build] Built successfully: $APP_BUNDLE"
