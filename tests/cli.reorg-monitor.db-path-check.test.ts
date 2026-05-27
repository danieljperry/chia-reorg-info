import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants as fsConstants, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkDbPathReadable } from '../src/cli/reorg-monitor.js';

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

  it('flags an unreadable file', (ctx) => {
    // Goal: verify checkDbPathReadable distinguishes "exists but not
    // readable" from "missing." The challenge is that root with
    // CAP_DAC_OVERRIDE bypasses chmod/ACL and can read anything.
    //
    // We attempt to construct an unreadable file with chmod 000 + a
    // restrictive POSIX ACL (which sometimes denies even root, depending on
    // the kernel/capability set). Then we verify accessSync actually fails
    // for *this* process before running the assertion. If the file is still
    // readable (e.g. running as root with default caps), we skip cleanly via
    // ctx.skip() rather than silently passing as the previous version did.
    const p = join(dir, 'locked.sqlite');
    writeFileSync(p, 'fake', { mode: 0o644 });
    chmodSync(p, 0o000);

    // Try to set a deny-everyone ACL too. Best-effort: setfacl may not be
    // installed, and even when it is, root often bypasses ACLs via
    // CAP_DAC_OVERRIDE. We don't fail the test if setfacl is missing — the
    // verification step below handles the actual decision.
    spawnSync('setfacl', ['-m', 'u::---,g::---,o::---,m::---', p], {
      encoding: 'utf8',
    });

    // Verify the file is actually unreadable for THIS process before
    // running the assertion. If we can still read it, skip — testing
    // checkDbPathReadable's "not readable" branch from a process that
    // can read everything is meaningless.
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

    const reason = checkDbPathReadable(p);
    expect(reason).toMatch(/not readable/);
  });

  it('flags a broken symlink as ENOENT', () => {
    const link = join(dir, 'link.sqlite');
    symlinkSync(join(dir, 'missing-target.sqlite'), link);
    expect(checkDbPathReadable(link)).toMatch(/does not exist/);
  });
});
