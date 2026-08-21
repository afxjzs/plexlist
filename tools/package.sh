#!/usr/bin/env bash
# Build the Chrome Web Store upload zip.
#
#   tools/package.sh
#   -> dist/plexlist-<version>.zip
#
# Ships only what the extension needs at runtime. Tests, docs and repo furniture
# stay out, both to keep the upload small and so nothing local is ever bundled by
# accident.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./manifest.json').version")"
OUT="dist/plexlist-${VERSION}.zip"

# Refuse to package if the icons are missing or stale relative to the source SVG:
# an upload rejected by the store for a missing 128px icon is a slow way to find
# out.
for size in 16 32 48 128; do
  [ -f "icons/icon-${size}.png" ] || { echo "missing icons/icon-${size}.png — run icons/build.sh" >&2; exit 1; }
  if [ "icons/icon.svg" -nt "icons/icon-${size}.png" ]; then
    echo "icons/icon-${size}.png is older than icon.svg — run icons/build.sh" >&2
    exit 1
  fi
done

# The manifest is the contract; if it does not parse, stop before zipping.
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))" \
  || { echo "manifest.json is not valid JSON" >&2; exit 1; }

mkdir -p dist
rm -f "$OUT"

zip -q -r "$OUT" \
  manifest.json \
  src \
  icons/icon-16.png icons/icon-32.png icons/icon-48.png icons/icon-128.png \
  LICENSE \
  -x '*.DS_Store'

echo "wrote $OUT"
unzip -l "$OUT"
