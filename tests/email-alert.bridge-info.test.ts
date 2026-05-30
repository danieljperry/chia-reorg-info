import { describe, expect, it, vi } from 'vitest';

// Tests for `buildBridgeInfoSection` (private, exercised via
// `sendReorgAlert`'s body assembly). Verifies the three size tiers, the
// "header + leading statement always present" invariant, the attachment
// filename format, and that the section is fully omitted from the body
// when no bridgeInfo is supplied.

const mockSendMail = vi.fn().mockResolvedValue({ messageId: 'test' });
const mockCreateTransport = vi.fn(() => ({ sendMail: mockSendMail }));
vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
}));

process.env.SMTP_HOST = 'localhost';

const { sendReorgAlert } = await import('../src/monitor/email-alert.js');
import type { ReorgEvent } from '../src/monitor/reorg-monitor.js';
import type { BridgeInfo } from '../src/monitor/bridge-info.js';

function makeReorg(overrides: Partial<ReorgEvent> = {}): ReorgEvent {
  return {
    height: 7357253,
    old_header_hash:
      'ee1b143321c63a67213ab54532d925c8133a94d276ba926754bbb91a72e1d413',
    new_header_hash:
      'aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00',
    detected_at: '2026-05-30T02:00:00.000Z',
    depth: 1,
    max_depth: 1,
    blocks_from_peak: 5,
    // Empty object → email-alert treats as non-tx block (no timestamp).
    // Avoids exercising the JSON-dump branch we're not testing here.
    old_block_record: {},
    ...overrides,
  };
}

function lastSent(): { subject: string; text: string; attachments?: Array<{ filename: string; content: string }> } {
  const c = mockSendMail.mock.calls[mockSendMail.mock.calls.length - 1];
  if (!c) throw new Error('expected sendMail to have been called');
  return c[0] as { subject: string; text: string; attachments?: Array<{ filename: string; content: string }> };
}

const STATEMENT = 'This reorg included bridge spends with the following details:';
const HEADER = 'Bridge Info:';

describe('Bridge Info section in email body', () => {
  it('is omitted entirely when extras.bridgeInfo is absent', async () => {
    mockSendMail.mockClear();
    await sendReorgAlert('a@b.com', 'mainnet', [makeReorg()], 1000);
    const text = lastSent().text;
    expect(text).not.toContain(HEADER);
    expect(text).not.toContain(STATEMENT);
  });

  it('inlines the formatted text below the header + statement when small', async () => {
    mockSendMail.mockClear();
    const formattedText =
      '  Found 1 reorged block(s) with bridge references (2 matching coin spend(s)).\n' +
      '\n' +
      '  Match 1:\n' +
      '    Block height:    7357253\n';
    const info: BridgeInfo = {
      formattedText,
      spendCount: 2,
      matchedBlockCount: 1,
      lowHeight: 7357253,
      highHeight: 7357253,
    };
    await sendReorgAlert('a@b.com', 'mainnet', [makeReorg()], 1000, { bridgeInfo: info });
    const sent = lastSent();
    expect(sent.text).toContain(HEADER);
    expect(sent.text).toContain(STATEMENT);
    expect(sent.text).toContain('Found 1 reorged block(s)');
    expect(sent.text).toContain('Block height:    7357253');
    expect(sent.attachments ?? []).toHaveLength(0);
  });

  it('attaches as bridge-info-<low>-<high>.txt when between inline and attachment limits', async () => {
    mockSendMail.mockClear();
    // > 25 KiB but < 250 KiB. Use ~50 KiB of ASCII so byte count == char count.
    const filler = '  '.repeat(50 * 1024); // ~100 KiB; well above 25 KiB
    const info: BridgeInfo = {
      formattedText: filler,
      spendCount: 99,
      matchedBlockCount: 3,
      lowHeight: 1000,
      highHeight: 1002,
    };
    await sendReorgAlert('a@b.com', 'mainnet', [makeReorg()], 1100, { bridgeInfo: info });
    const sent = lastSent();
    expect(sent.text).toContain(HEADER);
    expect(sent.text).toContain(STATEMENT);
    // Body should reference the attachment, not paste the contents.
    expect(sent.text).toMatch(/Bridge info attached as bridge-info-1000-1002\.txt \([0-9.]+ KiB\)\./);
    expect(sent.text).not.toContain(filler);
    expect(sent.attachments).toBeDefined();
    expect(sent.attachments?.length).toBe(1);
    expect(sent.attachments?.[0]?.filename).toBe('bridge-info-1000-1002.txt');
    expect(sent.attachments?.[0]?.content).toBe(filler);
  });

  it('omits content (no attachment) when above the attachment limit', async () => {
    mockSendMail.mockClear();
    // >= 250 KiB
    const oversize = 'x'.repeat(260 * 1024);
    const info: BridgeInfo = {
      formattedText: oversize,
      spendCount: 999,
      matchedBlockCount: 5,
      lowHeight: 2000,
      highHeight: 2010,
    };
    await sendReorgAlert('a@b.com', 'mainnet', [makeReorg()], 2100, { bridgeInfo: info });
    const sent = lastSent();
    expect(sent.text).toContain(HEADER);
    expect(sent.text).toContain(STATEMENT);
    expect(sent.text).toMatch(/Bridge info not included due to its large size:/);
    expect(sent.text).not.toContain(oversize);
    expect(sent.attachments ?? []).toHaveLength(0);
  });

  it('the header + statement are present in ALL three tiers (invariant)', async () => {
    const sizes = [
      { label: 'small', formattedText: '  small body' },
      { label: 'medium', formattedText: ' '.repeat(60 * 1024) },
      { label: 'large', formattedText: ' '.repeat(260 * 1024) },
    ];
    for (const s of sizes) {
      mockSendMail.mockClear();
      const info: BridgeInfo = {
        formattedText: s.formattedText,
        spendCount: 1,
        matchedBlockCount: 1,
        lowHeight: 1,
        highHeight: 1,
      };
      await sendReorgAlert('a@b.com', 'mainnet', [makeReorg()], 100, { bridgeInfo: info });
      const text = lastSent().text;
      expect(text, `${s.label}: missing header`).toContain(HEADER);
      expect(text, `${s.label}: missing statement`).toContain(STATEMENT);
    }
  });

  it('appears AFTER the per-block sections in the body (trailing section)', async () => {
    mockSendMail.mockClear();
    const info: BridgeInfo = {
      formattedText: '  bridge body content',
      spendCount: 1,
      matchedBlockCount: 1,
      lowHeight: 1,
      highHeight: 1,
    };
    await sendReorgAlert('a@b.com', 'mainnet', [makeReorg()], 100, { bridgeInfo: info });
    const text = lastSent().text;
    const blockIdx = text.indexOf('Block 1:');
    const bridgeIdx = text.indexOf(HEADER);
    expect(blockIdx).toBeGreaterThan(-1);
    expect(bridgeIdx).toBeGreaterThan(-1);
    expect(bridgeIdx).toBeGreaterThan(blockIdx);
  });
});
