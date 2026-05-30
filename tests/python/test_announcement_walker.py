"""Unit tests for the pure BFS function `_bfs_announcement_graph` extracted
from `_walk_announcement_linkages` in scripts/_decode_bridge_spends.py.

Run via:
    PYTHONPATH=tests/fixtures/fake_chia python3 -m unittest \\
        tests/python/test_announcement_walker.py

The wrapping vitest test (`tests/python.announcement-walker.test.ts`)
drives this with the correct PYTHONPATH so the module's chia / zstd
imports resolve against the fake fixtures rather than real packages.

What's covered:
  - Empty input (no seeds, no info, empty result).
  - A seed with no announcement edges (no extras).
  - One CCA edge in each direction (create→assert and assert→create).
  - One CPA edge in each direction (puzzle announcement).
  - Multi-hop transitive linkage (seed → A → B reached via two hops).
  - Edges only fire when the FULL announcement_id matches (sha256 of
    coin_id || msg, not just the raw msg) — i.e. we don't accidentally
    cross-link spends that share a literal message string but with
    different creator coin_ids.
  - `max_total` cap is enforced; truncated flag is set.
  - Edge note carries the source coin_id prefix and the edge kind.
  - Multiple seeds traverse independently and union into one extras set.
  - Cycle resistance — a coin can't be added twice and BFS terminates.
"""

import hashlib
import os
import sys
import unittest
from pathlib import Path

# Locate the script under test. The test file lives at
# tests/python/test_announcement_walker.py so the script is two
# directories up + /scripts.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(_REPO_ROOT / "scripts"))

# The module's top-level code probes a handful of chia.* and chia_rs
# imports. When those probes fail (e.g. fake_chia provides only a
# subset), the module sets the corresponding globals to None and
# continues — module load itself doesn't fail. The BFS function under
# test has no chia dependency at all, so we don't care about the probe
# outcomes here.
import _decode_bridge_spends as dbs  # noqa: E402


def _id(label: str) -> bytes:
    """Deterministic 32-byte coin_id derived from a short label so tests
    are readable. The exact bytes don't matter; only that distinct labels
    map to distinct ids."""
    return hashlib.sha256(b"coin:" + label.encode()).digest()


def _ann(label: str) -> bytes:
    """Deterministic 32-byte announcement_id from a label. Distinct
    labels → distinct ids; same label across spends → same id (so we
    can express edges)."""
    return hashlib.sha256(b"ann:" + label.encode()).digest()


def _empty_info(coin_id: bytes, puzzle_hash: bytes = b"") -> dict:
    """An info entry with no edges — for spends that have a coin_id but
    contribute nothing to the graph."""
    return {
        "puzzle_hash": puzzle_hash,
        "created_cca_ids": set(),
        "asserted_cca_ids": set(),
        "created_cpa_ids": set(),
        "asserted_cpa_ids": set(),
    }


class BfsAnnouncementGraphTests(unittest.TestCase):
    # ---------- shape / no-op cases ----------

    def test_empty_inputs(self):
        extras, truncated = dbs._bfs_announcement_graph({}, set())
        self.assertEqual(extras, {})
        self.assertFalse(truncated)

    def test_seed_with_no_edges_returns_no_extras(self):
        seed = _id("A")
        info = {seed: _empty_info(seed)}
        extras, truncated = dbs._bfs_announcement_graph(info, {seed})
        self.assertEqual(extras, {})
        self.assertFalse(truncated)

    def test_seed_not_in_info_doesnt_crash(self):
        # A caller may pass a seed coin_id that isn't in `info` (e.g.
        # the seed's solution couldn't be extracted). BFS should
        # gracefully traverse nothing.
        seed = _id("A")
        extras, truncated = dbs._bfs_announcement_graph({}, {seed})
        self.assertEqual(extras, {})
        self.assertFalse(truncated)

    # ---------- single-edge linkage in each direction ----------

    def test_cca_created_by_seed_pulls_in_asserter(self):
        seed = _id("locker")
        other = _id("xch_fee")
        msg = b"hello"
        ann_id = hashlib.sha256(seed + msg).digest()
        info = {
            seed: {
                **_empty_info(seed),
                "created_cca_ids": {ann_id},
            },
            other: {
                **_empty_info(other),
                "asserted_cca_ids": {ann_id},
            },
        }
        extras, truncated = dbs._bfs_announcement_graph(info, {seed})
        self.assertIn(other, extras)
        self.assertEqual(len(extras), 1)
        self.assertIn(
            "asserts coin announcement created by", extras[other]["edge_note"]
        )
        self.assertFalse(truncated)

    def test_cca_asserted_by_seed_pulls_in_creator(self):
        seed = _id("bridge_msg")
        creator = _id("locker")
        ann_id = _ann("c1")
        info = {
            seed: {
                **_empty_info(seed),
                "asserted_cca_ids": {ann_id},
            },
            creator: {
                **_empty_info(creator),
                "created_cca_ids": {ann_id},
            },
        }
        extras, _ = dbs._bfs_announcement_graph(info, {seed})
        self.assertIn(creator, extras)
        self.assertIn(
            "creates coin announcement asserted by", extras[creator]["edge_note"]
        )

    def test_cpa_created_by_seed_pulls_in_asserter(self):
        seed = _id("cat")
        other = _id("locker")
        ph = b"\xaa" * 32
        msg = b"world"
        ann_id = hashlib.sha256(ph + msg).digest()
        info = {
            seed: {
                **_empty_info(seed, puzzle_hash=ph),
                "created_cpa_ids": {ann_id},
            },
            other: {
                **_empty_info(other),
                "asserted_cpa_ids": {ann_id},
            },
        }
        extras, _ = dbs._bfs_announcement_graph(info, {seed})
        self.assertIn(other, extras)
        self.assertIn(
            "asserts puzzle announcement created by", extras[other]["edge_note"]
        )

    def test_cpa_asserted_by_seed_pulls_in_creator(self):
        seed = _id("locker")
        creator = _id("offer")
        ann_id = _ann("p1")
        info = {
            seed: {
                **_empty_info(seed),
                "asserted_cpa_ids": {ann_id},
            },
            creator: {
                **_empty_info(creator),
                "created_cpa_ids": {ann_id},
            },
        }
        extras, _ = dbs._bfs_announcement_graph(info, {seed})
        self.assertIn(creator, extras)
        self.assertIn(
            "creates puzzle announcement asserted by", extras[creator]["edge_note"]
        )

    # ---------- multi-hop & cycle behavior ----------

    def test_two_hop_transitive_linkage(self):
        # seed → A via CCA, A → B via CPA. B must be reached.
        seed = _id("seed")
        a = _id("A")
        b = _id("B")
        ann_seed_to_a = _ann("seed_a")
        ann_a_to_b = _ann("a_b")
        info = {
            seed: {
                **_empty_info(seed),
                "asserted_cca_ids": {ann_seed_to_a},
            },
            a: {
                **_empty_info(a),
                "created_cca_ids": {ann_seed_to_a},
                "asserted_cpa_ids": {ann_a_to_b},
            },
            b: {
                **_empty_info(b),
                "created_cpa_ids": {ann_a_to_b},
            },
        }
        extras, _ = dbs._bfs_announcement_graph(info, {seed})
        self.assertEqual(set(extras.keys()), {a, b})

    def test_cycle_does_not_double_add(self):
        # Two spends mutually reference each other; result is one
        # extra (the non-seed) and BFS terminates.
        seed = _id("S")
        other = _id("O")
        ann_a = _ann("a")
        ann_b = _ann("b")
        info = {
            seed: {
                **_empty_info(seed),
                "created_cca_ids": {ann_a},
                "asserted_cca_ids": {ann_b},
            },
            other: {
                **_empty_info(other),
                "asserted_cca_ids": {ann_a},
                "created_cca_ids": {ann_b},
            },
        }
        extras, truncated = dbs._bfs_announcement_graph(info, {seed})
        self.assertEqual(set(extras.keys()), {other})
        self.assertFalse(truncated)

    # ---------- announcement_id discrimination ----------

    def test_same_message_different_coin_ids_does_not_link(self):
        # Two spends use the same raw message bytes but the announcement_id
        # is sha256(coin_id || msg), so the resulting IDs differ — they
        # should NOT be linked. Confirms the caller is responsible for
        # pre-hashing announcement IDs correctly.
        seed = _id("seed")
        unrelated = _id("U")
        msg = b"same-message"
        seed_ann = hashlib.sha256(seed + msg).digest()
        # `unrelated` ALSO creates an ann with the same raw msg, but its
        # ann_id is hashed with its own coin_id → different bytes.
        unrelated_ann = hashlib.sha256(unrelated + msg).digest()
        self.assertNotEqual(seed_ann, unrelated_ann)
        info = {
            seed: {
                **_empty_info(seed),
                "created_cca_ids": {seed_ann},
            },
            unrelated: {
                **_empty_info(unrelated),
                "created_cca_ids": {unrelated_ann},
                # Asserts something nobody created → not linked.
                "asserted_cca_ids": {_ann("nope")},
            },
        }
        extras, _ = dbs._bfs_announcement_graph(info, {seed})
        self.assertEqual(extras, {})

    # ---------- max_total cap ----------

    def test_max_total_cap_truncates_and_flags(self):
        # One seed + 5 reachable extras, but cap allows only 3 reached
        # total → truncated, 2 extras returned (3 total - 1 seed).
        seed = _id("S")
        extras_ids = [_id(f"E{i}") for i in range(5)]
        info = {seed: {**_empty_info(seed), "created_cca_ids": set()}}
        for e in extras_ids:
            ann = _ann(f"e_{e.hex()[:6]}")
            info[seed]["created_cca_ids"].add(hashlib.sha256(seed + ann).digest())
            info[e] = {
                **_empty_info(e),
                "asserted_cca_ids": {hashlib.sha256(seed + ann).digest()},
            }
        result, truncated = dbs._bfs_announcement_graph(info, {seed}, max_total=3)
        self.assertTrue(truncated)
        self.assertEqual(len(result), 2)  # 3 reached - 1 seed

    def test_max_total_not_hit_means_truncated_false(self):
        seed = _id("S")
        e = _id("E")
        ann_id = _ann("a")
        info = {
            seed: {**_empty_info(seed), "created_cca_ids": {hashlib.sha256(seed + ann_id).digest()}},
            e: {**_empty_info(e), "asserted_cca_ids": {hashlib.sha256(seed + ann_id).digest()}},
        }
        _, truncated = dbs._bfs_announcement_graph(info, {seed}, max_total=100)
        self.assertFalse(truncated)

    # ---------- multiple seeds ----------

    def test_multiple_seeds_union_into_one_extras_set(self):
        # Two disjoint seeds each link to one extra; result has both
        # extras and excludes the seeds themselves.
        s1 = _id("S1")
        e1 = _id("E1")
        s2 = _id("S2")
        e2 = _id("E2")
        ann1 = hashlib.sha256(s1 + b"m1").digest()
        ann2 = hashlib.sha256(s2 + b"m2").digest()
        info = {
            s1: {**_empty_info(s1), "created_cca_ids": {ann1}},
            e1: {**_empty_info(e1), "asserted_cca_ids": {ann1}},
            s2: {**_empty_info(s2), "created_cca_ids": {ann2}},
            e2: {**_empty_info(e2), "asserted_cca_ids": {ann2}},
        }
        extras, _ = dbs._bfs_announcement_graph(info, {s1, s2})
        self.assertEqual(set(extras.keys()), {e1, e2})

    def test_seed_in_seeds_set_is_not_emitted_as_extra(self):
        # If two coins are mutually-linked and BOTH are passed as seeds,
        # neither appears in extras.
        s1 = _id("S1")
        s2 = _id("S2")
        ann = hashlib.sha256(s1 + b"m").digest()
        info = {
            s1: {**_empty_info(s1), "created_cca_ids": {ann}},
            s2: {**_empty_info(s2), "asserted_cca_ids": {ann}},
        }
        extras, _ = dbs._bfs_announcement_graph(info, {s1, s2})
        self.assertEqual(extras, {})

    # ---------- edge_note formatting ----------

    def test_edge_note_carries_source_coin_id_prefix(self):
        seed = _id("locker")
        other = _id("xch")
        ann = hashlib.sha256(seed + b"m").digest()
        info = {
            seed: {**_empty_info(seed), "created_cca_ids": {ann}},
            other: {**_empty_info(other), "asserted_cca_ids": {ann}},
        }
        extras, _ = dbs._bfs_announcement_graph(info, {seed})
        note = extras[other]["edge_note"]
        # The note ends with the first 12 hex chars of the seed's
        # coin_id, followed by the ellipsis.
        self.assertTrue(note.endswith(seed.hex()[:12] + "…"), repr(note))


if __name__ == "__main__":
    unittest.main()
