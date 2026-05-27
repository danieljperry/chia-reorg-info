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

/**
 * Spawn the helper script as the given uid and return its stdout.
 * Returns null when the spawn itself failed (e.g. running as non-root
 * so the kernel rejected the uid switch, or the uid doesn't exist on
 * this system). Throws if the spawn succeeded but the helper itself
 * errored — that's a real bug to surface.
 */
function checkAsUid(filepath: string, uid: number): string | null {
  const r = spawnSync(
    'npx',
    ['--no-install', 'tsx', HELPER_PATH, filepath],
    {
      encoding: 'utf8',
      uid,
      // tsx wants a writable home for its compile cache; give it /tmp
      // since the `nobody` user has no home directory.
      env: { ...process.env, HOME: tmpdir(), XDG_CACHE_HOME: tmpdir() },
    }
  );
  if (r.error !== undefined) return null; // EPERM, ENOENT, etc.
  if (r.status !== 0) {
    throw new Error(
      `helper subprocess exited ${r.status} (uid=${uid}): stderr=${r.stderr}`
    );
  }
  return r.stdout;
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

  it('flags an unreadable file (via subprocess as nobody when test runner is root)', (ctx) => {
    // The "CAP_DAC_OVERRIDE bypass" case: previously this test silently
    // skipped via early return whenever uid === 0 (i.e. nearly always in
    // CI containers), leaving the "not readable" branch effectively
    // uncovered. Now we spawn the helper as uid 65534 (nobody) so the
    // child genuinely can't read the file, which exercises the branch.
    //
    // Skip only when:
    //   - we're not running as root AND we couldn't lock the file
    //     against ourselves (covered by the sibling test instead), OR
    //   - the spawn-as-nobody attempt fails (e.g. running as root in a
    //     container with capabilities dropped; no CAP_SETUID)
    if (process.getuid?.() !== 0) {
      ctx.skip();
      return;
    }
    const p = join(dir, 'locked.sqlite');
    writeFileSync(p, 'fake', { mode: 0o000 });
    // World-readable on parents and node_modules so the nobody subprocess
    // can actually load the helper; that's already true on default umask,
    // but if tmpdir is mode 0700 we explicitly widen this test's dir.
    chmodSync(dir, 0o755);

    const out = checkAsUid(p, NOBODY_UID);
    if (out === null) {
      // Couldn't setuid (no CAP_SETUID, or `nobody` uid not allowed).
      ctx.skip();
      return;
    }
    expect(out).toMatch(/not readable/);
  });

  it('flags a broken symlink as ENOENT', () => {
    const link = join(dir, 'link.sqlite');
    symlinkSync(join(dir, 'missing-target.sqlite'), link);
    expect(checkDbPathReadable(link)).toMatch(/does not exist/);
  });
});
