#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="/tmp/photo-classifier-install"

mkdir -p "$TMP/scripts"
cp "$ROOT/package.json" "$TMP/package.json"
cp "$ROOT/scripts/copy-models.js" "$TMP/scripts/copy-models.js"

cd "$TMP"
npm install
npx electron-rebuild -f -w @tensorflow/tfjs-node || true

mkdir -p "$ROOT/node_modules" "$ROOT/resources/models"
rsync -a --delete "$TMP/node_modules/" "$ROOT/node_modules/"
if [ -d "$TMP/resources/models" ]; then
  rsync -a --delete "$TMP/resources/models/" "$ROOT/resources/models/"
fi
if [ -f "$TMP/package-lock.json" ]; then
  cp "$TMP/package-lock.json" "$ROOT/package-lock.json"
fi

echo "Dependencies copied to $ROOT"
