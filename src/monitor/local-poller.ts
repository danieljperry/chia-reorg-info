// Local-DB poller: periodically invokes scripts/reorg-finder.sh with
// `--json --peak-from db`, parses the JSON output, and reports any
// previously-unseen reorg clusters via an `onReorg` hook.
//
// Same lifecycle shape as the Coinset poller in src/monitor/reorg-monitor.ts —
// startLocalPoller() launches the loop, stopLocalPoller() cancels it via a
// generation counter so an in-flight spawn can bail before invoking the hook.

import { spawn } from 'node:child_process';
import { log } from '../util/logger.js';
import { safeMessage } from '../util/safe-message.js';

export type LocalReorg = {
  low: number;
  high: number;
  depth: number;
  ts_low_unix: number | null;
  ts_high_unix: number | null;
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
    reorgs.push({
      low: e.low,
      high: e.high,
      depth: e.depth,
      ts_low_unix: e.ts_low_unix,
      ts_high_unix: e.ts_high_unix,
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

  if (opts.on_peak) opts.on_peak(parsed.peak_at_scan);

  for (const reorg of parsed.reorgs) {
    const key = `${reorg.low}:${reorg.high}`;
    if (localState.seen.has(key)) continue;
    localState.seen.add(key);
    opts.on_reorg({
      ...reorg,
      detected_at_iso: new Date().toISOString(),
    });
  }
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
