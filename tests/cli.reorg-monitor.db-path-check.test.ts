import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants as fsConstants, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkDbPathReadable } from '../src/cli/reorg-monitor.js';

const NOBODY_UID = 65534;
const HELPER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'check-db-readable-helper.ts'
);
// Use tsx directly from node_modules (NOT via `npx tsx`). `npx` invokes
// `npm`, which tries to mkdir under `~/.npm/_cacache`; when the parent
// is root and the subprocess is a non-root uid, that's /root/.npm and
// the child gets EACCES. Calling the tsx CLI shim bypasses npm entirely.
const TSX_BIN = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'node_modules',
  '.bin',
  'tsx'
);

/**
 * Candidate non-root uids to try, in order of preference:
 *
 * 1. `SUDO_UID` (when running under sudo) — the user who invoked sudo.
 *    Always has read+execute permission on the source tree and node_modules
 *    (their own files). The chmod-000 file we create under sudo is owned
 *    by root with mode 0000, so the SUDO_UID user genuinely can't read it.
 * 2. `nobody` (uid 65534) — fallback for real-root environments without
 *    SUDO_UID set. May not work if the project lives under a home directory
 *    with restrictive perms (e.g. /home/dan mode 0750) since `nobody` can't
 *    traverse to reach tsx and the helper.
 */
function candidateNonRootUids(): number[] {
  const uids: number[] = [];
  const sudoUid = process.env.SUDO_UID;
  if (sudoUid !== undefined) {
    const u = parseInt(sudoUid, 10);
    if (Number.isInteger(u) && u > 0) uids.push(u);
  }
  uids.push(NOBODY_UID);
  return uids;
}

type SpawnResult =
  | { ok: true; stdout: string; uid: number }
  | { ok: false; reason: string };

/**
 * Spawn the helper as the given uid and return its stdout.
 * Returns a result object with `ok: false` and a diagnostic reason when
 * the spawn itself failed (e.g. EPERM if not really root, ENOENT if the
 * subprocess can't reach the binary, etc.).
 */
function checkAsUid(filepath: string, uid: number): SpawnResult {
  const r = spawnSync(TSX_BIN, [HELPER_PATH, filepath], {
    encoding: 'utf8',
    uid,
    env: { ...process.env, HOME: tmpdir(), XDG_CACHE_HOME: tmpdir() },
  });
  if (r.error !== undefined) {
    return { ok: false, reason: `spawn failed (uid=${uid}): ${r.error.message}` };
  }
  if (r.status !== 0) {
    return {
      ok: false,
      reason: `helper exited ${r.status} (uid=${uid}); stderr: ${r.stderr.trim() || '(empty)'}`,
    };
  }
  return { ok: true, stdout: r.stdout, uid };
}

/** Try each candidate non-root uid in turn; return the first success. */
function checkAsAnyNonRootUid(
  filepath: string
): { stdout: string; uid: number } | { failures: string[] } {
  const failures: string[] = [];
  for (const uid of candidateNonRootUids()) {
    const r = checkAsUid(filepath, uid);
    if (r.ok) return { stdout: r.stdout, uid: r.uid };
    failures.push(r.reason);
  }
  return { failures };
}

describe('checkDbPathReadable', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reorg-monitor-dbcheck-'));
  });
  afterEach(() => {
    try {
      // Restore perms before cleanup so rmSync can recurse.
      chmodSync(dir, 0o755);
    } catch {
      // ignore
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for a normal readable file', () => {
    const p = join(dir, 'db.sqlite');
    writeFileSync(p, 'fake', { mode: 0o644 });
    expect(checkDbPathReadable(p)).toBeNull();
  });

  it('flags ENOENT with a tilde/$HOME hint', () => {
    const reason = checkDbPathReadable(join(dir, 'nope.sqlite'));
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/does not exist/);
    expect(reason).toMatch(/systemd does not expand/);
  });

  it('flags a literal "~"-prefixed path as ENOENT (the systemd footgun)', () => {
    const reason = checkDbPathReadable('~/.chia/mainnet/db/blockchain_v2_mainnet.sqlite');
    expect(reason).toMatch(/does not exist/);
  });

  it('flags directories as not-a-regular-file', () => {
    const sub = join(dir, 'subdir');
    mkdirSync(sub);
    expect(checkDbPathReadable(sub)).toMatch(/not a regular file/);
  });

  it('flags an unreadable file (direct: when this process cannot bypass perms)', (ctx) => {
    // The simple path: chmod 000 + we run as a uid that can't bypass.
    // Holds for any non-root test runner. If we're root with
    // CAP_DAC_OVERRIDE, accessSync still succeeds and we skip — the
    // sibling test below handles the root-via-subprocess case.
    const p = join(dir, 'locked.sqlite');
    writeFileSync(p, 'fake', { mode: 0o000 });
    spawnSync('setfacl', ['-m', 'u::---,g::---,o::---,m::---', p], {
      encoding: 'utf8',
    });
    let blocked = false;
    try {
      accessSync(p, fsConstants.R_OK);
    } catch {
      blocked = true;
    }
    if (!blocked) {
      ctx.skip();
      return;
    }
    expect(checkDbPathReadable(p)).toMatch(/not readable/);
  });

  it('flags an unreadable file (via non-root subprocess when test runner is root)', (ctx) => {
    // Previously, this test silently skipped whenever uid === 0 (most CI
    // containers), leaving the "not readable" branch uncovered. Now we
    // spawn the helper as a non-root uid so the child genuinely can't
    // read the chmod-000 file (owned by root), exercising the branch.
    //
    // Tries SUDO_UID first (the user who ran `sudo`, who can reach
    // node_modules), then `nobody` (65534). Skips cleanly with diagnostics
    // when neither works — e.g. real root with no SUDO_UID set, project
    // living under a 0750 home dir that nobody can't traverse, container
    // without CAP_SETUID.
    if (process.getuid?.() !== 0) {
      ctx.skip();
      return;
    }
    const p = join(dir, 'locked.sqlite');
    writeFileSync(p, 'fake', { mode: 0o000 });
    chmodSync(dir, 0o755); // ensure the test dir doesn't block non-root traversal

    const result = checkAsAnyNonRootUid(p);
    if ('failures' in result) {
      // Be explicit about WHY we skipped so the user can debug if needed.
      ctx.skip(
        `no non-root uid could run the helper:\n  - ${result.failures.join('\n  - ')}`
      );
      return;
    }
    expect(
      result.stdout,
      `helper ran as uid=${result.uid}; expected /not readable/`
    ).toMatch(/not readable/);
  });

  it('flags a broken symlink as ENOENT', () => {
    const link = join(dir, 'link.sqlite');
    symlinkSync(join(dir, 'missing-target.sqlite'), link);
    expect(checkDbPathReadable(link)).toMatch(/does not exist/);
  });
});
