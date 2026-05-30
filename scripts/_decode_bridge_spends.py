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

import hashlib
import json
import sqlite3
import sys
import traceback
from typing import Any

# Chia condition opcodes used by the announcement-linkage walker. Created
# announcements carry the raw message; asserted announcements carry the
# pre-hashed announcement_id (sha256(coin_id || msg) for coin announcements,
# sha256(puzzle_hash || msg) for puzzle announcements).
_OP_CREATE_COIN_ANNOUNCEMENT = 60
_OP_ASSERT_COIN_ANNOUNCEMENT = 61
_OP_CREATE_PUZZLE_ANNOUNCEMENT = 62
_OP_ASSERT_PUZZLE_ANNOUNCEMENT = 63

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
# byte-search-only output. The chia_rs API has churned across versions,
# so we import both run_block_generator (no BLS check) and
# run_block_generator2 (with BLS check) when available, and try both at
# call time with the right argument shapes.
_run_generator_v1 = None
_run_generator_v2 = None
_DEFAULT_CONSTANTS: Any = None
_ZERO_G2: Any = None
_generator_setup_error: str | None = None

try:
    from chia_rs import run_block_generator2 as _run_generator_v2  # type: ignore
except ImportError as e:
    _generator_setup_error = f"chia_rs.run_block_generator2 not importable: {e}"

try:
    from chia_rs import run_block_generator as _run_generator_v1  # type: ignore
except ImportError:
    pass

if _run_generator_v1 is None and _run_generator_v2 is None:
    pass  # _generator_setup_error already set above
else:
    try:
        from chia.consensus.default_constants import DEFAULT_CONSTANTS as _DEFAULT_CONSTANTS  # type: ignore
    except ImportError:
        try:
            from chia_rs import DEFAULT_CONSTANTS as _DEFAULT_CONSTANTS  # type: ignore
        except ImportError as e:
            _generator_setup_error = f"DEFAULT_CONSTANTS not importable: {e}"
    # The v2 signature requires a G2Element signature (and won't accept
    # None or raw bytes on many chia_rs versions). Construct a zero
    # (infinity) element — sufficient for our use since we don't care
    # about BLS aggregation correctness, only about extracting spends.
    try:
        from chia_rs import G2Element  # type: ignore

        try:
            _ZERO_G2 = G2Element()
        except Exception:
            # Fall back to constructing from the canonical G2-infinity
            # bytes (0xc0 + 95 zero bytes = compressed infinity point).
            try:
                _ZERO_G2 = G2Element.from_bytes(b"\xc0" + b"\x00" * 95)
            except Exception:
                _ZERO_G2 = None
    except ImportError:
        _ZERO_G2 = None

# Asset classification: well-known MOD hashes for the common Chia puzzle
# templates. Each `import or None` block keeps us forward-compatible if a
# future chia version reorganizes these modules — missing constants just
# disable that branch of classification rather than failing the helper.
_PROGRAM_CLS: Any = None
try:
    from chia.types.blockchain_format.program import Program as _PROGRAM_CLS  # type: ignore
except ImportError:
    pass

def _safe_mod_hash(import_path: str, attr: str) -> bytes | None:
    """Import attr from import_path and return its .get_tree_hash() bytes."""
    try:
        mod_mod = __import__(import_path, fromlist=[attr])
        prog = getattr(mod_mod, attr)
        return bytes(prog.get_tree_hash())
    except Exception:
        return None

# Standard XCH puzzle (p2_delegated_puzzle_or_hidden_puzzle).
_STANDARD_MOD_HASH = _safe_mod_hash(
    "chia.wallet.puzzles.p2_delegated_puzzle_or_hidden_puzzle", "MOD"
)
# CAT v2 outer puzzle. Currying: (CAT_MOD_HASH, TAIL_HASH, inner_puzzle).
# Try a few import paths because chia has reshuffled this module across
# versions.
_CAT_MOD_HASH = (
    _safe_mod_hash("chia.wallet.cat_wallet.cat_utils", "CAT_MOD")
    or _safe_mod_hash("chia.wallet.puzzles.cat_loader", "CAT_MOD")
    or _safe_mod_hash("chia.wallet.cat_wallet.cat_constants", "CAT_MOD")
)
# Singleton top-layer v1.1 (NFTs, DIDs, etc. all wrap this).
_SINGLETON_MOD_HASH = (
    _safe_mod_hash("chia.wallet.singleton", "SINGLETON_TOP_LAYER_MOD")
    or _safe_mod_hash("chia.wallet.puzzles.singleton_top_layer_v1_1", "SINGLETON_MOD")
    or _safe_mod_hash("chia.wallet.singleton_top_layer", "SINGLETON_MOD")
)
# Additional common chia puzzle templates. Order matters: probed in the
# order written and the first match wins. Each entry is (asset_label,
# mod_hash_bytes_or_None) — a None entry just disables that branch.
# These cover most wallet-related puzzles users will see in practice,
# so a coin showing up as "unknown_curried" is likely a custom or
# protocol-specific puzzle (e.g. a warp.green bridge inner contract).
_EXTRA_TEMPLATES: list[tuple[str, bytes | None]] = [
    (
        "p2_singleton",
        _safe_mod_hash("chia.wallet.puzzles.p2_singleton", "MOD"),
    ),
    (
        "p2_singleton_or_delayed",
        _safe_mod_hash(
            "chia.wallet.puzzles.p2_singleton_or_delayed_puzhash", "MOD"
        ),
    ),
    (
        "nft_state_layer",
        _safe_mod_hash("chia.wallet.nft_wallet.nft_puzzles", "NFT_STATE_LAYER_MOD")
        or _safe_mod_hash("chia.wallet.puzzles.nft_state_layer", "MOD"),
    ),
    (
        "nft_ownership_layer",
        # Chia's attribute is NFT_OWNERSHIP_LAYER (no _MOD suffix) — different
        # from NFT_STATE_LAYER_MOD just above. Took an iteration to spot.
        _safe_mod_hash("chia.wallet.nft_wallet.nft_puzzles", "NFT_OWNERSHIP_LAYER")
        or _safe_mod_hash("chia.wallet.puzzles.nft_ownership_layer", "MOD"),
    ),
    (
        "did_inner",
        _safe_mod_hash("chia.wallet.did_wallet.did_wallet_puzzles", "DID_INNERPUZ_MOD")
        or _safe_mod_hash("chia.wallet.puzzles.did_innerpuz", "MOD"),
    ),
    (
        "settlement_payments",
        _safe_mod_hash(
            "chia.wallet.puzzles.settlement_payments",
            "SETTLEMENT_PAYMENTS_MOD",
        )
        or _safe_mod_hash("chia.wallet.puzzles.settlement_payments", "MOD"),
    ),
    (
        "cat_v1_legacy",
        _safe_mod_hash("chia.wallet.puzzles.cc_loader", "CC_MOD"),
    ),
]

# Warp.green Chia-side puzzle family. Mod hashes computed directly by
# tree-hashing the compiled .hex files in warpdotgreen/cli/puzzles/. The
# locker is the only one where the curry layout is worth extracting at
# uncurry time (it carries the destination chain + contract + asset_id);
# the others get a name-only label.
_WARP_PUZZLES: list[tuple[str, bytes]] = [
    (
        "warp_bridging_puzzle",
        bytes.fromhex("a09eb1ea8c6e83c0166801dabcf4a70d361cc7f6d89c4a46bcd400ac57719037"),
    ),
    (
        "warp_message_coin",
        bytes.fromhex("331e8775ee22bbb793b411071ba6d49739d8d496dff7d9eb059ac787ef7e89fc"),
    ),
    (
        "warp_portal_receiver",
        bytes.fromhex("6a91ad29cc7d8d16514316d20e154a393faa35d6474cec7c597a15fd017101d9"),
    ),
    (
        "warp_rekey_portal",
        bytes.fromhex("53536340f3539383988167d3bf98ea6353a6f981a6f9721aa9f6c739e8f88b27"),
    ),
    (
        "warp_cat_burner",
        bytes.fromhex("cf5743483ed4d0f5536a11877f5b15629b04e6bf34943843c5cad97ce61f2505"),
    ),
    (
        "warp_cat_minter",
        bytes.fromhex("9e1c1ca30ea296accdbd046b91b40f7907f86e33d41b57102211c48a3f9aa0f1"),
    ),
    (
        "warp_wrapped_tail",
        bytes.fromhex("2d7e6fd2e8dd27536ebba2cf6b9fde09493fa10037aa64e14b201762c902f013"),
    ),
    (
        "warp_burn_inner_puzzle",
        bytes.fromhex("69b9ac68db61a9941ff537cbb69158a7e1015ad44c42cff905159909cd8e1f90"),
    ),
    (
        "warp_cat_mint_and_payout",
        bytes.fromhex("2c78140b52765a1c063062775d31a33a452410e9777c01270c1001db6e821f37"),
    ),
    (
        "warp_unlocker",
        bytes.fromhex("71dcf765877bd0634f046876a182d04ab0170121032a0d6a83b0573ca1d24d0c"),
    ),
    (
        "warp_p2_controller",
        bytes.fromhex("a8082b5622ccb27e89f196f024f9851dee0bcb0f2d8afd395caa6d4432f6f85f"),
    ),
]

# The locker is the controller of a Chia→EVM outbound bundle (locks a
# Chia CAT — including wrapped-asset CATs like DWB — and creates the
# bridge message coin). Verified via warpdotgreen/cli's
# drivers/wrapped_cats.py::get_locker_puzzle, the 7 curried args are:
#   [0] MESSAGE_DESTINATION_CHAIN   3-byte ASCII (e.g. b"bse" for Base)
#   [1] MESSAGE_DESTINATION         32-byte EVM contract hash
#   [2] CAT_MOD_HASH                constant
#   [3] OFFER_MOD_HASH              constant (settlement_payments)
#   [4] BRIDGING_PUZZLE_HASH        constant (= warp_bridging_puzzle)
#   [5] VAULT_PUZZLE_HASH           p2_controller_puzzle_hash inner
#   [6] ASSET_ID                    CAT tail hash, or `()` for XCH
# The wallet receiver address is NOT curried — it comes from the
# solution, so we can't recover it from the puzzle reveal alone.
_WARP_LOCKER_MOD_HASH = bytes.fromhex(
    "69475cd8d5c28407feea9146f932d3b9971256436c7b6ff906d6b4b80d22187e"
)


def _classify_puzzle(
    puzzle_reveal_bytes: bytes, target_hashes: list[bytes]
) -> tuple[str, str | None, str]:
    """Identify a puzzle's asset type by uncurrying it and matching the
    inner MOD's tree hash against the well-known templates.

    Returns (asset_type, asset_id_or_None, note):
      - "bridge", None — coin's full puzzle hash matches a configured target
      - "xch", None    — standard p2_delegated puzzle (plain XCH)
      - "cat", "0x<tail_hash>" — CAT outer puzzle; asset_id is the TAIL hash
      - "singleton", "0x<launcher_id>" — singleton outer; asset_id is launcher
      - "unknown", None — uncurry failed or no known template matched

    The third return value is a short human-readable diagnostic note
    explaining how the decision was reached — used to surface 'unknown'
    causes inline in the Bridge Info output without an extra debug flag.

    Robust against missing chia modules and uncurry errors: any failure
    yields ("unknown", None, "...") instead of throwing."""
    if _PROGRAM_CLS is None:
        return "unknown", None, "chia python (Program) not importable"
    try:
        prog = _PROGRAM_CLS.from_bytes(puzzle_reveal_bytes)
    except Exception as e:
        return "unknown", None, f"Program.from_bytes failed: {type(e).__name__}: {e}"

    # Whole-puzzle hash match → this IS the bridge message coin.
    try:
        ph = bytes(prog.get_tree_hash())
        if ph in target_hashes:
            return "bridge", None, "whole puzzle hash matches a configured target"
    except Exception:
        pass

    # Try to uncurry to identify the wrapper.
    try:
        mod, curried_args = prog.uncurry()
    except Exception as e:
        return "unknown", None, f"uncurry threw: {type(e).__name__}: {e}"
    if mod is None:
        return "unknown", None, "uncurry returned no mod (not a curried puzzle)"
    try:
        mod_hash = bytes(mod.get_tree_hash())
    except Exception as e:
        return "unknown", None, f"mod.get_tree_hash failed: {type(e).__name__}: {e}"

    mod_short = mod_hash.hex()[:12] + "…"

    if _STANDARD_MOD_HASH is not None and mod_hash == _STANDARD_MOD_HASH:
        # Standard XCH puzzle. Single curried arg is the synthetic public
        # key; no asset_id to extract.
        return "xch", None, f"mod_hash={mod_short} matches p2_delegated → xch"

    if _CAT_MOD_HASH is not None and mod_hash == _CAT_MOD_HASH:
        # CAT outer puzzle. Curried args: (CAT_MOD_HASH, TAIL_HASH, inner).
        # Extract TAIL hash (second curried arg).
        try:
            args_list = list(curried_args.as_iter())
            if len(args_list) >= 2:
                tail = bytes(args_list[1].as_atom() or b"")
                if len(tail) == 32:
                    return (
                        "cat",
                        "0x" + tail.hex(),
                        f"mod_hash={mod_short} matches CAT_MOD → cat",
                    )
        except Exception:
            pass
        return "cat", None, f"mod_hash={mod_short} matches CAT_MOD but TAIL extract failed"

    if _SINGLETON_MOD_HASH is not None and mod_hash == _SINGLETON_MOD_HASH:
        # Singleton outer puzzle. First curried arg is the singleton_struct:
        # (MOD_HASH . (LAUNCHER_ID . LAUNCHER_PH)). Extract LAUNCHER_ID.
        try:
            args_list = list(curried_args.as_iter())
            if len(args_list) >= 1:
                singleton_struct = args_list[0]
                launcher_id = bytes(
                    singleton_struct.rest().first().as_atom() or b""
                )
                if len(launcher_id) == 32:
                    return (
                        "singleton",
                        "0x" + launcher_id.hex(),
                        f"mod_hash={mod_short} matches SINGLETON_MOD → singleton",
                    )
        except Exception:
            pass
        return (
            "singleton",
            None,
            f"mod_hash={mod_short} matches SINGLETON_MOD but launcher_id extract failed",
        )

    # Probe the extra templates. They don't have a distinguished asset_id
    # to extract (most are inner puzzles wrapped by something else), so
    # we just label them by name.
    for label, extra_hash in _EXTRA_TEMPLATES:
        if extra_hash is not None and mod_hash == extra_hash:
            return label, None, f"mod_hash={mod_short} matches {label}"

    if mod_hash == _WARP_LOCKER_MOD_HASH:
        # warp.green Chia→EVM outbound controller. Pull the destination
        # chain, destination contract, and asset_id from the 7 curried
        # args (see _WARP_LOCKER_MOD_HASH comment above for the layout).
        # The wallet receiver address isn't curried, so we report it as
        # "(receiver in solution)" in the note for clarity.
        try:
            args_list = list(curried_args.as_iter())
            if len(args_list) >= 7:
                chain_atom = bytes(args_list[0].as_atom() or b"")
                dest_contract = bytes(args_list[1].as_atom() or b"")
                asset_id_atom = bytes(args_list[6].as_atom() or b"")
                chain_tag = (
                    chain_atom.decode("ascii", errors="replace")
                    if chain_atom else "?"
                )
                asset_label = (
                    "0x" + asset_id_atom.hex() if len(asset_id_atom) == 32 else "xch"
                )
                dest_id = (
                    f"{chain_tag}:0x{dest_contract.hex()}"
                    if dest_contract else chain_tag
                )
                return (
                    "warp_locker",
                    dest_id,
                    f"mod_hash={mod_short} matches warp.green locker "
                    f"(destination: {dest_id}; locking asset: {asset_label}; "
                    f"receiver in solution)",
                )
        except Exception as e:
            return (
                "warp_locker",
                None,
                f"mod_hash={mod_short} matches warp.green locker but args parse "
                f"failed: {type(e).__name__}: {e}",
            )
        return (
            "warp_locker",
            None,
            f"mod_hash={mod_short} matches warp.green locker (unexpected arg count)",
        )

    # Other warp.green puzzles: name-only label, no extracted asset_id.
    for label, warp_hash in _WARP_PUZZLES:
        if mod_hash == warp_hash:
            return label, None, f"mod_hash={mod_short} matches {label}"

    # No template matched. Surface the FULL mod_hash so the user can
    # identify it externally (lookup against known protocols, ask the
    # wallet that produced the coin, etc.) and consider adding it to
    # _EXTRA_TEMPLATES or _WARP_PUZZLES. asset_id carries the mod_hash
    # so it shows up in the formatter under "asset_id: 0x..." rather
    # than getting hidden in the note.
    builtin_templates = [
        ("p2", _STANDARD_MOD_HASH),
        ("cat", _CAT_MOD_HASH),
        ("singleton", _SINGLETON_MOD_HASH),
    ]
    loaded = [
        lab for lab, h in (builtin_templates + _EXTRA_TEMPLATES) if h is not None
    ]
    loaded.extend(["warp_locker"] + [lab for lab, _ in _WARP_PUZZLES])
    loaded_str = ",".join(loaded) if loaded else "none"
    full_hex = "0x" + mod_hash.hex()
    return (
        "unknown_curried",
        full_hex,
        f"uncurried mod_hash={full_hex}; no template match (loaded: {loaded_str})",
    )


def _extract_puzzle_reveals(
    block: FullBlock, db: sqlite3.Connection
) -> tuple[dict[bytes, bytes], dict[tuple[bytes, bytes, int], dict], str]:
    """Run the block's generator via chia python to get the raw spend
    tuples, returning:

      (reveals_by_ph, spend_data_by_key, diagnostic_note)

    - reveals_by_ph: puzzle_hash → puzzle_reveal_bytes (existing classifier
      lookup; duplicate puzzle_hashes collide harmlessly — they share a reveal).
    - spend_data_by_key: (parent_id, puzzle_hash, amount) → {parent_id,
      puzzle_hash, amount, puzzle_reveal, solution}. The (parent, ph, amount)
      triple uniquely identifies a coin without needing a `Coin` import.
      Used by the announcement-linkage walker to look up solutions for
      `puzzle.run(solution)` condition extraction.

    Tries several Program.run shapes because chia's API differs across
    versions. On total failure: ({}, {}, note). On partial success: returns
    what could be extracted plus a note."""
    if _PROGRAM_CLS is None:
        return {}, {}, "chia python (Program) not importable"
    if block.transactions_generator is None:
        return {}, {}, "block has no transactions_generator"

    refs: list[Any] = []
    for ref_h in block.transactions_generator_ref_list:
        ref_block = _get_canonical_block(db, int(ref_h))
        if ref_block is None or ref_block.transactions_generator is None:
            return {}, {}, f"ref block at height {int(ref_h)} unavailable"
        try:
            refs.append(_PROGRAM_CLS.from_bytes(bytes(ref_block.transactions_generator)))
        except Exception as e:
            return {}, {}, f"ref block at {int(ref_h)} Program.from_bytes failed: {type(e).__name__}: {e}"

    try:
        gen_prog = _PROGRAM_CLS.from_bytes(bytes(block.transactions_generator))
    except Exception as e:
        return {}, {}, f"generator Program.from_bytes failed: {type(e).__name__}: {e}"

    max_cost = int(getattr(_DEFAULT_CONSTANTS, "MAX_BLOCK_COST_CLVM", 11_000_000_000))

    # Try every combination of (args shape, run method) — chia's Program
    # API has shifted across versions: Program.run vs run_with_cost,
    # args wrapped in outer list vs not, etc. First success wins.
    attempts: list[tuple[str, Any]] = []
    for args_label, args_factory in (
        ("[[refs]]", lambda: _PROGRAM_CLS.to([refs])),
        ("[refs]", lambda: _PROGRAM_CLS.to(refs)),
    ):
        for run_label, runner in (
            ("run", lambda p, a: p.run(a)),
            (
                "run_with_cost",
                lambda p, a: p.run_with_cost(max_cost, a)[1],
            ),
        ):
            attempts.append((f"{run_label}({args_label})", (args_factory, runner)))

    result = None
    shape_used = ""
    errors: list[str] = []
    for label, (args_factory, runner) in attempts:
        try:
            args = args_factory()
            result = runner(gen_prog, args)
            shape_used = label
            break
        except Exception as e:
            errors.append(f"{label}: {type(e).__name__}: {e}")
            continue
    if result is None:
        # Surface a compact summary of why every shape failed.
        return {}, {}, "Program.run failed for all shapes: " + " | ".join(errors[:3])

    # Walk the result looking for (parent puzzle_reveal amount solution)
    # 4-tuples. The chia generator's exact output shape varies across
    # versions: sometimes a flat list of spend tuples, sometimes wrapped
    # one level deeper. We try both AND a recursive walker as fallback,
    # then merge — duplicate keys just overwrite each other.
    reveals: dict[bytes, bytes] = {}
    spend_data: dict[tuple[bytes, bytes, int], dict] = {}
    strategy_counts: list[str] = []
    last_walk_err: str | None = None

    def _try_extract(node: Any) -> bool:
        nonlocal last_walk_err
        try:
            # Spend tuple shape: (parent puzzle amount solution)
            parent_node = node.first()
            puzzle_node = node.rest().first()
            amount_node = node.rest().rest().first()
            solution_node = node.rest().rest().rest().first()

            ph = bytes(puzzle_node.get_tree_hash())
            if len(ph) != 32:
                return False
            puzzle_bytes = bytes(puzzle_node)
            reveals[ph] = puzzle_bytes

            # Capture full per-coin data for the announcement walker. If
            # any individual field can't be coerced we still keep the
            # puzzle reveal — partial data is more useful than none.
            try:
                parent_atom = parent_node.as_atom() or b""
                amount_atom = amount_node.as_atom() or b""
                amount = int.from_bytes(amount_atom, "big") if amount_atom else 0
                solution_bytes = bytes(solution_node)
                if len(parent_atom) == 32:
                    spend_data[(parent_atom, ph, amount)] = {
                        "parent_id": parent_atom,
                        "puzzle_hash": ph,
                        "amount": amount,
                        "puzzle_reveal": puzzle_bytes,
                        "solution": solution_bytes,
                    }
            except Exception:
                pass
            return True
        except Exception as e:
            last_walk_err = f"{type(e).__name__}: {e}"
            return False

    # Strategy A — flat: iterate result directly as if it's the spend list.
    a_count = 0
    a_seen = 0
    try:
        for sp in result.as_iter():
            a_seen += 1
            if _try_extract(sp):
                a_count += 1
        strategy_counts.append(f"flat={a_count}/{a_seen}")
    except Exception as e:
        strategy_counts.append(f"flat-err={type(e).__name__}")

    # Strategy B — wrapped: result.first() is the spend list.
    b_count = 0
    b_seen = 0
    try:
        first = result.first()
        for sp in first.as_iter():
            b_seen += 1
            if _try_extract(sp):
                b_count += 1
        strategy_counts.append(f"wrapped={b_count}/{b_seen}")
    except Exception as e:
        strategy_counts.append(f"wrapped-err={type(e).__name__}")

    # Strategy C — recursive: walk the whole tree looking for any 4-tuple
    # whose 2nd element hashes to 32 bytes. Catches odd nesting we
    # don't anticipate. Bounded depth so a malformed program can't
    # exhaust the stack.
    c_count = 0

    def _recurse(node: Any, depth: int) -> None:
        nonlocal c_count
        if depth > 16:
            return
        try:
            parts = list(node.as_iter())
        except Exception:
            return
        if len(parts) == 4 and _try_extract(node):
            c_count += 1
            return
        for child in parts:
            _recurse(child, depth + 1)

    try:
        _recurse(result, 0)
        strategy_counts.append(f"recursive={c_count}")
    except Exception as e:
        strategy_counts.append(f"recursive-err={type(e).__name__}")

    summary = ", ".join(strategy_counts)
    if not reveals:
        suffix = f"; last walk error: {last_walk_err}" if last_walk_err else ""
        return (
            {},
            {},
            f"ran via {shape_used} but extracted 0 reveals ({summary}){suffix}",
        )

    return (
        reveals,
        spend_data,
        f"extracted {len(reveals)} reveals / {len(spend_data)} spends "
        f"via {shape_used} ({summary})",
    )


def _parse_announcements(
    puzzle_bytes: bytes, solution_bytes: bytes
) -> tuple[dict[str, list[bytes]], str | None]:
    """Run puzzle(solution) and return the announcement-related conditions:

        {
          "created_cca_msgs":  list[bytes],  # raw messages (creator coin_id implicit)
          "asserted_cca_ids":  list[bytes],  # pre-hashed sha256(coin_id || msg)
          "created_cpa_msgs":  list[bytes],  # raw messages
          "asserted_cpa_ids":  list[bytes],  # pre-hashed sha256(puzzle_hash || msg)
        }

    On run failure, returns empty lists plus an error note. Per-condition
    parse errors are skipped silently — one mis-shaped condition shouldn't
    drop the rest."""
    out: dict[str, list[bytes]] = {
        "created_cca_msgs": [],
        "asserted_cca_ids": [],
        "created_cpa_msgs": [],
        "asserted_cpa_ids": [],
    }
    if _PROGRAM_CLS is None:
        return out, "Program class not importable"
    try:
        puzzle = _PROGRAM_CLS.from_bytes(puzzle_bytes)
        solution = _PROGRAM_CLS.from_bytes(solution_bytes)
    except Exception as e:
        return out, f"Program.from_bytes failed: {type(e).__name__}: {e}"

    max_cost = int(getattr(_DEFAULT_CONSTANTS, "MAX_BLOCK_COST_CLVM", 11_000_000_000))
    conds = None
    last_err: str | None = None
    for label, runner in (
        ("run", lambda: puzzle.run(solution)),
        ("run_with_cost", lambda: puzzle.run_with_cost(max_cost, solution)[1]),
    ):
        try:
            conds = runner()
            break
        except Exception as e:
            last_err = f"{label}: {type(e).__name__}: {e}"
            continue
    if conds is None:
        return out, last_err or "puzzle.run failed (unknown)"

    try:
        for cond in conds.as_iter():
            try:
                opcode_atom = cond.first().as_atom() or b""
                opcode = int.from_bytes(opcode_atom, "big") if opcode_atom else 0
                if opcode not in (
                    _OP_CREATE_COIN_ANNOUNCEMENT,
                    _OP_ASSERT_COIN_ANNOUNCEMENT,
                    _OP_CREATE_PUZZLE_ANNOUNCEMENT,
                    _OP_ASSERT_PUZZLE_ANNOUNCEMENT,
                ):
                    continue
                arg_atom = cond.rest().first().as_atom()
                if arg_atom is None:
                    continue
                if opcode == _OP_CREATE_COIN_ANNOUNCEMENT:
                    out["created_cca_msgs"].append(bytes(arg_atom))
                elif opcode == _OP_ASSERT_COIN_ANNOUNCEMENT:
                    out["asserted_cca_ids"].append(bytes(arg_atom))
                elif opcode == _OP_CREATE_PUZZLE_ANNOUNCEMENT:
                    out["created_cpa_msgs"].append(bytes(arg_atom))
                elif opcode == _OP_ASSERT_PUZZLE_ANNOUNCEMENT:
                    out["asserted_cpa_ids"].append(bytes(arg_atom))
            except Exception:
                continue
    except Exception as e:
        return out, f"conditions walk failed: {type(e).__name__}: {e}"

    return out, None


def _walk_announcement_linkages(
    spends_list: list,
    spend_data_by_key: dict[tuple[bytes, bytes, int], dict],
    seed_coin_ids: set[bytes],
    max_total: int = 100,
) -> tuple[dict[bytes, dict], str]:
    """BFS from seed_coin_ids over chia coin/puzzle-announcement edges (60/61
    and 62/63). A spend is connected to another in the same block iff one
    creates an announcement the other asserts (in either direction).

    Returns ({extra_coin_id → {edge_note, asset_type/asset_id placeholders}},
    diagnostic_note). `extra_coin_id` excludes the seeds themselves.

    Capped at `max_total` reached coins (seeds + extras combined) so a
    pathological block can't blow up. Hitting the cap is reported in the
    note."""
    if not spends_list:
        return {}, "spends_list empty"

    # Per-spend announcement info, keyed by chia_rs `coin_id`. Spends whose
    # solution we couldn't extract are still registered (as no-announcements
    # nodes) so they can be reported as "linkage missing" rather than
    # quietly ignored, but they don't contribute edges.
    info: dict[bytes, dict] = {}
    parse_failures: list[str] = []
    spends_without_solution = 0
    for sp in spends_list:
        try:
            coin_id = bytes(getattr(sp, "coin_id"))
        except Exception:
            continue
        if len(coin_id) != 32:
            continue
        try:
            ph = bytes(getattr(sp, "puzzle_hash"))
        except Exception:
            ph = b""
        try:
            parent = bytes(getattr(sp, "parent_id"))
        except Exception:
            parent = b""
        amount_raw = getattr(sp, "coin_amount", None)
        if amount_raw is None:
            amount_raw = getattr(sp, "amount", None)
        try:
            amount = int(amount_raw) if amount_raw is not None else 0
        except Exception:
            amount = 0

        details = spend_data_by_key.get((parent, ph, amount))
        if details is None:
            info[coin_id] = {
                "puzzle_hash": ph,
                "created_cca_ids": set(),
                "asserted_cca_ids": set(),
                "created_cpa_ids": set(),
                "asserted_cpa_ids": set(),
            }
            spends_without_solution += 1
            continue

        parsed, err = _parse_announcements(
            details["puzzle_reveal"], details["solution"]
        )
        if err:
            parse_failures.append(f"{coin_id.hex()[:12]}…: {err}")
        info[coin_id] = {
            "puzzle_hash": ph,
            "created_cca_ids": {
                hashlib.sha256(coin_id + msg).digest()
                for msg in parsed["created_cca_msgs"]
            },
            "asserted_cca_ids": set(parsed["asserted_cca_ids"]),
            "created_cpa_ids": {
                hashlib.sha256(ph + msg).digest()
                for msg in parsed["created_cpa_msgs"]
            },
            "asserted_cpa_ids": set(parsed["asserted_cpa_ids"]),
        }

    # Inverse indices: announcement_id → set of coin_ids creating / asserting.
    cca_created_by: dict[bytes, set[bytes]] = {}
    cca_asserted_by: dict[bytes, set[bytes]] = {}
    cpa_created_by: dict[bytes, set[bytes]] = {}
    cpa_asserted_by: dict[bytes, set[bytes]] = {}
    for cid, x in info.items():
        for aid in x["created_cca_ids"]:
            cca_created_by.setdefault(aid, set()).add(cid)
        for aid in x["asserted_cca_ids"]:
            cca_asserted_by.setdefault(aid, set()).add(cid)
        for aid in x["created_cpa_ids"]:
            cpa_created_by.setdefault(aid, set()).add(cid)
        for aid in x["asserted_cpa_ids"]:
            cpa_asserted_by.setdefault(aid, set()).add(cid)

    # BFS expansion. Edge note records how each new coin entered the set.
    reached: set[bytes] = set(seed_coin_ids)
    edges: dict[bytes, str] = {}
    queue: list[bytes] = [c for c in seed_coin_ids if c in info]
    truncated = False

    def _add(other: bytes, note: str) -> None:
        nonlocal truncated
        if other in reached:
            return
        if len(reached) >= max_total:
            truncated = True
            return
        reached.add(other)
        edges[other] = note
        queue.append(other)

    while queue and not truncated:
        cid = queue.pop()
        x = info.get(cid)
        if x is None:
            continue
        src = cid.hex()[:12] + "…"
        # This spend creates announcements → other spends that assert them.
        for aid in x["created_cca_ids"]:
            for other in cca_asserted_by.get(aid, set()):
                _add(other, f"asserts coin announcement created by {src}")
        for aid in x["created_cpa_ids"]:
            for other in cpa_asserted_by.get(aid, set()):
                _add(other, f"asserts puzzle announcement created by {src}")
        # This spend asserts announcements → other spends that created them.
        for aid in x["asserted_cca_ids"]:
            for other in cca_created_by.get(aid, set()):
                _add(other, f"creates coin announcement asserted by {src}")
        for aid in x["asserted_cpa_ids"]:
            for other in cpa_created_by.get(aid, set()):
                _add(other, f"creates puzzle announcement asserted by {src}")

    extras: dict[bytes, dict] = {
        cid: {"edge_note": edges.get(cid, "(linked via announcement chain)")}
        for cid in reached
        if cid not in seed_coin_ids
    }

    note_parts: list[str] = [
        f"parsed {len(info)} spend(s)",
        f"{spends_without_solution} without solution data" if spends_without_solution else "",
        f"{len(parse_failures)} parse failure(s): " + "; ".join(parse_failures[:2])
            if parse_failures else "",
        f"capped at {max_total} reached coins" if truncated else "",
        f"found {len(extras)} announcement-linked sibling(s)",
    ]
    return extras, ", ".join(p for p in note_parts if p)


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
    on any failure. The fallback path uses byte search only.

    Tries several known chia_rs call shapes in order; reports each attempt's
    failure if all of them error out. The signatures differ across chia_rs
    versions — we don't pin a version, so we probe."""
    if _run_generator_v2 is None and _run_generator_v1 is None:
        return None, _generator_setup_error or "no generator runner importable"
    if _DEFAULT_CONSTANTS is None:
        return None, _generator_setup_error or "DEFAULT_CONSTANTS missing"
    if block.transactions_generator is None:
        return None, "no transactions_generator (non-tx block)"

    refs: list[bytes] = []
    for ref_h in block.transactions_generator_ref_list:
        ref_block = _get_canonical_block(db, int(ref_h))
        if ref_block is None or ref_block.transactions_generator is None:
            return None, f"ref block at height {ref_h} not available"
        refs.append(bytes(ref_block.transactions_generator))

    gen_bytes = bytes(block.transactions_generator)
    max_cost = int(getattr(_DEFAULT_CONSTANTS, "MAX_BLOCK_COST_CLVM", 11_000_000_000))

    # The aggregated BLS signature is right there on the FullBlock for tx
    # blocks. Using it makes both v1 and v2 happy. For non-tx blocks (no
    # transactions_info) we shouldn't even be here since
    # transactions_generator would be None, but be defensive.
    real_sig: Any = None
    if block.transactions_info is not None:
        real_sig = getattr(block.transactions_info, "aggregated_signature", None)
    fallback_sig: Any = _ZERO_G2 if _ZERO_G2 is not None else bytes(96)

    # Each attempt is a (label, callable). Both v1 and v2 take the same
    # 7-arg shape on modern chia_rs versions, so we don't really care
    # which we call — we try v1 first since it's the "block validation"
    # entry point, fall back to v2 (mempool-mode validation) when v1
    # isn't exported.
    #
    # The legacy 5-arg / 4-arg shapes catch much older chia_rs versions
    # that some users may still have installed.
    attempts: list[tuple[str, Any]] = []

    def _add_modern(label_prefix: str, fn):
        if real_sig is not None:
            attempts.append((
                f"{label_prefix}/7-arg with real signature",
                lambda: fn(gen_bytes, refs, max_cost, 0, real_sig, None, _DEFAULT_CONSTANTS),
            ))
        attempts.append((
            f"{label_prefix}/7-arg with zero G2Element signature",
            lambda: fn(gen_bytes, refs, max_cost, 0, fallback_sig, None, _DEFAULT_CONSTANTS),
        ))

    if _run_generator_v1 is not None:
        _add_modern("v1", _run_generator_v1)
        attempts.append((
            "v1/5-arg (legacy)",
            lambda: _run_generator_v1(gen_bytes, refs, max_cost, 0, _DEFAULT_CONSTANTS),
        ))
        attempts.append((
            "v1/4-arg (oldest)",
            lambda: _run_generator_v1(gen_bytes, refs, max_cost, 0),
        ))

    if _run_generator_v2 is not None:
        _add_modern("v2", _run_generator_v2)

    failures: list[str] = []
    for label, fn in attempts:
        try:
            result = fn()
        except TypeError as e:
            failures.append(f"{label}: TypeError: {e}")
            continue
        except Exception as e:
            # Non-TypeError exceptions are real (program crashed, bad args,
            # etc.) — don't keep trying other signatures.
            return None, f"{label}: {type(e).__name__}: {e}"

        # chia_rs result shape: (err, conds). When err is non-None, the
        # generator failed validation; conds is None in that case. When
        # err is None, conds carries the SpendBundleConditions.
        err_code = None
        conds = None
        if isinstance(result, tuple) and len(result) >= 2:
            err_code = result[0]
            conds = result[1]
        else:
            conds = result

        if conds is None:
            # If we used v2 and hit an error, the cause is most likely the
            # zero signature failing BLS validation. Record and try the
            # next attempt — v1 would have already succeeded if available,
            # so this only matters when v1 is unavailable on this version.
            failures.append(f"{label}: returned (err={err_code!r}, conds=None)")
            continue
        return list(getattr(conds, "spends", []) or []), None

    return None, "no generator signature succeeded; tried: " + " | ".join(failures)


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

    # Default classification — refined by _process_block when a puzzle
    # reveal is available. Spent-coin puzzle_hash match is unambiguously
    # the bridge contract; CREATE_COIN matches need the SOURCE coin's
    # puzzle reveal to classify (xch/cat/singleton/unknown).
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
    # Lazy: only pay for the Program.run() pass if we actually matched
    # something. We capture the extraction note (success or failure
    # reason) and stamp it on the block-level output so failures show up
    # in Bridge Info without an extra debug flag.
    puzzle_reveals_by_ph: dict[bytes, bytes] = {}
    spend_data_by_key: dict[tuple[bytes, bytes, int], dict] = {}
    extraction_note: str | None = None
    _reveals_loaded = False

    def _ensure_reveals_loaded() -> None:
        nonlocal puzzle_reveals_by_ph, spend_data_by_key, _reveals_loaded, extraction_note
        if _reveals_loaded:
            return
        _reveals_loaded = True
        try:
            puzzle_reveals_by_ph, spend_data_by_key, extraction_note = (
                _extract_puzzle_reveals(block, db)
            )
        except Exception as e:
            extraction_note = (
                f"_extract_puzzle_reveals threw: {type(e).__name__}: {e}"
            )

    # Seed coin_ids drive the announcement-linkage walker — coins matched
    # directly via puzzle_hash / create_coin_target / create_coin_hint
    # become the starting set, and the walker pulls in any sibling spend
    # connected via coin/puzzle announcement edges.
    seed_coin_ids: set[bytes] = set()

    if spends_list is not None:
        for sp in spends_list:
            try:
                m = _match_spend(sp, target_hashes)
                if m is None:
                    continue
                try:
                    seed_cid = bytes(getattr(sp, "coin_id"))
                    if len(seed_cid) == 32:
                        seed_coin_ids.add(seed_cid)
                except Exception:
                    pass
                # Enrich with asset classification when we can. Look up
                # the SPENT coin's puzzle_reveal by puzzle_hash and
                # uncurry it. For "puzzle_hash" matches the spent coin
                # IS the bridge contract — classification is already
                # "bridge". For "create_coin_*" matches the spent coin
                # is the SOURCE (e.g. XCH wallet, CAT) creating the
                # bridge message coin, and we want to identify that.
                _ensure_reveals_loaded()
                classification_note: str | None = None
                if m.get("asset_type") == "bridge":
                    classification_note = "whole puzzle_hash matches a configured target"
                else:
                    ph_hex = (m.get("coin") or {}).get("puzzle_hash")
                    ph_bytes = b""
                    if ph_hex and isinstance(ph_hex, str):
                        ph_clean = ph_hex[2:] if ph_hex.startswith("0x") else ph_hex
                        try:
                            ph_bytes = bytes.fromhex(ph_clean)
                        except ValueError:
                            ph_bytes = b""
                    reveal = puzzle_reveals_by_ph.get(ph_bytes) if ph_bytes else None
                    if reveal is not None:
                        new_type, new_id, note = _classify_puzzle(
                            reveal, target_hashes
                        )
                        m["asset_type"] = new_type
                        m["asset_id"] = new_id
                        classification_note = note
                    else:
                        if not puzzle_reveals_by_ph:
                            classification_note = (
                                "no puzzle reveals available "
                                f"({extraction_note or 'extraction skipped'})"
                            )
                        else:
                            # Show the puzzle_hashes that ARE in the dict so
                            # we can tell whether the extractor missed this
                            # spend entirely (key absent) vs. chia_rs and
                            # chia python disagree on the hash (different key).
                            keys_sample = ", ".join(
                                "0x" + k.hex()[:12] + "…"
                                for k in list(puzzle_reveals_by_ph.keys())[:5]
                            )
                            more = (
                                f" +{len(puzzle_reveals_by_ph) - 5} more"
                                if len(puzzle_reveals_by_ph) > 5
                                else ""
                            )
                            classification_note = (
                                f"puzzle_reveal not found for puzzle_hash="
                                f"{ph_hex}; extracted {len(puzzle_reveals_by_ph)} "
                                f"reveals: [{keys_sample}{more}]; "
                                f"extraction: {extraction_note or 'n/a'}"
                            )
                if classification_note is not None:
                    m["classification_note"] = classification_note
                spend_details.append(m)
            except Exception as e:
                # Don't let one mis-shaped spend kill the whole match.
                print(
                    f"# spend match warning at {height}:{hh_hex}: {type(e).__name__}: {e}",
                    file=sys.stderr,
                )

    # Announcement-linkage pass: pull in sibling spends from the same
    # spend_bundle. Skipped if no seeds matched (nothing to walk from) or
    # if generator parsing failed (no spends_list to traverse).
    linkage_note: str | None = None
    block_spend_count = len(spends_list) if spends_list is not None else None
    if spends_list and seed_coin_ids:
        _ensure_reveals_loaded()
        try:
            extras, linkage_note = _walk_announcement_linkages(
                spends_list, spend_data_by_key, seed_coin_ids
            )
        except Exception as e:
            extras = {}
            linkage_note = f"walker threw: {type(e).__name__}: {e}"

        # Build a coin_id → spend lookup so we can fill in coin info for
        # the linked siblings. Same defensive bytes() pattern as elsewhere.
        spends_by_coin_id: dict[bytes, Any] = {}
        for sp in spends_list:
            try:
                cid = bytes(getattr(sp, "coin_id"))
                if len(cid) == 32:
                    spends_by_coin_id[cid] = sp
            except Exception:
                continue

        target_hex_sorted = sorted(h.hex() for h in target_hashes)
        for new_cid, link_info in extras.items():
            sp = spends_by_coin_id.get(new_cid)
            if sp is None:
                continue
            try:
                spent_ph = bytes(getattr(sp, "puzzle_hash"))
            except Exception:
                spent_ph = b""
            try:
                parent = bytes(getattr(sp, "parent_id"))
            except Exception:
                try:
                    parent = bytes(getattr(sp, "coin_id"))
                except Exception:
                    parent = b""
            amount_raw = getattr(sp, "coin_amount", None)
            if amount_raw is None:
                amount_raw = getattr(sp, "amount", None)
            try:
                amount_int = int(amount_raw) if amount_raw is not None else None
            except Exception:
                amount_int = None

            m_extra: dict = {
                # Carry the bridge target through so downstream tooling can
                # still group by target; the match_reason makes clear this
                # was reached transitively, not by direct byte match.
                "matched_hashes": target_hex_sorted,
                "match_reasons": ["announcement_linked"],
                "coin": {
                    "parent_coin_info": "0x" + parent.hex() if parent else None,
                    "puzzle_hash": "0x" + spent_ph.hex() if spent_ph else None,
                    "amount": amount_int,
                },
                "asset_type": "unknown",
                "asset_id": None,
            }

            classification_note = link_info.get("edge_note") or "announcement-linked"
            if spent_ph:
                reveal = puzzle_reveals_by_ph.get(spent_ph)
                if reveal is not None:
                    new_type, new_id, cl_note = _classify_puzzle(
                        reveal, target_hashes
                    )
                    m_extra["asset_type"] = new_type
                    m_extra["asset_id"] = new_id
                    classification_note = f"{classification_note}; {cl_note}"
                else:
                    classification_note = (
                        f"{classification_note}; puzzle reveal not extracted "
                        f"for puzzle_hash=0x{spent_ph.hex()}"
                    )
            m_extra["classification_note"] = classification_note
            spend_details.append(m_extra)

    return {
        "height": height,
        "header_hash": hh_hex,
        "timestamp": ts,
        "byte_matched_hashes": byte_matched,
        "generator_parsed": spends_list is not None,
        "generator_error": gen_err,
        "classification_extraction_note": extraction_note,
        "announcement_linkage_note": linkage_note,
        "block_spend_count": block_spend_count,
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
