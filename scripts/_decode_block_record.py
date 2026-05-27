#!/usr/bin/env python3
"""
Internal helper for scripts/reorg-finder.sh — decodes the BlockRecord blob
stored in the `block_record` column of Chia v2 full_blocks, so the bash
script's JSON output can include the full per-orphan record (signage point
index, weight, total_iters, VDF outputs, reward claims, etc.) instead of
just the timestamp.

Usage: _decode_block_record.py DB_PATH
Reads tab-separated `height<TAB>header_hash_hex` pairs from stdin, one per line.
Emits TSV to stdout, one line per successfully-decoded row:
  height<TAB>header_hash_hex<TAB>block_record_json_object

block_record_json is a single-line JSON object (BlockRecord.to_json_dict()
serialized via json.dumps). Because JSON escapes \\t and \\n inside string
values, the TSV stays parseable.

Rows that fail decode are silently omitted from stdout; a comment line is
written to stderr.

Exits non-zero only when the chia-blockchain Python package itself isn't
importable.

Unlike _decode_pos.py, this helper does NOT need zstd — the `block_record`
column is stored uncompressed (only the `block` column is zstd-compressed).
"""

import json
import sqlite3
import sys

try:
    from chia.consensus.block_record import BlockRecord
except ImportError as e1:
    try:
        from chia_rs import BlockRecord  # type: ignore  # noqa: F401
    except ImportError as e2:
        print(
            f"error: BlockRecord not importable: chia.consensus.block_record: {type(e1).__name__}: {e1}; chia_rs: {type(e2).__name__}: {e2}",
            file=sys.stderr,
        )
        print(
            "       (ensure CHIA_PYTHON points at a venv with chia-blockchain installed)",
            file=sys.stderr,
        )
        sys.exit(3)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: _decode_block_record.py DB_PATH < pairs", file=sys.stderr)
        return 2
    db_path = sys.argv[1]
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            h_str, hh_hex = line.split("\t", 1)
            height = int(h_str)
            hh = bytes.fromhex(hh_hex)
        except (ValueError, IndexError):
            print(f"# bad-input: {line!r}", file=sys.stderr)
            continue
        row = db.execute(
            "SELECT block_record FROM full_blocks WHERE height = ? AND header_hash = ?",
            (height, hh),
        ).fetchone()
        if row is None:
            print(f"# missing: {height}:{hh_hex}", file=sys.stderr)
            continue
        try:
            br = BlockRecord.from_bytes(row[0])
            br_json = json.dumps(br.to_json_dict())
        except Exception as e:
            print(f"# decode-failed: {height}:{hh_hex}: {e}", file=sys.stderr)
            continue
        print(f"{height}\t{hh_hex}\t{br_json}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
