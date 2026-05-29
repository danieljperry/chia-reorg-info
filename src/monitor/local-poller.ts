// Local-DB poller: periodically invokes scripts/reorg-finder.sh with
// `--json --peak-from db`, parses the JSON output, and reports any
// previously-unseen reorg clusters via an `onReorg` hook.
//
// Same lifecycle shape as the Coinset poller in src/monitor/reorg-monitor.ts —
// startLocalPoller() launches the loop, stopLocalPoller() cancels it via a
// generation counter so an in-flight spawn can bail before invoking the hook.

import { spawn } from 'node:child_process';
import { isHex32 } from '../chia/hex.js';
import { log } from '../util/logger.js';
import { safeMessage } from '../util/safe-message.js';

export type LocalReorg = {
  low: number;
  high: number;
  depth: number;
  ts_low_unix: number | null;
  ts_high_unix: number | null;
  /** Orphaned block's header_hash at `high`, lowercase hex without 0x.
   *  Null if the JSON omits the field (older script) or the query failed. */
  old_hash: string | null;
  /** Canonical block's header_hash at `high`, same encoding. */
  new_hash: string | null;
  /** Decoded BlockRecord of the orphan at `high` (the same shape that
   *  coinset.org's get_block_record_by_height returns: weight, total_iters,
   *  signage_point_index, VDF outputs, reward claims, etc.). Null if the
   *  JSON omits the field (older script), the chia python helper failed,
   *  or the row went missing mid-scan. */
  old_block_record: Record<string, unknown> | null;
  /** Diagnostic string explaining why `old_block_record` is null. Set by
   *  the bash script when its block-record helper fails (chia python
   *  missing, BlockRecord.from_bytes blew up, row missing mid-scan, etc.).
   *  Surfaced into the alert email body so the recipient sees the actual
   *  failure cause instead of a misleadingly minimal `{ timestamp }` dump.
   *  Null when `old_block_record` was successfully decoded OR when the
   *  field was omitted entirely (older script versions). */
  old_block_record_error: string | null;
};

export type LocalScanResult = {
  network: string;
  start_height: number;
  end_height: number;
  scanned_at_unix: number;
  peak_at_scan: number;
  reorgs: LocalReorg[];
};

export type LocalPollerOpts = {
  script_path: string;
  db_path: string;
  poll_interval_seconds: number;
  lookback_blocks: number;
  on_reorg: (evt: LocalReorg & { detected_at_iso: string }) => void;
  on_peak?: (peak: number) => void;
};

type State = {
  active: boolean;
  poll_count: number;
  last_poll_at: string | null;
  last_error: string | null;
  peak_at_last_scan: number | null;
  seen: Set<string>; // dedup keys of the form "low:high"
  timer: NodeJS.Timeout | null;
  generation: number;
};

const localState: State = {
  active: false,
  poll_count: 0,
  last_poll_at: null,
  last_error: null,
  peak_at_last_scan: null,
  seen: new Set(),
  timer: null,
  generation: 0,
};

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/**
 * Tighter validation of the decoded BlockRecord embedded in
 * `LocalReorg.old_block_record`. The validator at the LocalScanResult level
 * only checks that the field is an object — but the BlockRecord then flows
 * verbatim into the email body via JSON.stringify, and a tampered DB could
 * produce values that, while safely encoded by JSON.stringify, would still
 * mislead the recipient (e.g. negative weights, control chars in strings,
 * non-finite numbers).
 *
 * Strategy: validate the well-known fields when present; accept additional
 * fields as-is for forward-compatibility with chia version changes. If any
 * known field has the wrong type, reject the whole BlockRecord.
 *
 * The hash-format check (isHex32) is intentionally NOT applied here because
 * BlockRecord stores hashes with `0x` prefix (BlockRecord.to_json_dict()
 * convention) — a separate check at line level is sufficient.
 */
function isFiniteNonNegInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && Number.isFinite(v) && v >= 0;
}
function isPrintableString(v: unknown): boolean {
  // Rejects all C0 control chars (0x00-0x1f) and DEL (0x7f). For
  // BlockRecord hash and puzzle-hash fields, none of these should ever
  // appear. Includes \t, \n, \r — defense in depth against email-header
  // injection vectors even though JSON.stringify would also escape them.
  // eslint-disable-next-line no-control-regex
  return typeof v === 'string' && !/[\x00-\x1f\x7f]/.test(v);
}
export function validateBlockRecordShape(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  // Numeric fields — when present, must be finite non-negative integers.
  // Some fields may be null (e.g. timestamp on non-tx blocks).
  const numericFields = [
    'height',
    'weight',
    'total_iters',
    'signage_point_index',
    'required_iters',
    'deficit',
    'sub_slot_iters',
  ] as const;
  for (const f of numericFields) {
    if (f in r && r[f] !== null && !isFiniteNonNegInt(r[f])) return false;
  }
  // Nullable numeric fields.
  const nullableNumericFields = [
    'timestamp',
    'fees',
    'prev_transaction_block_height',
  ] as const;
  for (const f of nullableNumericFields) {
    if (f in r && r[f] !== null && !isFiniteNonNegInt(r[f])) return false;
  }
  // Boolean fields.
  if ('overflow' in r && r.overflow !== null && typeof r.overflow !== 'boolean') {
    return false;
  }
  // String fields (hashes, addresses) — reject control characters that
  // could mislead a recipient if rendered in the body. JSON.stringify
  // would escape them, but the defense-in-depth check is cheap.
  const stringFields = [
    'header_hash',
    'prev_hash',
    'challenge_block_info_hash',
    'reward_infusion_new_challenge',
    'prev_transaction_block_hash',
    'farmer_puzzle_hash',
    'pool_puzzle_hash',
  ] as const;
  for (const f of stringFields) {
    if (f in r && r[f] !== null && !isPrintableString(r[f])) return false;
  }
  return true;
}

/**
 * Validate the bash script's JSON output against the LocalScanResult shape.
 * Returns the typed value on success, null on any shape mismatch.
 *
 * We don't trust the script's output blindly because (a) the script itself
 * pulls block timestamps from RPCs that aren't fully trusted (see the
 * timestamp-validation comment in scripts/reorg-finder.sh) and (b) defending
 * against type confusion here is cheap and means downstream consumers
 * (dual-source, dispatch) can rely on the types.
 */
export function validateLocalScanResult(raw: unknown): LocalScanResult | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.network !== 'string') return null;
  if (!isNonNegInt(r.start_height)) return null;
  if (!isNonNegInt(r.end_height)) return null;
  if (!isNonNegInt(r.scanned_at_unix)) return null;
  if (!isNonNegInt(r.peak_at_scan)) return null;
  if (!Array.isArray(r.reorgs)) return null;
  const reorgs: LocalReorg[] = [];
  for (const item of r.reorgs) {
    if (typeof item !== 'object' || item === null) return null;
    const e = item as Record<string, unknown>;
    if (!isNonNegInt(e.low)) return null;
    if (!isNonNegInt(e.high)) return null;
    if (!isNonNegInt(e.depth)) return null;
    if (e.ts_low_unix !== null && !isNonNegInt(e.ts_low_unix)) return null;
    if (e.ts_high_unix !== null && !isNonNegInt(e.ts_high_unix)) return null;
    // Hash fields are optional (older scripts don't emit them). When present
    // they must be either null or a valid 64-char SHA-256 hex string.
    // Stricter than just `typeof string` because these values flow verbatim
    // into the email body — defense in depth against a tampered DB or
    // script returning attacker-influenced strings (newlines, control chars,
    // etc.) that could mislead the recipient.
    const old_hash = e.old_hash === undefined ? null : e.old_hash;
    const new_hash = e.new_hash === undefined ? null : e.new_hash;
    if (old_hash !== null && (typeof old_hash !== 'string' || !isHex32(old_hash))) return null;
    if (new_hash !== null && (typeof new_hash !== 'string' || !isHex32(new_hash))) return null;
    // old_block_record is optional. When present it must be a plain object
    // (the decoded BlockRecord.to_json_dict() from the chia python helper)
    // or null. We deep-check the well-known BlockRecord fields via
    // validateBlockRecordShape (defense in depth against a tampered DB
    // producing junk that would otherwise render into the email body).
    const obr_raw = e.old_block_record === undefined ? null : e.old_block_record;
    let old_block_record: Record<string, unknown> | null = null;
    if (obr_raw !== null) {
      if (!validateBlockRecordShape(obr_raw)) return null;
      old_block_record = obr_raw as Record<string, unknown>;
    }
    // Optional diagnostic. Must be either null or a reasonably-sized
    // string. We don't trust this to be safe HTML/markdown — the email
    // renderer flows it into a plain-text body line. Cap at 512 chars
    // to keep email bodies bounded; truncate quietly rather than reject
    // (the field is best-effort anyway).
    const obr_err_raw =
      e.old_block_record_error === undefined ? null : e.old_block_record_error;
    let old_block_record_error: string | null = null;
    if (obr_err_raw !== null) {
      if (typeof obr_err_raw !== 'string') return null;
      old_block_record_error = obr_err_raw.slice(0, 512);
    }
    reorgs.push({
      low: e.low,
      high: e.high,
      depth: e.depth,
      ts_low_unix: e.ts_low_unix,
      ts_high_unix: e.ts_high_unix,
      old_hash,
      new_hash,
      old_block_record,
      old_block_record_error,
    });
  }
  return {
    network: r.network,
    start_height: r.start_height,
    end_height: r.end_height,
    scanned_at_unix: r.scanned_at_unix,
    peak_at_scan: r.peak_at_scan,
    reorgs,
  };
}

/** Run the script once. Exported for testability; the loop calls it directly. */
export async function _pollLocalOnce(opts: LocalPollerOpts): Promise<void> {
  const generation = localState.generation;
  const args = [
    opts.script_path,
    '-d',
    opts.db_path,
    '-n',
    String(opts.lookback_blocks),
    '--peak-from',
    'db',
    '--json',
  ];

  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('bash', args);
      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      proc.on('error', (err) => reject(err));
      proc.on('close', (code) => {
        exitCode = code;
        resolve();
      });
    });
  } catch (err) {
    if (generation !== localState.generation) return;
    localState.last_error = `local poll spawn failed: ${safeMessage(err)}`;
    log('error', 'Local poll failed', { error: localState.last_error });
    return;
  }
  if (generation !== localState.generation) return;

  if (exitCode !== 0) {
    localState.last_error = `local poll exited ${exitCode}: ${stderr.trim() || '(no stderr)'}`;
    log('error', 'Local poll failed', { exit_code: exitCode, stderr: stderr.trim() });
    return;
  }

  let parsed: LocalScanResult;
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const raw = JSON.parse(stdout);
    const validated = validateLocalScanResult(raw);
    if (validated === null) {
      localState.last_error = `local poll output failed schema validation`;
      log('error', 'Local poll output failed schema validation', {
        stdout_head: stdout.slice(0, 200),
      });
      return;
    }
    parsed = validated;
  } catch (err) {
    localState.last_error = `local poll output unparseable: ${safeMessage(err)}`;
    log('error', 'Local poll output unparseable', {
      error: safeMessage(err),
      stdout_head: stdout.slice(0, 200),
    });
    return;
  }

  localState.poll_count++;
  localState.last_poll_at = new Date().toISOString();
  localState.last_error = null;
  localState.peak_at_last_scan = parsed.peak_at_scan;

  // ORDER MATTERS: emit new reorgs BEFORE the peak update.
  // The dual-source coordinator releases buffered events on peak updates,
  // so if on_peak fires first, a peak advance that releases a buffered
  // Coinset counterpart would dispatch it as single-source-only before
  // this poll's new local event is added to the buffer.
  for (const reorg of parsed.reorgs) {
    const key = `${reorg.low}:${reorg.high}`;
    if (localState.seen.has(key)) continue;
    localState.seen.add(key);
    opts.on_reorg({
      ...reorg,
      detected_at_iso: new Date().toISOString(),
    });
  }

  if (opts.on_peak) opts.on_peak(parsed.peak_at_scan);
}

function scheduleNextLocal(opts: LocalPollerOpts): void {
  localState.timer = setTimeout(() => {
    void _pollLocalOnce(opts).finally(() => {
      if (localState.active) scheduleNextLocal(opts);
    });
  }, opts.poll_interval_seconds * 1000);
  localState.timer.unref();
}

export function startLocalPoller(opts: LocalPollerOpts): void {
  localState.generation++;
  if (localState.timer !== null) clearTimeout(localState.timer);
  localState.active = true;
  localState.poll_count = 0;
  localState.last_poll_at = null;
  localState.last_error = null;
  localState.peak_at_last_scan = null;
  localState.seen = new Set();

  log('info', 'Local poller started', {
    db_path: opts.db_path,
    poll_interval_seconds: opts.poll_interval_seconds,
    lookback_blocks: opts.lookback_blocks,
  });

  void _pollLocalOnce(opts).finally(() => {
    if (localState.active) scheduleNextLocal(opts);
  });
}

export function stopLocalPoller(): void {
  const wasActive = localState.active;
  localState.generation++;
  if (localState.timer !== null) {
    clearTimeout(localState.timer);
    localState.timer = null;
  }
  localState.active = false;
  if (wasActive) {
    log('info', 'Local poller stopped', {
      poll_count: localState.poll_count,
    });
  }
}

/** Test-only: reset internal state between tests. */
export function _resetLocalStateForTests(): void {
  localState.active = false;
  localState.poll_count = 0;
  localState.last_poll_at = null;
  localState.last_error = null;
  localState.peak_at_last_scan = null;
  localState.seen.clear();
  localState.timer = null;
  localState.generation = 0;
}

export function getLocalStatus() {
  return {
    active: localState.active,
    poll_count: localState.poll_count,
    last_poll_at: localState.last_poll_at,
    last_error: localState.last_error,
    peak_at_last_scan: localState.peak_at_last_scan,
    seen_count: localState.seen.size,
  };
}
