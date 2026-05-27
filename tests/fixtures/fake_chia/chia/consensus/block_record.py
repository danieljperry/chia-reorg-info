# Minimal mock of chia.consensus.block_record.BlockRecord for testing
# _decode_block_record.py. Same idea as the fake FullBlock — from_bytes
# treats the blob as JSON and to_json_dict round-trips it back.

import json


class BlockRecord:
    def __init__(self, data: dict):
        self._data = data

    @classmethod
    def from_bytes(cls, blob: bytes) -> "BlockRecord":
        return cls(json.loads(blob.decode("utf-8")))

    def to_json_dict(self) -> dict:
        return self._data
