#!/usr/bin/env python3
"""Stand-in helper that returns no matches."""
import json
import sys

assert len(sys.argv) == 3
# Drain stdin so the harness's `.end()` succeeds.
sys.stdin.read()

print(json.dumps({"matches": []}))
