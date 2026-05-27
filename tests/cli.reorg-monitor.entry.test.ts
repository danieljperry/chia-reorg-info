import { describe, expect, it } from 'vitest';
import { runReorgMonitorCli } from '../src/cli/reorg-monitor.js';

// Integration test for runReorgMonitorCli's argument-handling paths. The
// full monitor lifecycle (network polling, alert dispatch) isn't exercised
// here — those are covered by reorg-monitor.detection.test.ts and the
// helper-level tests. This file covers the entry-point branches:
// help text, invalid arguments, and invalid --db-path when --source needs
// the DB.

function captureStdio(): {
  stdout: string[];
  stderr: string[];
  restore: () => void;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s: string | Uint8Array): boolean => {
    stdout.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
    return true;
  };
  process.stderr.write = (s: string | Uint8Array): boolean => {
    stderr.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
    return true;
  };
  return {
    stdout,
    stderr,
    restore() {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    },
  };
}

describe('runReorgMonitorCli — entry point branches', () => {
  it('returns 0 and prints help text on --help', async () => {
    const io = captureStdio();
    try {
      const code = await runReorgMonitorCli(['--help']);
      expect(code).toBe(0);
      expect(io.stdout.join('')).toMatch(/Usage: chia-reorg-info reorg_monitor/);
    } finally {
      io.restore();
    }
  });

  it('returns 2 and an error message on unknown flag', async () => {
    const io = captureStdio();
    try {
      const code = await runReorgMonitorCli(['--bogus-flag']);
      expect(code).toBe(2);
      const err = io.stderr.join('');
      expect(err).toMatch(/Unknown flag/);
      expect(err).toMatch(/Run with --help for usage/);
    } finally {
      io.restore();
    }
  });

  it('returns 2 on invalid --network', async () => {
    const io = captureStdio();
    try {
      const code = await runReorgMonitorCli(['--network', 'rinkeby']);
      expect(code).toBe(2);
      expect(io.stderr.join('')).toMatch(/--network must be one of/);
    } finally {
      io.restore();
    }
  });

  it('returns 2 on invalid --source', async () => {
    const io = captureStdio();
    try {
      const code = await runReorgMonitorCli(['--source', 'remote']);
      expect(code).toBe(2);
      expect(io.stderr.join('')).toMatch(/--source must be one of/);
    } finally {
      io.restore();
    }
  });

  it('returns 2 when --source=local is given but --db-path is unreadable', async () => {
    const io = captureStdio();
    try {
      const code = await runReorgMonitorCli([
        '--source',
        'local',
        '--db-path',
        '/nonexistent/path/to.sqlite',
        '--no-log-file',
      ]);
      expect(code).toBe(2);
      const err = io.stderr.join('');
      expect(err).toMatch(/--source=local cannot use/);
      expect(err).toMatch(/Reason:/);
    } finally {
      io.restore();
    }
  });

  it('returns 2 on invalid integer flag value', async () => {
    const io = captureStdio();
    try {
      const code = await runReorgMonitorCli(['--poll-interval', 'abc']);
      expect(code).toBe(2);
      expect(io.stderr.join('')).toMatch(/--poll-interval must be an integer/);
    } finally {
      io.restore();
    }
  });
});
