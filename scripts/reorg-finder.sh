#!/usr/bin/env bash
# reorg-finder.sh — scan the local Chia full-node DB for heights that
# have multiple blocks (i.e. re-orged heights with orphaned siblings).
#
# Requires read access to a Chia v2 full-node database file. By default this
# is the mainnet DB at ~/.chia/mainnet/db/blockchain_v2_mainnet.sqlite; pass
# -d to point at a different path (e.g. testnet11 or a copy on another disk).
#
# Step 1: find heights in the range that have >1 block.
# Step 2: for each such height, walk backward one block at a time (up to LIMIT
#         blocks) so a re-org that extends below the queried range is captured
#         in full. Group consecutive re-orged heights into clusters; each
#         cluster is one re-org event whose size is the cluster length.
# Step 3: list every block at the resulting heights with their hashes and
#         whether they're on the canonical chain.
#
# Note: timestamps in the reorg summary are approximate. Chia only stores a
# timestamp on transaction blocks; the other ~2/3 of blocks are non-tx and
# have no timestamp of their own, so the script walks forward to the nearest
# tx block and uses its timestamp as a proxy.
#
# Usage:
#   ./reorg-finder.sh [-n COUNT] [-e END_HEIGHT] [-l LIMIT] [-m MIN_DEPTH]
#                     [-q [true|false]] [-qq [true|false]] [-d DB_PATH]
#                     [--json] [--peak-from rpc|db] [--compare-proofs]
#
#   -n COUNT       Number of blocks to examine (default: 10). Pass `g` or
#                  `genesis` to scan every block from END_HEIGHT down to the
#                  genesis block (height 0).
#   -e END_HEIGHT  Highest height to examine (default: full node peak via RPC)
#   -l LIMIT       Maximum reorg depth to search (max blocks to walk backward
#                  per cluster). Does not typically need to be modified
#                  (default: 100)
#   -m MIN_DEPTH   Only report reorgs of at least this many blocks; shallower
#                  reorgs are silently dropped (default: 1)
#   -q [true|false] quiet: suppress the per-block detail section (default:
#                  false — detail is shown). Invoke as bare `-q` or `-q true`
#                  to suppress; `-q false` is the explicit default.
#   -qq [true|false] super-quiet: output ONLY a one-line summary
#                  "Found <n> reorgs of at least <m> blocks in the specified
#                  range." and nothing else (default: false). Invoke as bare
#                  `-qq` or `-qq true`. Overrides -q.
#   -d DB_PATH     Path to blockchain_v2_mainnet.sqlite (overrides CHIA_DB env)
#   --json         Emit a single JSON object to stdout and nothing else.
#                  Suppresses the prose report. Intended for programmatic
#                  consumers (e.g. the reorg_monitor's local poller).
#                  Incompatible with -q and -qq.
#   --peak-from rpc|db  When -e is not given, source the peak height from
#                  the full-node RPC (default, rpc) or from the local DB via
#                  `SELECT MAX(height) FROM full_blocks` (db). `db` avoids
#                  any RPC dependency — useful for monitor-driven use.
#   --compare-proofs  For each reorg, compare the proof-of-space at the
#                  cluster's top height between the canonical and orphaned
#                  blocks. Appends " — Proofs match" / " — Proofs don't
#                  match" to each per-reorg summary line, adds a totals
#                  line under "Found N reorgs:", and (when -q is not set)
#                  shows a per-cluster verdict in the per-block-detail
#                  section. Requires chia-blockchain Python package.
#                  Default: disabled.
#   -h             Show this help
#
# Environment overrides (CLI flags take precedence):
#   CHIA_DB        Path to blockchain_v2_mainnet.sqlite
#                  (default: ~/.chia/mainnet/db/blockchain_v2_mainnet.sqlite)
#   CHIA_SSL_DIR   Path to full-node SSL dir
#                  (default: ~/.chia/mainnet/config/ssl/full_node)
#   NODE_HOST      Full node RPC base URL (default: https://localhost:8555)

main() {
  set -euo pipefail

  # `${BASH_SOURCE[0]}` always points at this file even when sourced ($0
  # would be the parent shell's name in that case).
  local SCRIPT_PATH="${BASH_SOURCE[0]}"
  local COUNT=10
  local END_HEIGHT=""
  local LIMIT=100
  local MIN_DEPTH=1
  local QUIET="false"
  local QQ_QUIET="false"
  local JSON_OUT="false"
  local PEAK_FROM="rpc"
  local COMPARE_PROOFS="false"
  local DB_PATH="${CHIA_DB:-$HOME/.chia/mainnet/db/blockchain_v2_mainnet.sqlite}"
  local SSL_DIR="${CHIA_SSL_DIR:-$HOME/.chia/mainnet/config/ssl/full_node}"
  local CERT_PATH="$SSL_DIR/private_full_node.crt"
  local KEY_PATH="$SSL_DIR/private_full_node.key"
  local NODE_HOST="${NODE_HOST:-https://localhost:8555}"

  usage() {
    sed -n '2,/^$/p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
  }

# Pre-process argv:
#   - `-qq`, `--json`, `--peak-from` are multi-char flags getopts can't handle,
#     so we consume them directly into local state and drop them from the arg
#     list. They never reach getopts.
#   - `-q` (without a value) is normalized to `-q true`, so the rest of the
#     code can treat -q uniformly as a value-required option.
local PRE_ARGS=()
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-qq" ]]; then
    case "${2:-}" in
      ""|-*)  QQ_QUIET="true"; shift ;;
      *)      QQ_QUIET="$2"; shift 2 ;;
    esac
  elif [[ "$1" == "--json" ]]; then
    JSON_OUT="true"
    shift
  elif [[ "$1" == "--peak-from" ]]; then
    if [[ -z "${2:-}" ]]; then
      echo "Error: --peak-from requires a value (rpc or db)" >&2
      exit 2
    fi
    PEAK_FROM="$2"
    shift 2
  elif [[ "$1" == "--compare-proofs" ]]; then
    COMPARE_PROOFS="true"
    shift
  elif [[ "$1" == "-q" ]]; then
    PRE_ARGS+=("-q")
    case "${2:-}" in
      ""|-*)
        PRE_ARGS+=("true")
        shift
        ;;
      *)
        PRE_ARGS+=("$2")
        shift 2
        ;;
    esac
  else
    PRE_ARGS+=("$1")
    shift
  fi
done
set -- "${PRE_ARGS[@]}"

while getopts ":n:e:l:m:q:d:h" opt; do
  case "$opt" in
    n) COUNT="$OPTARG" ;;
    e) END_HEIGHT="$OPTARG" ;;
    l) LIMIT="$OPTARG" ;;
    m) MIN_DEPTH="$OPTARG" ;;
    q) QUIET="$OPTARG" ;;
    d) DB_PATH="$OPTARG" ;;
    h) usage 0 ;;
    :) echo "Error: -$OPTARG requires a value" >&2; usage 2 ;;
    \?) echo "Error: unknown option -$OPTARG" >&2; usage 2 ;;
  esac
done

if [[ "${COUNT,,}" == "g" || "${COUNT,,}" == "genesis" ]]; then
  # Defer resolution until END_HEIGHT is known (could be RPC-supplied below).
  COUNT="genesis"
elif ! [[ "$COUNT" =~ ^[0-9]+$ ]] || [[ "$COUNT" -lt 1 ]]; then
  echo "Error: -n COUNT must be a positive integer, or 'g'/'genesis' (got: $COUNT)" >&2
  exit 2
fi

if ! [[ "$LIMIT" =~ ^[0-9]+$ ]] || [[ "$LIMIT" -lt 0 ]]; then
  echo "Error: -l LIMIT must be a non-negative integer (got: $LIMIT)" >&2
  exit 2
fi

if ! [[ "$MIN_DEPTH" =~ ^[0-9]+$ ]] || [[ "$MIN_DEPTH" -lt 1 ]]; then
  echo "Error: -m MIN_DEPTH must be a positive integer (got: $MIN_DEPTH)" >&2
  exit 2
fi

# Normalise QUIET to "true" or "false".
case "${QUIET,,}" in
  true|1|yes|y)  QUIET="true" ;;
  false|0|no|n)  QUIET="false" ;;
  *)
    echo "Error: -q quiet must be true or false (got: $QUIET)" >&2
    exit 2
    ;;
esac

# Normalise QQ_QUIET to "true" or "false".
case "${QQ_QUIET,,}" in
  true|1|yes|y)  QQ_QUIET="true" ;;
  false|0|no|n)  QQ_QUIET="false" ;;
  *)
    echo "Error: -qq must be true or false (got: $QQ_QUIET)" >&2
    exit 2
    ;;
esac

# Validate --peak-from value.
case "$PEAK_FROM" in
  rpc|db) ;;
  *)
    echo "Error: --peak-from must be 'rpc' or 'db' (got: $PEAK_FROM)" >&2
    exit 2
    ;;
esac

# --json is incompatible with -q / -qq (predictable behavior).
if [[ "$JSON_OUT" == "true" ]] && { [[ "$QUIET" == "true" ]] || [[ "$QQ_QUIET" == "true" ]]; }; then
  echo "Error: --json is incompatible with -q / -qq" >&2
  exit 2
fi

if [[ -z "$END_HEIGHT" ]]; then
  if [[ "$PEAK_FROM" == "db" ]]; then
    # Local-only peak: SELECT MAX(height) FROM full_blocks. Requires the DB
    # to be readable (checked further below); error out cleanly here if not.
    if [[ ! -r "$DB_PATH" ]]; then
      echo "Error: --peak-from db requires a readable DB at $DB_PATH (set -d / CHIA_DB)" >&2
      exit 1
    fi
    END_HEIGHT=$(sqlite3 "file:${DB_PATH}?mode=ro" "SELECT MAX(height) FROM full_blocks;")
    if [[ -z "$END_HEIGHT" ]] || [[ "$END_HEIGHT" == "" ]]; then
      echo "Error: --peak-from db returned no rows (is the DB populated?)" >&2
      exit 1
    fi
    [[ "$QQ_QUIET" == "false" && "$JSON_OUT" == "false" ]] && echo "Resolved peak height from DB: $END_HEIGHT"
  else
    if [[ ! -r "$CERT_PATH" || ! -r "$KEY_PATH" ]]; then
      echo "Error: full-node SSL credentials not readable at:" >&2
      echo "  $CERT_PATH" >&2
      echo "  $KEY_PATH" >&2
      echo "Pass -e END_HEIGHT, set CHIA_SSL_DIR, or use --peak-from db." >&2
      exit 1
    fi
    END_HEIGHT=$(curl -sk -X POST \
      --cert "$CERT_PATH" --key "$KEY_PATH" \
      "${NODE_HOST}/get_blockchain_state" \
      -H 'Content-Type: application/json' -d '{}' \
      | python3 -c 'import sys, json; print(json.load(sys.stdin)["blockchain_state"]["peak"]["height"])')
    [[ "$QQ_QUIET" == "false" && "$JSON_OUT" == "false" ]] && echo "Fetched peak height from full node RPC: $END_HEIGHT"
  fi
fi

if ! [[ "$END_HEIGHT" =~ ^[0-9]+$ ]]; then
  echo "Error: END_HEIGHT must be a non-negative integer (got: $END_HEIGHT)" >&2
  exit 2
fi

# Resolve `-n genesis` now that END_HEIGHT is known: scan from 0..END_HEIGHT.
if [[ "$COUNT" == "genesis" ]]; then
  COUNT=$((END_HEIGHT + 1))
fi

START_HEIGHT=$((END_HEIGHT - COUNT + 1))
if [[ "$START_HEIGHT" -lt 0 ]]; then
  START_HEIGHT=0
fi

if [[ "$QQ_QUIET" == "false" && "$JSON_OUT" == "false" ]]; then
  echo "Scanning heights $START_HEIGHT..$END_HEIGHT ($((END_HEIGHT - START_HEIGHT + 1)) blocks) in $DB_PATH"
  echo
fi

if [[ ! -r "$DB_PATH" ]]; then
  echo "No database file found at $DB_PATH."
  echo
  echo "This script requires access to a Chia v2 full-node database file."
  echo "Default location: ~/.chia/mainnet/db/blockchain_v2_mainnet.sqlite"
  echo "Use -d to point at a different location."
  exit 1
fi

# Step 1: every height in the queried range that has >1 block, ascending.
IN_RANGE_HEIGHTS=$(sqlite3 "file:${DB_PATH}?mode=ro" <<SQL
SELECT height FROM full_blocks
WHERE height BETWEEN $START_HEIGHT AND $END_HEIGHT
GROUP BY height
HAVING COUNT(*) > 1
ORDER BY height;
SQL
)

if [[ -z "$IN_RANGE_HEIGHTS" ]]; then
  if [[ "$JSON_OUT" == "true" ]]; then
    printf '{"network":"mainnet","start_height":%d,"end_height":%d,"scanned_at_unix":%d,"peak_at_scan":%d,"reorgs":[]}\n' \
      "$START_HEIGHT" "$END_HEIGHT" "$(date +%s)" "$END_HEIGHT"
  elif [[ "$QQ_QUIET" == "true" ]]; then
    echo "Found 0 reorgs of at least $MIN_DEPTH blocks in the specified range."
  else
    echo "No re-orged heights found in range."
  fi
  exit 0
fi

# Group consecutive in-range heights into clusters. Each cluster is one
# re-org event; its eventual size is high - low + 1 after backward extension.
CLUSTER_LOWS=()
CLUSTER_HIGHS=()
prev=""
for h in $IN_RANGE_HEIGHTS; do
  if [[ -z "$prev" ]] || [[ $((h - prev)) -ne 1 ]]; then
    CLUSTER_LOWS+=("$h")
    CLUSTER_HIGHS+=("$h")
  else
    CLUSTER_HIGHS[-1]=$h
  fi
  prev=$h
done

# Step 2: for each cluster, walk backward to extend it past the queried range.
# Query the LIMIT-wide window below the cluster's low in one shot, then walk
# the descending result while each row is exactly one less than the last.
for i in "${!CLUSTER_LOWS[@]}"; do
  low="${CLUSTER_LOWS[$i]}"
  walk_from=$((low - 1))
  walk_to=$((low - LIMIT))
  if [[ $walk_to -lt 0 ]]; then walk_to=0; fi
  if [[ $walk_from -lt 0 ]] || [[ $LIMIT -eq 0 ]]; then continue; fi

  BELOW=$(sqlite3 "file:${DB_PATH}?mode=ro" <<SQL
SELECT height FROM full_blocks
WHERE height BETWEEN $walk_to AND $walk_from
GROUP BY height
HAVING COUNT(*) > 1
ORDER BY height DESC;
SQL
)

  expected=$walk_from
  for h in $BELOW; do
    if [[ $h -eq $expected ]]; then
      low=$h
      expected=$((expected - 1))
    else
      break
    fi
  done
  CLUSTER_LOWS[$i]=$low
done

# Apply min_depth filter: drop clusters whose final size is below MIN_DEPTH.
KEPT_LOWS=()
KEPT_HIGHS=()
for i in "${!CLUSTER_LOWS[@]}"; do
  size=$((CLUSTER_HIGHS[$i] - CLUSTER_LOWS[$i] + 1))
  if [[ $size -ge $MIN_DEPTH ]]; then
    KEPT_LOWS+=("${CLUSTER_LOWS[$i]}")
    KEPT_HIGHS+=("${CLUSTER_HIGHS[$i]}")
  fi
done
if [[ ${#KEPT_LOWS[@]} -eq 0 ]]; then
  if [[ "$JSON_OUT" == "true" ]]; then
    printf '{"network":"mainnet","start_height":%d,"end_height":%d,"scanned_at_unix":%d,"peak_at_scan":%d,"reorgs":[]}\n' \
      "$START_HEIGHT" "$END_HEIGHT" "$(date +%s)" "$END_HEIGHT"
  elif [[ "$QQ_QUIET" == "true" ]]; then
    echo "Found 0 reorgs of at least $MIN_DEPTH blocks in the specified range."
  elif [[ $MIN_DEPTH -eq 1 ]]; then
    echo "No re-orged heights found in range."
  else
    echo "No reorgs of depth >= $MIN_DEPTH found in range."
  fi
  exit 0
fi
CLUSTER_LOWS=("${KEPT_LOWS[@]}")
CLUSTER_HIGHS=("${KEPT_HIGHS[@]}")

# Build a flat comma-separated list of every cluster height for the detail query.
HEIGHT_LIST=""
for i in "${!CLUSTER_LOWS[@]}"; do
  for ((h=CLUSTER_LOWS[i]; h<=CLUSTER_HIGHS[i]; h++)); do
    HEIGHT_LIST+="$h,"
  done
done
HEIGHT_LIST="${HEIGHT_LIST%,}"

# Look up the timestamp of the block at exactly `height` via full_node RPC.
# Returns the unix integer timestamp on success, or empty string if the block
# is non-tx (timestamp null), missing, or any RPC call failed. Tries the local
# node first (when SSL credentials exist), then falls back to public coinset.
_lookup_one_timestamp() {
  local h=$1 out ts
  out=""
  if [[ -r "$CERT_PATH" && -r "$KEY_PATH" ]]; then
    out=$(curl -sk -X POST --cert "$CERT_PATH" --key "$KEY_PATH" \
      "${NODE_HOST}/get_block_record_by_height" \
      -H 'Content-Type: application/json' \
      -d "{\"height\":$h}" 2>/dev/null || true)
  fi
  if [[ -z "$out" ]]; then
    out=$(curl -s -X POST \
      "https://api.coinset.org/get_block_record_by_height" \
      -H 'Content-Type: application/json' \
      -d "{\"height\":$h}" 2>/dev/null || true)
  fi
  ts=$(printf '%s' "$out" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    br = d.get("block_record")
    ts = (br or {}).get("timestamp")
    print(ts if ts is not None else "")
except Exception:
    print("")
' 2>/dev/null || true)
  [[ "$ts" == "None" ]] && ts=""
  # Reject anything that isn't a non-negative integer. The result is later
  # interpolated into a `python3 -c` template (format_local_time) and emitted
  # unquoted into JSON (--json mode), so an attacker-controlled non-numeric
  # value would be RCE in one path and JSON corruption in the other. The
  # upstream RPCs (localhost full node via `curl -sk`, plus coinset fallback)
  # are not fully trusted for the purposes of code-eval, so validate here.
  if [[ -n "$ts" ]] && ! [[ "$ts" =~ ^[0-9]+$ ]]; then
    ts=""
  fi
  printf '%s' "$ts"
}

# Walk FORWARD up to 16 heights from `start_height`, returning the first
# tx block's timestamp. Used as the natural "approximately at this height"
# anchor for a re-org range when start_height is itself a non-tx block.
get_block_timestamp() {
  local start_height=$1 i h ts
  for ((i = 0; i < 16; i++)); do
    h=$((start_height + i))
    ts=$(_lookup_one_timestamp "$h")
    if [[ -n "$ts" ]]; then
      printf '%s' "$ts"
      return 0
    fi
  done
  printf ''
}

# Walk BACKWARD up to 16 heights from `start_height`, returning the first
# tx block's timestamp. Used to break a timestamp tie when both the low and
# high of a multi-block re-org walked forward to the same downstream tx block.
get_block_timestamp_backward() {
  local start_height=$1 i h ts
  for ((i = 0; i < 16; i++)); do
    h=$((start_height - i))
    if [[ $h -lt 0 ]]; then break; fi
    ts=$(_lookup_one_timestamp "$h")
    if [[ -n "$ts" ]]; then
      printf '%s' "$ts"
      return 0
    fi
  done
  printf ''
}

# Format a unix timestamp as local-time "YYYY-MM-DD HH:MM:SS ZZZ".
# Returns "n/a" for empty input.
format_local_time() {
  local ts=$1
  if [[ -z "$ts" ]]; then
    echo "n/a"
  else
    python3 -c "
from datetime import datetime
print(datetime.fromtimestamp($ts).astimezone().strftime('%Y-%m-%d %H:%M:%S %Z'))
"
  fi
}

# Format a unix-timestamp pair as "(YYYY-MM-DD HH:MM:SS to HH:MM:SS TZ)" when
# both fall on the same local date, or "(YYYY-MM-DD HH:MM:SS TZ to YYYY-MM-DD
# HH:MM:SS TZ)" when they don't. Always emits two timestamps, even if equal.
# Either side may be empty → renders as "n/a".
format_range() {
  TS_LOW=$1 TS_HIGH=$2 python3 -c "
import os
from datetime import datetime
def parse(t):
    if not t:
        return None
    try:
        return datetime.fromtimestamp(int(t)).astimezone()
    except Exception:
        return None
a = parse(os.environ['TS_LOW'])
b = parse(os.environ['TS_HIGH'])
full = '%Y-%m-%d %H:%M:%S %Z'
if a is None and b is None:
    print('(n/a to n/a)')
elif a is None:
    print(f\"(n/a to {b.strftime(full)})\")
elif b is None:
    print(f\"({a.strftime(full)} to n/a)\")
elif a.date() == b.date():
    print(f\"({a.strftime('%Y-%m-%d %H:%M:%S')} to {b.strftime('%H:%M:%S')} {a.strftime('%Z')})\")
else:
    print(f\"({a.strftime(full)} to {b.strftime(full)})\")
"
}

# Build the "(...)" suffix for a height range: one timestamp for a 1-block
# cluster, always two (with date condensed when shared) for multi-block.
#
# If the forward-walked timestamps for low and high collide — i.e. both
# heights are non-tx and walked forward to the same downstream tx block —
# walk BACKWARD from the lowest re-orged height to find an earlier tx
# block, and use its timestamp for the "start" side. That guarantees the
# two timestamps are distinct whenever the chain supplies the data.
fmt_ts_suffix() {
  local low=$1 high=$2
  local ts_low ts_high ts_pre
  ts_low=$(get_block_timestamp "$low")
  if [[ "$low" -eq "$high" ]]; then
    echo "($(format_local_time "$ts_low"))"
  else
    ts_high=$(get_block_timestamp "$high")
    if [[ -n "$ts_low" && -n "$ts_high" && "$ts_low" == "$ts_high" ]]; then
      ts_pre=$(get_block_timestamp_backward "$low")
      if [[ -n "$ts_pre" ]]; then
        ts_low="$ts_pre"
      fi
    fi
    format_range "$ts_low" "$ts_high"
  fi
}

# Report.
N_CLUSTERS=${#CLUSTER_LOWS[@]}

# JSON output: emit a single object and exit. No prose, no per-block detail.
# Schema matches what the reorg_monitor's local poller expects.
if [[ "$JSON_OUT" == "true" ]]; then
  # Resolve a timestamp for each cluster's low+high in unix-seconds form.
  # Resolution is the same forward-walk used by the prose report, so the
  # JSON values represent the same anchor points.
  #
  # Also resolve the orphaned (`old_hash`) and canonical (`new_hash`) header
  # hashes at the cluster's top height (`high`). Both are queryable from the
  # DB because the whole reason `high` is in our cluster is that it has
  # multiple block records. Hashes are returned without `0x` prefix and
  # lowercased; either may be null if the row vanishes mid-scan (defensive).
  json_reorgs=""
  for i in "${!CLUSTER_LOWS[@]}"; do
    low="${CLUSTER_LOWS[$i]}"
    high="${CLUSTER_HIGHS[$i]}"
    depth=$((high - low + 1))
    ts_low=$(get_block_timestamp "$low")
    if [[ "$low" -eq "$high" ]]; then
      ts_high="$ts_low"
    else
      ts_high=$(get_block_timestamp "$high")
    fi
    [[ -z "$ts_low" ]] && ts_low="null"
    [[ -z "$ts_high" ]] && ts_high="null"
    old_hash=$(sqlite3 "file:${DB_PATH}?mode=ro" \
      "SELECT lower(hex(header_hash)) FROM full_blocks WHERE height = $high AND in_main_chain = 0 LIMIT 1;")
    new_hash=$(sqlite3 "file:${DB_PATH}?mode=ro" \
      "SELECT lower(hex(header_hash)) FROM full_blocks WHERE height = $high AND in_main_chain = 1 LIMIT 1;")
    # Safe to wrap in literal quotes without escaping: lower(hex(...)) returns
    # only [0-9a-f], no JSON metacharacters. DO NOT use this pattern with
    # other column types — change to a proper JSON-escaper if you do.
    if [[ -n "$old_hash" ]]; then old_hash_json="\"$old_hash\""; else old_hash_json="null"; fi
    if [[ -n "$new_hash" ]]; then new_hash_json="\"$new_hash\""; else new_hash_json="null"; fi
    if [[ -n "$json_reorgs" ]]; then json_reorgs+=","; fi
    json_reorgs+="{\"low\":$low,\"high\":$high,\"depth\":$depth,\"ts_low_unix\":$ts_low,\"ts_high_unix\":$ts_high,\"old_hash\":$old_hash_json,\"new_hash\":$new_hash_json}"
  done
  printf '{"network":"mainnet","start_height":%d,"end_height":%d,"scanned_at_unix":%d,"peak_at_scan":%d,"reorgs":[%s]}\n' \
    "$START_HEIGHT" "$END_HEIGHT" "$(date +%s)" "$END_HEIGHT" "$json_reorgs"
  exit 0
fi

# Super-quiet: just the one-line summary, no further output of any kind.
if [[ "$QQ_QUIET" == "true" ]]; then
  echo "Found $N_CLUSTERS reorgs of at least $MIN_DEPTH blocks in the specified range."
  exit 0
fi

# -----------------------------------------------------------------------------
# Proof-of-Space data gathering. We need PoS info in two scenarios:
#   1. The per-block-detail section (QUIET=false): every block at every height
#      in every cluster, both canonical and orphaned.
#   2. --compare-proofs: at minimum, the two siblings at each cluster's top
#      (high). When the per-block-detail also needs all blocks, the union
#      already covers this — no separate query.
# We hit the chia-blockchain Python helper once with all pairs to amortize the
# import cost (it's ~1s of Python startup that we don't want per row).
# -----------------------------------------------------------------------------
POS_DATA=""
POS_AVAILABLE="false"
POS_HELPER="$(dirname "$SCRIPT_PATH")/_decode_pos.py"

NEED_POS="false"
[[ "$QUIET" == "false" || "$COMPARE_PROOFS" == "true" ]] && NEED_POS="true"

if [[ "$NEED_POS" == "true" && -r "$POS_HELPER" ]]; then
  POS_PAIRS=""
  if [[ "$QUIET" == "false" ]]; then
    # All blocks at all cluster heights.
    while IFS=$'\t' read -r _h _hh; do
      [[ -n "$_h" ]] && POS_PAIRS+="$_h	$_hh"$'\n'
    done < <(sqlite3 -separator $'\t' "file:${DB_PATH}?mode=ro" \
      "SELECT height, lower(hex(header_hash)) FROM full_blocks WHERE height IN ($HEIGHT_LIST);")
  else
    # --compare-proofs only: just the cluster tops.
    for i in "${!CLUSTER_HIGHS[@]}"; do
      while IFS= read -r _hh; do
        [[ -n "$_hh" ]] && POS_PAIRS+="${CLUSTER_HIGHS[$i]}	$_hh"$'\n'
      done < <(sqlite3 "file:${DB_PATH}?mode=ro" \
        "SELECT lower(hex(header_hash)) FROM full_blocks WHERE height = ${CLUSTER_HIGHS[$i]};")
    done
  fi

  if [[ -n "$POS_PAIRS" ]]; then
    POS_DATA=$(printf '%s' "$POS_PAIRS" | python3 "$POS_HELPER" "$DB_PATH" 2>/dev/null || true)
    if [[ -n "$POS_DATA" ]]; then
      POS_AVAILABLE="true"
    fi
  fi
fi

# Look up a TSV field for a (height, hash) pair from POS_DATA.
# Args: height header_hash field_index (1-based)
# Fields: 1=height 2=hash 3=k 4=challenge 5=plot_pk 6=pool_value 7=pool_type 8=proof_sha256
_pos_field() {
  awk -v h="$1" -v hh="$2" -v f="$3" -F '\t' \
    '$1 == h && $2 == hh { print $f; exit }' <<< "$POS_DATA"
}

# Compare proofs at the cluster top. Echoes "match", "no-match", or
# "unavailable" (when PoS data couldn't be loaded for either side).
_proof_compare_status() {
  local high=$1 canonical_hash orphan_hash canonical_sha orphan_sha
  canonical_hash=$(sqlite3 "file:${DB_PATH}?mode=ro" \
    "SELECT lower(hex(header_hash)) FROM full_blocks WHERE height = $high AND in_main_chain = 1 LIMIT 1;")
  orphan_hash=$(sqlite3 "file:${DB_PATH}?mode=ro" \
    "SELECT lower(hex(header_hash)) FROM full_blocks WHERE height = $high AND in_main_chain = 0 LIMIT 1;")
  canonical_sha=$(_pos_field "$high" "$canonical_hash" 8)
  orphan_sha=$(_pos_field "$high" "$orphan_hash" 8)
  if [[ -z "$canonical_sha" || -z "$orphan_sha" ]]; then
    echo "unavailable"
  elif [[ "$canonical_sha" == "$orphan_sha" ]]; then
    echo "match"
  else
    echo "no-match"
  fi
}

# Render the human verdict for a status. Two callers: per-reorg summary
# suffix and the in-detail "Proof comparison:" line.
_proof_verdict_text() {
  case "$1" in
    match)       echo "Proofs match" ;;
    no-match)    echo "Proofs don't match" ;;
    unavailable) echo "Proofs unavailable" ;;
  esac
}

# Pre-compute per-cluster comparison statuses (used for both the per-reorg
# suffix and the totals line). Indexed by cluster index.
declare -a CLUSTER_PROOF_STATUS=()
PROOF_MATCH_COUNT=0
PROOF_NOMATCH_COUNT=0
if [[ "$COMPARE_PROOFS" == "true" && "$POS_AVAILABLE" == "true" ]]; then
  for i in "${!CLUSTER_HIGHS[@]}"; do
    s=$(_proof_compare_status "${CLUSTER_HIGHS[$i]}")
    CLUSTER_PROOF_STATUS[$i]="$s"
    case "$s" in
      match)    PROOF_MATCH_COUNT=$((PROOF_MATCH_COUNT + 1)) ;;
      no-match) PROOF_NOMATCH_COUNT=$((PROOF_NOMATCH_COUNT + 1)) ;;
    esac
  done
fi

# Helper: append " — <verdict>" suffix to a per-reorg summary line when
# --compare-proofs is set. Echoes empty string otherwise.
_proof_suffix() {
  local i=$1
  if [[ "$COMPARE_PROOFS" == "true" && -n "${CLUSTER_PROOF_STATUS[$i]:-}" ]]; then
    echo " — $(_proof_verdict_text "${CLUSTER_PROOF_STATUS[$i]}")"
  fi
}

if [[ $N_CLUSTERS -eq 1 ]]; then
  size=$((CLUSTER_HIGHS[0] - CLUSTER_LOWS[0] + 1))
  ts_suffix=$(fmt_ts_suffix "${CLUSTER_LOWS[0]}" "${CLUSTER_HIGHS[0]}")
  echo "Found a reorg of $size block(s) (heights ${CLUSTER_LOWS[0]}..${CLUSTER_HIGHS[0]}) $ts_suffix$(_proof_suffix 0):"
else
  echo "Found $N_CLUSTERS reorgs:"
  for i in "${!CLUSTER_LOWS[@]}"; do
    size=$((CLUSTER_HIGHS[$i] - CLUSTER_LOWS[$i] + 1))
    ts_suffix=$(fmt_ts_suffix "${CLUSTER_LOWS[$i]}" "${CLUSTER_HIGHS[$i]}")
    echo "  Reorg of $size block(s) at heights ${CLUSTER_LOWS[$i]}..${CLUSTER_HIGHS[$i]} $ts_suffix$(_proof_suffix $i)"
  done
fi

# Totals line for proof matches (under "Found N reorgs:" / equivalent).
# Shown when --compare-proofs is set; -qq already exited before this point.
if [[ "$COMPARE_PROOFS" == "true" ]]; then
  if [[ "$POS_AVAILABLE" == "true" ]]; then
    PROOF_UNAVAIL_COUNT=$((N_CLUSTERS - PROOF_MATCH_COUNT - PROOF_NOMATCH_COUNT))
    extra=""
    [[ $PROOF_UNAVAIL_COUNT -gt 0 ]] && extra=" ($PROOF_UNAVAIL_COUNT unavailable)"
    echo "Of those reorgs, $PROOF_MATCH_COUNT have matching proofs and $PROOF_NOMATCH_COUNT have differing proofs.$extra"
  else
    echo "Of those reorgs, proof comparison is unavailable (chia-blockchain Python package not importable)."
  fi
fi

if [[ "$QUIET" == "false" ]]; then
  echo
  echo "Per-block detail (in_main_chain=1 is canonical, 0 is orphaned):"
  echo
  sqlite3 "file:${DB_PATH}?mode=ro" -cmd ".mode column" -cmd ".headers on" <<SQL
SELECT
  height,
  lower(hex(header_hash)) AS header_hash,
  lower(hex(prev_hash))   AS prev_hash,
  in_main_chain
FROM full_blocks
WHERE height IN ($HEIGHT_LIST)
ORDER BY height, in_main_chain DESC;
SQL

  # Proof-of-Space detail per block, plus per-cluster comparison verdict
  # when --compare-proofs is set.
  if [[ "$POS_AVAILABLE" == "true" ]]; then
    echo
    echo "Proof of Space (per block at reorged heights):"
    # Iterate in the same order as the table above.
    while IFS=$'\t' read -r _h _hh _imc; do
      [[ -z "$_h" ]] && continue
      _k=$(_pos_field "$_h" "$_hh" 3)
      _ch=$(_pos_field "$_h" "$_hh" 4)
      _ppk=$(_pos_field "$_h" "$_hh" 5)
      _pv=$(_pos_field "$_h" "$_hh" 6)
      _pt=$(_pos_field "$_h" "$_hh" 7)
      role="canonical"; [[ "$_imc" == "0" ]] && role="orphaned"
      if [[ -z "$_k" ]]; then
        printf "  height=%s %s (%s):  PoS data unavailable\n" "$_h" "${_hh:0:8}…${_hh: -4}" "$role"
      else
        printf "  height=%s %s (%s):  k=%s  challenge=%s…%s  plot_pk=%s…%s  %s=%s…%s\n" \
          "$_h" "${_hh:0:8}…${_hh: -4}" "$role" \
          "$_k" \
          "${_ch:0:8}" "${_ch: -4}" \
          "${_ppk:0:8}" "${_ppk: -4}" \
          "$_pt" "${_pv:0:8}" "${_pv: -4}"
      fi
    done < <(sqlite3 -separator $'\t' "file:${DB_PATH}?mode=ro" \
      "SELECT height, lower(hex(header_hash)), in_main_chain FROM full_blocks WHERE height IN ($HEIGHT_LIST) ORDER BY height, in_main_chain DESC;")

    if [[ "$COMPARE_PROOFS" == "true" ]]; then
      echo
      echo "Proof comparison at each cluster's top height:"
      for i in "${!CLUSTER_HIGHS[@]}"; do
        s="${CLUSTER_PROOF_STATUS[$i]:-unavailable}"
        printf "  heights %s..%s (top=%s):  %s\n" \
          "${CLUSTER_LOWS[$i]}" "${CLUSTER_HIGHS[$i]}" "${CLUSTER_HIGHS[$i]}" \
          "$(_proof_verdict_text "$s")"
      done
    fi
  elif [[ "$NEED_POS" == "true" ]]; then
    # User wanted PoS info but the helper failed (chia-blockchain not
    # installed, or python3 not on PATH, etc.). Don't silently omit.
    echo
    echo "Proof of Space: unavailable (chia-blockchain Python package not importable)."
  fi
fi
}

# Run in a subshell so that `exit` and `set -e` inside main() can never affect
# the parent shell — important if a user `source`s this script. (When executed
# normally, this is a no-op.)
(main "$@")
