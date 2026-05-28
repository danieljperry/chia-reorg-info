#!/usr/bin/env python3
"""
Internal helper for scripts/reorg-finder.sh — searches orphan blocks for
references to a set of target puzzle hashes (e.g. the Warp.green bridge
message coin puzzle hash). Used by reorg-finder.sh's -b/--bridge flag.

Detection is two-tier:

  1. Byte search (always works as long as the block can be decompressed):
     the 32-byte target hash appears verbatim in the block when it's used
     as a CREATE_COIN target, a hint (first memo), or any literal CLVM
     argument. Doesn't detect the case where the target IS the puzzle
     hash of a coin being spent — because the puzzle_reveal hashes TO
     the target, the reveal bytes themselves don't contain the target.

  2. Generator parsing (best-effort, requires chia-blockchain + chia_rs):
     for blocks where byte search hits, run the transactions_generator
     with refs fetched from the same DB (canonical chain). Iterate the
     resulting spends and report coin amounts, parent coin info, and any
     target-related condition. This covers the puzzle-hash-of-spent-coin
     case as well.

Usage: _decode_bridge_spends.py DB_PATH TARGET_HASHES_CSV < pairs
  pairs: tab-separated `height<TAB>header_hash_hex` lines (orphan blocks)
  TARGET_HASHES_CSV: comma-separated 64-char hex puzzle hashes

Output: single JSON object on stdout:
  {
    "matches": [
      {
        "height": N,
        "header_hash": "...",
        "timestamp": N | null,
        "byte_matched_hashes": ["..."],  // hashes found via byte search
        "generator_parsed": true | false,
        "generator_error": "..." | null,
        "spends": [                       // only when generator_parsed is true
          {
            "matched_hashes": ["..."],   // why this spend matched
            "match_reasons": ["puzzle_hash" | "create_coin_target" | "create_coin_hint"],
            "coin": {
              "parent_coin_info": "0x...",
              "puzzle_hash": "0x...",
              "amount": N
            },
            "asset_type": "bridge" | "unknown",
            "asset_id": null
          }
        ]
      }
    ]
  }

Errors during single-row processing become "spend_parse_error" fields;
the script still exits 0. Only setup-level errors (no chia, bad args)
exit non-zero.
"""

import json
import sqlite3
import sys
import traceback
from typing import Any

try:
    import zstd as _zstd

    def _decompress(b: bytes) -> bytes:
        return _zstd.decompress(b)
except ImportError:
    try:
        import zstandard

        def _decompress(b: bytes) -> bytes:
            return zstandard.ZstdDecompressor().decompress(b)
    except ImportError:
        print("error: neither `zstd` nor `zstandard` python package is installed", file=sys.stderr)
        sys.exit(2)

# FullBlock — required for both byte search and parsing (we need to find
# the transactions_generator bytes).
try:
    from chia.types.full_block import FullBlock
except ImportError as e1:
    try:
        from chia_rs import FullBlock  # type: ignore
    except ImportError as e2:
        print(
            f"error: FullBlock not importable: chia.types.full_block: {type(e1).__name__}: {e1}; chia_rs: {type(e2).__name__}: {e2}",
            file=sys.stderr,
        )
        sys.exit(3)

# Generator runner — optional. When unavailable, we fall back to
# byte-search-only output. Tried multiple import paths because the API
# location has moved between chia versions.
_run_generator = None
_DEFAULT_CONSTANTS: Any = None
_generator_setup_error: str | None = None
try:
    from chia_rs import run_block_generator2 as _run_generator
    try:
        from chia.consensus.default_constants import DEFAULT_CONSTANTS as _DEFAULT_CONSTANTS  # type: ignore
    except ImportError:
        try:
            from chia_rs import DEFAULT_CONSTANTS as _DEFAULT_CONSTANTS  # type: ignore
        except ImportError as e:
            _generator_setup_error = f"DEFAULT_CONSTANTS not importable: {e}"
            _run_generator = None
except ImportError as e:
    _generator_setup_error = f"chia_rs.run_block_generator2 not importable: {e}"


def _load_block(row_bytes: bytes) -> FullBlock:
    try:
        blob = _decompress(row_bytes)
    except Exception:
        blob = row_bytes  # legacy uncompressed
    return FullBlock.from_bytes(blob)


def _get_canonical_block(db: sqlite3.Connection, height: int):
    row = db.execute(
        "SELECT block FROM full_blocks WHERE height = ? AND in_main_chain = 1 LIMIT 1",
        (height,),
    ).fetchone()
    if row is None:
        return None
    try:
        return _load_block(row[0])
    except Exception:
        return None


def _byte_search_block(block: FullBlock, target_hashes: list[bytes]) -> list[str]:
    """Search the block's bytes for any target hash. Returns hex of those found."""
    # Serialize the block back to bytes for a comprehensive search. This
    # covers the generator, solutions, foliage, etc. — anywhere a target
    # hash could appear as a literal 32-byte sequence.
    serialized = bytes(block)
    matched: list[str] = []
    for h in target_hashes:
        if h in serialized:
            matched.append(h.hex())
    return matched


def _try_run_generator(block: FullBlock, db: sqlite3.Connection):
    """Run the block's transactions_generator, returning the spends or None
    on any failure. The fallback path uses byte search only."""
    if _run_generator is None or _DEFAULT_CONSTANTS is None:
        return None, _generator_setup_error
    if block.transactions_generator is None:
        return None, "no transactions_generator (non-tx block)"

    refs: list[bytes] = []
    for ref_h in block.transactions_generator_ref_list:
        ref_block = _get_canonical_block(db, int(ref_h))
        if ref_block is None or ref_block.transactions_generator is None:
            return None, f"ref block at height {ref_h} not available"
        refs.append(bytes(ref_block.transactions_generator))

    try:
        gen_bytes = bytes(block.transactions_generator)
        max_cost = int(getattr(_DEFAULT_CONSTANTS, "MAX_BLOCK_COST_CLVM", 11_000_000_000))
        # API signature varies by version; try a couple shapes.
        try:
            result = _run_generator(gen_bytes, refs, max_cost, 0, None, None, _DEFAULT_CONSTANTS)
        except TypeError:
            try:
                result = _run_generator(gen_bytes, refs, max_cost, 0, _DEFAULT_CONSTANTS)
            except TypeError:
                result = _run_generator(gen_bytes, refs, max_cost, 0)

        # Result shape: (err, conds) or (cost, conds) depending on version.
        if isinstance(result, tuple) and len(result) >= 2:
            conds = result[1]
        else:
            conds = result

        if conds is None:
            return None, "generator returned None conds"
        return list(getattr(conds, "spends", []) or []), None
    except Exception as e:
        return None, f"generator run failed: {type(e).__name__}: {e}"


def _match_spend(spend, target_hashes: list[bytes]) -> dict | None:
    """Return match info dict if the spend matches any target, else None."""
    matched_hashes: set[str] = set()
    reasons: set[str] = set()

    def _to_bytes(x):
        try:
            return bytes(x)
        except Exception:
            return None

    # The spent coin's puzzle hash (the puzzle_reveal hashed to this value).
    spent_ph = _to_bytes(getattr(spend, "puzzle_hash", None))
    if spent_ph is not None:
        for h in target_hashes:
            if spent_ph == h:
                matched_hashes.add(h.hex())
                reasons.add("puzzle_hash")

    # CREATE_COIN conditions: check target and the hint (first memo).
    creates = getattr(spend, "create_coin", None) or []
    for create in creates:
        # create can be a namedtuple-ish (puzzle_hash, amount, hint) or
        # an object with .puzzle_hash / .amount / .hint attrs.
        cp = None
        ch = None
        if hasattr(create, "puzzle_hash"):
            cp = _to_bytes(create.puzzle_hash)
            ch = _to_bytes(getattr(create, "hint", None))
        elif isinstance(create, (tuple, list)) and len(create) >= 1:
            cp = _to_bytes(create[0])
            if len(create) >= 3:
                hint_field = create[2]
                # hint may be bytes directly, or a list whose first elem is the hint
                if isinstance(hint_field, (bytes, bytearray)):
                    ch = bytes(hint_field)
                elif isinstance(hint_field, (list, tuple)) and len(hint_field) >= 1:
                    ch = _to_bytes(hint_field[0])
        if cp is not None:
            for h in target_hashes:
                if cp == h:
                    matched_hashes.add(h.hex())
                    reasons.add("create_coin_target")
        if ch is not None:
            for h in target_hashes:
                if ch == h:
                    matched_hashes.add(h.hex())
                    reasons.add("create_coin_hint")

    if not matched_hashes:
        return None

    asset_type = "bridge" if "puzzle_hash" in reasons else "unknown"
    parent = _to_bytes(getattr(spend, "parent_id", None) or getattr(spend, "coin_id", None))
    amount = getattr(spend, "coin_amount", None)
    if amount is None:
        amount = getattr(spend, "amount", None)
    try:
        amount = int(amount) if amount is not None else None
    except Exception:
        amount = None

    return {
        "matched_hashes": sorted(matched_hashes),
        "match_reasons": sorted(reasons),
        "coin": {
            "parent_coin_info": "0x" + parent.hex() if parent else None,
            "puzzle_hash": "0x" + spent_ph.hex() if spent_ph else None,
            "amount": amount,
        },
        "asset_type": asset_type,
        "asset_id": None,
    }


def _process_block(
    db: sqlite3.Connection, height: int, hh_hex: str, target_hashes: list[bytes]
) -> dict | None:
    row = db.execute(
        "SELECT block FROM full_blocks WHERE height = ? AND header_hash = ?",
        (height, bytes.fromhex(hh_hex)),
    ).fetchone()
    if row is None:
        return None

    try:
        block = _load_block(row[0])
    except Exception as e:
        return {
            "height": height,
            "header_hash": hh_hex,
            "timestamp": None,
            "byte_matched_hashes": [],
            "generator_parsed": False,
            "generator_error": f"block decode failed: {type(e).__name__}: {e}",
            "spends": [],
        }

    byte_matched = _byte_search_block(block, target_hashes)
    if not byte_matched:
        return None

    ts = None
    if block.foliage_transaction_block is not None:
        try:
            ts = int(block.foliage_transaction_block.timestamp)
        except Exception:
            ts = None

    spends_list, gen_err = _try_run_generator(block, db)
    spend_details: list[dict] = []
    if spends_list is not None:
        for sp in spends_list:
            try:
                m = _match_spend(sp, target_hashes)
                if m is not None:
                    spend_details.append(m)
            except Exception as e:
                # Don't let one mis-shaped spend kill the whole match.
                print(
                    f"# spend match warning at {height}:{hh_hex}: {type(e).__name__}: {e}",
                    file=sys.stderr,
                )

    return {
        "height": height,
        "header_hash": hh_hex,
        "timestamp": ts,
        "byte_matched_hashes": byte_matched,
        "generator_parsed": spends_list is not None,
        "generator_error": gen_err,
        "spends": spend_details,
    }


def main() -> int:
    if len(sys.argv) != 3:
        print(
            "usage: _decode_bridge_spends.py DB_PATH TARGET_HASHES_CSV < pairs",
            file=sys.stderr,
        )
        return 2
    db_path = sys.argv[1]
    raw_targets = [t.strip() for t in sys.argv[2].split(",") if t.strip()]
    try:
        target_hashes = [bytes.fromhex(t) for t in raw_targets]
    except ValueError as e:
        print(f"error: invalid target hash: {e}", file=sys.stderr)
        return 2
    if not target_hashes:
        print("error: at least one target puzzle hash required", file=sys.stderr)
        return 2

    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)

    matches: list[dict] = []
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            h_str, hh_hex = line.split("\t", 1)
            height = int(h_str)
        except (ValueError, IndexError):
            print(f"# bad-input: {line!r}", file=sys.stderr)
            continue
        try:
            m = _process_block(db, height, hh_hex, target_hashes)
            if m is not None:
                matches.append(m)
        except Exception as e:
            print(
                f"# unhandled error at {height}:{hh_hex}: {type(e).__name__}: {e}\n{traceback.format_exc()}",
                file=sys.stderr,
            )

    print(json.dumps({"matches": matches}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
