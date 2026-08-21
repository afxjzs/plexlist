#!/usr/bin/env bash
# Drive the dialog on a real list page with a stubbed chrome.* API.
#
#   test/run-ui-smoke.sh https://letterboxd.com/arinbicer/list/mcu/ [shot.png]
#
# Verifies what a unit test cannot: that the shadow-DOM panel builds, that
# extraction feeds it, that coverage and the post-create parked state render,
# that a hostile list title is escaped, and that the extension leaves no trace in
# the host page. It does NOT touch Plex — see test/ui-stub.js for the canned
# responses.
set -euo pipefail

URL="${1:?usage: run-ui-smoke.sh <url> [screenshot.png]}"
SHOT="${2:-/private/tmp/plexlist-ui.png}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"

B="$HOME/.claude/skills/gstack/browse/dist/browse"
[ -x "$B" ] || { echo "browse not built at $B" >&2; exit 127; }

# Headed: IMDb 403s headless, and this should behave the same on both sites.
"$B" --headed goto "$URL" >/dev/null
"$B" --headed eval "$HERE/ui-stub.js"     >/dev/null
"$B" --headed eval "$ROOT/src/extract.js" >/dev/null
"$B" --headed eval "$ROOT/src/content.js" >/dev/null
"$B" --headed eval "$HERE/ui-drive.js"    >/dev/null

# One evaluation for the whole interaction. Live list pages run ads that navigate
# the top frame on their own schedule, and a navigation between two separate
# `browse js` calls destroys the execution context mid-test.
OUT="$("$B" --headed js "self.__plexlistDrive()")"
echo "$OUT"

fail() { echo "UI SMOKE FAILED: $1" >&2; exit 1; }
has()  { printf '%s' "$OUT" | grep -q "$1"; }

has '"ready": true'            || fail "panel never reached a ready state"
has '"panelVisible": true'     || fail "panel did not open"
has '"parked": true'           || fail "create button did not park after creating"
has '"againShown": true'       || fail "no way offered to make another playlist"

# Escaping. If these regress, a list title becomes script in the content
# script's privileged world.
has '"fired": 0'               || fail "XSS payload executed"
has '"injectedNode": false'    || fail "XSS payload parsed as markup"
has '"injectedImg": false'     || fail "XSS payload created an element"
has '"renderedAsText": true'   || fail "XSS payload was not rendered as text"

# Footprint. The extension owns one node and nothing else.
has '"rootsInPage": 1'         || fail "expected exactly one #plexlist-root in the page"
has '"strayLightDomNodes": 0'  || fail "leaked nodes into the host page's light DOM"
has '"pageStyleSheetsAdded": 0'|| fail "leaked a stylesheet into the host page"
has '"localStorageKeys": \[\]' || fail "wrote a Plex key into the page's localStorage"
has '"sessionStorageKeys": \[\]' || fail "wrote a Plex key into the page's sessionStorage"
has '"cookieMentionsPlex": false' || fail "wrote a Plex cookie on the host page"

# Screenshot last, and viewport-only: a full-page capture of a list page is
# enormous (measured 2400x9760) and the scrolling can navigate the page.
"$B" --headed screenshot "$SHOT" --viewport >/dev/null
echo "screenshot: $SHOT"

echo "UI SMOKE PASSED for $URL"
