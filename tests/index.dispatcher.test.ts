import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Integration tests for src/index.ts — the subcommand dispatcher. Has to
// be tested via subprocess because the file has `process.exit(...)` at top
// level. We run `tsx src/index.ts <args>` and capture stdio + exit code.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = join(REPO_ROOT, 'src', 'index.ts');

function runIndex(args: string[]): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const r = spawnSync('npx', ['--no-install', 'tsx', INDEX, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

describe('src/index.ts dispatcher', () => {
  it('prints usage and exits 0 with no arguments', () => {
    const r = runIndex([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage: chia-reorg-info <subcommand>/);
    // All four subcommands should be listed.
    expect(r.stdout).toMatch(/reorg_monitor/);
    expect(r.stdout).toMatch(/check_block_canonical/);
    expect(r.stdout).toMatch(/scan_chain_consistency/);
    expect(r.stdout).toMatch(/status/);
  });

  it('prints usage and exits 0 on --help', () => {
    const r = runIndex(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage: chia-reorg-info/);
  });

  it('prints usage and exits 0 on -h', () => {
    const r = runIndex(['-h']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage: chia-reorg-info/);
  });

  it('exits 2 and prints usage on an unknown subcommand', () => {
    const r = runIndex(['nosuchcommand']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Unknown subcommand: nosuchcommand/);
    expect(r.stderr).toMatch(/Usage: chia-reorg-info/);
  });

  it('dispatches reorg_monitor --help and exits 0', () => {
    const r = runIndex(['reorg_monitor', '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage: chia-reorg-info reorg_monitor/);
  });

  it('dispatches check_block_canonical --help and exits 0', () => {
    const r = runIndex(['check_block_canonical', '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage: chia-reorg-info check_block_canonical/);
  });

  it('dispatches scan_chain_consistency --help and exits 0', () => {
    const r = runIndex(['scan_chain_consistency', '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage: chia-reorg-info scan_chain_consistency/);
  });

  it('dispatches status --help and exits 0', () => {
    const r = runIndex(['status', '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage: chia-reorg-info status/);
  });

  it('returns the subcommand\'s exit code on invalid args', () => {
    // reorg_monitor with an unknown flag exits 2 via runReorgMonitorCli.
    // Confirms the dispatcher forwards exit codes back through process.exit.
    const r = runIndex(['reorg_monitor', '--bogus-flag']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Unknown flag/);
  });
});
