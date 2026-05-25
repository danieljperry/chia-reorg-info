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

  it('local-only outcome shows exact local depth (no Coinset range to merge)', async () => {
    mockSendMail.mockClear();

    const localSource = {
      source: 'local' as const,
      low: 100,
      high: 102,
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
