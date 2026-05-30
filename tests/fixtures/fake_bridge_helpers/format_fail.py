#!/usr/bin/env python3
"""Stand-in formatter that exits non-zero, exercising the formatter
failure branch of searchBridges."""
import sys

sys.stdin.read()
print("simulated formatter failure", file=sys.stderr)
sys.exit(1)
