#!/usr/bin/env bash
# Render the Chrome Web Store promo tiles.
#
#   tools/promo-tiles.sh
#   -> store/promo-small-440x280.png
#      store/promo-marquee-1400x560.png
#
# The store requires JPEG or 24-bit PNG with NO alpha channel, at exactly those
# canvas sizes. A screenshot is RGBA, so each render is flattened onto the design
# background and re-encoded as PNG24 — then both properties are verified, because
# an upload rejected for a stray alpha channel is a slow way to learn it was there.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
OUT="$ROOT/store"
mkdir -p "$OUT"

B="$HOME/.claude/skills/gstack/browse/dist/browse"
[ -x "$B" ] || { echo "browse not built at $B" >&2; exit 127; }
command -v magick >/dev/null || { echo "ImageMagick not found" >&2; exit 127; }

BG="#17181b"   # must match .bg in tools/promo.html

# $1 mode (small|marquee), $2 WxH, $3 outfile
tile() {
  local mode="$1" size="$2" out="$3"
  local w="${size%x*}" h="${size#*x}"

  "$B" --headed viewport "$size" >/dev/null
  "$B" --headed goto "file://$HERE/promo.html?mode=$mode" >/dev/null
  # Fonts and the gradient need a beat to paint; the driver's named-function
  # wait is the only form `browse js` reliably returns a value from.
  "$B" --headed eval "$HERE/shot-drive.js" >/dev/null
  "$B" --headed js "self.__plexlistShot.waitPage(1200)" >/dev/null || true

  # Confirm the layout actually switched. The first version of this script used a
  # URL hash, which does not reload the page, so the marquee silently rendered
  # with the small layout and looked plausible enough to miss.
  local cls
  cls="$("$B" --headed js "document.body.className")"
  if ! printf '%s' "$cls" | grep -q "$mode"; then
    echo "layout did not switch for $out (body class is '$cls', expected '$mode')" >&2
    exit 1
  fi

  "$B" --headed screenshot "$out" --viewport >/dev/null

  # Flatten: remove alpha onto the design background, force 24-bit, exact canvas.
  magick "$out" -background "$BG" -alpha remove -alpha off \
    -resize "${w}x${h}^" -gravity center -extent "$size" \
    -strip "PNG24:$out"

  local dims alpha
  dims="$(magick identify -format '%wx%h' "$out")"
  alpha="$(magick identify -format '%A' "$out")"
  [ "$dims" = "$size" ]  || { echo "$out is $dims, expected $size" >&2; exit 1; }
  case "$alpha" in
    False|Undefined) ;;
    *) echo "$out still reports an alpha channel ($alpha)" >&2; exit 1 ;;
  esac
  echo "wrote $out  ($dims, alpha=$alpha)"
}

tile small   440x280   "$OUT/promo-small-440x280.png"
tile marquee 1400x560  "$OUT/promo-marquee-1400x560.png"

# Leave the browser at a sane viewport for the screenshot script.
"$B" --headed viewport 1280x800 >/dev/null
echo
magick identify "$OUT"/promo-*.png
