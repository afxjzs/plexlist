#!/usr/bin/env bash
# Regenerate the PNG icons from icon.svg.
#
#   icons/build.sh
#
# Chrome wants PNG, and the Web Store listing requires the 128px one. Needs
# rsvg-convert (brew install librsvg).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v rsvg-convert >/dev/null || { echo "rsvg-convert not found (brew install librsvg)" >&2; exit 127; }

for size in 16 32 48 128; do
  rsvg-convert -w "$size" -h "$size" "$HERE/icon.svg" -o "$HERE/icon-${size}.png"
  echo "wrote icon-${size}.png"
done
