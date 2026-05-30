"""Verify the warp.green mod-hash table in scripts/_decode_bridge_spends.py
by re-tree-hashing each pinned `.clsp.hex` file in
tests/fixtures/warp_puzzles/ and asserting against the constants.

Catches:
  - A typo in any of the 12 hardcoded mod_hashes.
  - A row-swap in `_WARP_PUZZLES` (label `warp_X` pointing at the hash
    of a different puzzle Y).
  - An orphan: a pinned fixture with no corresponding entry in
    `_WARP_PUZZLES` / `_WARP_LOCKER_MOD_HASH`.
  - A drift: an entry in the table with no corresponding fixture.

Implementation note: we deliberately use a pure-Python CLVM
deserializer + tree-hasher so this test has zero chia / chia_rs
dependency — same code that originally identified
`0x69475cd8…` as `locker.clsp` (see commit history). The tree-hash
algorithm:
    atom: sha256(0x01 || atom_bytes)
    pair: sha256(0x02 || tree_hash(L) || tree_hash(R))
"""

import hashlib
import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(_REPO_ROOT / "scripts"))

import _decode_bridge_spends as dbs  # noqa: E402

_FIXTURES = _REPO_ROOT / "tests" / "fixtures" / "warp_puzzles"

# Label-to-filename mapping. The label side comes from `_WARP_PUZZLES`
# and `_WARP_LOCKER_MOD_HASH`; the filename side is the pinned fixture.
# If a label is added to the script without a matching fixture (or
# vice versa) the catch-all tests below will fail.
_LABEL_TO_FILE: dict[str, str] = {
    "warp_bridging_puzzle":    "bridging_puzzle.clsp.hex",
    "warp_message_coin":       "message_coin.clsp.hex",
    "warp_portal_receiver":    "portal_receiver.clsp.hex",
    "warp_rekey_portal":       "rekey_portal.clsp.hex",
    "warp_cat_burner":         "cat_burner.clsp.hex",
    "warp_cat_minter":         "cat_minter.clsp.hex",
    "warp_wrapped_tail":       "wrapped_tail.clsp.hex",
    "warp_burn_inner_puzzle":  "burn_inner_puzzle.clsp.hex",
    "warp_cat_mint_and_payout": "cat_mint_and_payout.clsp.hex",
    "warp_unlocker":           "unlocker.clsp.hex",
    "warp_p2_controller":      "p2_controller_puzzle_hash.clsp.hex",
    # `warp_locker` lives in its own constant (`_WARP_LOCKER_MOD_HASH`),
    # not in `_WARP_PUZZLES`, because the classifier extracts its
    # curried args. Test treats it as just another labeled entry.
    "warp_locker":             "locker.clsp.hex",
}


def _parse_clvm(buf: bytes, i: int):
    """Minimal CLVM deserializer — atom prefix encoding + cons (0xff)."""
    b = buf[i]
    i += 1
    if b == 0xFF:
        left, i = _parse_clvm(buf, i)
        right, i = _parse_clvm(buf, i)
        return ("pair", left, right), i
    if b == 0x80:
        return ("atom", b""), i
    if b <= 0x7F:
        return ("atom", bytes([b])), i
    if b <= 0xBF:
        length, extra = b & 0x3F, 0
    elif b <= 0xDF:
        length, extra = b & 0x1F, 1
    elif b <= 0xEF:
        length, extra = b & 0x0F, 2
    elif b <= 0xF7:
        length, extra = b & 0x07, 3
    elif b <= 0xFB:
        length, extra = b & 0x03, 4
    elif b <= 0xFD:
        length, extra = b & 0x01, 5
    else:
        raise ValueError(f"invalid prefix byte 0x{b:02x} at offset {i-1}")
    for _ in range(extra):
        length = (length << 8) | buf[i]
        i += 1
    atom = buf[i : i + length]
    if len(atom) != length:
        raise ValueError(f"truncated atom: wanted {length} got {len(atom)}")
    return ("atom", atom), i + length


def _tree_hash(node) -> bytes:
    if node[0] == "atom":
        return hashlib.sha256(b"\x01" + node[1]).digest()
    return hashlib.sha256(
        b"\x02" + _tree_hash(node[1]) + _tree_hash(node[2])
    ).digest()


def _hash_hex_file(path: Path) -> bytes:
    raw = bytes.fromhex(path.read_text().strip())
    node, consumed = _parse_clvm(raw, 0)
    if consumed != len(raw):
        raise ValueError(
            f"{path.name}: {consumed}/{len(raw)} bytes consumed (trailing data)"
        )
    return _tree_hash(node)


def _warp_table_dict() -> dict[str, bytes]:
    """Flat label → hash mapping including both `_WARP_PUZZLES` (the
    name-only family) and `_WARP_LOCKER_MOD_HASH` (the curry-extracting
    branch). Tests treat them uniformly."""
    out = dict(dbs._WARP_PUZZLES)
    out["warp_locker"] = dbs._WARP_LOCKER_MOD_HASH
    return out


class WarpPuzzleHashTests(unittest.TestCase):
    def test_every_table_entry_matches_its_fixture(self):
        """Each label in the warp table tree-hashes to the value stored
        next to it. A row-swap or typo in the source breaks this."""
        warp = _warp_table_dict()
        for label, expected_hash in warp.items():
            with self.subTest(label=label):
                self.assertIn(
                    label,
                    _LABEL_TO_FILE,
                    f"label {label!r} in source but no fixture mapping in this test",
                )
                fixture = _FIXTURES / _LABEL_TO_FILE[label]
                self.assertTrue(
                    fixture.exists(),
                    f"fixture not found: {fixture}",
                )
                computed = _hash_hex_file(fixture)
                self.assertEqual(
                    computed.hex(),
                    expected_hash.hex(),
                    f"{label}: tree_hash({_LABEL_TO_FILE[label]}) = "
                    f"{computed.hex()}, but source has "
                    f"{expected_hash.hex()}",
                )

    def test_no_fixture_is_unmapped(self):
        """Every pinned `.hex` fixture corresponds to a labeled entry —
        catches the case where someone adds a fixture but forgets to
        register it in `_WARP_PUZZLES` / `_WARP_LOCKER_MOD_HASH`."""
        mapped_files = set(_LABEL_TO_FILE.values())
        actual_files = {p.name for p in _FIXTURES.glob("*.hex")}
        unmapped = actual_files - mapped_files
        self.assertFalse(
            unmapped,
            f"fixture file(s) with no label mapping: {sorted(unmapped)}",
        )

    def test_no_source_label_is_unmapped(self):
        """Every label in the warp table has a fixture mapping in this
        test — catches the case where a label is added to the source
        but not pinned here."""
        warp = _warp_table_dict()
        unmapped = set(warp.keys()) - set(_LABEL_TO_FILE.keys())
        self.assertFalse(
            unmapped,
            f"warp source label(s) with no fixture: {sorted(unmapped)}; "
            "pin the corresponding .clsp.hex in tests/fixtures/warp_puzzles/ "
            "and add a row to _LABEL_TO_FILE in this test",
        )

    def test_table_entries_are_distinct(self):
        """Sanity check: no two labels in the warp table point at the
        same mod_hash (would indicate a copy-paste error)."""
        warp = _warp_table_dict()
        by_hash: dict[bytes, list[str]] = {}
        for label, h in warp.items():
            by_hash.setdefault(h, []).append(label)
        collisions = {h.hex(): labels for h, labels in by_hash.items() if len(labels) > 1}
        self.assertFalse(
            collisions,
            f"multiple labels share a mod_hash: {collisions}",
        )

    def test_each_entry_is_32_bytes(self):
        """Sanity check: every mod_hash is exactly 32 bytes (sha256
        output)."""
        warp = _warp_table_dict()
        for label, h in warp.items():
            with self.subTest(label=label):
                self.assertEqual(
                    len(h), 32, f"{label}: expected 32 bytes, got {len(h)}"
                )


if __name__ == "__main__":
    unittest.main()
