import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnvFile } from '../src/util/env-file.js';

describe('loadEnvFile', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chia-env-file-'));
    file = join(dir, 'smtp.env');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function write(contents: string): void {
    writeFileSync(file, contents);
  }

  it('parses KEY=VALUE lines', async () => {
    vi.stubEnv('SMTP_HOST', '');
    vi.stubEnv('SMTP_PORT', '');
    write('SMTP_HOST=127.0.0.1\nSMTP_PORT=1025\n');

    const result = await loadEnvFile(file);
    expect(result.loaded.sort()).toEqual(['SMTP_HOST', 'SMTP_PORT']);
    expect(process.env.SMTP_HOST).toBe('127.0.0.1');
    expect(process.env.SMTP_PORT).toBe('1025');
  });

  it('ignores blank lines and # comments', async () => {
    vi.stubEnv('SMTP_HOST', '');
    write('# top comment\n\nSMTP_HOST=x\n  # leading whitespace comment\n');
    const result = await loadEnvFile(file);
    expect(result.loaded).toEqual(['SMTP_HOST']);
    expect(process.env.SMTP_HOST).toBe('x');
  });

  it('strips matching quotes from values', async () => {
    vi.stubEnv('SMTP_FROM', '');
    vi.stubEnv('SMTP_USER', '');
    write(`SMTP_FROM="me@example.com"\nSMTP_USER='bridge-user'\n`);
    await loadEnvFile(file);
    expect(process.env.SMTP_FROM).toBe('me@example.com');
    expect(process.env.SMTP_USER).toBe('bridge-user');
  });

  it('accepts an optional `export ` prefix (shell-style env files)', async () => {
    vi.stubEnv('SMTP_HOST', '');
    vi.stubEnv('SMTP_PORT', '');
    vi.stubEnv('SMTP_USER', '');
    write(`export SMTP_HOST=127.0.0.1\nexport  SMTP_PORT=1025\nexport\tSMTP_USER=u\n`);
    const result = await loadEnvFile(file);
    expect(result.loaded.sort()).toEqual(['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER']);
    expect(process.env.SMTP_HOST).toBe('127.0.0.1');
    expect(process.env.SMTP_PORT).toBe('1025');
    expect(process.env.SMTP_USER).toBe('u');
  });

  it('preserves values that contain = signs', async () => {
    vi.stubEnv('SMTP_PASS', '');
    write('SMTP_PASS=abc=def==xyz\n');
    await loadEnvFile(file);
    expect(process.env.SMTP_PASS).toBe('abc=def==xyz');
  });

  it('does not overwrite vars already set in process.env', async () => {
    vi.stubEnv('SMTP_HOST', 'preset-host');
    write('SMTP_HOST=from-file\n');
    const result = await loadEnvFile(file);
    expect(result.skipped).toEqual(['SMTP_HOST']);
    expect(result.loaded).toEqual([]);
    expect(process.env.SMTP_HOST).toBe('preset-host');
  });

  it('rejects a line without an = sign', async () => {
    write('SMTP_HOST 127.0.0.1\n');
    await expect(loadEnvFile(file)).rejects.toThrow(/expected KEY=VALUE/);
  });

  it('rejects an invalid env var name', async () => {
    write('1BAD=value\n');
    await expect(loadEnvFile(file)).rejects.toThrow(/invalid env var name/);
  });

  it('throws ENOENT when the file does not exist', async () => {
    await expect(loadEnvFile(join(dir, 'missing.env'))).rejects.toThrow(/ENOENT|no such file/i);
  });
});
