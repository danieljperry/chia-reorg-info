#!/usr/bin/env python3
"""Stand-in for scripts/_decode_bridge_spends.py that always returns a
fixed match payload, so tests/bridge-info.test.ts can drive
`searchBridges` end-to-end without needing chia or sqlite.

Asserts the contract: argv length, stdin pairs, exit 0 + JSON stdout.
"""

import json
import sys

# Mirror the helper's signature: DB_PATH TARGETS_CSV
assert len(sys.argv) == 3, f"expected 2 args (db_path, targets), got {sys.argv[1:]}"
_db_path = sys.argv[1]
_targets = sys.argv[2].split(",")
_orphans = [line.strip() for line in sys.stdin if line.strip()]

print(
    json.dumps(
        {
            "matches": [
                {
                    "height": 7357253,
                    "header_hash": "ee1b143321c63a67213ab54532d925c8133a94d276ba926754bbb91a72e1d413",
                    "timestamp": 1753099325,
                    "byte_matched_hashes": [_targets[0]],
                    "generator_parsed": True,
                    "generator_error": None,
                    "block_spend_count": 38,
                    "spends": [
                        {
                            "matched_hashes": [_targets[0]],
                            "match_reasons": ["puzzle_hash"],
                            "coin": {
                                "parent_coin_info": "0xabcd",
                                "puzzle_hash": "0x" + _targets[0],
                                "amount": 1000000000,
                            },
                            "asset_type": "bridge",
                            "asset_id": None,
                        },
                        {
                            "matched_hashes": [_targets[0]],
                            "match_reasons": ["create_coin_target"],
                            "coin": {
                                "parent_coin_info": "0xef01",
                                "puzzle_hash": "0xc94e",
                                "amount": 1000000000,
                            },
                            "asset_type": "warp_locker",
                            "asset_id": "bse:0xc651",
                        },
                    ],
                }
            ],
            # Mirror in the diagnostic header so the test can verify
            # downstream code didn't accidentally drop unfamiliar keys.
            "_test_diagnostics": {
                "orphan_pair_count": len(_orphans),
                "db_path": _db_path,
            },
        }
    )
)
