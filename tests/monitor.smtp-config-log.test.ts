import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logSmtpConfig } from '../src/monitor/email-alert.js';
import { closeLogger, setLogFile } from '../src/util/logger.js';

describe('logSmtpConfig', () => {
  let dir: string;
  let logPath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'chia-smtp-config-'));
    logPath = join(dir, 'monitor.log');
    await setLogFile(logPath);
  });

  afterEach(async () => {
    await closeLogger();
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function readLog(): string {
    return readFileSync(logPath, 'utf8');
  }

  it('logs literal values for non-secret SMTP env vars', async () => {
    vi.stubEnv('SMTP_HOST', '127.0.0.1');
    vi.stubEnv('SMTP_PORT', '1025');
    vi.stubEnv('SMTP_SECURE', 'true');
    vi.stubEnv('SMTP_FROM', 'me@example.com');
    vi.stubEnv('SMTP_CA_CERT_PATH', '/etc/bridge.pem');
    vi.stubEnv('SMTP_USER', '');
    vi.stubEnv('SMTP_PASS', '');

    logSmtpConfig();
    await closeLogger();

    const contents = readLog();
    expect(contents).toContain('SMTP_HOST=127.0.0.1');
    expect(contents).toContain('SMTP_PORT=1025');
    expect(contents).toContain('SMTP_SECURE=true');
    expect(contents).toContain('SMTP_FROM=me@example.com');
    expect(contents).toContain('SMTP_CA_CERT_PATH=/etc/bridge.pem');
  });

  it('redacts SMTP_PASS and SMTP_USER (presence only)', async () => {
    vi.stubEnv('SMTP_HOST', '127.0.0.1');
    vi.stubEnv('SMTP_USER', 'bridge-user');
    vi.stubEnv('SMTP_PASS', 'super-secret-do-not-log');

    logSmtpConfig();
    await closeLogger();

    const contents = readLog();
    expect(contents).toContain('SMTP_USER=<set>');
    expect(contents).toContain('SMTP_PASS=<set>');
    expect(contents).not.toContain('super-secret-do-not-log');
    expect(contents).not.toContain('bridge-user');
  });

  it('marks missing values as <unset>', async () => {
    vi.stubEnv('SMTP_HOST', '');
    vi.stubEnv('SMTP_USER', '');
    vi.stubEnv('SMTP_PASS', '');

    logSmtpConfig();
    await closeLogger();

    const contents = readLog();
    expect(contents).toContain('SMTP_HOST=<unset>');
    expect(contents).toContain('SMTP_USER=<unset>');
    expect(contents).toContain('SMTP_PASS=<unset>');
  });

  it('emits a warning when SMTP_HOST is unset', async () => {
    vi.stubEnv('SMTP_HOST', '');

    logSmtpConfig();
    await closeLogger();

    expect(readLog()).toMatch(/\[warn\] SMTP_HOST is not set/);
  });

  it('does not emit the unset warning when SMTP_HOST is set', async () => {
    vi.stubEnv('SMTP_HOST', '127.0.0.1');

    logSmtpConfig();
    await closeLogger();

    expect(readLog()).not.toMatch(/SMTP_HOST is not set/);
  });
});
