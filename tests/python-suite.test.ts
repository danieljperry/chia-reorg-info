import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Drives the Python unittest suite in tests/python/ — unit tests for
// pure functions inside scripts/_decode_bridge_spends.py that don't
// require a real chia install (announcement-graph BFS, warp mod-hash
// table correctness).
//
// We invoke `python3 -m unittest` per test file (rather than discover)
// so a failure in one file produces a focused error message naming
// which file broke. The fake_chia fixture on PYTHONPATH satisfies the
// module's load-time chia / zstd imports.

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const PYTHON_TESTS_DIR = join(TESTS_DIR, 'python');
const FIXTURES_PATH = join(TESTS_DIR, 'fixtures', 'fake_chia');

function runUnittest(file: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  return spawnSync('python3', ['-m', 'unittest', '-v', join(PYTHON_TESTS_DIR, file)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONPATH: `${FIXTURES_PATH}:${process.env.PYTHONPATH ?? ''}`,
      // A real chia install on the dev machine could shadow fake_chia
      // and change behavior — disable user site-packages.
      PYTHONNOUSERSITE: '1',
    },
  });
}

// Each entry: { file, expectedTestCount }. The expected count guards
// against silent skips and reminds us to update this list when adding
// tests to one of the files.
const PY_TEST_FILES: { file: string; expectedTestCount: number }[] = [
  { file: 'test_announcement_walker.py', expectedTestCount: 15 },
  { file: 'test_warp_puzzle_hashes.py', expectedTestCount: 5 },
];

describe('Python unittest suite (scripts/_decode_bridge_spends.py)', () => {
  for (const { file, expectedTestCount } of PY_TEST_FILES) {
    it(`${file}: passes all ${expectedTestCount} cases`, () => {
      const r = runUnittest(file);
      if (r.status !== 0) {
        throw new Error(
          `python unittest failed in ${file} (exit=${r.status})\n` +
            `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`
        );
      }
      // unittest writes to stderr by default and decorates "OK" with ANSI
      // color when stderr is a TTY-ish stream — strip ANSI so the
      // assertion regexes don't get tripped up by the escape sequences.
      const combined = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, '');
      expect(combined).toMatch(/\bOK\b/);
      expect(combined).toMatch(new RegExp(`Ran ${expectedTestCount} tests`));
    });
  }

  it('every .py file in tests/python/ is listed above (no orphans)', () => {
    // Don't let a new Python test file slip in without being run by
    // vitest — the list above is the single source of truth.
    const onDisk = readdirSync(PYTHON_TESTS_DIR)
      .filter((f) => f.endsWith('.py') && f.startsWith('test_'))
      .sort();
    const listed = PY_TEST_FILES.map((e) => e.file).sort();
    expect(onDisk).toEqual(listed);
  });
});
