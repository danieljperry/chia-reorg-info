#!/usr/bin/env python3
"""Stand-in helper that exits non-zero with a stderr message — exercises
the helper-failure branch of searchBridges."""
import sys

sys.stdin.read()
print("simulated decode failure (no chia)", file=sys.stderr)
sys.exit(2)
