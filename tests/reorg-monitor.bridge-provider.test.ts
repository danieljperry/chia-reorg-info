import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChiaAgentMocks } from './helpers/chia-agent-mocks.js';
import type { BridgeInfo } from '../src/monitor/bridge-info.js';
import type { ReorgEvent } from '../src/monitor/reorg-monitor.js';

// Covers the Bridge Info hook wired into _pollOnce — the production
// single-source-coinset path. The dispatch-level wiring is tested in
// cli.reorg-monitor.bridge-dispatch.test.ts, but that exercises
// dispatchToRecipients; this file exercises the OTHER call site, the
// per-poll bridge resolution inside _pollOnce (reorg-monitor.ts).
//
// Setup mirrors reorg-monitor.detection.test.ts (mock chia-agent RPC +
// nodemailer). Crucially, these tests must NOT call stopMonitor() before
// polling: stopMonitor() nulls state.bridgeInfoProvider. Each test instead
// uses startMonitor's own initial poll to settle a baseline (flushed), then
// drives a second _pollOnce() that detects a re-org.

const mockSendMail = vi.fn().mockResolvedValue({ messageId: 'test' });
const mockCreateTransport = vi.fn<(opts: unknown) => { sendMail: typeof mockSendMail }>(() => ({
  sendMail: mockSendMail,
}));

const mocks = createChiaAgentMocks();

vi.mock('chia-agent/api/rpc/full_node/index.js', () => mocks);
vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
}));

process.env.SMTP_HOST = 'localhost';

const { _pollOnce, startMonitor, stopMonitor, getStatus } = await import(
  '../src/monitor/reorg-monitor.js'
);

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

// Drain microtasks twice. _pollOnce awaits the bridge provider internally,
// but the sendReorgAlert call it makes afterwards is fire-and-forget (.catch),
// so we flush before asserting on mockSendMail.
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function bridgeInfoFixture(): BridgeInfo {
  return {
    formattedText:
      '  Found 1 reorged block(s) with bridge references (1 matching coin spend(s)).',
    spendCount: 1,
    matchedBlockCount: 1,
    lowHeight: 99,
    highHeight: 99,
  };
}

describe('bridge info provider wiring in _pollOnce', () => {
  beforeEach(() => {
    mockSendMail.mockClear();
    for (const fn of Object.values(mocks)) fn.mockReset();
  });

  afterEach(() => {
    stopMonitor();
    vi.restoreAllMocks();
    mockSendMail.mockReset();
    mockSendMail.mockResolvedValue({ messageId: 'test' });
  });

  it('invokes the provider once and attaches the Bridge Info section to the email', async () => {
    const info = bridgeInfoFixture();
    const provider = vi.fn<(events: ReorgEvent[]) => Promise<BridgeInfo | undefined>>(() =>
      Promise.resolve(info)
    );

    // Baseline poll establishes observations (no re-org).
    mockPeak(100, 'a'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(98, '8'.repeat(64)),
      makeBlockRecord(99, '9'.repeat(64)),
      makeBlockRecord(100, 'a'.repeat(64)),
    ]);
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 3,
      network: 'mainnet',
      alert_recipients: [{ email: 'a@b.com', min_blocks: 1 }],
      bridge_info_provider: provider,
    });
    await flush(); // let startMonitor's initial poll settle the baseline

    // Second poll: height 99's hash changes → re-org at 99.
    mockPeak(101, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(99, 'd'.repeat(64)),
      makeBlockRecord(100, 'a'.repeat(64)),
      makeBlockRecord(101, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    await flush();

    expect(getStatus().reorgs).toHaveLength(1);
    // Provider runs exactly once (not per recipient, not on the baseline poll)
    // and receives the newly-detected re-org batch.
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider.mock.calls[0]![0].map((e) => e.height)).toEqual([99]);

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const sent = mockSendMail.mock.calls[0]![0] as { text: string };
    expect(sent.text).toContain('Bridge Info:');
    expect(sent.text).toContain(
      'This reorg included bridge spends with the following details:'
    );
    expect(sent.text).toContain('Found 1 reorged block(s) with bridge references');
  });

  it('swallows a provider rejection and still sends the alert without a Bridge Info section', async () => {
    const provider = vi.fn<(events: ReorgEvent[]) => Promise<BridgeInfo | undefined>>(() =>
      Promise.reject(new Error('boom in provider'))
    );

    mockPeak(100, 'a'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(98, '8'.repeat(64)),
      makeBlockRecord(99, '9'.repeat(64)),
      makeBlockRecord(100, 'a'.repeat(64)),
    ]);
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 3,
      network: 'mainnet',
      alert_recipients: [{ email: 'a@b.com', min_blocks: 1 }],
      bridge_info_provider: provider,
    });
    await flush();

    mockPeak(101, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(99, 'd'.repeat(64)),
      makeBlockRecord(100, 'a'.repeat(64)),
      makeBlockRecord(101, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    await flush();

    expect(provider).toHaveBeenCalledTimes(1);
    // Rejection is caught inside _pollOnce; the email still goes out, just
    // without a bridge section. last_error must not be set by the rejection.
    expect(getStatus().last_error).toBeNull();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const sent = mockSendMail.mock.calls[0]![0] as { text: string };
    expect(sent.text).not.toContain('Bridge Info:');
  });

  it('does not invoke the provider when a poll detects no new re-orgs', async () => {
    const provider = vi.fn<(events: ReorgEvent[]) => Promise<BridgeInfo | undefined>>(() =>
      Promise.resolve(undefined)
    );

    mockPeak(100, 'a'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(99, '9'.repeat(64)),
      makeBlockRecord(100, 'a'.repeat(64)),
    ]);
    startMonitor({
      poll_interval_seconds: 60,
      lookback_blocks: 2,
      network: 'mainnet',
      alert_recipients: [{ email: 'a@b.com', min_blocks: 1 }],
      bridge_info_provider: provider,
    });
    await flush();

    // Stable second poll — no hash changes, so no re-org and no provider call.
    mockPeak(101, 'b'.repeat(64));
    mockBlockRecords([
      makeBlockRecord(100, 'a'.repeat(64)),
      makeBlockRecord(101, 'b'.repeat(64)),
    ]);
    await _pollOnce();
    await flush();

    expect(getStatus().reorgs).toHaveLength(0);
    expect(provider).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});
