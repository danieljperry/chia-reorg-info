#!/usr/bin/env python3
"""
Internal helper for scripts/reorg-finder.sh — decodes proof-of-space data
from Chia v2 full_blocks rows.

Usage: _decode_pos.py DB_PATH
Reads tab-separated `height<TAB>header_hash_hex` pairs from stdin, one per line.
Emits TSV to stdout with columns:
  height  header_hash_hex  k  challenge_hex  plot_pk_hex  pool_value_hex  pool_type  proof_sha256_hex

`pool_type` is either "pool_pk" or "pool_contract" — pool_value_hex is the
corresponding G1 pubkey hex or 32-byte puzzle-hash hex.

Exits 0 on success even if some rows fail (those are reported to stderr,
not stdout). Exits non-zero only when chia-blockchain or a zstd backend
is missing — those are setup problems the caller should surface.
"""

import hashlib
import sqlite3
import sys

try:
    # Most chia installs ship zstd via the `zstd` PyPI package.
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

# Try a few candidate import paths for FullBlock — chia-blockchain has
# reorganized internals across versions. Surface the first failure's actual
# message so the user (or maintainer) can fix it instead of guessing.
FullBlock = None
_chia_import_error = None
for _modpath in ("chia.types.full_block", "chia.consensus.full_block"):
    try:
        _mod = __import__(_modpath, fromlist=["FullBlock"])
        FullBlock = getattr(_mod, "FullBlock", None)
        if FullBlock is not None:
            break
    except Exception as _e:  # ImportError is most common; protect against runtime errors too.
        if _chia_import_error is None:
            _chia_import_error = f"{_modpath}: {type(_e).__name__}: {_e}"
        continue

if FullBlock is None:
    # Last-ditch: try the Rust bindings, which expose FullBlock in newer chia.
    try:
        from chia_rs import FullBlock  # type: ignore  # noqa: F401
    except Exception as _e:
        if _chia_import_error is None:
            _chia_import_error = f"chia_rs: {type(_e).__name__}: {_e}"

if FullBlock is None:
    print(
        f"error: FullBlock not importable: {_chia_import_error or 'unknown'}",
        file=sys.stderr,
    )
    print(
        "       (ensure CHIA_PYTHON points at a venv with chia-blockchain installed)",
        file=sys.stderr,
    )
    sys.exit(3)


def _format_pos(height: int, hh_hex: str, block: FullBlock) -> str:
    pos = block.reward_chain_block.proof_of_space
    k = pos.size
    challenge_hex = pos.challenge.hex()
    plot_pk_hex = bytes(pos.plot_public_key).hex()
    if pos.pool_public_key is not None:
        pool_type = "pool_pk"
        pool_value_hex = bytes(pos.pool_public_key).hex()
    elif pos.pool_contract_puzzle_hash is not None:
        pool_type = "pool_contract"
        pool_value_hex = pos.pool_contract_puzzle_hash.hex()
    else:
        pool_type = "none"
        pool_value_hex = ""
    proof_sha = hashlib.sha256(bytes(pos.proof)).hexdigest()
    return f"{height}\t{hh_hex}\t{k}\t{challenge_hex}\t{plot_pk_hex}\t{pool_value_hex}\t{pool_type}\t{proof_sha}"


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: _decode_pos.py DB_PATH < pairs", file=sys.stderr)
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
            "SELECT block FROM full_blocks WHERE height = ? AND header_hash = ?",
            (height, hh),
        ).fetchone()
        if row is None:
            print(f"# missing: {height}:{hh_hex}", file=sys.stderr)
            continue

        try:
            blob = _decompress(row[0])
        except Exception:
            # Very old v2 DBs may have stored blocks uncompressed; fall back.
            blob = row[0]

        try:
            block = FullBlock.from_bytes(blob)
        except Exception as e:
            print(f"# decode-failed: {height}:{hh_hex}: {e}", file=sys.stderr)
            continue

        print(_format_pos(height, hh_hex, block))

    return 0


if __name__ == "__main__":
    sys.exit(main())
