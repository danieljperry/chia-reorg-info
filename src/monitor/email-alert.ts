import { readFile } from 'node:fs/promises';
import nodemailer from 'nodemailer';
import { log, logBlock } from '../util/logger.js';
import { safeMessage } from '../util/safe-message.js';
import type { BridgeInfo } from './bridge-info.js';
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

export type EmailExtras = {
  /** Appended to the subject line, e.g. " — confirmed by Coinset + local DB". */
  subjectSuffix?: string;
  /** Prepended to the body (before the existing intro). Used by dual-source
   *  mode to insert the "same reorg / Coinset only / local only" sentence. */
  introPrepend?: string;
  /** Pre-rendered Bridge Info section to append to the body when the batch
   *  contained bridge spends. The same instance is shared across all
   *  recipients of one batch — the dispatcher computes it once and passes
   *  it to every `sendReorgAlert` call. */
  bridgeInfo?: BridgeInfo;
};

export async function sendReorgAlert(
  to: string,
  network: string,
  reorgs: ReorgEvent[],
  peakHeight: number,
  extras: EmailExtras = {}
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

  const baseSubject =
    clusterCount === 1
      ? `Re-org of depth ${depthLabel} detected on Chia ${network}`
      : `${clusterCount} re-orgs detected on Chia ${network} (max depth ${depthLabel})`;
  const subject = baseSubject + (extras.subjectSuffix ?? '');

  const intro =
    clusterCount === 1
      ? `A re-org of depth ${depthLabel} was detected on the Chia ${network} blockchain${uncertainNote}.`
      : `${clusterCount} re-orgs were detected on the Chia ${network} blockchain (max depth ${depthLabel})${uncertainNote}.`;

  // Size tiers for the per-block JSON dump. Coarse buckets, KiB-based.
  // Below INLINE_LIMIT: paste contents directly into the body (status quo).
  // Below ATTACHMENT_LIMIT: attach as block-<height>-record.json and reference
  //   it from the body, so the user can open it if they want detail but the
  //   email body stays compact.
  // Above ATTACHMENT_LIMIT: drop the contents entirely; body shows just the
  //   size. Defends recipients from "denial-of-inbox" via outsized BlockRecord
  //   payloads (e.g. a malicious chain producing huge reward_claims arrays).
  const INLINE_LIMIT_BYTES = 25 * 1024;
  const ATTACHMENT_LIMIT_BYTES = 250 * 1024;
  // Bridge Info has its own independent size tier (same 25 KiB / 250 KiB
  // thresholds applied to the formatted text, not combined with the
  // block-record budget). A re-org with both a large block record AND
  // large bridge info could therefore produce two attachments.
  const BRIDGE_INFO_INLINE_LIMIT_BYTES = 25 * 1024;
  const BRIDGE_INFO_ATTACHMENT_LIMIT_BYTES = 250 * 1024;
  const attachments: Array<{ filename: string; content: string }> = [];

  const blockSections = sorted
    .map((reorg, i) => {
      const unavailableReason = recordUnavailableReason(reorg.old_block_record);
      const foliageTs = unavailableReason !== null
        ? (reorg.old_block_record as { foliage_timestamp_unix?: unknown }).foliage_timestamp_unix
        : null;
      const isTxBlock =
        unavailableReason !== null
          ? foliageTs != null
          : (reorg.old_block_record as { timestamp?: unknown }).timestamp != null;
      const depthLine =
        reorg.depth === reorg.max_depth
          ? `  Depth:        ${reorg.depth} block(s) (size of the re-org cascade)`
          : `  Depth:        ${reorg.depth}-${reorg.max_depth} block(s) (observed cascade is ${reorg.depth}; up to ${reorg.max_depth - reorg.depth} more block(s) above were never compared)`;
      // Four paths for the "original block contents" section:
      //   1. Unavailable sentinel + foliage timestamp known — we expected
      //      a record (was a tx block) but couldn't decode; report the
      //      reason explicitly. Don't dump the sentinel JSON — it'd
      //      just confuse the reader.
      //   2. Unavailable sentinel + no foliage timestamp — genuinely
      //      non-tx; nothing was expected. Use the original "non-tx"
      //      wording, not "unavailable" (which implies we wanted data
      //      and didn't get it).
      //   3. Tx block with a decoded record — render via buildTxBlockSection.
      //   4. Non-tx block (no sentinel, no record timestamp) — single
      //      line, nothing to dump.
      const origBlockSection =
        unavailableReason !== null
          ? isTxBlock
            ? buildUnavailableSection(unavailableReason)
            : [`  The original block was a non-tx block (no canonical contents available).`]
          : isTxBlock
          ? buildTxBlockSection(reorg, attachments, INLINE_LIMIT_BYTES, ATTACHMENT_LIMIT_BYTES)
          : [`  The original block was a non-tx block (no canonical contents available).`];
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
        ...origBlockSection,
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
  const parts: string[] = extras.introPrepend
    ? [extras.introPrepend, ``, intro, peakLine, ``, blockSections]
    : [intro, peakLine, ``, blockSections];

  if (extras.bridgeInfo !== undefined) {
    parts.push(
      ``,
      ...buildBridgeInfoSection(
        extras.bridgeInfo,
        attachments,
        BRIDGE_INFO_INLINE_LIMIT_BYTES,
        BRIDGE_INFO_ATTACHMENT_LIMIT_BYTES
      )
    );
  }

  const text = parts.join('\n');

  const from = process.env.SMTP_FROM ?? process.env.SMTP_USER ?? 'chia-reorg-info@localhost';

  logBlock('info', 'Sending re-org alert email', text, {
    to,
    from,
    subject,
    network,
    cluster_count: clusterCount,
    depth_range: depthLabel,
    peak_height: peakHeight,
    reorg_heights: sorted.map((r) => r.height),
    attachment_count: attachments.length,
    attachment_names: attachments.map((a) => a.filename),
  });

  try {
    await transporter.sendMail({
      from,
      to,
      subject,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    log('info', 'Re-org alert email sent', { to, subject });
  } catch (err) {
    log('error', 'Re-org alert email failed', { to, subject, error: safeMessage(err) });
    throw err;
  }
}

/**
 * If `record` is the `{ _unavailable: string, ... }` sentinel produced by
 * `synthesizeReorgEventFromLocal` when the bash decoder failed, return the
 * reason string. Otherwise null. Keeps the check structural so renaming
 * the sentinel key here propagates cleanly without scattered any-casts.
 */
function recordUnavailableReason(record: unknown): string | null {
  if (typeof record !== 'object' || record === null) return null;
  if (!('_unavailable' in record)) return null;
  const u = (record as { _unavailable?: unknown })._unavailable;
  if (typeof u !== 'string' || u.length === 0) return 'unavailable';
  return u;
}

function buildUnavailableSection(reason: string): string[] {
  // Reason may contain colons / spaces (e.g. "decode-failed: H:HH: ChildProcessError")
  // — indent it as a continuation line so the block stays scannable.
  return [
    `  The original block was a tx block, but its block record could not be decoded:`,
    `    ${reason}`,
  ];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}

/**
 * Build the per-reorg "original block contents" section for tx blocks,
 * picking among three size-tiered presentations:
 *   1. Below `inlineLimit`: paste the indented JSON inline (status quo).
 *   2. Between `inlineLimit` and `attachmentLimit`: push an attachment
 *      onto `attachments` and reference it from the body.
 *   3. At or above `attachmentLimit`: omit the contents; body just notes
 *      that the record was dropped and reports its size.
 *
 * Sizing uses UTF-8 byte count via Buffer.byteLength — the actual mail
 * transfer encoding is UTF-8, so JS-string `.length` would underreport
 * for any multi-byte characters in the BlockRecord.
 */
function buildTxBlockSection(
  reorg: ReorgEvent,
  attachments: Array<{ filename: string; content: string }>,
  inlineLimit: number,
  attachmentLimit: number
): string[] {
  const jsonStr = JSON.stringify(reorg.old_block_record, null, 2);
  const sizeBytes = Buffer.byteLength(jsonStr, 'utf8');

  if (sizeBytes < inlineLimit) {
    return [
      `  The original block was a tx block with the following contents:`,
      jsonStr
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n'),
    ];
  }

  if (sizeBytes < attachmentLimit) {
    const filename = `block-${reorg.height}-record.json`;
    attachments.push({ filename, content: jsonStr });
    return [
      `  The original block was a tx block. Its contents are attached as`,
      `  ${filename} (${formatSize(sizeBytes)}).`,
    ];
  }

  return [
    `  The original block was a tx block.`,
    `  Block record not included due to its large size: ${formatSize(sizeBytes)}.`,
  ];
}

/**
 * Build the trailing "Bridge Info" section when the batch contained bridge
 * spends. Same three-tier size handling as `buildTxBlockSection`:
 *   1. Below `inlineLimit`: paste the formatter's output inline (status quo
 *      for `reorg-finder.sh -b`).
 *   2. Between `inlineLimit` and `attachmentLimit`: attach as
 *      `bridge-info-<low>-<high>.txt` and reference it from the body.
 *   3. At or above `attachmentLimit`: omit and just report the size.
 *
 * The header ("Bridge Info:") and the user-spec'd leading statement
 * ("This reorg included bridge spends with the following details:")
 * appear in all three tiers — even when the body is omitted, the reader
 * knows what was checked and why a Bridge Info entry exists at all.
 */
function buildBridgeInfoSection(
  info: BridgeInfo,
  attachments: Array<{ filename: string; content: string }>,
  inlineLimit: number,
  attachmentLimit: number
): string[] {
  const sizeBytes = Buffer.byteLength(info.formattedText, 'utf8');
  const header = [
    `Bridge Info:`,
    ``,
    `  This reorg included bridge spends with the following details:`,
    ``,
  ];

  if (sizeBytes < inlineLimit) {
    // The formatter already indents its output with two spaces, matching
    // the body's indentation style. Trim a trailing newline if present
    // so the section doesn't sprout a blank line at the end.
    const trimmed = info.formattedText.replace(/\n+$/, '');
    return [...header, trimmed];
  }

  if (sizeBytes < attachmentLimit) {
    const filename = `bridge-info-${info.lowHeight}-${info.highHeight}.txt`;
    attachments.push({ filename, content: info.formattedText });
    return [
      ...header,
      `  Bridge info attached as ${filename} (${formatSize(sizeBytes)}).`,
    ];
  }

  return [
    ...header,
    `  Bridge info not included due to its large size: ${formatSize(sizeBytes)}.`,
  ];
}
