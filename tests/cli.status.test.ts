import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HelpRequested, parseArgs, runStatusCli } from '../src/cli/status.js';

describe('status CLI parseArgs', () => {
  it('returns default log file when no flags given', () => {
    const { logFile } = parseArgs([]);
    expect(logFile).toMatch(/logs\/reorg_monitor\.log$/);
  });

  it('accepts --log-file', () => {
    expect(parseArgs(['--log-file', '/tmp/custom.log']).logFile).toBe(
      '/tmp/custom.log'
    );
  });

  it('throws HelpRequested for --help and -h', () => {
    expect(() => parseArgs(['--help'])).toThrow(HelpRequested);
    expect(() => parseArgs(['-h'])).toThrow(HelpRequested);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown flag/);
  });

  it('rejects --log-file with no value', () => {
    expect(() => parseArgs(['--log-file'])).toThrow(/Missing value/);
  });
});

describe('runStatusCli', () => {
  let dir: string;
  let stdoutLines: string[];
  let stderrLines: string[];
  let restoreStdout: () => void;
  let restoreStderr: () => void;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'status-cli-test-'));
    stdoutLines = [];
    stderrLines = [];
    const origStdout = process.stdout.write.bind(process.stdout);
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (s: string | Uint8Array): boolean => {
      stdoutLines.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
      return true;
    };
    process.stderr.write = (s: string | Uint8Array): boolean => {
      stderrLines.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
      return true;
    };
    restoreStdout = () => {
      process.stdout.write = origStdout;
    };
    restoreStderr = () => {
      process.stderr.write = origStderr;
    };
  });

  afterEach(() => {
    restoreStdout();
    restoreStderr();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns 0 and prints the LATEST status line when multiple are present', async () => {
    const logFile = join(dir, 'monitor.log');
    writeFileSync(
      logFile,
      [
        '2026-05-25T00:00:00.000Z [info] Status polls=1 peak=100',
        '2026-05-25T00:00:01.000Z [warn] Re-org detected height=100',
        '2026-05-25T00:00:10.000Z [info] Status polls=2 peak=101',
        '2026-05-25T00:00:20.000Z [info] Status polls=3 peak=102',
        '2026-05-25T00:00:30.000Z [info] Other message — not a status',
      ].join('\n') + '\n'
    );
    const code = await runStatusCli(['--log-file', logFile]);
    expect(code).toBe(0);
    const out = stdoutLines.join('');
    expect(out).toContain('polls=3 peak=102');
    // Earlier status lines must NOT appear (we print only the latest).
    expect(out).not.toContain('polls=1');
    expect(out).not.toContain('polls=2');
  });

  it('returns 1 when the log file is missing', async () => {
    const code = await runStatusCli(['--log-file', '/nonexistent/path.log']);
    expect(code).toBe(1);
    expect(stderrLines.join('')).toMatch(/Log file not found/);
    expect(stdoutLines.join('')).toBe('');
  });

  it('returns 1 when the log file has no Status lines', async () => {
    const logFile = join(dir, 'empty.log');
    writeFileSync(logFile, 'some other content\nno status here\n');
    const code = await runStatusCli(['--log-file', logFile]);
    expect(code).toBe(1);
    expect(stderrLines.join('')).toMatch(/No Status lines found/);
  });

  it('returns 0 and prints help when --help is given', async () => {
    const code = await runStatusCli(['--help']);
    expect(code).toBe(0);
    expect(stdoutLines.join('')).toMatch(/Usage: chia-reorg-info status/);
  });

  it('returns 2 on invalid arguments', async () => {
    const code = await runStatusCli(['--bogus']);
    expect(code).toBe(2);
    expect(stderrLines.join('')).toMatch(/Unknown flag/);
  });
});
