import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

  it('flags an unreadable file when running as non-root', () => {
    if (process.getuid?.() === 0) return; // root bypasses read-mode bits
    const p = join(dir, 'locked.sqlite');
    writeFileSync(p, 'fake', { mode: 0o000 });
    const reason = checkDbPathReadable(p);
    expect(reason).toMatch(/not readable/);
  });

  it('flags a broken symlink as ENOENT', () => {
    const link = join(dir, 'link.sqlite');
    symlinkSync(join(dir, 'missing-target.sqlite'), link);
    expect(checkDbPathReadable(link)).toMatch(/does not exist/);
  });
});
