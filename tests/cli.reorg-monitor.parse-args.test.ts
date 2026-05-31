import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HelpRequested, parseArgs } from '../src/cli/reorg-monitor.js';

describe('cli monitor parseArgs', () => {
  it('returns defaults when no flags are passed', () => {
    expect(parseArgs([])).toEqual({
      network: 'mainnet',
      pollIntervalSeconds: 5,
      lookbackBlocks: 5,
      statusEverySeconds: 60,
      recipients: [],
      logFile: join(homedir(), 'logs', 'reorg_monitor.log'),
      smtpEnvFile: null,
      source: 'coinset',
      localPollIntervalSeconds: 10,
      localLookbackBlocks: 5,
      dbPath:
        process.env.CHIA_DB ?? join(homedir(), '.chia', 'mainnet', 'db', 'blockchain_v2_mainnet.sqlite'),
    });
  });

  it('parses --source values', () => {
    expect(parseArgs(['--source', 'coinset']).source).toBe('coinset');
    expect(parseArgs(['--source', 'local']).source).toBe('local');
    expect(parseArgs(['--source', 'both']).source).toBe('both');
  });

  it('rejects invalid --source', () => {
    expect(() => parseArgs(['--source', 'bogus'])).toThrow(/must be one of/);
  });

  it('parses --local-poll-interval with range 5-3600', () => {
    expect(parseArgs(['--local-poll-interval', '20']).localPollIntervalSeconds).toBe(20);
    expect(() => parseArgs(['--local-poll-interval', '4'])).toThrow(/integer between 5 and 3600/);
    expect(() => parseArgs(['--local-poll-interval', '3601'])).toThrow(/integer between 5 and 3600/);
  });

  it('parses --local-lookback with range 1-1000', () => {
    expect(parseArgs(['--local-lookback', '50']).localLookbackBlocks).toBe(50);
    expect(() => parseArgs(['--local-lookback', '0'])).toThrow(/integer between 1 and 1000/);
  });

  it('parses --db-path', () => {
    expect(parseArgs(['--db-path', '/mnt/chia/db.sqlite']).dbPath).toBe('/mnt/chia/db.sqlite');
  });

  it('parses --log-file', () => {
    expect(parseArgs(['--log-file', '/tmp/foo.log']).logFile).toBe('/tmp/foo.log');
  });

  it('parses --no-log-file', () => {
    expect(parseArgs(['--no-log-file']).logFile).toBeNull();
  });

  it('parses --smtp-env-file', () => {
    expect(parseArgs(['--smtp-env-file', '/etc/smtp.env']).smtpEnvFile).toBe('/etc/smtp.env');
  });

  it('parses --network', () => {
    expect(parseArgs(['--network', 'testnet11']).network).toBe('testnet11');
  });

  it('rejects an invalid --network value', () => {
    expect(() => parseArgs(['--network', 'mainnett'])).toThrow(/must be one of/);
  });

  it('parses --poll-interval, --lookback, --status-every', () => {
    const a = parseArgs(['--poll-interval', '15', '--lookback', '10', '--status-every', '30']);
    expect(a.pollIntervalSeconds).toBe(15);
    expect(a.lookbackBlocks).toBe(10);
    expect(a.statusEverySeconds).toBe(30);
  });

  it.each([
    ['--poll-interval', '4'],
    ['--poll-interval', '61'],
    ['--poll-interval', 'abc'],
    ['--lookback', '0'],
    ['--lookback', '33'],
    ['--status-every', '0'],
  ])('rejects out-of-range %s %s', (flag, value) => {
    expect(() => parseArgs([flag, value])).toThrow(/must be an integer/);
  });

  it('parses --recipient with default min_blocks', () => {
    const a = parseArgs(['--recipient', 'alice@example.com']);
    expect(a.recipients).toEqual([{ email: 'alice@example.com', min_blocks: 1, bridge: false }]);
  });

  it('parses --recipient with explicit min_blocks', () => {
    const a = parseArgs(['--recipient', 'alice@example.com:3']);
    expect(a.recipients).toEqual([{ email: 'alice@example.com', min_blocks: 3, bridge: false }]);
  });

  it('collects multiple --recipient flags', () => {
    const a = parseArgs(['--recipient', 'alice@example.com:1', '--recipient', 'bob@example.com:5']);
    expect(a.recipients).toEqual([
      { email: 'alice@example.com', min_blocks: 1, bridge: false },
      { email: 'bob@example.com', min_blocks: 5, bridge: false },
    ]);
  });

  it('dedupes duplicate recipient emails', () => {
    const a = parseArgs([
      '--recipient',
      'alice@example.com:1',
      '--recipient',
      'alice@example.com:9',
    ]);
    expect(a.recipients).toEqual([{ email: 'alice@example.com', min_blocks: 1, bridge: false }]);
  });

  it('rejects more than 10 recipients', () => {
    const flags: string[] = [];
    for (let i = 0; i < 11; i++) flags.push('--recipient', `user${i}@example.com`);
    expect(() => parseArgs(flags)).toThrow(/maximum of 10/);
  });

  it('rejects a recipient without @', () => {
    expect(() => parseArgs(['--recipient', 'not-an-email'])).toThrow(/--recipient expects/);
  });

  it('rejects a missing value for a flag', () => {
    expect(() => parseArgs(['--network'])).toThrow(/Missing value/);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown flag/);
  });

  it('throws HelpRequested for --help and -h', () => {
    expect(() => parseArgs(['--help'])).toThrow(HelpRequested);
    expect(() => parseArgs(['-h'])).toThrow(HelpRequested);
  });

  it('parses :b as a bridge-only subscription (min_blocks null)', () => {
    const a = parseArgs(['--recipient', 'alice@example.com:b']);
    expect(a.recipients).toEqual([
      { email: 'alice@example.com', min_blocks: null, bridge: true },
    ]);
  });

  it('merges a numeric entry and a :b entry for the same email (numeric first)', () => {
    const a = parseArgs([
      '--recipient',
      'alice@example.com:2',
      '--recipient',
      'alice@example.com:b',
    ]);
    expect(a.recipients).toEqual([
      { email: 'alice@example.com', min_blocks: 2, bridge: true },
    ]);
  });

  it('merges regardless of order (:b first, then numeric)', () => {
    const a = parseArgs([
      '--recipient',
      'alice@example.com:b',
      '--recipient',
      'alice@example.com:4',
    ]);
    expect(a.recipients).toEqual([
      { email: 'alice@example.com', min_blocks: 4, bridge: true },
    ]);
  });

  it('collapses duplicate :b entries for the same email', () => {
    const a = parseArgs([
      '--recipient',
      'alice@example.com:b',
      '--recipient',
      'alice@example.com:b',
    ]);
    expect(a.recipients).toEqual([
      { email: 'alice@example.com', min_blocks: null, bridge: true },
    ]);
  });

  it('keeps the first numeric when two numerics merge, preserving the bridge flag', () => {
    const a = parseArgs([
      '--recipient',
      'alice@example.com:b',
      '--recipient',
      'alice@example.com:2',
      '--recipient',
      'alice@example.com:9',
    ]);
    expect(a.recipients).toEqual([
      { email: 'alice@example.com', min_blocks: 2, bridge: true },
    ]);
  });

  it('rejects a spec with more than one colon part (e.g. :2:b)', () => {
    expect(() => parseArgs(['--recipient', 'alice@example.com:2:b'])).toThrow(
      /--recipient expects/
    );
  });

  it('counts merged records once against the 10-recipient cap', () => {
    const argv = [
      ...Array.from({ length: 10 }, (_, i) => ['--recipient', `u${i}@e.com`]).flat(),
      '--recipient',
      'u0@e.com:b',
    ];
    const a = parseArgs(argv);
    expect(a.recipients).toHaveLength(10);
    expect(a.recipients[0]).toEqual({ email: 'u0@e.com', min_blocks: 1, bridge: true });
  });
});
