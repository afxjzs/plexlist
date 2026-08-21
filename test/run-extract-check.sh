#!/usr/bin/env bash
# Run the live extractor check against one URL.
#
#   test/run-extract-check.sh https://www.imdb.com/chart/top/
#
# Uses gstack's `browse` in HEADED mode on purpose: IMDb serves 403 to headless
# Chromium (verified 2026-08-20 — a 49-byte document with no markup), so a
# headless run would report a false failure.
#
# Exits non-zero when the check fails, so it is usable in a pre-release sweep.
set -euo pipefail

URL="${1:?usage: run-extract-check.sh <url>}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"

B="$HOME/.claude/skills/gstack/browse/dist/browse"
[ -x "$B" ] || { echo "browse not built at $B" >&2; exit 127; }

# browse only evaluates files under /private/tmp or the project directory.
# Load both files into the page (eval runs them; its return value is unreliable
# for longer async work), then invoke the check with `js`, which does return it.
"$B" --headed goto "$URL" >/dev/null
"$B" --headed eval "$ROOT/src/extract.js" >/dev/null
"$B" --headed eval "$HERE/extract-check.js" >/dev/null
OUT="$("$B" --headed js "self.__plexlistCheck()")"
echo "$OUT"

# The check reports its own verdict; trust that, not the exit code of `browse`.
if ! printf '%s' "$OUT" | grep -q '"PASS": true'; then
  echo "EXTRACT CHECK FAILED for $URL" >&2
  exit 1
fi
echo "EXTRACT CHECK PASSED for $URL"
