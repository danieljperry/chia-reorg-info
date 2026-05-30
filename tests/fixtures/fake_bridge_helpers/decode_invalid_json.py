#!/usr/bin/env python3
"""Stand-in helper that emits non-JSON on stdout. Tests the unparseable
output branch of searchBridges."""
import sys

sys.stdin.read()
print("not json at all <<<", end="")
