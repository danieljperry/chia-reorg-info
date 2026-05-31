import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, logBlock } from '../util/logger.js';
import { safeMessage } from '../util/safe-message.js';
import { resolveChiaPython } from '../util/chia-python.js';
import type { ReorgEvent } from './reorg-monitor.js';

// Default puzzle hash to search for in orphan blocks: the Warp.green
// outbound bridge message coin (bridging_puzzle.clsp, tree-hashed). Same
// default as BRIDGE_HASHES in scripts/reorg-finder.sh:155-157 — keep
// these in sync.
export const BRIDGING_PUZZLE_HASH =
  'a09eb1ea8c6e83c0166801dabcf4a70d361cc7f6d89c4a46bcd400ac57719037';

const SCRIPTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts'
);
const DEFAULT_HELPER_PATH = join(SCRIPTS_DIR, '_decode_bridge_spends.py');
const DEFAULT_FORMATTER_PATH = join(SCRIPTS_DIR, '_format_bridge_info.py');

/** The shape passed into emails as `EmailExtras.bridgeInfo`. */
export type BridgeInfo = {
  /** Pre-rendered text from _format_bridge_info.py — drop-in for the email body. */
  formattedText: string;
  /** Total matched-spend count across all blocks (for logging / future use). */
  spendCount: number;
  /** Total re-orged blocks with at least one match. */
  matchedBlockCount: number;
  /** Range of orphan heights actually searched — used to name the attachment. */
  lowHeight: number;
  highHeight: number;
};

type SearchOptions = {
  dbPath: string;
  /** Hex puzzle hashes (no `0x` prefix). Defaults to [BRIDGING_PUZZLE_HASH]. */
  bridgeTargets?: string[];
  /** Orphan blocks to scan, one per re-orged height. */
  orphans: { height: number; header_hash: string }[];
  /** Path to _decode_bridge_spends.py; defaults to the bundled scripts dir. */
  helperPath?: string;
  /** Path to _format_bridge_info.py; defaults to the bundled scripts dir. */
  formatterPath?: string;
  /** Chia-importable python interpreter; defaults to resolveChiaPython(). */
  chiaPython?: string;
};

type SearchOutcome =
  | { kind: 'matches'; info: BridgeInfo }
  | { kind: 'no-matches'; blocksSearched: number }
  | { kind: 'skipped'; reason: string }
  | { kind: 'error'; error: string };

/**
 * Spawn `_decode_bridge_spends.py` against the supplied orphan blocks, and
 * if it returns any matches, render them via `_format_bridge_info.py
 * detailed`. Mirrors how scripts/reorg-finder.sh invokes the helpers under
 * `-b/--bridge`.
 *
 * Skipped (not an error): no orphans, unreadable DB, missing chia python.
 * Error: helper exits non-zero, JSON unparseable, formatter fails.
 */
export async function searchBridges(opts: SearchOptions): Promise<SearchOutcome> {
  if (opts.orphans.length === 0) {
    return { kind: 'no-matches', blocksSearched: 0 };
  }
  try {
    accessSync(opts.dbPath, constants.R_OK);
  } catch {
    return { kind: 'skipped', reason: `DB not readable: ${opts.dbPath}` };
  }

  const chiaPython = opts.chiaPython ?? resolveChiaPython();
  const helper = opts.helperPath ?? DEFAULT_HELPER_PATH;
  const formatter = opts.formatterPath ?? DEFAULT_FORMATTER_PATH;
  // Gate target hashes through the same 64-char-hex filter as the orphan
  // header hashes before they reach the subprocess argv. The default is
  // already canonical, but a caller-supplied bridgeTargets list is not
  // trusted: strip any 0x prefix and drop anything that isn't a clean
  // 32-byte hex hash. If nothing valid survives, skip rather than hand the
  // helper an empty/garbage target list.
  const validTargets = (opts.bridgeTargets ?? [BRIDGING_PUZZLE_HASH])
    .map(stripHexPrefix)
    .filter(isValidHash);
  if (validTargets.length === 0) {
    return { kind: 'skipped', reason: 'no valid bridge target hashes supplied' };
  }
  const targets = validTargets.join(',');
  const stdin = opts.orphans
    .map((o) => `${o.height}\t${o.header_hash}`)
    .join('\n');

  // Step 1: decode.
  const decode = await spawnCapture(chiaPython, [helper, opts.dbPath, targets], stdin);
  if (decode.kind === 'spawn-error') {
    return { kind: 'skipped', reason: `chia python not runnable: ${decode.message}` };
  }
  if (decode.kind === 'exit' && decode.code !== 0) {
    return {
      kind: 'error',
      error: `decode helper exited ${decode.code}: ${decode.stderr.trim() || '(no stderr)'}`,
    };
  }
  let parsed: { matches?: unknown };
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    parsed = JSON.parse(decode.stdout);
  } catch (err) {
    return {
      kind: 'error',
      error: `decode helper output unparseable: ${safeMessage(err)}; head=${decode.stdout.slice(0, 200)}`,
    };
  }
  const matches = Array.isArray(parsed.matches) ? parsed.matches : [];
  if (matches.length === 0) {
    return { kind: 'no-matches', blocksSearched: opts.orphans.length };
  }

  // Step 2: format. Use the JSON we just received, not re-encoded — that
  // way any future field additions in the helper pass through unchanged.
  const format = await spawnCapture(chiaPython, [formatter, 'detailed'], decode.stdout);
  if (format.kind === 'spawn-error') {
    return { kind: 'error', error: `formatter not runnable: ${format.message}` };
  }
  if (format.kind === 'exit' && format.code !== 0) {
    return {
      kind: 'error',
      error: `formatter exited ${format.code}: ${format.stderr.trim() || '(no stderr)'}`,
    };
  }

  const heights = opts.orphans.map((o) => o.height);
  const lowHeight = Math.min(...heights);
  const highHeight = Math.max(...heights);

  return {
    kind: 'matches',
    info: {
      formattedText: format.stdout,
      matchedBlockCount: matches.length,
      spendCount: countSpends(matches),
      lowHeight,
      highHeight,
    },
  };
}

/**
 * Convenience wrapper used by the dispatch sites: build orphan pairs from
 * a batch of ReorgEvent, run searchBridges, log the result, return a
 * BridgeInfo when there are matches (and `undefined` otherwise).
 *
 * Logging policy:
 *   - matches: a `logBlock(info, 'Bridge Info detected in re-orged blocks', ...)`
 *     so the formatted section appears in the log file even when no email
 *     is sent. Matches the user spec: "output them in the log... If found".
 *   - no-matches / skipped: single `log('info'|'warn', ...)` line, no body.
 *   - error: `log('warn', ...)` with the reason; no BridgeInfo returned.
 */
export async function runBridgeSearchForBatch(
  events: ReorgEvent[],
  searchOpts: Omit<SearchOptions, 'orphans'>
): Promise<BridgeInfo | undefined> {
  const orphans = events
    .map((e) => ({ height: e.height, header_hash: stripHexPrefix(e.old_header_hash) }))
    .filter((o) => isValidHash(o.header_hash));
  if (orphans.length === 0) {
    log('info', 'Bridge search skipped (no usable orphan hashes in batch)');
    return undefined;
  }

  const outcome = await searchBridges({ ...searchOpts, orphans });
  if (outcome.kind === 'matches') {
    logBlock('info', 'Bridge Info detected in re-orged blocks', outcome.info.formattedText, {
      matched_blocks: outcome.info.matchedBlockCount,
      matched_spends: outcome.info.spendCount,
      height_range: `${outcome.info.lowHeight}..${outcome.info.highHeight}`,
    });
    return outcome.info;
  }
  if (outcome.kind === 'no-matches') {
    log('info', 'Bridge search complete (no matches)', {
      blocks_searched: outcome.blocksSearched,
    });
    return undefined;
  }
  if (outcome.kind === 'skipped') {
    log('info', 'Bridge search skipped', { reason: outcome.reason });
    return undefined;
  }
  log('warn', 'Bridge search failed', { error: outcome.error });
  return undefined;
}

// ---------- internal helpers ----------

function countSpends(matches: unknown[]): number {
  let n = 0;
  for (const m of matches) {
    if (typeof m === 'object' && m !== null && 'spends' in m) {
      const s = (m as { spends?: unknown }).spends;
      if (Array.isArray(s)) n += s.length;
    }
  }
  return n;
}

function stripHexPrefix(s: string): string {
  return s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
}

function isValidHash(s: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(s);
}

type CaptureResult =
  | { kind: 'exit'; code: number | null; stdout: string; stderr: string }
  | { kind: 'spawn-error'; message: string };

function spawnCapture(
  cmd: string,
  args: string[],
  stdin: string
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(cmd, args);
    } catch (err) {
      resolve({ kind: 'spawn-error', message: safeMessage(err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    proc.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    proc.on('error', (err) => {
      resolve({ kind: 'spawn-error', message: safeMessage(err) });
    });
    proc.on('close', (code) => {
      resolve({ kind: 'exit', code, stdout, stderr });
    });
    if (proc.stdin) {
      proc.stdin.end(stdin);
    }
  });
}
