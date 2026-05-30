#!/usr/bin/env python3
"""Stand-in formatter that emits a deterministic Bridge Info body so
tests can assert on the wrapper's behavior without exercising the real
formatter's prose."""
import sys

assert len(sys.argv) == 2 and sys.argv[1] in ("quiet", "detailed")
# Drain the JSON input so the spawn pipe closes cleanly.
sys.stdin.read()
sys.stdout.write(
    "  Found 1 reorged block(s) with bridge references (2 matching coin spend(s)).\n"
    "\n"
    "  Match 1:\n"
    "    Block height:    7357253\n"
)
