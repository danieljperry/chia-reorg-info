import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// chia-required API smoke test. Guards against the structural gap that the
// tests/fixtures/fake_chia stub CANNOT catch: real chia-blockchain renaming or
// moving an import path / method that scripts/_decode_*.py depend on. Those
// helpers decode BlockRecord / FullBlock blobs by importing chia/chia_rs and
// calling from_bytes/to_json_dict/run_block_generator etc.; the fake fixture
// always "passes" regardless of what real chia does.
//
// This runs ONLY when chia is importable by CHIA_PYTHON (set by the
// `chia-required` CI job to a venv with chia-blockchain installed). On a normal
// dev machine / the main CI job — where chia isn't installed — the whole
// describe SELF-SKIPS so `npx vitest run` stays green. It is intentionally NOT
// in the branch-protection required checks.

/** The interpreter the helpers would use. Mirrors CHIA_PYTHON's role in
 *  resolveChiaPython() (src/util/chia-python.ts); we don't need the full
 *  resolution chain here — the CI job sets CHIA_PYTHON explicitly. */
const CHIA_PYTHON = process.env.CHIA_PYTHON ?? 'python3';

/** True iff CHIA_PYTHON can import chia + chia_rs. Same probe shape as
 *  warnIfChiaMissing() in src/cli/reorg-monitor.ts. */
function chiaImportable(): boolean {
  try {
    const r = spawnSync(CHIA_PYTHON, ['-c', 'import chia, chia_rs'], { encoding: 'utf8' });
    return r.status === 0;
  } catch {
    return false;
  }
}

// One consolidated probe. For each symbol group it mirrors the helper's own
// fallback order (chia path(s) → chia_rs) and asserts the attribute the helper
// actually calls. Prints "SMOKE_OK:<group>,..." so the TS side can confirm each
// group resolved (not just that python exited 0). Any failure raises, exits
// non-zero, and the original ImportError/AttributeError lands on stderr.
const PROBE = `
groups = []

# BlockRecord: _decode_block_record.py / generally needs from_bytes + to_json_dict
try:
    from chia.consensus.block_record import BlockRecord
except Exception:
    from chia_rs import BlockRecord
assert hasattr(BlockRecord, "from_bytes"), "BlockRecord.from_bytes missing"
assert hasattr(BlockRecord, "to_json_dict"), "BlockRecord.to_json_dict missing"
groups.append("BlockRecord")

# FullBlock: _decode_pos.py + _decode_bridge_spends.py; needs from_bytes
FullBlock = None
for modpath in ("chia.types.full_block", "chia.consensus.full_block"):
    try:
        FullBlock = __import__(modpath, fromlist=["FullBlock"]).FullBlock
        break
    except Exception:
        continue
if FullBlock is None:
    from chia_rs import FullBlock
assert hasattr(FullBlock, "from_bytes"), "FullBlock.from_bytes missing"
groups.append("FullBlock")

# Generator runners: _decode_bridge_spends.py uses at least one of these
import chia_rs
assert hasattr(chia_rs, "run_block_generator") or hasattr(chia_rs, "run_block_generator2"), \\
    "neither run_block_generator nor run_block_generator2 present"
groups.append("generator")

# DEFAULT_CONSTANTS (chia or chia_rs)
ok_const = False
try:
    from chia.consensus.default_constants import DEFAULT_CONSTANTS  # noqa: F401
    ok_const = True
except Exception:
    ok_const = hasattr(chia_rs, "DEFAULT_CONSTANTS")
assert ok_const, "DEFAULT_CONSTANTS not importable from chia or chia_rs"
groups.append("DEFAULT_CONSTANTS")

# Program + G2Element (bridge puzzle-reveal walker)
from chia.types.blockchain_format.program import Program  # noqa: F401
assert hasattr(Program, "from_bytes"), "Program.from_bytes missing"
from chia_rs import G2Element  # noqa: F401
groups.append("Program")
groups.append("G2Element")

print("SMOKE_OK:" + ",".join(groups))
`;

const EXPECTED_GROUPS = [
  'BlockRecord',
  'FullBlock',
  'generator',
  'DEFAULT_CONSTANTS',
  'Program',
  'G2Element',
];

describe.skipIf(!chiaImportable())('chia API smoke (real chia-blockchain)', () => {
  it('all import paths + methods the scripts/_decode_*.py helpers use still resolve', () => {
    const r = spawnSync(CHIA_PYTHON, ['-c', PROBE], { encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(
        `chia API smoke probe failed (exit=${r.status}). This usually means chia ` +
          `renamed/moved an import path or method the decode helpers rely on.\n` +
          `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`
      );
    }
    expect(r.stdout).toContain('SMOKE_OK:');
    for (const group of EXPECTED_GROUPS) {
      expect(r.stdout).toContain(group);
    }
  });
});
