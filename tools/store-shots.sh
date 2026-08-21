#!/usr/bin/env bash
# Render the Chrome Web Store screenshots at the required 1280x800.
#
#   tools/store-shots.sh
#   -> store/screenshot-1-imdb.png
#      store/screenshot-2-letterboxd.png
#      store/screenshot-3-created.png
#
# Uses the same stubbed chrome.* as the smoke test, so the panel shows realistic
# numbers without touching a Plex account. Server names are fictional on purpose:
# these images get published, and a real server name has no business in one.
#
# Every wait is short and repeated rather than one long one — `browse js` has its
# own timeout and returns nothing if a promise outlives it, which looks exactly
# like a page that never loaded. The panel state is checked before each capture,
# so a half-rendered panel fails the run instead of becoming the listing image.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
OUT="$ROOT/store"
mkdir -p "$OUT"

B="$HOME/.claude/skills/gstack/browse/dist/browse"
[ -x "$B" ] || { echo "browse not built at $B" >&2; exit 127; }

js() { "$B" --headed js "$1"; }

# Repeatedly call a short in-page wait until it reports success.
# $1 = js expression returning the success token, $2 = token, $3 = attempts
spin() {
  local i out
  for ((i = 1; i <= $3; i++)); do
    out="$(js "$1" || true)"
    printf '%s' "$out" | grep -q "$2" && return 0
  done
  return 1
}

# Setting the viewport rebuilds the browser context, so do it once up front and
# let a warm-up navigation absorb the cost.
"$B" --headed viewport 1280x800 >/dev/null
"$B" --headed goto "https://www.imdb.com/chart/top/" >/dev/null

# $1 url, $2 outfile, $3 server name, $4 "created" to also click Create
shoot() {
  local url="$1" out="$2" server="$3" mode="${4:-}"

  "$B" --headed goto "$url" >/dev/null

  # Load the driver first: `browse js` only returns a value when it calls a named
  # function, so every wait has to go through this object rather than an inline
  # expression.
  "$B" --headed eval "$HERE/shot-drive.js" >/dev/null
  spin "self.__plexlistShot.waitPage(8000)" 'PAGEREADY' 6 \
    || { echo "page never loaded: $url" >&2; exit 1; }

  "$B" --headed eval "$ROOT/test/ui-stub.js" >/dev/null
  "$B" --headed eval "$ROOT/src/extract.js"  >/dev/null
  "$B" --headed eval "$ROOT/src/content.js"  >/dev/null
  "$B" --headed eval "$HERE/shot-drive.js"   >/dev/null

  js "self.__plexlistShot.open()" >/dev/null

  # Letterboxd is the slow case: resolving unmatched films costs one page fetch
  # each, so allow well over a minute in 8s slices.
  spin "self.__plexlistShot.waitCovered(8000)" 'COVERED' 15 \
    || { echo "coverage never rendered for $out" >&2; exit 1; }

  js "self.__plexlistShot.rename('$server')" >/dev/null

  if [ "$mode" = "created" ]; then
    js "self.__plexlistShot.create()" >/dev/null
    spin "self.__plexlistShot.waitCreated(8000)" 'CREATED' 6 \
      || { echo "create never completed for $out" >&2; exit 1; }
    js "self.__plexlistShot.rename('$server')" >/dev/null
  fi

  # A store listing should not feature somebody else's ad creative.
  "$B" --headed cleanup --ads >/dev/null 2>&1 || true

  "$B" --headed screenshot "$out" --viewport >/dev/null

  local dims
  dims="$(magick identify -format '%wx%h' "$out")"
  if [ "$dims" != "1280x800" ]; then
    magick "$out" -resize 1280x800^ -gravity center -extent 1280x800 "$out"
    echo "  (rescaled from $dims)"
  fi
  echo "wrote $out"
}

shoot "https://www.imdb.com/chart/top/"            "$OUT/screenshot-1-imdb.png"       "Living Room"
shoot "https://letterboxd.com/arinbicer/list/mcu/" "$OUT/screenshot-2-letterboxd.png" "Living Room"
shoot "https://www.imdb.com/chart/top/"            "$OUT/screenshot-3-created.png"    "Living Room" created

# Server names come from test/ui-stub.js and the fictional values above, never
# from a real Plex account — the stub is the only source of server data during a
# render, so there is no real name available to leak.
echo
magick identify "$OUT"/screenshot-*.png
