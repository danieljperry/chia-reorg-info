import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

/**
 * Find a Python interpreter that can `import chia`. TS-side mirror of
 * `_resolve_chia_python` in `scripts/reorg-finder.sh`:
 *
 *   1. `$CHIA_PYTHON` if set
 *   2. shebang of `which chia` (typically points at the venv's python)
 *   3. fall back to `python3` on PATH
 *
 * Cached per process. The bridge helper subprocess in
 * `src/monitor/bridge-info.ts` needs this because the helper's own
 * `#!/usr/bin/env python3` shebang resolves to system python, which
 * usually doesn't have chia installed.
 */
let cached: string | undefined;

export function resolveChiaPython(): string {
  if (cached !== undefined) return cached;
  cached = (() => {
    const env = process.env.CHIA_PYTHON;
    if (env && env.length > 0) return env;

    const which = spawnSync('command', ['-v', 'chia'], {
      shell: '/bin/bash',
      encoding: 'utf8',
    });
    const chiaBin = which.status === 0 ? which.stdout.trim() : '';
    if (chiaBin) {
      try {
        const firstLine = readFileSync(chiaBin, 'utf8').split('\n', 1)[0] ?? '';
        // Match `#!<absolute path>` (optional whitespace allowed by the spec).
        const m = firstLine.match(/^#!\s*(\/\S+)/);
        if (m && m[1] && m[1].includes('python')) {
          try {
            const st = statSync(m[1]);
            // Owner-or-anyone exec bit. If the file isn't executable we
            // skip — better to fall through to plain `python3` than to
            // spawn something that'll EACCES at runtime.
            if (st.mode & 0o111) return m[1];
          } catch {
            // Bad shebang path — keep falling through.
          }
        }
      } catch {
        // Couldn't read `which chia`'s output; ignore.
      }
    }
    return 'python3';
  })();
  return cached;
}

/** Test-only: reset the cache. */
export function _resetChiaPythonCacheForTests(): void {
  cached = undefined;
}
