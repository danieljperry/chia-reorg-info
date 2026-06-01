#!/usr/bin/env bash
#
# One-time helper: extract real serialized block fixtures from a Chia v2
# full_blocks DB for the Phase-2 round-trip tests (tests/chia-real-blocks.test.ts).
#
# Run this on a machine with the real chia DB AND a chia-capable python
# (chiafarmer). It is READ-ONLY against the DB (opens it ?mode=ro indirectly via
# sqlite3 SELECT; never writes). Output goes to tests/fixtures/real_blocks/ in
# this repo, which you then `git add` + commit.
#
# Why the operator must do this: the decode helpers need REAL chia-serialized
# bytes. The `block` column is zstd-compressed, so the bridge puzzle hash only
# appears AFTER decompression — you can't find a bridge block by grepping the
# raw column. So you supply a bridge height from a past bridge alert email; this
# script decompresses + verifies the byte match before committing it.
#
# Usage:
#   scripts/_extract_real_block_fixtures.sh -d <DB_PATH> -c <CANON_HEIGHT> -b <BRIDGE_HEIGHT>
#
#   -d  Path to blockchain_v2_mainnet.sqlite (or set CHIA_DB).
#   -c  CANON_HEIGHT: a normal tx block (non-null timestamp) for the
#       BlockRecord + PoS fixtures. Pick any recent tx height.
#   -b  BRIDGE_HEIGHT: a height whose orphan/canonical block contained a bridge
#       spend (from a past "Bridge Info" alert email). Verified below.
#
# Requires: sqlite3, and a chia-capable python (CHIA_PYTHON, or `which chia`'s
# venv, same resolution as reorg-finder.sh).

set -euo pipefail

BRIDGE_HASH="a09eb1ea8c6e83c0166801dabcf4a70d361cc7f6d89c4a46bcd400ac57719037"

DB_PATH="${CHIA_DB:-}"
CANON_HEIGHT=""
BRIDGE_HEIGHT=""
while getopts "d:c:b:" opt; do
  case "$opt" in
    d) DB_PATH="$OPTARG" ;;
    c) CANON_HEIGHT="$OPTARG" ;;
    b) BRIDGE_HEIGHT="$OPTARG" ;;
    *) echo "see header for usage" >&2; exit 2 ;;
  esac
done

[[ -n "$DB_PATH" && -r "$DB_PATH" ]] || { echo "error: -d DB_PATH (or \$CHIA_DB) must be a readable file" >&2; exit 2; }
[[ "$CANON_HEIGHT" =~ ^[0-9]+$ ]] || { echo "error: -c CANON_HEIGHT must be an integer" >&2; exit 2; }
[[ "$BRIDGE_HEIGHT" =~ ^[0-9]+$ ]] || { echo "error: -b BRIDGE_HEIGHT must be an integer" >&2; exit 2; }
command -v sqlite3 >/dev/null || { echo "error: sqlite3 not found" >&2; exit 2; }

# Resolve chia python (mirror reorg-finder.sh's _resolve_chia_python).
resolve_chia_python() {
  if [[ -n "${CHIA_PYTHON:-}" ]]; then printf '%s' "$CHIA_PYTHON"; return; fi
  local chia_bin shebang interp
  if chia_bin=$(command -v chia 2>/dev/null); then
    shebang=$(head -n 1 "$chia_bin" 2>/dev/null || true)
    if [[ "$shebang" =~ ^\#![[:space:]]*(/[^[:space:]]+) ]]; then
      interp="${BASH_REMATCH[1]}"
      if [[ "$interp" == *python* && -x "$interp" ]]; then printf '%s' "$interp"; return; fi
    fi
  fi
  printf '%s' "python3"
}
PY=$(resolve_chia_python)
"$PY" -c "import chia, chia_rs" 2>/dev/null || {
  echo "error: resolved python ($PY) cannot import chia/chia_rs; set CHIA_PYTHON" >&2; exit 3; }

OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tests/fixtures/real_blocks"
mkdir -p "$OUT_DIR"
echo "Extracting into $OUT_DIR (chia python: $PY)"

# --- helper: dump one blob column for (height) picking the canonical row ---
dump_blob() {  # $1=height $2=column $3=outfile
  local height="$1" col="$2" out="$3"
  sqlite3 "$DB_PATH" \
    "SELECT writefile('$out', $col) FROM full_blocks WHERE height = $height AND in_main_chain = 1 LIMIT 1;" \
    >/dev/null
  [[ -s "$out" ]] || { echo "error: no canonical row / empty $col at height $height" >&2; exit 1; }
}

get_header_hash() {  # $1=height -> hex header_hash of canonical row
  sqlite3 "$DB_PATH" \
    "SELECT lower(hex(header_hash)) FROM full_blocks WHERE height = $1 AND in_main_chain = 1 LIMIT 1;"
}

# --- canonical tx block: block_record (uncompressed) + block (zstd) ---
CANON_HH=$(get_header_hash "$CANON_HEIGHT")
[[ -n "$CANON_HH" ]] || { echo "error: no canonical block at height $CANON_HEIGHT" >&2; exit 1; }
dump_blob "$CANON_HEIGHT" block_record "$OUT_DIR/canonical.block_record.bin"
dump_blob "$CANON_HEIGHT" block        "$OUT_DIR/canonical.block.bin"

# --- bridge block: full block bytes, verified to contain the puzzle hash ---
BRIDGE_HH=$(get_header_hash "$BRIDGE_HEIGHT")
[[ -n "$BRIDGE_HH" ]] || { echo "error: no canonical block at height $BRIDGE_HEIGHT" >&2; exit 1; }
dump_blob "$BRIDGE_HEIGHT" block "$OUT_DIR/bridge.block.bin"

# Decompress the bridge block and confirm the puzzle hash is present in the
# serialized FullBlock bytes (the same byte-search the helper does). If not,
# this height isn't a usable bridge fixture — pick another from your alerts.
"$PY" - "$OUT_DIR/bridge.block.bin" "$BRIDGE_HASH" <<'PYEOF'
import sys
blob = open(sys.argv[1], "rb").read()
target = bytes.fromhex(sys.argv[2])
try:
    import zstd as _z
    raw = _z.decompress(blob)
except Exception:
    import zstandard
    raw = zstandard.ZstdDecompressor().decompress(blob)
# Re-serialize via FullBlock to match exactly what the helper searches.
try:
    from chia.types.full_block import FullBlock
except Exception:
    from chia_rs import FullBlock
fb = FullBlock.from_bytes(raw)
hay = bytes(fb)
if target not in hay and target not in raw:
    sys.stderr.write(
        "error: bridge puzzle hash NOT found in block bytes at this height.\n"
        "       Pick a BRIDGE_HEIGHT from a past 'Bridge Info' alert email.\n"
    )
    sys.exit(1)
print("  bridge byte-match: OK")
PYEOF

# --- golden manifest: decode the canonical BlockRecord so `expect` values are
#     REAL (not guessed). Capture a few stable scalar fields to assert on. ---
"$PY" - \
  "$OUT_DIR/canonical.block_record.bin" \
  "$CANON_HEIGHT" "$CANON_HH" \
  "$BRIDGE_HEIGHT" "$BRIDGE_HH" \
  "$BRIDGE_HASH" \
  > "$OUT_DIR/manifest.json" <<'PYEOF'
import sys, json
br_path, c_h, c_hh, b_h, b_hh, bridge_hash = sys.argv[1:7]
try:
    from chia.consensus.block_record import BlockRecord
except Exception:
    from chia_rs import BlockRecord
br = BlockRecord.from_bytes(open(br_path, "rb").read())
d = br.to_json_dict()
# Pick stable scalar fields that exist on every BlockRecord. Stored as strings
# where the JSON encodes large ints as strings — the test compares as strings.
def g(k):
    v = d.get(k)
    return v
expect = {
    "weight": g("weight"),
    "total_iters": g("total_iters"),
    "signage_point_index": g("signage_point_index"),
    "timestamp": g("timestamp"),
    "header_hash": g("header_hash"),
}
manifest = {
    "canonical": {
        "height": int(c_h),
        "header_hash": c_hh,
        "block_record_bin": "canonical.block_record.bin",
        "block_bin": "canonical.block.bin",
        "expect": expect,
    },
    "bridge": {
        "height": int(b_h),
        "header_hash": b_hh,
        "block_bin": "bridge.block.bin",
        "target_hash": bridge_hash,
    },
}
print(json.dumps(manifest, indent=2))
PYEOF

echo "Done. Files written:"
ls -l "$OUT_DIR"
echo
echo "Sanity-check manifest.json (esp. that timestamp is non-null = tx block),"
echo "then: git add tests/fixtures/real_blocks && git commit"
