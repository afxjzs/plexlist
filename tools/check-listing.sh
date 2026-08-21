#!/usr/bin/env bash
# Check store/listing.md against the Developer Dashboard's field limits.
#
#   tools/check-listing.sh
#
# Exists because the host permission justification silently ran 180 characters
# over its 1,000 limit and would have been discovered by the paste box refusing
# it. Every fenced block in listing.md is measured against the limit named in the
# table below.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FILE="$ROOT/store/listing.md"
[ -f "$FILE" ] || { echo "missing $FILE" >&2; exit 1; }

python3 - "$FILE" "$ROOT/manifest.json" <<'PY'
import json, re, sys

listing_path, manifest_path = sys.argv[1], sys.argv[2]
text = open(listing_path, encoding="utf-8").read()
blocks = re.findall(r"```\n(.*?)\n```", text, re.S)

# Order matches the fenced blocks in store/listing.md.
LIMITS = [
    ("title",                     132),
    ("summary",                   132),
    ("description",            16_000),
    ("single purpose",          1_000),
    ("storage justification",   1_000),
    ("host permission just.",   1_000),
    ("privacy policy URL",       2_048),
    ("test instructions",          500),
]

if len(blocks) != len(LIMITS):
    print(f"FAIL: expected {len(LIMITS)} fenced blocks, found {len(blocks)}.")
    print("      store/listing.md changed shape; update LIMITS in this script.")
    sys.exit(1)

bad = 0
for (name, limit), body in zip(LIMITS, blocks):
    n = len(body)
    flag = "ok  " if n <= limit else "OVER"
    if n > limit:
        bad += 1
    print(f"  {flag} {name:<24} {n:>6} / {limit}")

# The summary is read from the manifest, so the two must agree or the listing
# documents something the package does not ship.
manifest_desc = json.load(open(manifest_path, encoding="utf-8"))["description"]
if manifest_desc.strip() != blocks[1].strip():
    print("  OVER summary does not match manifest.json description")
    print(f"       manifest: {manifest_desc}")
    print(f"       listing : {blocks[1]}")
    bad += 1

print()
if bad:
    print(f"{bad} problem(s)")
    sys.exit(1)
print("listing fields fit")
PY
