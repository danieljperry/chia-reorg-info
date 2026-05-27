# Mock zstd module for testing _decode_pos.py without the real zstd lib.
# Behavior: pretend everything is already decompressed (identity function).
# Tests pass uncompressed JSON-encoded blobs so the helper's decompress
# step is a no-op.

def decompress(b: bytes) -> bytes:
    return b
