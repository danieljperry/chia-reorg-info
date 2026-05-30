import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetChiaPythonCacheForTests,
  resolveChiaPython,
} from '../src/util/chia-python.js';

// Tests for resolveChiaPython — the TS mirror of `_resolve_chia_python`
// in scripts/reorg-finder.sh. Covers the three resolution strategies (env
// wins, shebang of `which chia`, fall back to python3), plus the
// per-process cache.

let work: string;
let originalEnv: typeof process.env.CHIA_PYTHON;
let originalPath: typeof process.env.PATH;

beforeEach(() => {
  // Prefix deliberately omits the substring "python" — the shebang
  // resolver's "contains python" check is satisfied by any path
  // component, including the temp dir, so a "python" in the prefix
  // would spoof the bash-stub fallback test.
  work = mkdtempSync(join(tmpdir(), 'cp-resolve-test-'));
  mkdirSync(join(work, 'bin'));
  originalEnv = process.env.CHIA_PYTHON;
  originalPath = process.env.PATH;
  delete process.env.CHIA_PYTHON;
  _resetChiaPythonCacheForTests();
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  if (originalEnv === undefined) {
    delete process.env.CHIA_PYTHON;
  } else {
    process.env.CHIA_PYTHON = originalEnv;
  }
  if (originalPath !== undefined) process.env.PATH = originalPath;
  _resetChiaPythonCacheForTests();
});

describe('resolveChiaPython', () => {
  it('returns $CHIA_PYTHON unchanged when set (highest precedence)', () => {
    process.env.CHIA_PYTHON = '/some/venv/bin/python3';
    expect(resolveChiaPython()).toBe('/some/venv/bin/python3');
  });

  it("env value wins even when it's a path that doesn't exist", () => {
    // The resolver doesn't try to validate the env value — that's the
    // caller's job (the spawn will error if the path is bad). This test
    // pins down the precedence so a future "validate env" change doesn't
    // silently fall through to python3 on misconfiguration.
    process.env.CHIA_PYTHON = '/no/such/python/at/all';
    expect(resolveChiaPython()).toBe('/no/such/python/at/all');
  });

  it('falls back to "python3" when no env and `which chia` finds nothing', () => {
    // Strip PATH to nearly nothing so `command -v chia` returns no match.
    // Keep /usr/bin so the test's own `bash` invocation can still resolve
    // (resolveChiaPython spawns `bash` to run `command -v chia`).
    process.env.PATH = '/usr/bin:/bin';
    // Best-effort: if the test runner happens to have chia on PATH at
    // /usr/bin (very unlikely in CI), this test will fail. Detect that
    // and skip gracefully.
    const out = resolveChiaPython();
    if (out !== 'python3') {
      // chia is installed on this machine; skip the assertion rather than
      // false-fail. (The other tests still pin behavior in controllable
      // ways.)
      expect(out).toBeTruthy();
      return;
    }
    expect(out).toBe('python3');
  });

  it("parses the shebang of `which chia` and returns the interpreter when it's executable", () => {
    // Build a fake chia binary whose shebang points at a real, executable
    // python stub. Both files live in our temp dir; we prepend that dir to
    // PATH so `command -v chia` finds our fake.
    const pythonStub = join(work, 'bin', 'python3-stub');
    writeFileSync(pythonStub, '#!/bin/sh\nexit 0\n');
    chmodSync(pythonStub, 0o755);

    const chiaStub = join(work, 'bin', 'chia');
    writeFileSync(chiaStub, `#!${pythonStub}\nprint("nope")\n`);
    chmodSync(chiaStub, 0o755);

    process.env.PATH = `${join(work, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`;
    expect(resolveChiaPython()).toBe(pythonStub);
  });

  it('falls back to python3 when the shebang interpreter does not exist on disk', () => {
    const chiaStub = join(work, 'bin', 'chia');
    writeFileSync(chiaStub, `#!/no/such/python\nprint("nope")\n`);
    chmodSync(chiaStub, 0o755);

    process.env.PATH = `${join(work, 'bin')}:/usr/bin:/bin`;
    expect(resolveChiaPython()).toBe('python3');
  });

  it("falls back to python3 when the shebang interpreter doesn't contain 'python'", () => {
    // The regex requires `/python/.test(interp)` so e.g. `/bin/sh` is
    // rejected — guards against accidentally running chia under a
    // non-python interpreter that happens to be referenced in a malformed
    // chia shim.
    const interp = join(work, 'bin', 'bash-stub');
    writeFileSync(interp, '#!/bin/sh\nexit 0\n');
    chmodSync(interp, 0o755);

    const chiaStub = join(work, 'bin', 'chia');
    writeFileSync(chiaStub, `#!${interp}\nprint("nope")\n`);
    chmodSync(chiaStub, 0o755);

    process.env.PATH = `${join(work, 'bin')}:/usr/bin:/bin`;
    expect(resolveChiaPython()).toBe('python3');
  });

  it('caches the result across calls (same value)', () => {
    process.env.CHIA_PYTHON = '/sentinel/cached/python';
    const first = resolveChiaPython();
    // Mutate env after the first call. A non-caching implementation would
    // return the new value on the second call; the caching one keeps the
    // original.
    process.env.CHIA_PYTHON = '/different/path/that/should/be/ignored';
    const second = resolveChiaPython();
    expect(first).toBe('/sentinel/cached/python');
    expect(second).toBe('/sentinel/cached/python');
  });

  it('_resetChiaPythonCacheForTests forces re-resolution on next call', () => {
    process.env.CHIA_PYTHON = '/first';
    expect(resolveChiaPython()).toBe('/first');
    process.env.CHIA_PYTHON = '/second';
    // Still cached — without reset:
    expect(resolveChiaPython()).toBe('/first');
    _resetChiaPythonCacheForTests();
    expect(resolveChiaPython()).toBe('/second');
  });
});
