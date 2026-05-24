import { readFile } from 'node:fs/promises';
import nodemailer from 'nodemailer';
import { log, logBlock } from '../util/logger.js';
import { safeMessage } from '../util/safe-message.js';
import type { ReorgEvent } from './reorg-monitor.js';

function parsePort(): number {
  const raw = process.env.SMTP_PORT;
  if (raw === undefined || raw === '') return 587;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid SMTP_PORT: "${raw}" (expected an integer 1-65535)`);
  }
  return n;
}

function presence(name: string): string {
  const v = process.env[name];
  return v !== undefined && v !== '' ? '<set>' : '<unset>';
}

function literal(name: string, fallback = '<unset>'): string {
  const v = process.env[name];
  return v !== undefined && v !== '' ? v : fallback;
}

/**
 * Log the current SMTP-related environment (presence only for credentials) so
 * misconfiguration surfaces at startup rather than on the first re-org. Called
 * by the CLI when recipients are configured.
 */
export function logSmtpConfig(): void {
  log('info', 'SMTP configuration', {
    SMTP_HOST: literal('SMTP_HOST'),
    SMTP_PORT: literal('SMTP_PORT', '<unset (default 587)>'),
    SMTP_SECURE: literal('SMTP_SECURE', '<unset (default false)>'),
    SMTP_USER: presence('SMTP_USER'),
    SMTP_PASS: presence('SMTP_PASS'),
    SMTP_FROM: literal('SMTP_FROM'),
    SMTP_CA_CERT_PATH: literal('SMTP_CA_CERT_PATH'),
  });
  if (process.env.SMTP_HOST === undefined || process.env.SMTP_HOST === '') {
    log(
      'warn',
      'SMTP_HOST is not set — email alerts will fail (nodemailer falls back to localhost)'
    );
  }
}

export async function sendReorgAlert(
  to: string,
  network: string,
  reorgs: ReorgEvent[],
  peakHeight: number
): Promise<void> {
  const caPath = process.env.SMTP_CA_CERT_PATH;
  const ca = caPath ? await readFile(caPath, 'utf8') : undefined;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parsePort(),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
    tls: ca ? { ca } : undefined,
  });

  // Descending by height: closest to peak first.
  const sorted = [...reorgs].sort((a, b) => b.height - a.height);

  // Count distinct clusters: a gap in consecutive heights starts a new cluster.
  let clusterCount = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0 || sorted[i]!.height !== sorted[i - 1]!.height - 1) clusterCount++;
  }
  const lowerBound = sorted.reduce((m, r) => Math.max(m, r.depth), 0);
  const upperBound = sorted.reduce((m, r) => Math.max(m, r.max_depth), 0);
  const fmt = (lo: number, hi: number) => (lo === hi ? `${lo}` : `${lo}-${hi}`);
  const depthLabel = fmt(lowerBound, upperBound);
  const uncertainNote =
    lowerBound === upperBound
      ? ''
      : ` (range due to ${upperBound - lowerBound} unobserved block(s) above the cascade)`;

  const subject =
    clusterCount === 1
      ? `Re-org of depth ${depthLabel} detected on Chia ${network}`
      : `${clusterCount} re-orgs detected on Chia ${network} (max depth ${depthLabel})`;

  const intro =
    clusterCount === 1
      ? `A re-org of depth ${depthLabel} was detected on the Chia ${network} blockchain${uncertainNote}.`
      : `${clusterCount} re-orgs were detected on the Chia ${network} blockchain (max depth ${depthLabel})${uncertainNote}.`;

  const blockSections = sorted
    .map((reorg, i) => {
      const recordJson = JSON.stringify(reorg.old_block_record, null, 2)
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n');
      const depthLine =
        reorg.depth === reorg.max_depth
          ? `  Depth:        ${reorg.depth} block(s) (size of the re-org cascade)`
          : `  Depth:        ${reorg.depth}-${reorg.max_depth} block(s) (observed cascade is ${reorg.depth}; up to ${reorg.max_depth - reorg.depth} more block(s) above were never compared)`;
      return [
        `Block ${i + 1}:`,
        ``,
        `  Height:       ${reorg.height}`,
        `  Old hash:     ${reorg.old_header_hash}`,
        `  New hash:     ${reorg.new_header_hash}`,
        depthLine,
        `  Behind peak:  ${reorg.blocks_from_peak} block(s) from current peak (how long ago)`,
        `  Detected:     ${reorg.detected_at}`,
        ``,
        `  The original block was a ${(reorg.old_block_record as { timestamp?: unknown }).timestamp != null ? 'tx' : 'non-tx'} block with the following contents:`,
        recordJson,
        ``,
        `  See https://spacescan.io/block/${reorg.height} for the canonical block contents.`,
      ].join('\n');
    })
    .join('\n\n');

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const localDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const localTime = now.toLocaleTimeString();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const peakLine = `Peak height at detection: ${peakHeight.toLocaleString()} (${localDate} ${localTime} ${timeZone})`;
  const text = [intro, peakLine, ``, blockSections].join('\n');

  const from = process.env.SMTP_FROM ?? process.env.SMTP_USER ?? 'chia-explorer@localhost';

  logBlock('info', 'Sending re-org alert email', text, {
    to,
    from,
    subject,
    network,
    cluster_count: clusterCount,
    depth_range: depthLabel,
    peak_height: peakHeight,
    reorg_heights: sorted.map((r) => r.height),
  });

  try {
    await transporter.sendMail({ from, to, subject, text });
    log('info', 'Re-org alert email sent', { to, subject });
  } catch (err) {
    log('error', 'Re-org alert email failed', { to, subject, error: safeMessage(err) });
    throw err;
  }
}
