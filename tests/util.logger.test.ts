import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeLogger, log, logBlock, setLogFile, setStderrEnabled } from '../src/util/logger.js';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;

describe('logger', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chia-reorg-info-logger-'));
    logPath = join(dir, 'monitor.log');
    setStderrEnabled(false);
  });

  afterEach(async () => {
    await closeLogger();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a timestamped line with level and message', async () => {
    await setLogFile(logPath);
    log('info', 'hello world');
    await closeLogger();

    const contents = readFileSync(logPath, 'utf8');
    expect(contents).toMatch(ISO);
    expect(contents).toMatch(/\[info\] hello world\n$/);
  });

  it('appends structured fields after the message', async () => {
    await setLogFile(logPath);
    log('info', 'event', { height: 100, hash: 'abc' });
    await closeLogger();

    const contents = readFileSync(logPath, 'utf8');
    expect(contents).toContain('[info] event');
    expect(contents).toContain('height=100');
    expect(contents).toContain('hash=abc');
  });

  it('appends to an existing log file rather than truncating it', async () => {
    await setLogFile(logPath);
    log('info', 'first');
    await closeLogger();

    await setLogFile(logPath);
    log('info', 'second');
    await closeLogger();

    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('first');
    expect(lines[1]).toContain('second');
  });

  it('creates missing parent directories', async () => {
    const nested = join(dir, 'a', 'b', 'c', 'monitor.log');
    await setLogFile(nested);
    log('info', 'nested');
    await closeLogger();
    expect(readFileSync(nested, 'utf8')).toContain('nested');
  });

  it('logBlock writes a header, body and a separator', async () => {
    await setLogFile(logPath);
    logBlock('info', 'Email', 'Hello\nWorld', { to: 'a@b.com' });
    await closeLogger();

    const contents = readFileSync(logPath, 'utf8');
    expect(contents).toContain('[info] Email');
    expect(contents).toContain('to=a@b.com');
    expect(contents).toContain('Hello\nWorld');
    expect(contents).toMatch(/─{60}/);
  });

  it('is a no-op when no log file is configured', async () => {
    // Ensure prior tests didn't leave state behind, then never call setLogFile.
    await setLogFile(null);
    expect(() => log('info', 'should not throw')).not.toThrow();
  });

  it('switches to a new file when setLogFile is called again', async () => {
    await setLogFile(logPath);
    log('info', 'first-file');

    const second = join(dir, 'second.log');
    await setLogFile(second);
    log('info', 'second-file');
    await closeLogger();

    expect(readFileSync(logPath, 'utf8')).toContain('first-file');
    expect(readFileSync(logPath, 'utf8')).not.toContain('second-file');
    expect(readFileSync(second, 'utf8')).toContain('second-file');
  });
});
