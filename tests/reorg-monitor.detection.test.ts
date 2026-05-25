import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChiaAgentMocks } from './helpers/chia-agent-mocks.js';

const mockSendMail = vi.fn().mockResolvedValue({ messageId: 'test' });
const mockCreateTransport = vi.fn<(opts: unknown) => { sendMail: typeof mockSendMail }>(() => ({
  sendMail: mockSendMail,
}));

const mocks = createChiaAgentMocks();

vi.mock('chia-agent/api/rpc/full_node/index.js', () => mocks);
vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
}));

const monitorModule = await import('../src/monitor/reorg-monitor.js');
const { _pollOnce, startMonitor, stopMonitor, getStatus } = monitorModule;

function makeBlockRecord(height: number, headerHash: string) {
  return { height, header_hash: headerHash };
}

function mockPeak(height: number, headerHash: string) {
  mocks.get_blockchain_state.mockResolvedValue({
    blockchain_state: { peak: { height, header_hash: headerHash } },
  });
}

function mockBlockRecords(records: Array<{ height: number; header_hash: string }>) {
  mocks.get_block_records.mockResolvedValue({ block_records: records });
}
describe('reorg monitor detection logic', () => {
  afterEach(() => {
    stopMonitor();
    vi.useRealTimers();
    vi.restoreAllMocks();
    mockSendMail.mockReset();
    mockSendMail.mockResolvedValue({ messageId: 'test' });
    for (const fn of Object.values(mocks)) fn.mockReset();
  });

  it('records no reorgs when hashes are stable across polls', async () => {
    startMonitor({ poll_interval_seconds: 60, lookback_blocks: 3, network: 'mainnet' });
    stopMonitor();

    mockPeak(100, 'a'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(98, 'x'.repeat(64)),
      makeBlockRecord(99, 'y'.repeat(64)),
      makeBlockRecord(100, 'a'.repeat(64)),
    ]);
    await _pollOnce();

    mockPeak(101, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(99, 'y'.repeat(64)),
      makeBlockRecord(100, 'a'.repeat(64)),
      makeBlockRecord(101, 'b'.repeat(64)),
    ]);
    await _pollOnce();

    expect(getStatus().reorgs).toHaveLength(0);
    expect(getStatus().poll_count).toBe(2);
  });

  it('detects a reorg when a previously-seen block hash changes', async () => {
    startMonitor({ poll_interval_seconds: 60, lookback_blocks: 3, network: 'mainnet' });
    stopMonitor();

    mockPeak(100, 'a'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(98, 'x'.repeat(64)),
      makeBlockRecord(99, 'y'.repeat(64)),
      makeBlockRecord(100, 'a'.repeat(64)),
    ]);
    await _pollOnce();

    const newHash99 = 'z'.repeat(64);
    mockPeak(101, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(99, newHash99),
      makeBlockRecord(100, 'a'.repeat(64)),
      makeBlockRecord(101, 'b'.repeat(64)),
    ]);
    await _pollOnce();

    const { reorgs } = getStatus();
    expect(reorgs).toHaveLength(1);
    expect(reorgs[0]!.height).toBe(99);
    expect(reorgs[0]!.old_header_hash).toBe('y'.repeat(64));
    expect(reorgs[0]!.new_header_hash).toBe(newHash99);
    expect(reorgs[0]!.depth).toBe(1);
    expect(reorgs[0]!.blocks_from_peak).toBe(2);
  });

  it('strips 0x prefix when comparing hashes', async () => {
    startMonitor({ poll_interval_seconds: 60, lookback_blocks: 2, network: 'mainnet' });
    stopMonitor();

    const hash = 'a'.repeat(64);
    mockPeak(200, '0x' + hash);
    mockBlockRecords([makeBlockRecord(200, '0x' + hash)]);
    await _pollOnce();

    mockPeak(201, 'b'.repeat(64));
    mockBlockRecords([makeBlockRecord(200, hash), makeBlockRecord(201, 'b'.repeat(64))]);
    await _pollOnce();

    expect(getStatus().reorgs).toHaveLength(0);
  });

  it('accumulates multiple reorgs across polls', async () => {
    startMonitor({ poll_interval_seconds: 60, lookback_blocks: 3, network: 'mainnet' });
    stopMonitor();

    mockPeak(300, 'a'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(298, '1'.repeat(64)),
      makeBlockRecord(299, '2'.repeat(64)),
      makeBlockRecord(300, 'a'.repeat(64)),
    ]);
    await _pollOnce();

    mockPeak(301, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(298, '3'.repeat(64)),
      makeBlockRecord(299, '4'.repeat(64)),
      makeBlockRecord(300, 'a'.repeat(64)),
      makeBlockRecord(301, 'b'.repeat(64)),
    ]);
    await _pollOnce();

    expect(getStatus().reorgs).toHaveLength(2);
  });

  it('surfaces API errors in last_error without crashing', async () => {
    startMonitor({ poll_interval_seconds: 60, lookback_blocks: 3, network: 'mainnet' });
    stopMonitor();

    mocks.get_blockchain_state.mockRejectedValue(new Error('network timeout'));
    await _pollOnce();

    const status = getStatus();
    expect(status.last_error).toMatch(/network timeout/);
    expect(status.poll_count).toBe(0);
  });

  it('_isBlockDoesNotExistRace matches the null-prototype shape from chia-agent', async () => {
    const { _isBlockDoesNotExistRace } = await import('../src/monitor/reorg-monitor.js');
    const nullProtoErr = Object.create(null) as Record<string, unknown>;
    const inner = Object.create(null) as Record<string, unknown>;
    inner.code = 'BLOCK_DOES_NOT_EXIST';
    nullProtoErr.structuredError = inner;
    expect(_isBlockDoesNotExistRace(nullProtoErr)).toBe(true);

    expect(_isBlockDoesNotExistRace(null)).toBe(false);
    expect(_isBlockDoesNotExistRace(undefined)).toBe(false);
    expect(_isBlockDoesNotExistRace(new Error('boom'))).toBe(false);
    expect(_isBlockDoesNotExistRace({ structuredError: { code: 'OTHER' } })).toBe(false);
    expect(_isBlockDoesNotExistRace({})).toBe(false);
  });

  it('treats BLOCK_DOES_NOT_EXIST as a transient race, not an error', async () => {
    startMonitor({ poll_interval_seconds: 60, lookback_blocks: 3, network: 'mainnet' });
    stopMonitor();

    // Coinset / chia-agent rejection shape for the tip-race condition.
    const raceError: unknown = {
      error: 'Block record at height 8754858 does not exist',
      structuredError: {
        code: 'BLOCK_DOES_NOT_EXIST',
        data: {},
        message: 'Block record at height 8754858 does not exist',
      },
      success: false,
      traceback: null,
    };
    mocks.get_block_records.mockRejectedValueOnce(raceError);
    mockPeak(8754857, 'a'.repeat(64));

    await _pollOnce();

    const status = getStatus();
    expect(status.last_error).toBeNull();
    // poll_count is incremented before get_block_records is called, so the
    // tip race still counts as a poll attempt — we made progress (fetched the
    // peak), we just couldn't read the new tip yet.
    expect(status.poll_count).toBe(1);
  });

  it('does not crash when a poll rejects with a non-stringifiable value', async () => {
    // Regression: an RPC rejection whose String() conversion throws used to
    // escape the catch and kill the process with "Cannot convert object to
    // primitive value".
    startMonitor({ poll_interval_seconds: 60, lookback_blocks: 3, network: 'mainnet' });
    stopMonitor();

    const poison: unknown = Object.create(null) as unknown;
    mocks.get_blockchain_state.mockRejectedValue(poison);
    await expect(_pollOnce()).resolves.toBeUndefined();

    const status = getStatus();
    expect(typeof status.last_error).toBe('string');
    expect(status.last_error).not.toBe('');
  });

  it('silently skips a poll when peak is absent in the blockchain state', async () => {
    startMonitor({ poll_interval_seconds: 60, lookback_blocks: 3, network: 'mainnet' });
    stopMonitor();

    mocks.get_blockchain_state.mockResolvedValue({ blockchain_state: { peak: null } });
    await _pollOnce();

    expect(getStatus().poll_count).toBe(0);
    expect(getStatus().last_error).toBeNull();
  });

  it('handles null block_records in the RPC response without crashing', async () => {
    startMonitor({ poll_interval_seconds: 60, lookback_blocks: 3, network: 'mainnet' });
    stopMonitor();

    mockPeak(100, 'a'.repeat(64));
    mocks.get_block_records.mockResolvedValue({ block_records: null });
    await _pollOnce();

    expect(getStatus().poll_count).toBe(1);
    expect(getStatus().reorgs).toHaveLength(0);
  });

  it('restarting the monitor resets state without an intervening stop', async () => {
    // Prime with a reorg so state is non-empty.
    startMonitor({ poll_interval_seconds: 60, lookback_blocks: 2, network: 'mainnet' });
    stopMonitor();

    mockPeak(100, 'a'.repeat(64));
    mockBlockRecords([makeBlockRecord(100, 'a'.repeat(64))]);
    await _pollOnce();
    mockPeak(101, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(100, 'REORGED'.padEnd(64, '0')),
      makeBlockRecord(101, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    expect(getStatus().reorgs).toHaveLength(1);
    expect(getStatus().poll_count).toBe(2);

    // Restart without stopping first.
    mockPeak(200, 'c'.repeat(64));
    mockBlockRecords([makeBlockRecord(200, 'c'.repeat(64))]);
    startMonitor({ poll_interval_seconds: 60, lookback_blocks: 1, network: 'mainnet' });
    stopMonitor();

    expect(getStatus().reorgs).toHaveLength(0);
    expect(getStatus().poll_count).toBe(0);
    expect(getStatus().observations_count).toBe(0);
  });

  it('stopMonitor is a no-op when the monitor is already inactive', () => {
    // Ensure timer is null and active is false before the test.
    expect(getStatus().active).toBe(false);
    expect(() => stopMonitor()).not.toThrow();
    expect(getStatus().active).toBe(false);
  });

  it('discards reorgs and emails from a poll that started before stopMonitor', async () => {
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 2,
      network: 'mainnet',
      alert_recipients: [{ email: 'user@example.com', min_blocks: 1 }],
    });

    // Prime observations in session 1.
    mockPeak(100, 'a'.repeat(64));
    mockBlockRecords([makeBlockRecord(100, 'a'.repeat(64))]);
    await _pollOnce();

    // Simulate an in-flight poll: get_blockchain_state resolves but get_block_records
    // is deferred until after stopMonitor fires.
    let resolveBlocks!: (v: unknown) => void;
    mocks.get_blockchain_state.mockResolvedValue({
      blockchain_state: { peak: { height: 101, header_hash: 'b'.repeat(64) } },
    });
    mocks.get_block_records.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBlocks = resolve;
      })
    );

    const stalePoll = _pollOnce();
    // Let get_blockchain_state resolve, but block_records is still pending.
    await Promise.resolve();
    await Promise.resolve();

    // Stop invalidates the generation while the poll is suspended.
    stopMonitor();

    // Now let the deferred block_records response arrive with a reorg.
    resolveBlocks({
      block_records: [
        makeBlockRecord(100, 'REORGED'.padEnd(64, '0')),
        makeBlockRecord(101, 'b'.repeat(64)),
      ],
    });
    await stalePoll;
    await Promise.resolve();

    // Stale poll must not have committed reorgs or fired emails.
    expect(getStatus().reorgs).toHaveLength(0);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('prunes the observation map when it exceeds 1,000 entries', async () => {
    startMonitor({ poll_interval_seconds: 60, lookback_blocks: 600, network: 'mainnet' });
    stopMonitor();

    const manyBlocks = (start: number, count: number) =>
      Array.from({ length: count }, (_, i) =>
        makeBlockRecord(start + i, ((start + i) % 16).toString(16).repeat(64))
      );

    // First poll: 600 unique heights — below the 1,000 threshold, no pruning yet.
    mockPeak(599, 'f'.repeat(64));
    mocks.get_block_records.mockResolvedValue({ block_records: manyBlocks(0, 600) });
    await _pollOnce();
    expect(getStatus().observations_count).toBe(600);

    // Second poll: 600 more unique heights → 1,200 total → pruned back to 1,000.
    mockPeak(1199, 'e'.repeat(64));
    mocks.get_block_records.mockResolvedValue({ block_records: manyBlocks(600, 600) });
    await _pollOnce();
    expect(getStatus().observations_count).toBe(1000);
  });

  it('logs email contents and metadata to the configured log file', async () => {
    const { setLogFile, closeLogger } = await import('../src/util/logger.js');
    const dir = mkdtempSync(join(tmpdir(), 'reorg-monitor-log-test-'));
    const logPath = join(dir, 'monitor.log');
    try {
      await setLogFile(logPath);

      startMonitor({
        poll_interval_seconds: 60,
        lookback_blocks: 3,
        network: 'mainnet',
        alert_recipients: [{ email: 'user@example.com', min_blocks: 1 }],
      });
      stopMonitor();

      mockPeak(900, 'a'.repeat(64));
      mockBlockRecords([
        makeBlockRecord(899, 'x'.repeat(64)),
        makeBlockRecord(900, 'a'.repeat(64)),
      ]);
      await _pollOnce();

      mockPeak(901, 'b'.repeat(64));
      mockBlockRecords([
        makeBlockRecord(899, 'z'.repeat(64)),
        makeBlockRecord(900, 'a'.repeat(64)),
        makeBlockRecord(901, 'b'.repeat(64)),
      ]);
      await _pollOnce();
      await Promise.resolve();
      await Promise.resolve();
      await closeLogger();

      const contents = readFileSync(logPath, 'utf8');
      expect(contents).toContain('Re-org detected');
      expect(contents).toContain('Dispatching re-org alert');
      expect(contents).toContain('to=user@example.com');
      expect(contents).toContain('Sending re-org alert email');
      expect(contents).toContain('subject=');
      expect(contents).toContain('Peak height at detection: 901');
      expect(contents).toContain('z'.repeat(64));
      expect(contents).toContain('Re-org alert email sent');
    } finally {
      await closeLogger();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends an email when a reorg is detected and a recipient is configured', async () => {
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 3,
      network: 'mainnet',
      alert_recipients: [{ email: 'user@example.com', min_blocks: 1 }],
    });
    stopMonitor();

    mockPeak(500, 'a'.repeat(64));
    mockBlockRecords([makeBlockRecord(499, 'x'.repeat(64)), makeBlockRecord(500, 'a'.repeat(64))]);
    await _pollOnce();

    mockPeak(501, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(499, 'z'.repeat(64)),
      makeBlockRecord(500, 'a'.repeat(64)),
      makeBlockRecord(501, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    await Promise.resolve();

    expect(mockSendMail).toHaveBeenCalledOnce();
    const call = mockSendMail.mock.calls[0]![0] as { to: string; subject: string; text: string };
    expect(call.to).toBe('user@example.com');
    expect(call.subject).toBe('Re-org of depth 1 detected on Chia mainnet');
    expect(call.text).toContain('Peak height at detection: 501');
    expect(call.text).toContain('z'.repeat(64)); // new hash
    expect(call.text).toContain('x'.repeat(64)); // old hash in header + block record
    expect(call.text).toContain('The original block was a');
    expect(call.text).toContain('spacescan.io/block/499');
  });

  it('does not send an email when no recipients are configured', async () => {
    startMonitor({ poll_interval_seconds: 60, lookback_blocks: 2, network: 'mainnet' });
    stopMonitor();

    mockPeak(600, 'a'.repeat(64));
    mockBlockRecords([makeBlockRecord(600, 'a'.repeat(64))]);
    await _pollOnce();

    mockPeak(601, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(600, 'CHANGED'.padEnd(64, '0')),
      makeBlockRecord(601, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    await Promise.resolve();

    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('captures email failures in last_error without crashing the monitor', async () => {
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 2,
      network: 'mainnet',
      alert_recipients: [{ email: 'user@example.com', min_blocks: 1 }],
    });
    stopMonitor();

    mockSendMail.mockRejectedValueOnce(new Error('SMTP connection refused'));

    mockPeak(700, 'a'.repeat(64));
    mockBlockRecords([makeBlockRecord(700, 'a'.repeat(64))]);
    await _pollOnce();

    mockPeak(701, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(700, 'CHANGED'.padEnd(64, '0')),
      makeBlockRecord(701, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    await Promise.resolve();
    await Promise.resolve();

    expect(getStatus().reorgs).toHaveLength(1);
    expect(getStatus().last_error).toMatch(/SMTP connection refused/);
  });

  it('does not alert a recipient when reorg depth is below their min_blocks', async () => {
    // Single height change → depth 1; recipient requires >= 3, no alert.
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 3,
      network: 'mainnet',
      alert_recipients: [{ email: 'strict@example.com', min_blocks: 3 }],
    });
    stopMonitor();

    mockPeak(100, 'a'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(98, 'x'.repeat(64)),
      makeBlockRecord(99, 'y'.repeat(64)),
      makeBlockRecord(100, 'a'.repeat(64)),
    ]);
    await _pollOnce();

    mockPeak(101, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(99, 'z'.repeat(64)),
      makeBlockRecord(100, 'a'.repeat(64)),
      makeBlockRecord(101, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    await Promise.resolve();

    expect(getStatus().reorgs).toHaveLength(1);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('alerts a recipient when reorg depth meets their min_blocks threshold', async () => {
    // Three consecutive heights (99, 100, 101) all change in one poll → cluster depth = 3.
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 4,
      network: 'mainnet',
      alert_recipients: [{ email: 'strict@example.com', min_blocks: 3 }],
    });
    stopMonitor();

    mockPeak(101, 'a'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(98, '0'.repeat(64)),
      makeBlockRecord(99, '1'.repeat(64)),
      makeBlockRecord(100, '2'.repeat(64)),
      makeBlockRecord(101, 'a'.repeat(64)),
    ]);
    await _pollOnce();

    mockPeak(102, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(99, 'R1'.padEnd(64, '0')),
      makeBlockRecord(100, 'R2'.padEnd(64, '0')),
      makeBlockRecord(101, 'R3'.padEnd(64, '0')),
      makeBlockRecord(102, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    await Promise.resolve();

    expect(getStatus().reorgs).toHaveLength(3);
    expect(getStatus().reorgs.every((r) => r.depth === 3)).toBe(true);
    expect(mockSendMail).toHaveBeenCalledOnce();
    const call = mockSendMail.mock.calls[0]![0] as { to: string };
    expect(call.to).toBe('strict@example.com');
  });

  it('reports the full depth of an 8-block re-org even when lookback=5', async () => {
    // Build observations for heights 89..100 by walking the peak with lookback=5,
    // then re-org heights 93..100 in one poll. With walk-back the monitor must
    // detect all 8 changes as a single cluster of depth 8, even though the
    // initial fetch only sees 5 heights.
    startMonitor({ poll_interval_seconds: 60, lookback_blocks: 5, network: 'mainnet' });
    stopMonitor();

    const orig = (h: number) => `o${String(h).padStart(63, '0')}`;
    const reorged = (h: number) => `r${String(h).padStart(63, '0')}`;

    // Dynamic mock: returns whichever heights the monitor requests, and flips
    // 93..100 to their `reorged` hashes once reorgActive is set.
    let reorgActive = false;
    mocks.get_block_records.mockImplementation(
      (_agent: unknown, args: { start: number; end: number }) => {
        const records: Array<{ height: number; header_hash: string }> = [];
        for (let h = args.start; h < args.end; h++) {
          const useReorg = reorgActive && h >= 93 && h <= 100;
          records.push(makeBlockRecord(h, useReorg ? reorged(h) : orig(h)));
        }
        return Promise.resolve({ block_records: records });
      }
    );

    for (let peak = 93; peak <= 100; peak++) {
      mockPeak(peak, orig(peak));
      await _pollOnce();
    }
    expect(getStatus().observations_count).toBe(12); // heights 89..100

    reorgActive = true;
    mockPeak(100, reorged(100));
    await _pollOnce();

    const { reorgs } = getStatus();
    expect(reorgs).toHaveLength(8);
    expect(reorgs.every((r) => r.depth === 8)).toBe(true);
    expect(reorgs.map((r) => r.height).sort((a, b) => a - b)).toEqual([
      93, 94, 95, 96, 97, 98, 99, 100,
    ]);
  });

  it('warns when the chain advanced past our last observed peak during a re-org', async () => {
    // prev_peak = 100, then chain advances to 103 with a re-org touching height 100.
    // Heights 101..103 are new to us — they may or may not be part of the cascade.
    // Reported depth=1 is a lower bound; the warning surfaces that ambiguity.
    const { setLogFile, closeLogger } = await import('../src/util/logger.js');
    const dir = mkdtempSync(join(tmpdir(), 'reorg-monitor-warn-test-'));
    const logPath = join(dir, 'monitor.log');
    try {
      await setLogFile(logPath);
      startMonitor({ poll_interval_seconds: 60, lookback_blocks: 5, network: 'mainnet' });
      stopMonitor();

      // Establish observations 96..100 with prev_peak = 100.
      mockPeak(100, 'a'.repeat(64));
      mockBlockRecords([
        makeBlockRecord(96, 'p'.repeat(64)),
        makeBlockRecord(97, 'q'.repeat(64)),
        makeBlockRecord(98, 'r'.repeat(64)),
        makeBlockRecord(99, 's'.repeat(64)),
        makeBlockRecord(100, 'a'.repeat(64)),
      ]);
      await _pollOnce();

      // Chain advanced 3 blocks (during simulated skips) AND height 100 was re-orged.
      mockPeak(103, 'd'.repeat(64));
      mockBlockRecords([
        makeBlockRecord(99, 's'.repeat(64)), // unchanged
        makeBlockRecord(100, 'REORG'.padEnd(64, '0')), // changed → cluster_high = 100 = prev_peak
        makeBlockRecord(101, 'b'.repeat(64)), // new
        makeBlockRecord(102, 'c'.repeat(64)), // new
        makeBlockRecord(103, 'd'.repeat(64)), // new
      ]);
      await _pollOnce();
      await closeLogger();

      const contents = readFileSync(logPath, 'utf8');
      expect(contents).toContain(
        'Re-org depth may be a lower bound (chain advanced into unobserved territory)'
      );
      expect(contents).toContain('unobserved_range=101..103');
      expect(contents).toContain('unobserved_blocks=3');
    } finally {
      await closeLogger();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns even when the chain advance happened across SKIPPED polls (not just one)', async () => {
    // Regression: skipped polls used to update state.peak_height too, which
    // polluted the warning's notion of "previous peak" and suppressed it in
    // exactly the case it was meant to fire.
    const { setLogFile, closeLogger } = await import('../src/util/logger.js');
    const dir = mkdtempSync(join(tmpdir(), 'reorg-monitor-skip-warn-test-'));
    const logPath = join(dir, 'monitor.log');
    try {
      await setLogFile(logPath);
      startMonitor({ poll_interval_seconds: 60, lookback_blocks: 5, network: 'mainnet' });
      stopMonitor();

      // Poll 1: successful, observe 96..100.
      mockPeak(100, 'a'.repeat(64));
      mockBlockRecords([
        makeBlockRecord(96, 'p'.repeat(64)),
        makeBlockRecord(97, 'q'.repeat(64)),
        makeBlockRecord(98, 'r'.repeat(64)),
        makeBlockRecord(99, 's'.repeat(64)),
        makeBlockRecord(100, 'a'.repeat(64)),
      ]);
      await _pollOnce();

      // Poll 2: chain advanced to 102 but get_block_records throws the tip-race
      // error. state.peak_height becomes 102; last_observed_peak should NOT.
      mockPeak(102, 'b'.repeat(64));
      const raceError: unknown = {
        structuredError: { code: 'BLOCK_DOES_NOT_EXIST' },
      };
      mocks.get_block_records.mockRejectedValueOnce(raceError);
      await _pollOnce();

      // Poll 3: successful. Chain now at peak=103. Height 100 was re-orged.
      // The warning must fire even though state.peak_height was already 102.
      mockPeak(103, 'c'.repeat(64));
      mockBlockRecords([
        makeBlockRecord(99, 's'.repeat(64)), // unchanged
        makeBlockRecord(100, 'REORG'.padEnd(64, '0')), // changed
        makeBlockRecord(101, 'x'.repeat(64)), // new
        makeBlockRecord(102, 'y'.repeat(64)), // new
        makeBlockRecord(103, 'c'.repeat(64)), // new
      ]);
      await _pollOnce();
      await closeLogger();

      const contents = readFileSync(logPath, 'utf8');
      expect(contents).toContain(
        'Re-org depth may be a lower bound (chain advanced into unobserved territory)'
      );
      expect(contents).toContain('unobserved_range=101..103');
      expect(contents).toContain('unobserved_blocks=3');
    } finally {
      await closeLogger();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('worst-case dispatch: uncertain depth alerts every recipient whose threshold ≤ max_depth', async () => {
    // Scenario from the user's instruction: a re-org with depth 1, but the chain
    // advanced 3 blocks during the re-org window so the true depth could be 1-4.
    // Anyone with min_blocks ≤ 4 must get an email; anyone with min_blocks ≥ 5 must not.
    // The log line and email subject must both express the "1-4" range.
    const { setLogFile, closeLogger } = await import('../src/util/logger.js');
    const dir = mkdtempSync(join(tmpdir(), 'reorg-worst-case-test-'));
    const logPath = join(dir, 'monitor.log');
    try {
      await setLogFile(logPath);
      startMonitor({
        poll_interval_seconds: 60,
        lookback_blocks: 5,
        network: 'mainnet',
        alert_recipients: [
          { email: 'r1@example.com', min_blocks: 1 }, // should alert (1 ≤ 4)
          { email: 'r2@example.com', min_blocks: 2 }, // should alert (2 ≤ 4)
          { email: 'r3@example.com', min_blocks: 3 }, // should alert (3 ≤ 4)
          { email: 'r4@example.com', min_blocks: 4 }, // should alert (4 ≤ 4)
          { email: 'r5@example.com', min_blocks: 5 }, // should NOT alert (5 > 4)
          { email: 'r6@example.com', min_blocks: 8 }, // should NOT alert (8 > 4)
        ],
      });
      stopMonitor();

      // Poll 1: peak=100, observe 96..100. last_observed_peak = 100.
      mockPeak(100, 'a'.repeat(64));
      mockBlockRecords([
        makeBlockRecord(96, 'p'.repeat(64)),
        makeBlockRecord(97, 'q'.repeat(64)),
        makeBlockRecord(98, 'r'.repeat(64)),
        makeBlockRecord(99, 's'.repeat(64)),
        makeBlockRecord(100, 'a'.repeat(64)),
      ]);
      await _pollOnce();

      // Poll 2: chain has advanced to 103 (peak += 3) AND height 100 was re-orged.
      // Observed cluster size = 1 (height 100). Heights 101..103 are unobserved.
      // True depth could be 1, 2, 3, or 4 → max_depth = 1 + 3 = 4.
      mockPeak(103, 'd'.repeat(64));
      mockBlockRecords([
        makeBlockRecord(99, 's'.repeat(64)),
        makeBlockRecord(100, 'REORG'.padEnd(64, '0')),
        makeBlockRecord(101, 'b'.repeat(64)),
        makeBlockRecord(102, 'c'.repeat(64)),
        makeBlockRecord(103, 'd'.repeat(64)),
      ]);
      await _pollOnce();
      // Two `await Promise.resolve()` to flush sendReorgAlert promises.
      await Promise.resolve();
      await Promise.resolve();
      await closeLogger();

      // Recipient filter: exactly r1..r4 should have been emailed.
      expect(mockSendMail).toHaveBeenCalledTimes(4);
      const recipientsCalled = mockSendMail.mock.calls
        .map((c) => (c[0] as { to: string }).to)
        .sort();
      expect(recipientsCalled).toEqual([
        'r1@example.com',
        'r2@example.com',
        'r3@example.com',
        'r4@example.com',
      ]);

      // Subject and intro must show the "1-4" range, not just "1".
      const call = mockSendMail.mock.calls[0]![0] as { subject: string; text: string };
      expect(call.subject).toBe('Re-org of depth 1-4 detected on Chia mainnet');
      expect(call.text).toContain('A re-org of depth 1-4 was detected on the Chia mainnet');
      expect(call.text).toContain('unobserved block(s) above the cascade');
      // Per-block depth line spells out the range explicitly.
      expect(call.text).toMatch(/Depth:\s+1-4 block\(s\)/);
      expect(call.text).toContain('observed cascade is 1');
      expect(call.text).toContain('up to 3 more block(s) above were never compared');

      // Log line for "Re-org detected" must express the range.
      const contents = readFileSync(logPath, 'utf8');
      expect(contents).toMatch(/Re-org detected.*depth=1-4/);

      // ReorgEvent on getStatus() carries both bounds.
      const reorgs = getStatus().reorgs;
      expect(reorgs).toHaveLength(1);
      expect(reorgs[0]!.depth).toBe(1);
      expect(reorgs[0]!.max_depth).toBe(4);
    } finally {
      await closeLogger();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT warn when the chain stayed at the same peak during a re-org', async () => {
    // Re-org swaps blocks at heights 99..100 but new tip is still at 100.
    // No unobserved territory → depth=2 is authoritative, no warning.
    const { setLogFile, closeLogger } = await import('../src/util/logger.js');
    const dir = mkdtempSync(join(tmpdir(), 'reorg-monitor-no-warn-test-'));
    const logPath = join(dir, 'monitor.log');
    try {
      await setLogFile(logPath);
      startMonitor({ poll_interval_seconds: 60, lookback_blocks: 5, network: 'mainnet' });
      stopMonitor();

      mockPeak(100, 'a'.repeat(64));
      mockBlockRecords([
        makeBlockRecord(96, 'p'.repeat(64)),
        makeBlockRecord(97, 'q'.repeat(64)),
        makeBlockRecord(98, 'r'.repeat(64)),
        makeBlockRecord(99, 's'.repeat(64)),
        makeBlockRecord(100, 'a'.repeat(64)),
      ]);
      await _pollOnce();

      // Same peak height, but heights 99 and 100 got new hashes (block swap).
      mockPeak(100, 'A'.repeat(64));
      mockBlockRecords([
        makeBlockRecord(96, 'p'.repeat(64)),
        makeBlockRecord(97, 'q'.repeat(64)),
        makeBlockRecord(98, 'r'.repeat(64)),
        makeBlockRecord(99, 'S'.repeat(64)),
        makeBlockRecord(100, 'A'.repeat(64)),
      ]);
      await _pollOnce();
      await closeLogger();

      const contents = readFileSync(logPath, 'utf8');
      expect(contents).not.toContain('Re-org depth may be a lower bound');
    } finally {
      await closeLogger();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends only to recipients whose threshold is met', async () => {
    // depth = peak(101) - reorged_height(99) = 2; low(min 1) gets it, high(min 3) does not
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 3,
      network: 'mainnet',
      alert_recipients: [
        { email: 'low@example.com', min_blocks: 1 },
        { email: 'high@example.com', min_blocks: 3 },
      ],
    });
    stopMonitor();

    mockPeak(100, 'a'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(98, 'x'.repeat(64)),
      makeBlockRecord(99, 'y'.repeat(64)),
      makeBlockRecord(100, 'a'.repeat(64)),
    ]);
    await _pollOnce();

    mockPeak(101, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(99, 'z'.repeat(64)),
      makeBlockRecord(100, 'a'.repeat(64)),
      makeBlockRecord(101, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    await Promise.resolve();

    expect(mockSendMail).toHaveBeenCalledOnce();
    const call = mockSendMail.mock.calls[0]![0] as { to: string };
    expect(call.to).toBe('low@example.com');
  });

  it('batches multiple reorgs from the same poll into one email per recipient', async () => {
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 4,
      network: 'mainnet',
      alert_recipients: [{ email: 'user@example.com', min_blocks: 1 }],
    });
    stopMonitor();

    // Establish observations for heights 98, 99, 100, 101.
    mockPeak(101, 'a'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(98, '1'.repeat(64)),
      makeBlockRecord(99, '2'.repeat(64)),
      makeBlockRecord(100, '3'.repeat(64)),
      makeBlockRecord(101, 'a'.repeat(64)),
    ]);
    await _pollOnce();

    // Second poll: heights 99 and 100 both reorged in the same poll.
    mockPeak(102, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(99, 'REORG1'.padEnd(64, '0')),
      makeBlockRecord(100, 'REORG2'.padEnd(64, '0')),
      makeBlockRecord(101, 'a'.repeat(64)),
      makeBlockRecord(102, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    await Promise.resolve();

    // Two reorgs in one poll → one email with both blocks.
    expect(getStatus().reorgs).toHaveLength(2);
    expect(mockSendMail).toHaveBeenCalledOnce();
    const call = mockSendMail.mock.calls[0]![0] as { to: string; subject: string; text: string };
    expect(call.to).toBe('user@example.com');
    expect(call.subject).toBe('Re-org of depth 2 detected on Chia mainnet');
    expect(call.text).toContain('Block 1:');
    expect(call.text).toContain('Block 2:');
    expect(call.text).toContain('REORG1'.padEnd(64, '0').toLowerCase());
    expect(call.text).toContain('REORG2'.padEnd(64, '0').toLowerCase());
  });

  it('uses a cluster-count subject when re-orgs are non-consecutive', async () => {
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 5,
      network: 'mainnet',
      alert_recipients: [{ email: 'user@example.com', min_blocks: 1 }],
    });
    stopMonitor();

    mockPeak(103, 'a'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(99, '1'.repeat(64)),
      makeBlockRecord(100, '2'.repeat(64)),
      makeBlockRecord(101, '3'.repeat(64)),
      makeBlockRecord(102, '4'.repeat(64)),
      makeBlockRecord(103, 'a'.repeat(64)),
    ]);
    await _pollOnce();

    // Heights 99 and 101 both change — non-consecutive.
    mockPeak(104, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(99, 'REORG1'.padEnd(64, '0')),
      makeBlockRecord(100, '2'.repeat(64)), // unchanged
      makeBlockRecord(101, 'REORG2'.padEnd(64, '0')),
      makeBlockRecord(102, '4'.repeat(64)), // unchanged
      makeBlockRecord(104, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    await Promise.resolve();

    expect(getStatus().reorgs).toHaveLength(2);
    expect(mockSendMail).toHaveBeenCalledOnce();
    const call = mockSendMail.mock.calls[0]![0] as { subject: string };
    expect(call.subject).toBe('2 re-orgs detected on Chia mainnet (max depth 1)');
  });

  it('block labels are always sequential starting at 1 regardless of depth', async () => {
    // peak=105; reorged heights 102 and 103 → depths 3 and 2
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 4,
      network: 'mainnet',
      alert_recipients: [{ email: 'user@example.com', min_blocks: 1 }],
    });
    stopMonitor();

    mockPeak(104, 'a'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(101, '1'.repeat(64)),
      makeBlockRecord(102, '2'.repeat(64)),
      makeBlockRecord(103, '3'.repeat(64)),
      makeBlockRecord(104, 'a'.repeat(64)),
    ]);
    await _pollOnce();

    mockPeak(105, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(102, 'REORG1'.padEnd(64, '0')), // depth = 105-102 = 3
      makeBlockRecord(103, 'REORG2'.padEnd(64, '0')), // depth = 105-103 = 2
      makeBlockRecord(104, 'a'.repeat(64)),
      makeBlockRecord(105, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    await Promise.resolve();

    const call = mockSendMail.mock.calls[0]![0] as { text: string };
    // Closest to peak (depth 2, height 103) shown first → Block 1:
    // Further from peak (depth 3, height 102) shown second → Block 2:
    const pos1 = call.text.indexOf('Block 1:');
    const pos2 = call.text.indexOf('Block 2:');
    expect(pos1).toBeGreaterThanOrEqual(0);
    expect(pos2).toBeGreaterThanOrEqual(0);
    expect(pos1).toBeLessThan(pos2);
    expect(call.text).not.toContain('Block 3:');
  });

  it('2-block reorg: non-tx→tx and tx→non-tx; email shows original block contents', async () => {
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 3,
      network: 'mainnet',
      alert_recipients: [{ email: 'user@example.com', min_blocks: 1 }],
    });
    stopMonitor();

    // Original state — the blocks before the reorg.
    // Height 200: non-tx block (no timestamp, no fees).
    // Height 201: tx block with 10 transactions (timestamp present, non-null fees).
    const originalBlock200 = {
      height: 200,
      header_hash: 'a'.repeat(64),
      timestamp: null,
      fees: null,
      reward_claims_incorporated: null,
    };
    const originalBlock201 = {
      height: 201,
      header_hash: 'b'.repeat(64),
      timestamp: 1_700_000_000,
      fees: 100_000_000_000, // 10 transactions
      reward_claims_incorporated: Array.from({ length: 10 }, (_, i) => ({
        amount: 125_000_000_000,
        parent_coin_info: `0x${'c'.repeat(62)}${String(i).padStart(2, '0')}`,
        puzzle_hash: '0x' + 'd'.repeat(64),
      })),
    };

    mocks.get_blockchain_state.mockResolvedValue({
      blockchain_state: { peak: { height: 201, header_hash: 'b'.repeat(64) } },
    });
    mocks.get_block_records.mockResolvedValue({
      block_records: [originalBlock200, originalBlock201],
    });
    await _pollOnce();

    // Replacement blocks after the reorg.
    // Height 200: now a tx block with 5 transactions (opposite of original).
    // Height 201: now a non-tx block (opposite of original).
    const newBlock200 = {
      height: 200,
      header_hash: 'e'.repeat(64),
      timestamp: 1_700_000_050,
      fees: 50_000_000_000, // 5 transactions
      reward_claims_incorporated: Array.from({ length: 5 }, (_, i) => ({
        amount: 125_000_000_000,
        parent_coin_info: `0x${'f'.repeat(62)}${String(i).padStart(2, '0')}`,
        puzzle_hash: '0x' + 'a'.repeat(64),
      })),
    };
    const newBlock201 = {
      height: 201,
      header_hash: 'f'.repeat(64),
      timestamp: null,
      fees: null,
      reward_claims_incorporated: null,
    };

    mocks.get_blockchain_state.mockResolvedValue({
      blockchain_state: { peak: { height: 202, header_hash: '0'.repeat(64) } },
    });
    mocks.get_block_records.mockResolvedValue({
      block_records: [
        newBlock200,
        newBlock201,
        { height: 202, header_hash: '0'.repeat(64), timestamp: null },
      ],
    });
    await _pollOnce();
    await Promise.resolve();

    expect(getStatus().reorgs).toHaveLength(2);
    expect(mockSendMail).toHaveBeenCalledOnce();

    const call = mockSendMail.mock.calls[0]![0] as { subject: string; text: string };

    // Consecutive heights 200 and 201 → batched as a single 2-block reorg.
    // Chain advanced to 202 during the re-org, so depth is a range (2-3) —
    // height 202 is unobserved territory that could be part of the cascade.
    expect(call.subject).toBe('Re-org of depth 2-3 detected on Chia mainnet');
    expect(call.text).toContain('Block 1:');
    expect(call.text).toContain('Block 2:');

    // Closest to peak (height 201) is Block 1; furthest (height 200) is Block 2.
    const block1Pos = call.text.indexOf('Block 1:');
    const block2Pos = call.text.indexOf('Block 2:');
    expect(block1Pos).toBeLessThan(block2Pos);

    // Block 1 (height 201) original was tx.
    expect(call.text).toContain('b'.repeat(64)); // original hash of block 201
    expect(call.text).toContain('The original block was a tx block with the following contents:');
    expect(call.text).toContain('"timestamp": 1700000000');
    expect(call.text).toContain('"fees": 100000000000');

    // Block 2 (height 200) original was non-tx — body omits the JSON dump
    // and just states the block type.
    expect(call.text).toContain('a'.repeat(64)); // original hash of block 200
    expect(call.text).toContain(
      'The original block was a non-tx block (no canonical contents available).'
    );
    expect(call.text).not.toContain('"timestamp": null');
    expect(call.text).not.toContain('"fees": null');

    // Both spacescan links present.
    expect(call.text).toContain('spacescan.io/block/200');
    expect(call.text).toContain('spacescan.io/block/201');
  });

  // Email body intro text (consecutive vs non-consecutive)

  it('email body opens with the consecutive intro when blocks are adjacent', async () => {
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 3,
      network: 'mainnet',
      alert_recipients: [{ email: 'user@example.com', min_blocks: 1 }],
    });
    stopMonitor();

    // Establish heights 99 and 100 as consecutive reorgs (peak=101, depths 2 and 1).
    mockPeak(100, 'a'.repeat(64));
    mockBlockRecords([makeBlockRecord(99, 'x'.repeat(64)), makeBlockRecord(100, 'a'.repeat(64))]);
    await _pollOnce();

    mockPeak(101, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(99, 'y'.repeat(64)),
      makeBlockRecord(100, 'z'.repeat(64)),
      makeBlockRecord(101, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    await Promise.resolve();

    const call = mockSendMail.mock.calls[0]![0] as { text: string };
    // Chain advanced from 100 to 101 during the re-org, so depth is a range
    // (2 observed, possibly up to 3 if height 101 is also part of the cascade).
    expect(call.text).toContain(
      'A re-org of depth 2-3 was detected on the Chia mainnet blockchain'
    );
  });

  it('email body opens with the non-consecutive intro when blocks are not adjacent', async () => {
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 5,
      network: 'mainnet',
      alert_recipients: [{ email: 'user@example.com', min_blocks: 1 }],
    });
    stopMonitor();

    mockPeak(104, 'a'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(100, '1'.repeat(64)),
      makeBlockRecord(101, '2'.repeat(64)),
      makeBlockRecord(102, '3'.repeat(64)),
      makeBlockRecord(103, '4'.repeat(64)),
      makeBlockRecord(104, 'a'.repeat(64)),
    ]);
    await _pollOnce();

    // Heights 100 and 102 change — not consecutive.
    mockPeak(105, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(100, 'R1'.padEnd(64, '0')),
      makeBlockRecord(101, '2'.repeat(64)),
      makeBlockRecord(102, 'R2'.padEnd(64, '0')),
      makeBlockRecord(103, '4'.repeat(64)),
      makeBlockRecord(105, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    await Promise.resolve();

    const call = mockSendMail.mock.calls[0]![0] as { text: string };
    expect(call.text).toContain(
      '2 re-orgs were detected on the Chia mainnet blockchain (max depth 1).'
    );
  });

  // Email sender (from field)

  it('uses SMTP_FROM as the sender when set', async () => {
    process.env.SMTP_FROM = 'alerts@myorg.com';
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 2,
      network: 'mainnet',
      alert_recipients: [{ email: 'user@example.com', min_blocks: 1 }],
    });
    stopMonitor();

    mockPeak(100, 'a'.repeat(64));
    mockBlockRecords([makeBlockRecord(100, 'a'.repeat(64))]);
    await _pollOnce();
    mockPeak(101, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(100, 'REORG'.padEnd(64, '0')),
      makeBlockRecord(101, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    await Promise.resolve();

    const call = mockSendMail.mock.calls[0]![0] as { from: string };
    expect(call.from).toBe('alerts@myorg.com');
    delete process.env.SMTP_FROM;
  });

  it('falls back to SMTP_USER as sender when SMTP_FROM is not set', async () => {
    delete process.env.SMTP_FROM;
    process.env.SMTP_USER = 'bot@example.com';
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 2,
      network: 'mainnet',
      alert_recipients: [{ email: 'user@example.com', min_blocks: 1 }],
    });
    stopMonitor();

    mockPeak(100, 'a'.repeat(64));
    mockBlockRecords([makeBlockRecord(100, 'a'.repeat(64))]);
    await _pollOnce();
    mockPeak(101, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(100, 'REORG'.padEnd(64, '0')),
      makeBlockRecord(101, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    await Promise.resolve();

    const call = mockSendMail.mock.calls[0]![0] as { from: string };
    expect(call.from).toBe('bot@example.com');
    delete process.env.SMTP_USER;
  });

  it('falls back to chia-reorg-info@localhost when neither SMTP_FROM nor SMTP_USER is set', async () => {
    delete process.env.SMTP_FROM;
    delete process.env.SMTP_USER;
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 2,
      network: 'mainnet',
      alert_recipients: [{ email: 'user@example.com', min_blocks: 1 }],
    });
    stopMonitor();

    mockPeak(100, 'a'.repeat(64));
    mockBlockRecords([makeBlockRecord(100, 'a'.repeat(64))]);
    await _pollOnce();
    mockPeak(101, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(100, 'REORG'.padEnd(64, '0')),
      makeBlockRecord(101, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    await Promise.resolve();

    const call = mockSendMail.mock.calls[0]![0] as { from: string };
    expect(call.from).toBe('chia-reorg-info@localhost');
  });

  // Three-recipient tests: no-min-specified (defaults to 1), explicit min-1, explicit min-3.
  const THREE_RECIPIENTS = [
    { email: 'none@example.com', min_blocks: 1 }, // represents the tool default when min_blocks is omitted
    { email: 'min1@example.com', min_blocks: 1 },
    { email: 'min3@example.com', min_blocks: 3 },
  ];

  it('three recipients — no reorg → no emails sent', async () => {
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 2,
      network: 'mainnet',
      alert_recipients: THREE_RECIPIENTS,
    });
    stopMonitor();

    mockPeak(100, 'a'.repeat(64));
    mockBlockRecords([makeBlockRecord(99, 'x'.repeat(64)), makeBlockRecord(100, 'a'.repeat(64))]);
    await _pollOnce();

    // Same hashes on second poll — no change.
    mockPeak(101, 'b'.repeat(64));
    mockBlockRecords([makeBlockRecord(100, 'a'.repeat(64)), makeBlockRecord(101, 'b'.repeat(64))]);
    await _pollOnce();
    await Promise.resolve();

    expect(getStatus().reorgs).toHaveLength(0);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('three recipients — 1-block reorg → no-min and min-1 alerted, min-3 skipped', async () => {
    // depth = peak(101) - reorged_height(100) = 1
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 2,
      network: 'mainnet',
      alert_recipients: THREE_RECIPIENTS,
    });
    stopMonitor();

    mockPeak(100, 'a'.repeat(64));
    mockBlockRecords([makeBlockRecord(99, 'x'.repeat(64)), makeBlockRecord(100, 'a'.repeat(64))]);
    await _pollOnce();

    mockPeak(101, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(100, 'REORGED'.padEnd(64, '0')), // depth = 101-100 = 1
      makeBlockRecord(101, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    await Promise.resolve();

    expect(getStatus().reorgs).toHaveLength(1);
    expect(mockSendMail).toHaveBeenCalledTimes(2);
    const recipients = mockSendMail.mock.calls.map((c) => (c[0] as { to: string }).to).sort();
    expect(recipients).toEqual(['min1@example.com', 'none@example.com']);
  });

  it('three recipients — 2-block reorg → no-min and min-1 alerted, min-3 skipped', async () => {
    // depth = peak(102) - reorged_height(100) = 2
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 3,
      network: 'mainnet',
      alert_recipients: THREE_RECIPIENTS,
    });
    stopMonitor();

    mockPeak(101, 'a'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(99, 'x'.repeat(64)),
      makeBlockRecord(100, 'y'.repeat(64)),
      makeBlockRecord(101, 'a'.repeat(64)),
    ]);
    await _pollOnce();

    mockPeak(102, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(100, 'REORGED'.padEnd(64, '0')), // depth = 102-100 = 2
      makeBlockRecord(101, 'a'.repeat(64)),
      makeBlockRecord(102, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    await Promise.resolve();

    expect(getStatus().reorgs).toHaveLength(1);
    expect(mockSendMail).toHaveBeenCalledTimes(2);
    const recipients = mockSendMail.mock.calls.map((c) => (c[0] as { to: string }).to).sort();
    expect(recipients).toEqual(['min1@example.com', 'none@example.com']);
  });

  it('three recipients — 3-block reorg → all three alerted', async () => {
    // Heights 100, 101, 102 all change in one poll → cluster depth = 3; min-3 met.
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 4,
      network: 'mainnet',
      alert_recipients: THREE_RECIPIENTS,
    });
    stopMonitor();

    mockPeak(102, 'a'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(99, 'w'.repeat(64)),
      makeBlockRecord(100, 'x'.repeat(64)),
      makeBlockRecord(101, 'y'.repeat(64)),
      makeBlockRecord(102, 'a'.repeat(64)),
    ]);
    await _pollOnce();

    mockPeak(103, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(100, 'R1'.padEnd(64, '0')),
      makeBlockRecord(101, 'R2'.padEnd(64, '0')),
      makeBlockRecord(102, 'R3'.padEnd(64, '0')),
      makeBlockRecord(103, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    await Promise.resolve();

    expect(getStatus().reorgs).toHaveLength(3);
    expect(getStatus().reorgs.every((r) => r.depth === 3)).toBe(true);
    expect(mockSendMail).toHaveBeenCalledTimes(3);
    const recipients = mockSendMail.mock.calls.map((c) => (c[0] as { to: string }).to).sort();
    expect(recipients).toEqual(['min1@example.com', 'min3@example.com', 'none@example.com']);
  });

  it('runs a follow-up poll after the scheduled timer fires', async () => {
    vi.useFakeTimers();

    mockPeak(500, 'a'.repeat(64));
    mockBlockRecords([makeBlockRecord(500, 'a'.repeat(64))]);

    startMonitor({ poll_interval_seconds: 10, lookback_blocks: 1, network: 'mainnet' });

    // Flush the initial void _pollOnce() call and its .finally() callback
    // so that scheduleNext() has registered the setTimeout before we advance.
    await vi.advanceTimersByTimeAsync(0);
    expect(getStatus().poll_count).toBe(1);

    // Wire up the second poll's mock before advancing the clock.
    mockPeak(501, 'b'.repeat(64));
    mockBlockRecords([makeBlockRecord(501, 'b'.repeat(64))]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(getStatus().poll_count).toBe(2);
  });

  // ── Generation guard: errors from cancelled polls must not leak into a fresh session ──

  it('a cancelled poll throwing does not pollute last_error of the next session', async () => {
    startMonitor({ poll_interval_seconds: 60, lookback_blocks: 2, network: 'mainnet' });
    stopMonitor();

    // Prime an in-flight poll: blockchain_state resolves, block_records is deferred.
    mocks.get_blockchain_state.mockResolvedValue({
      blockchain_state: { peak: { height: 100, header_hash: 'a'.repeat(64) } },
    });
    let rejectBlocks!: (e: Error) => void;
    mocks.get_block_records.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectBlocks = reject;
      })
    );

    const stalePoll = _pollOnce();
    await Promise.resolve();
    await Promise.resolve();

    // Stop, then start a brand new session (bumps generation twice).
    stopMonitor();
    startMonitor({ poll_interval_seconds: 60, lookback_blocks: 2, network: 'mainnet' });
    stopMonitor();
    expect(getStatus().last_error).toBeNull();

    // Now let the stale poll's block_records reject — this must NOT touch last_error.
    rejectBlocks(new Error('stale poll failed'));
    await stalePoll;
    await Promise.resolve();

    expect(getStatus().last_error).toBeNull();
  });

  // ── scheduleNext: must not re-arm after stopMonitor ──

  it('does not schedule a follow-up poll when stopMonitor fires during the in-flight poll', async () => {
    vi.useFakeTimers();

    let resolveBlocks!: (v: unknown) => void;
    mocks.get_blockchain_state.mockResolvedValue({
      blockchain_state: { peak: { height: 200, header_hash: 'a'.repeat(64) } },
    });
    mocks.get_block_records.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBlocks = resolve;
      })
    );

    startMonitor({ poll_interval_seconds: 10, lookback_blocks: 1, network: 'mainnet' });
    await Promise.resolve();
    await Promise.resolve();

    stopMonitor();
    resolveBlocks({ block_records: [makeBlockRecord(200, 'a'.repeat(64))] });
    await vi.advanceTimersByTimeAsync(0);

    // After stop + the in-flight poll settles, no follow-up timer should be armed.
    expect(vi.getTimerCount()).toBe(0);
  });

  // ── Network parameter on detection logic side ──

  it('flows the testnet11 network into both status and the alert email', async () => {
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 2,
      network: 'testnet11',
      alert_recipients: [{ email: 'user@example.com', min_blocks: 1 }],
    });
    stopMonitor();
    expect(getStatus().network).toBe('testnet11');

    mockPeak(100, 'a'.repeat(64));
    mockBlockRecords([makeBlockRecord(100, 'a'.repeat(64))]);
    await _pollOnce();

    mockPeak(101, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(100, 'REORG'.padEnd(64, '0')),
      makeBlockRecord(101, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    await Promise.resolve();

    const call = mockSendMail.mock.calls[0]![0] as { subject: string; text: string };
    expect(call.subject).toContain('testnet11');
    expect(call.text).toContain('testnet11');
  });

  // ── getStatus immutability ──

  it('mutating the arrays returned by getStatus does not affect internal state', async () => {
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 2,
      network: 'mainnet',
      alert_recipients: [{ email: 'a@example.com', min_blocks: 1 }],
    });
    stopMonitor();

    mockPeak(100, 'a'.repeat(64));
    mockBlockRecords([makeBlockRecord(100, 'a'.repeat(64))]);
    await _pollOnce();
    mockPeak(101, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(100, 'REORG'.padEnd(64, '0')),
      makeBlockRecord(101, 'b'.repeat(64)),
    ]);
    await _pollOnce();

    const snapshot = getStatus();
    expect(snapshot.reorgs).toHaveLength(1);
    expect(snapshot.alert_recipients).toHaveLength(1);

    // Mutate the returned arrays + inner objects.
    snapshot.reorgs.length = 0;
    snapshot.alert_recipients.length = 0;
    const fresh = getStatus();
    expect(fresh.reorgs).toHaveLength(1);
    expect(fresh.alert_recipients).toHaveLength(1);

    // Mutating an inner reorg object also must not bleed back.
    const inner = fresh.reorgs[0]!;
    inner.height = -1;
    expect(getStatus().reorgs[0]!.height).toBe(100);
  });

  // ── Email body: timezone-aware peak-height line ──

  it('email body includes peak height with local date, time, and timezone', async () => {
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 2,
      network: 'mainnet',
      alert_recipients: [{ email: 'user@example.com', min_blocks: 1 }],
    });
    stopMonitor();

    mockPeak(100, 'a'.repeat(64));
    mockBlockRecords([makeBlockRecord(100, 'a'.repeat(64))]);
    await _pollOnce();
    mockPeak(101, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(100, 'REORG'.padEnd(64, '0')),
      makeBlockRecord(101, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    await Promise.resolve();

    const call = mockSendMail.mock.calls[0]![0] as { text: string };
    // Format: "Peak height at detection: <num> (<YYYY-MM-DD> <locale-time> <IANA-zone>)"
    // Permissive regex: date is strict, time/zone are anything-but-newline.
    expect(call.text).toMatch(/Peak height at detection: 101 \(\d{4}-\d{2}-\d{2} [^\n)]+\)/);
  });

  // ── Email-address redaction in getStatus ──

  it('get_reorg_monitor_status redacts configured email addresses', () => {
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 2,
      network: 'mainnet',
      alert_recipients: [
        { email: 'secret.user@example.com', min_blocks: 1 },
        { email: 'b@x.io', min_blocks: 5 },
      ],
    });
    stopMonitor();

    const status = getStatus();
    expect(status.alert_recipients).toEqual([
      { email: 's***@example.com', min_blocks: 1 },
      { email: 'b***@x.io', min_blocks: 5 },
    ]);
    expect(JSON.stringify(status)).not.toContain('secret.user');
  });

  // ── Debounce: thrashing back to a previously-alerted (height, new_hash) pair ──

  it('debounces re-alerts when the same (height, new_hash) pair recurs', async () => {
    const hashA = 'a'.repeat(64);
    const hashB = 'b'.repeat(64);

    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 10,
      network: 'mainnet',
      alert_recipients: [{ email: 'user@example.com', min_blocks: 1 }],
    });
    stopMonitor();

    // Poll 1: establish height 100 = A. No reorg.
    mockPeak(100, hashA);
    mockBlockRecords([makeBlockRecord(100, hashA)]);
    await _pollOnce();
    expect(mockSendMail).not.toHaveBeenCalled();

    // Poll 2: height 100 flips to B → reorg event (100, B). Alert #1.
    mockPeak(101, 'p'.repeat(64));
    mockBlockRecords([makeBlockRecord(100, hashB), makeBlockRecord(101, 'p'.repeat(64))]);
    await _pollOnce();
    await Promise.resolve();
    expect(mockSendMail).toHaveBeenCalledTimes(1);

    // Poll 3: height 100 flips back to A → reorg event (100, A). Alert #2 (new pair).
    mockPeak(102, 'q'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(100, hashA),
      makeBlockRecord(101, 'p'.repeat(64)),
      makeBlockRecord(102, 'q'.repeat(64)),
    ]);
    await _pollOnce();
    await Promise.resolve();
    expect(mockSendMail).toHaveBeenCalledTimes(2);

    // Poll 4: height 100 thrashes back to B → reorg event (100, B) — DEBOUNCED.
    mockPeak(103, 'r'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(100, hashB),
      makeBlockRecord(101, 'p'.repeat(64)),
      makeBlockRecord(102, 'q'.repeat(64)),
      makeBlockRecord(103, 'r'.repeat(64)),
    ]);
    await _pollOnce();
    await Promise.resolve();
    expect(mockSendMail).toHaveBeenCalledTimes(2);
    // But the reorg is still recorded in history.
    expect(getStatus().reorgs).toHaveLength(3);
  });

  it('clears the alert debounce set on restart', async () => {
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 2,
      network: 'mainnet',
      alert_recipients: [{ email: 'user@example.com', min_blocks: 1 }],
    });
    stopMonitor();

    mockPeak(100, 'a'.repeat(64));
    mockBlockRecords([makeBlockRecord(100, 'a'.repeat(64))]);
    await _pollOnce();
    mockPeak(101, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(100, 'CAFEBABE'.padEnd(64, '0')),
      makeBlockRecord(101, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    await Promise.resolve();
    expect(mockSendMail).toHaveBeenCalledTimes(1);

    // Restart — debounce set should be cleared. A reorg with the same (height, hash)
    // pair as before must now alert again because it's a brand-new session.
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 2,
      network: 'mainnet',
      alert_recipients: [{ email: 'user@example.com', min_blocks: 1 }],
    });
    stopMonitor();

    mockPeak(100, 'a'.repeat(64));
    mockBlockRecords([makeBlockRecord(100, 'a'.repeat(64))]);
    await _pollOnce();
    mockPeak(101, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(100, 'CAFEBABE'.padEnd(64, '0')),
      makeBlockRecord(101, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    await Promise.resolve();
    expect(mockSendMail).toHaveBeenCalledTimes(2);
  });

  // ── SMTP_PORT validation ──

  it('captures an invalid SMTP_PORT as last_error without crashing', async () => {
    const prevHost = process.env.SMTP_HOST;
    const prevPort = process.env.SMTP_PORT;
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = 'not-a-number';

    try {
      startMonitor({
        poll_interval_seconds: 60,
        lookback_blocks: 2,
        network: 'mainnet',
        alert_recipients: [{ email: 'user@example.com', min_blocks: 1 }],
      });
      stopMonitor();

      mockPeak(100, 'a'.repeat(64));
      mockBlockRecords([makeBlockRecord(100, 'a'.repeat(64))]);
      await _pollOnce();
      mockPeak(101, 'b'.repeat(64));
      mockBlockRecords([
        makeBlockRecord(100, 'REORG'.padEnd(64, '0')),
        makeBlockRecord(101, 'b'.repeat(64)),
      ]);
      await _pollOnce();
      await Promise.resolve();
      await Promise.resolve();

      expect(getStatus().reorgs).toHaveLength(1);
      expect(getStatus().last_error).toMatch(/SMTP_PORT/);
    } finally {
      if (prevHost === undefined) delete process.env.SMTP_HOST;
      else process.env.SMTP_HOST = prevHost;
      if (prevPort === undefined) delete process.env.SMTP_PORT;
      else process.env.SMTP_PORT = prevPort;
    }
  });

  // ── SMTP_CA_CERT_PATH support ──

  async function triggerReorg(): Promise<void> {
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 2,
      network: 'mainnet',
      alert_recipients: [{ email: 'user@example.com', min_blocks: 1 }],
    });
    stopMonitor();

    mockPeak(100, 'a'.repeat(64));
    mockBlockRecords([makeBlockRecord(100, 'a'.repeat(64))]);
    await _pollOnce();
    mockPeak(101, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(100, 'REORG'.padEnd(64, '0')),
      makeBlockRecord(101, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    await Promise.resolve();
  }

  it('passes the SMTP_CA_CERT_PATH file contents as tls.ca to nodemailer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reorg-ca-'));
    const certPath = join(dir, 'ca.pem');
    const certBody = '-----BEGIN CERTIFICATE-----\nFAKEPEM\n-----END CERTIFICATE-----\n';
    writeFileSync(certPath, certBody);
    const prev = process.env.SMTP_CA_CERT_PATH;
    process.env.SMTP_CA_CERT_PATH = certPath;
    mockCreateTransport.mockClear();

    try {
      await triggerReorg();
      await vi.waitFor(() => expect(mockCreateTransport).toHaveBeenCalled());
      const opts = mockCreateTransport.mock.calls.at(-1)?.[0] as {
        tls?: { ca?: string };
      };
      expect(opts?.tls?.ca).toBe(certBody);
    } finally {
      if (prev === undefined) delete process.env.SMTP_CA_CERT_PATH;
      else process.env.SMTP_CA_CERT_PATH = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits tls option when SMTP_CA_CERT_PATH is not set', async () => {
    const prev = process.env.SMTP_CA_CERT_PATH;
    delete process.env.SMTP_CA_CERT_PATH;
    mockCreateTransport.mockClear();

    try {
      await triggerReorg();
      const opts = mockCreateTransport.mock.calls.at(-1)?.[0] as {
        tls?: unknown;
      };
      expect(opts.tls).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.SMTP_CA_CERT_PATH = prev;
    }
  });

  it('captures a missing SMTP_CA_CERT_PATH file as last_error without crashing', async () => {
    const prev = process.env.SMTP_CA_CERT_PATH;
    process.env.SMTP_CA_CERT_PATH = join(tmpdir(), 'does-not-exist-ca.pem');

    try {
      await triggerReorg();
      await vi.waitFor(() => expect(getStatus().last_error).toMatch(/ENOENT|no such file/i));
      expect(getStatus().reorgs).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.SMTP_CA_CERT_PATH;
      else process.env.SMTP_CA_CERT_PATH = prev;
    }
  });
});
