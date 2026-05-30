import { describe, expect, it, vi } from 'vitest';

// Tests the dispatch-level wiring of the bridge-info provider into
// `dispatchToRecipients`. Verifies:
//   - provider is invoked exactly once per batch (not per recipient)
//   - the same BridgeInfo instance flows to every eligible recipient
//   - the provider runs even when min_blocks filters out all recipients,
//     so the per-batch log entry fires (matches the user's "log on
//     detection" spec, decoupled from "include in email")
//   - provider failure is swallowed and email dispatch continues with no
//     bridge section
//   - provider is not invoked at all when the event list is empty

const mockSendMail = vi.fn().mockResolvedValue({ messageId: 'test' });
const mockCreateTransport = vi.fn(() => ({ sendMail: mockSendMail }));
vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
}));

process.env.SMTP_HOST = 'localhost';

const { dispatchToRecipients } = await import('../src/cli/reorg-monitor.js');
import type { ReorgEvent, AlertRecipient } from '../src/monitor/reorg-monitor.js';
import type { BridgeInfo } from '../src/monitor/bridge-info.js';

function evt(height: number, max_depth = 1): ReorgEvent {
  return {
    height,
    old_header_hash: 'aa'.repeat(32),
    new_header_hash: 'bb'.repeat(32),
    detected_at: '2026-05-30T02:00:00.000Z',
    depth: max_depth,
    max_depth,
    blocks_from_peak: 0,
    old_block_record: {},
  };
}

function makeInfo(overrides: Partial<BridgeInfo> = {}): BridgeInfo {
  return {
    formattedText: '  Bridge body fixture',
    spendCount: 1,
    matchedBlockCount: 1,
    lowHeight: 100,
    highHeight: 100,
    ...overrides,
  };
}

// Drain microtasks + the fire-and-forget sendReorgAlert promises so we
// can assert on mockSendMail. dispatchToRecipients is async but the
// inner sendReorgAlert call is fire-and-forget via .catch().
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('dispatchToRecipients — bridge provider integration', () => {
  it('calls the provider exactly once for a batch with 3 eligible recipients', async () => {
    mockSendMail.mockClear();
    const provider = vi.fn(() => Promise.resolve(makeInfo()));
    const recipients: AlertRecipient[] = [
      { email: 'a@x.com', min_blocks: 1 },
      { email: 'b@x.com', min_blocks: 1 },
      { email: 'c@x.com', min_blocks: 1 },
    ];
    await dispatchToRecipients([evt(100)], recipients, 'mainnet', 100, {
      bridgeInfoProvider: provider,
    });
    await flush();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(mockSendMail).toHaveBeenCalledTimes(3);
  });

  it('passes the SAME BridgeInfo instance to every eligible recipient', async () => {
    mockSendMail.mockClear();
    const info = makeInfo({ formattedText: '  unique fixture text' });
    const provider = vi.fn(() => Promise.resolve(info));
    const recipients: AlertRecipient[] = [
      { email: 'a@x.com', min_blocks: 1 },
      { email: 'b@x.com', min_blocks: 1 },
    ];
    await dispatchToRecipients([evt(100)], recipients, 'mainnet', 100, {
      bridgeInfoProvider: provider,
    });
    await flush();
    expect(mockSendMail).toHaveBeenCalledTimes(2);
    for (const call of mockSendMail.mock.calls) {
      const text = (call[0] as { text: string }).text;
      expect(text).toContain('unique fixture text');
    }
  });

  it('still calls the provider when ALL recipients are filtered out by min_blocks', async () => {
    // User spec: log entry fires whenever a re-org is detected, regardless
    // of whether any email goes out. The provider is what writes the log
    // entry (and produces the BridgeInfo); it must run.
    mockSendMail.mockClear();
    const provider = vi.fn(() => Promise.resolve(makeInfo()));
    const recipients: AlertRecipient[] = [
      { email: 'high@x.com', min_blocks: 5 },
      { email: 'higher@x.com', min_blocks: 10 },
    ];
    await dispatchToRecipients([evt(100, /*max_depth=*/ 1)], recipients, 'mainnet', 100, {
      bridgeInfoProvider: provider,
    });
    await flush();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('does NOT call the provider when the event list is empty', async () => {
    mockSendMail.mockClear();
    const provider = vi.fn(() => Promise.resolve(makeInfo()));
    await dispatchToRecipients([], [{ email: 'a@x.com', min_blocks: 1 }], 'mainnet', 100, {
      bridgeInfoProvider: provider,
    });
    await flush();
    expect(provider).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('swallows provider rejection and emails go out with no bridge section', async () => {
    mockSendMail.mockClear();
    const provider = vi.fn(() =>
      Promise.reject<BridgeInfo | undefined>(new Error('simulated provider boom'))
    );
    await dispatchToRecipients(
      [evt(100)],
      [{ email: 'a@x.com', min_blocks: 1 }],
      'mainnet',
      100,
      { bridgeInfoProvider: provider }
    );
    await flush();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const text = (mockSendMail.mock.calls[0]?.[0] as { text: string }).text;
    expect(text).not.toContain('Bridge Info:');
    expect(text).not.toContain('This reorg included bridge spends');
  });

  it('omits the bridge section when the provider returns undefined (no matches / skipped)', async () => {
    mockSendMail.mockClear();
    const provider = vi.fn(() => Promise.resolve<BridgeInfo | undefined>(undefined));
    await dispatchToRecipients(
      [evt(100)],
      [{ email: 'a@x.com', min_blocks: 1 }],
      'mainnet',
      100,
      { bridgeInfoProvider: provider }
    );
    await flush();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const text = (mockSendMail.mock.calls[0]?.[0] as { text: string }).text;
    expect(text).not.toContain('Bridge Info:');
  });

  it('with mixed recipients, only the eligible ones get emails, and they all see the bridge section', async () => {
    mockSendMail.mockClear();
    const info = makeInfo({ formattedText: '  mixed-eligibility fixture' });
    const provider = vi.fn(() => Promise.resolve(info));
    const recipients: AlertRecipient[] = [
      { email: 'low@x.com', min_blocks: 1 },
      { email: 'high@x.com', min_blocks: 5 },
      { email: 'also-low@x.com', min_blocks: 1 },
    ];
    await dispatchToRecipients([evt(100, /*max_depth=*/ 2)], recipients, 'mainnet', 100, {
      bridgeInfoProvider: provider,
    });
    await flush();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(mockSendMail).toHaveBeenCalledTimes(2);
    for (const call of mockSendMail.mock.calls) {
      const to = (call[0] as { to: string }).to;
      const text = (call[0] as { text: string }).text;
      expect(['low@x.com', 'also-low@x.com']).toContain(to);
      expect(text).toContain('mixed-eligibility fixture');
    }
  });
});
