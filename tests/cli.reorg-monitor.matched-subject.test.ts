import { describe, expect, it, vi } from 'vitest';

// Mock nodemailer so we can capture the outgoing email without sending it.
const mockSendMail = vi.fn().mockResolvedValue({ messageId: 'test' });
const mockCreateTransport = vi.fn(() => ({ sendMail: mockSendMail }));
vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
}));

// Force SMTP_HOST so sendReorgAlert doesn't bail. (createTransport is mocked
// anyway, so the value is unused except to pass the "configured" check.)
process.env.SMTP_HOST = 'localhost';

const { sendReorgAlert } = await import('../src/monitor/email-alert.js');
const { synthesizeReorgEventFromSource } = await import(
  '../src/cli/reorg-monitor.js'
);

describe('matched-outcome email subject uses local node depth, not Coinset range', () => {
  it("user scenario: local 1-block + Coinset 1-4 range → subject says 'depth 1', not 'depth 1-4'", async () => {
    mockSendMail.mockClear();

    // Simulate what dispatchDualOutcome does for a `matched` outcome:
    // synthesize the alert event from the LOCAL source so the email-alert
    // subject computation sees an exact depth (depth == max_depth) and
    // renders as "depth 1" not "depth 1-4".
    const localSource = {
      source: 'local' as const,
      low: 8773500,
      high: 8773500,
      settle_at: 8773500,
      depth: 1,
      max_depth: 1, // local is always exact
      detected_at_iso: '2026-05-25T02:45:27.985Z',
    };
    const evt = synthesizeReorgEventFromSource(localSource);

    await sendReorgAlert('alice@example.com', 'mainnet', [evt], 8773503, {
      subjectSuffix: ' — confirmed by Coinset + local DB',
      introPrepend: 'The same reorg of 1 block(s) ...',
    });

    expect(mockSendMail).toHaveBeenCalledOnce();
    const sentSubject = (mockSendMail.mock.calls[0]?.[0] as { subject: string })
      .subject;
    expect(sentSubject).toBe(
      'Re-org of depth 1 detected on Chia mainnet — confirmed by Coinset + local DB'
    );
    expect(sentSubject).not.toMatch(/1-4/);
  });

  it('coinset-only outcome still shows the Coinset range (no local data to override)', async () => {
    mockSendMail.mockClear();

    // For coinset-only, synthesize from the Coinset source — keeping
    // depth=1, max_depth=4 — so the email correctly conveys Coinset's
    // uncertainty since local has no opinion on this reorg.
    const coinsetSource = {
      source: 'coinset' as const,
      low: 8773500,
      high: 8773503, // widened
      settle_at: 8773500, // observed top, un-widened
      depth: 1,
      max_depth: 4,
      detected_at_iso: '2026-05-25T02:45:27.985Z',
    };
    const evt = synthesizeReorgEventFromSource(coinsetSource);

    await sendReorgAlert('alice@example.com', 'mainnet', [evt], 8773503, {
      subjectSuffix: ' — Coinset only',
      introPrepend: 'A reorg from height 8773500 to 8773503 ... on Coinset only.',
    });

    expect(mockSendMail).toHaveBeenCalledOnce();
    const sentSubject = (mockSendMail.mock.calls[0]?.[0] as { subject: string })
      .subject;
    expect(sentSubject).toBe(
      'Re-org of depth 1-4 detected on Chia mainnet — Coinset only'
    );
  });

  it('local-only outcome includes the actual hashes from the local DB when supplied', async () => {
    mockSendMail.mockClear();
    const localSource = {
      source: 'local' as const,
      low: 8773500,
      high: 8773500,
      settle_at: 8773500,
      depth: 1,
      max_depth: 1,
      detected_at_iso: '2026-05-25T02:45:27.985Z',
      old_header_hash: 'd17e2cf5cc3e32a5c3f52ef031139775d9a5db20bf1b26b14ca3826dac54615f',
      new_header_hash: 'a4ec9dc5ddf1dd0b5c894c9989780e6be2bb9e69e418ad037504aa5f15833a41',
    };
    const evt = synthesizeReorgEventFromSource(localSource);
    expect(evt.old_header_hash).toBe(localSource.old_header_hash);
    expect(evt.new_header_hash).toBe(localSource.new_header_hash);

    await sendReorgAlert('alice@example.com', 'mainnet', [evt], 8773500, {
      subjectSuffix: ' — local DB only',
    });
    const body = (mockSendMail.mock.calls[0]?.[0] as { text: string }).text;
    expect(body).toContain('d17e2cf5cc3e32a5c3f52ef031139775d9a5db20bf1b26b14ca3826dac54615f');
    expect(body).toContain('a4ec9dc5ddf1dd0b5c894c9989780e6be2bb9e69e418ad037504aa5f15833a41');
    expect(body).not.toContain('unavailable');
  });

  it('email body for a non-tx block omits the JSON dump and states the block type', async () => {
    mockSendMail.mockClear();
    const localSource = {
      source: 'local' as const,
      low: 100,
      high: 100,
      settle_at: 100,
      depth: 1,
      max_depth: 1,
      detected_at_iso: '2026-05-25T02:45:27.985Z',
      ts_high_unix: null, // non-tx block → timestamp null
      old_header_hash: 'aa',
      new_header_hash: 'bb',
    };
    const evt = synthesizeReorgEventFromSource(localSource);
    await sendReorgAlert('alice@example.com', 'mainnet', [evt], 100, {});
    const body = (mockSendMail.mock.calls[0]?.[0] as { text: string }).text;
    expect(body).toContain('The original block was a non-tx block (no canonical contents available).');
    // No JSON dump for the record.
    expect(body).not.toMatch(/^ {2}\{$/m);
    expect(body).not.toContain('"timestamp"');
  });

  it('email body for a tx block keeps the JSON dump of the record (real record present)', async () => {
    mockSendMail.mockClear();
    const localSource = {
      source: 'local' as const,
      low: 100,
      high: 100,
      settle_at: 100,
      depth: 1,
      max_depth: 1,
      detected_at_iso: '2026-05-25T02:45:27.985Z',
      ts_high_unix: 1_748_097_540,
      old_header_hash: 'aa',
      new_header_hash: 'bb',
      // Real decoded BlockRecord present — render the JSON dump.
      old_block_record: {
        timestamp: 1_748_097_540,
        weight: 12345,
        signage_point_index: 7,
      },
    };
    const evt = synthesizeReorgEventFromSource(localSource);
    await sendReorgAlert('alice@example.com', 'mainnet', [evt], 100, {});
    const body = (mockSendMail.mock.calls[0]?.[0] as { text: string }).text;
    expect(body).toContain('The original block was a tx block with the following contents:');
    expect(body).toContain('"timestamp"');
    expect(body).toContain('1748097540');
    expect(body).toContain('"weight"');
    expect(body).toContain('12345');
    // No unavailable sentinel leaks through.
    expect(body).not.toContain('_unavailable');
    expect(body).not.toContain('foliage_timestamp_unix');
  });

  it('email body for a tx block whose record decode failed reports the failure reason', async () => {
    // When the bash decoder fails, synthesizeReorgEventFromLocal emits an
    // { _unavailable, foliage_timestamp_unix } sentinel and the renderer
    // surfaces the reason rather than fabricating a JSON dump.
    mockSendMail.mockClear();
    const localSource = {
      source: 'local' as const,
      low: 100,
      high: 100,
      settle_at: 100,
      depth: 1,
      max_depth: 1,
      detected_at_iso: '2026-05-25T02:45:27.985Z',
      ts_high_unix: 1_748_097_540, // tx block → foliage timestamp known
      old_header_hash: 'aa',
      new_header_hash: 'bb',
      // No old_block_record — decoder failed upstream.
    };
    const evt = synthesizeReorgEventFromSource(localSource);
    await sendReorgAlert('alice@example.com', 'mainnet', [evt], 100, {});
    const body = (mockSendMail.mock.calls[0]?.[0] as { text: string }).text;
    expect(body).toContain('The original block was a tx block, but its block record could not be decoded:');
    expect(body).toContain('local poller did not provide a block record');
    // No misleading JSON dump anymore.
    expect(body).not.toContain('"timestamp": 1748097540');
    expect(body).not.toContain('The original block was a tx block with the following contents:');
  });

  it('LARGE old_block_record (>= 250 KiB) is dropped with size message; no attachment', async () => {
    mockSendMail.mockClear();
    // Build a payload that JSON.stringify(null, 2)s to >= 256000 bytes.
    // A 200-element array of long-ish strings handily clears the limit.
    const largeArray = Array.from({ length: 5000 }, (_, i) => ({
      idx: i,
      data: 'x'.repeat(60),
    }));
    const localSource = {
      source: 'local' as const,
      low: 100,
      high: 100,
      settle_at: 100,
      depth: 1,
      max_depth: 1,
      detected_at_iso: '2026-05-27T00:00:00Z',
      ts_high_unix: 1700000000, // tx block
      old_block_record: { timestamp: 1700000000, reward_claims_incorporated: largeArray },
    };
    const evt = synthesizeReorgEventFromSource(localSource);
    await sendReorgAlert('alice@example.com', 'mainnet', [evt], 100, {});
    const call = mockSendMail.mock.calls[0]![0] as {
      text: string;
      attachments?: unknown[];
    };
    expect(call.text).toMatch(/Block record not included due to its large size: \d+\.\d+ KiB/);
    expect(call.text).not.toContain('reward_claims_incorporated');
    expect(call.attachments).toBeUndefined();
  });

  it('MEDIUM old_block_record (25 KiB <= size < 250 KiB) is sent as attachment', async () => {
    mockSendMail.mockClear();
    // Build a payload between 25 and 250 KiB. ~500 items of ~80 bytes each.
    const mediumArray = Array.from({ length: 500 }, (_, i) => ({
      idx: i,
      data: 'y'.repeat(60),
    }));
    const localSource = {
      source: 'local' as const,
      low: 200,
      high: 200,
      settle_at: 200,
      depth: 1,
      max_depth: 1,
      detected_at_iso: '2026-05-27T00:00:00Z',
      ts_high_unix: 1700000000,
      old_block_record: { timestamp: 1700000000, items: mediumArray },
    };
    const evt = synthesizeReorgEventFromSource(localSource);
    await sendReorgAlert('alice@example.com', 'mainnet', [evt], 200, {});
    const call = mockSendMail.mock.calls[0]![0] as {
      text: string;
      attachments?: Array<{ filename: string; content: string }>;
    };
    expect(call.text).toContain('block-200-record.json');
    expect(call.text).toMatch(/\d+\.\d+ KiB/);
    expect(call.text).not.toContain('"items"'); // contents NOT inline
    expect(call.attachments).toBeDefined();
    expect(call.attachments).toHaveLength(1);
    expect(call.attachments![0]!.filename).toBe('block-200-record.json');
    // The attachment content should be the JSON we'd otherwise have inlined.
    expect(call.attachments![0]!.content).toContain('"items"');
  });

  it('SMALL old_block_record (< 25 KiB) stays inline; no attachment', async () => {
    mockSendMail.mockClear();
    const localSource = {
      source: 'local' as const,
      low: 300,
      high: 300,
      settle_at: 300,
      depth: 1,
      max_depth: 1,
      detected_at_iso: '2026-05-27T00:00:00Z',
      ts_high_unix: 1700000000,
      old_block_record: {
        timestamp: 1700000000,
        weight: 12345,
        signage_point_index: 49,
      },
    };
    const evt = synthesizeReorgEventFromSource(localSource);
    await sendReorgAlert('alice@example.com', 'mainnet', [evt], 300, {});
    const call = mockSendMail.mock.calls[0]![0] as {
      text: string;
      attachments?: unknown[];
    };
    expect(call.text).toContain('"weight": 12345');
    expect(call.text).toContain('"signage_point_index": 49');
    expect(call.text).toContain('The original block was a tx block with the following contents:');
    expect(call.attachments).toBeUndefined();
  });

  it('multiple reorgs with mixed sizes each get their own attachment / inline / drop treatment', async () => {
    mockSendMail.mockClear();
    const tiny = { timestamp: 1, w: 1 };
    const medium = {
      timestamp: 1,
      items: Array.from({ length: 500 }, (_, i) => ({ i, d: 'z'.repeat(60) })),
    };
    const huge = {
      timestamp: 1,
      bigarr: Array.from({ length: 5000 }, (_, i) => ({ i, d: 'q'.repeat(60) })),
    };
    const sources = [
      { height: 1000, record: tiny },
      { height: 1001, record: medium },
      { height: 1002, record: huge },
    ];
    const events = sources.map((s) =>
      synthesizeReorgEventFromSource({
        source: 'local' as const,
        low: s.height,
        high: s.height,
        settle_at: s.height,
        depth: 1,
        max_depth: 1,
        detected_at_iso: '2026-05-27T00:00:00Z',
        ts_high_unix: 1700000000,
        old_block_record: s.record,
      })
    );
    await sendReorgAlert('alice@example.com', 'mainnet', events, 1002, {});
    const call = mockSendMail.mock.calls[0]![0] as {
      text: string;
      attachments?: Array<{ filename: string; content: string }>;
    };
    // Tiny: inline
    expect(call.text).toContain('"w": 1');
    // Medium: attached, not inline
    expect(call.text).toContain('block-1001-record.json');
    expect(call.text).not.toContain('"items"');
    // Huge: dropped with size message
    expect(call.text).toMatch(/Block record not included due to its large size/);
    expect(call.text).not.toContain('"bigarr"');
    // Exactly one attachment (for the medium one)
    expect(call.attachments).toHaveLength(1);
    expect(call.attachments![0]!.filename).toBe('block-1001-record.json');
  });

  it('local source with full old_block_record propagates it into the email body', async () => {
    mockSendMail.mockClear();
    const fullRecord = {
      header_hash: '0x' + '2d'.repeat(32),
      weight: 54814746912,
      total_iters: 97745094007150,
      signage_point_index: 49,
      timestamp: 1779831225,
      fees: 392389759,
      farmer_puzzle_hash: '0x' + '4b'.repeat(32),
    };
    const localSource = {
      source: 'local' as const,
      low: 8781783,
      high: 8781783,
      settle_at: 8781783,
      depth: 1,
      max_depth: 1,
      detected_at_iso: '2026-05-27T00:00:00Z',
      ts_high_unix: 1779831225,
      old_header_hash: '2d'.repeat(32),
      new_header_hash: '36'.repeat(32),
      old_block_record: fullRecord,
    };
    const evt = synthesizeReorgEventFromSource(localSource);
    expect(evt.old_block_record).toBe(fullRecord);

    await sendReorgAlert('alice@example.com', 'mainnet', [evt], 8781800, {});
    const body = (mockSendMail.mock.calls[0]?.[0] as { text: string }).text;
    // Every key from the rich record should appear in the rendered body.
    expect(body).toContain('"weight": 54814746912');
    expect(body).toContain('"signage_point_index": 49');
    expect(body).toContain('"farmer_puzzle_hash"');
    expect(body).toContain('"fees": 392389759');
    expect(body).toContain('The original block was a tx block with the following contents:');
  });

  it('local source WITHOUT old_block_record produces _unavailable sentinel (not a fake {timestamp})', () => {
    const localSource = {
      source: 'local' as const,
      low: 100,
      high: 100,
      settle_at: 100,
      depth: 1,
      max_depth: 1,
      detected_at_iso: '2026-05-25T00:00:00Z',
      ts_high_unix: 1700000000,
    };
    const evt = synthesizeReorgEventFromSource(localSource);
    // The sentinel makes the failure honest. Foliage timestamp is
    // preserved separately so the renderer can still mark this as a
    // tx block when reporting the failure.
    expect(evt.old_block_record).toEqual({
      _unavailable: 'local poller did not provide a block record',
      foliage_timestamp_unix: 1700000000,
    });
  });

  it('local source with old_block_record_error preserves the reason in the sentinel', () => {
    const localSource = {
      source: 'local' as const,
      low: 100,
      high: 100,
      settle_at: 100,
      depth: 1,
      max_depth: 1,
      detected_at_iso: '2026-05-25T00:00:00Z',
      ts_high_unix: 1700000000,
      old_block_record_error: 'decode-failed: 100:aabb: bad BlockRecord',
    };
    const evt = synthesizeReorgEventFromSource(localSource);
    expect(evt.old_block_record).toEqual({
      _unavailable: 'decode-failed: 100:aabb: bad BlockRecord',
      foliage_timestamp_unix: 1700000000,
    });
  });

  it('local source with null hashes falls back to "(unavailable — local DB detection)"', () => {
    const localSource = {
      source: 'local' as const,
      low: 100,
      high: 100,
      settle_at: 100,
      depth: 1,
      max_depth: 1,
      detected_at_iso: '2026-05-25T02:45:27.985Z',
      old_header_hash: null,
      new_header_hash: null,
    };
    const evt = synthesizeReorgEventFromSource(localSource);
    expect(evt.old_header_hash).toBe('(unavailable — local DB detection)');
    expect(evt.new_header_hash).toBe('(unavailable — local DB detection)');
  });

  it('local-only outcome shows exact local depth (no Coinset range to merge)', async () => {
    mockSendMail.mockClear();

    const localSource = {
      source: 'local' as const,
      low: 100,
      high: 102,
      settle_at: 102,
      depth: 3,
      max_depth: 3,
      detected_at_iso: '2026-05-25T02:45:27.985Z',
    };
    const evt = synthesizeReorgEventFromSource(localSource);

    await sendReorgAlert('alice@example.com', 'mainnet', [evt], 104, {
      subjectSuffix: ' — local DB only',
      introPrepend: 'A reorg from height 100 to 102 ... in the local database only.',
    });

    const sentSubject = (mockSendMail.mock.calls[0]?.[0] as { subject: string })
      .subject;
    expect(sentSubject).toBe(
      'Re-org of depth 3 detected on Chia mainnet — local DB only'
    );
  });
});
