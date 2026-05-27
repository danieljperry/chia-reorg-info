# Minimal mock of chia.types.full_block.FullBlock for testing _decode_pos.py
# without a real chia install. Behavior: FullBlock.from_bytes(b) interprets
# the bytes as a tiny custom encoding (defined below) and returns a stub
# object whose attribute access path matches what _decode_pos.py reads.
#
# Custom encoding (used by tests only):
#   The blob is a UTF-8 JSON string of a dict with the same field names
#   the helper extracts. from_bytes decodes the JSON and builds the
#   nested object graph.

import json
from types import SimpleNamespace


class _PoS(SimpleNamespace):
    pass


class _RewardChainBlock(SimpleNamespace):
    pass


class _FoliageBlockData(SimpleNamespace):
    pass


class _Foliage(SimpleNamespace):
    pass


class _FoliageTransactionBlock(SimpleNamespace):
    pass


class _TransactionsInfo(SimpleNamespace):
    pass


class _BytesField(bytes):
    """Acts like the chia bytes32/bytes48 wrappers — has .hex() (from bytes)
    and is bytes-convertible. The helper does both `bytes(x)` and `x.hex()`
    on different fields; both work on a bytes subclass."""


class FullBlock:
    def __init__(self):
        self.reward_chain_block = None
        self.foliage = None
        self.foliage_transaction_block = None
        self.transactions_generator = None
        self.transactions_info = None

    @classmethod
    def from_bytes(cls, blob: bytes) -> "FullBlock":
        d = json.loads(blob.decode("utf-8"))
        b = cls()
        pos_d = d["proof_of_space"]
        pos = _PoS(
            size=pos_d["size"],
            challenge=_BytesField(bytes.fromhex(pos_d["challenge"])),
            plot_public_key=_BytesField(bytes.fromhex(pos_d["plot_public_key"])),
            pool_public_key=(
                _BytesField(bytes.fromhex(pos_d["pool_public_key"]))
                if pos_d.get("pool_public_key") is not None
                else None
            ),
            pool_contract_puzzle_hash=(
                _BytesField(bytes.fromhex(pos_d["pool_contract_puzzle_hash"]))
                if pos_d.get("pool_contract_puzzle_hash") is not None
                else None
            ),
            proof=_BytesField(bytes.fromhex(pos_d["proof"])),
        )
        b.reward_chain_block = _RewardChainBlock(
            proof_of_space=pos,
            signage_point_index=d["signage_point_index"],
        )
        b.foliage = _Foliage(
            foliage_block_data=_FoliageBlockData(
                farmer_reward_puzzle_hash=_BytesField(
                    bytes.fromhex(d["farmer_reward_puzzle_hash"])
                ),
            ),
        )
        if d.get("timestamp") is not None:
            b.foliage_transaction_block = _FoliageTransactionBlock(
                timestamp=d["timestamp"],
            )
        else:
            b.foliage_transaction_block = None
        gen = d.get("generator")
        if gen is not None:
            b.transactions_generator = _BytesField(bytes.fromhex(gen))
        else:
            b.transactions_generator = None
        cost = d.get("cost")
        if cost is not None:
            b.transactions_info = _TransactionsInfo(cost=cost)
        else:
            b.transactions_info = None
        return b
