import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Drives the Python unittest suite at tests/python/test_announcement_walker.py
// — unit tests for the pure BFS function _bfs_announcement_graph extracted
// from _walk_announcement_linkages in scripts/_decode_bridge_spends.py.
//
// We can't drive that function from TypeScript directly (it's a Python
// internal), so this wrapper invokes `python3 -m unittest` against the
// test file with the fake_chia fixture on PYTHONPATH (so the module's
// chia / zstd imports resolve without needing a real chia install).
// Asserts the subprocess exits 0 with the documented test count.

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = join(TESTS_DIR, 'fixtures', 'fake_chia');
const TEST_FILE = join(TESTS_DIR, 'python', 'test_announcement_walker.py');

describe('_decode_bridge_spends.py — announcement walker (BFS)', () => {
  it('Python unittest suite passes (all _bfs_announcement_graph cases)', () => {
    const r = spawnSync(
      'python3',
      ['-m', 'unittest', '-v', TEST_FILE],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONPATH: `${FIXTURES_PATH}:${process.env.PYTHONPATH ?? ''}`,
          // Suppress user site-packages so a real chia install on the dev
          // machine doesn't shadow the fake_chia fixture and accidentally
          // change behavior.
          PYTHONNOUSERSITE: '1',
        },
      }
    );
    if (r.status !== 0) {
      // Surface the Python output so a failing test isn't opaque.
      throw new Error(
        `python unittest failed (exit=${r.status})\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`
      );
    }
    // unittest writes results to stderr by default.
    const combined = r.stdout + r.stderr;
    expect(combined).toMatch(/OK/);
    // Lock in the count so silently-skipped tests are caught.
    expect(combined).toMatch(/Ran 15 tests/);
  });
});
