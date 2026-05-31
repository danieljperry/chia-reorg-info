import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BridgeInfo, runBridgeSearchForBatch } from '../monitor/bridge-info.js';
import {
  createDualSource,
  type DispatchOutcome,
  type SourceEvent,
} from '../monitor/dual-source.js';
import { logSmtpConfig, sendReorgAlert } from '../monitor/email-alert.js';
import {
  getLocalStatus,
  startLocalPoller,
  stopLocalPoller,
  type LocalReorg,
} from '../monitor/local-poller.js';
import {
  startMonitor,
  stopMonitor,
  getStatus,
  type AlertRecipient,
  type ReorgEvent,
} from '../monitor/reorg-monitor.js';
import { type Network, NETWORKS } from '../network.js';
import { loadEnvFile } from '../util/env-file.js';
import { closeLogger, log, setLogFile, setStderrEnabled } from '../util/logger.js';
import { safeMessage } from '../util/safe-message.js';

export type Source = 'coinset' | 'local' | 'both';

export type ParsedArgs = {
  network: Network;
  pollIntervalSeconds: number;
  lookbackBlocks: number;
  statusEverySeconds: number;
  recipients: AlertRecipient[];
  logFile: string | null;
  smtpEnvFile: string | null;
  source: Source;
  localPollIntervalSeconds: number;
  localLookbackBlocks: number;
  dbPath: string;
};

const DEFAULT_LOG_FILE = join(homedir(), 'logs', 'reorg_monitor.log');
const DEFAULT_DB_PATH =
  process.env.CHIA_DB ?? join(homedir(), '.chia', 'mainnet', 'db', 'blockchain_v2_mainnet.sqlite');

const DEFAULTS = {
  network: 'mainnet' as Network,
  pollIntervalSeconds: 5,
  lookbackBlocks: 5,
  statusEverySeconds: 60,
  source: 'coinset' as Source,
  localPollIntervalSeconds: 10,
  localLookbackBlocks: 5,
};

const SOURCES: readonly Source[] = ['coinset', 'local', 'both'];

// Returns null when the DB at `path` can be opened for reading by this process,
// otherwise a short reason suitable for surfacing to the user.
export function checkDbPathReadable(path: string): string | null {
  let stat;
  try {
    stat = statSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return `path does not exist (note: systemd does not expand ~ or $HOME in ExecStart — use an absolute path)`;
    if (code === 'EACCES') return `cannot stat path — a parent directory blocks lookup for this user (uid=${process.getuid?.() ?? '?'})`;
    return `stat failed (${code ?? 'unknown'}): ${safeMessage(err)}`;
  }
  if (!stat.isFile()) return `path is not a regular file`;
  try {
    accessSync(path, fsConstants.R_OK);
  } catch {
    return `file exists but is not readable by this user (uid=${process.getuid?.() ?? '?'}) — check file permissions`;
  }
  return null;
}

function parseIntegerFlag(name: string, raw: string, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

/** One parsed `--recipient` token: either a numeric depth subscription or a
 *  bridge subscription. parseArgs merges these by email into AlertRecipient. */
type RecipientEntry =
  | { email: string; kind: 'depth'; min_blocks: number }
  | { email: string; kind: 'bridge' };

function parseRecipient(raw: string): RecipientEntry {
  const parts = raw.split(':');
  const email = parts[0];
  if (email === undefined || !email.includes('@')) {
    throw new Error(`--recipient expects email[:min_blocks|:b], got "${raw}"`);
  }
  if (parts.length > 2) {
    throw new Error(`--recipient expects email[:min_blocks|:b], got "${raw}"`);
  }
  const spec = parts[1];
  if (spec === undefined) return { email, kind: 'depth', min_blocks: 1 };
  if (spec === 'b') return { email, kind: 'bridge' };
  // Anything else must be a positive integer; parseIntegerFlag throws otherwise.
  const min_blocks = parseIntegerFlag('min_blocks', spec, 1, 1_000_000);
  return { email, kind: 'depth', min_blocks };
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = {
    network: DEFAULTS.network,
    pollIntervalSeconds: DEFAULTS.pollIntervalSeconds,
    lookbackBlocks: DEFAULTS.lookbackBlocks,
    statusEverySeconds: DEFAULTS.statusEverySeconds,
    recipients: [],
    logFile: DEFAULT_LOG_FILE,
    smtpEnvFile: null,
    source: DEFAULTS.source,
    localPollIntervalSeconds: DEFAULTS.localPollIntervalSeconds,
    localLookbackBlocks: DEFAULTS.localLookbackBlocks,
    dbPath: DEFAULT_DB_PATH,
  };
  // Recipients merge by email: one address can carry both a numeric depth
  // trigger and a bridge trigger. Duplicate numeric entries collapse (first
  // wins); duplicate bridge entries collapse (idempotent). The 10-recipient
  // cap counts distinct emails.
  const recipientMap = new Map<string, AlertRecipient>();

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const take = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${flag ?? '<flag>'}`);
      return v;
    };
    switch (flag) {
      case '--network': {
        const v = take();
        if (!(NETWORKS as readonly string[]).includes(v)) {
          throw new Error(`--network must be one of ${NETWORKS.join(', ')} (got "${v}")`);
        }
        args.network = v as Network;
        break;
      }
      case '--poll-interval':
        args.pollIntervalSeconds = parseIntegerFlag('--poll-interval', take(), 5, 60);
        break;
      case '--lookback':
        args.lookbackBlocks = parseIntegerFlag('--lookback', take(), 1, 32);
        break;
      case '--status-every':
        args.statusEverySeconds = parseIntegerFlag('--status-every', take(), 1, 86_400);
        break;
      case '--recipient': {
        const entry = parseRecipient(take());
        const existing = recipientMap.get(entry.email);
        if (existing === undefined) {
          if (recipientMap.size >= 10) {
            throw new Error('A maximum of 10 --recipient flags is allowed');
          }
          recipientMap.set(
            entry.email,
            entry.kind === 'bridge'
              ? { email: entry.email, min_blocks: null, bridge: true }
              : { email: entry.email, min_blocks: entry.min_blocks, bridge: false }
          );
        } else if (entry.kind === 'bridge') {
          existing.bridge = true; // idempotent; collapses duplicate :b
        } else if (existing.min_blocks === null) {
          existing.min_blocks = entry.min_blocks; // first numeric wins
        }
        // else: a second numeric entry for this email is dropped (collapse).
        break;
      }
      case '--log-file':
        args.logFile = take();
        break;
      case '--no-log-file':
        args.logFile = null;
        break;
      case '--smtp-env-file':
        args.smtpEnvFile = take();
        break;
      case '--source': {
        const v = take();
        if (!(SOURCES as readonly string[]).includes(v)) {
          throw new Error(`--source must be one of ${SOURCES.join(', ')} (got "${v}")`);
        }
        args.source = v as Source;
        break;
      }
      case '--local-poll-interval':
        args.localPollIntervalSeconds = parseIntegerFlag(
          '--local-poll-interval',
          take(),
          5,
          3600
        );
        break;
      case '--local-lookback':
        args.localLookbackBlocks = parseIntegerFlag('--local-lookback', take(), 1, 1000);
        break;
      case '--db-path':
        args.dbPath = take();
        break;
      case '--help':
      case '-h':
        throw new HelpRequested();
      default:
        throw new Error(`Unknown flag: ${flag ?? ''}`);
    }
  }
  args.recipients = [...recipientMap.values()];
  return args;
}

export class HelpRequested extends Error {
  constructor() {
    super('help');
    this.name = 'HelpRequested';
  }
}

const HELP_TEXT = `Usage: chia-reorg-info reorg_monitor [options]

Run the re-org monitor as a long-running CLI process. Logs status snapshots,
re-org events, and outgoing email contents to a log file (and mirrors them to
stderr). Send SIGINT (Ctrl-C) to stop.

Options:
  --network <mainnet|testnet11>   Network to monitor (default: mainnet)
  --poll-interval <seconds>       Seconds between polls, 5–60 (default: 5)
  --lookback <blocks>             Heights to re-check per poll, 1–32 (default: 5)
  --status-every <seconds>        How often to log a status snapshot (default: 60)
  --recipient <email[:min_blocks|:b]>  Email recipient; repeatable, max 10.
                                  min_blocks (a positive integer, default 1)
                                  alerts on re-orgs at least that deep. Use ':b'
                                  to alert only when a re-org involves the bridge
                                  (any depth). One address may use both (e.g.
                                  ':2' and ':b') to get depth alerts plus
                                  bridge alerts; these merge into a single
                                  subscription. Duplicates collapsed.
  --log-file <path>               Log file path (default: ~/logs/reorg_monitor.log)
  --no-log-file                   Disable file logging (stderr only)
  --smtp-env-file <path>          Load SMTP_* env vars from a KEY=VALUE file.
                                  Comments (#) and quoted values allowed.
                                  Shell-exported vars take precedence.

Source selection (which detector(s) to run — default: coinset):
  --source <coinset|local|both>   coinset: today's behavior, polls coinset.org.
                                  local:   polls the local Chia SQLite DB via
                                           scripts/reorg-finder.sh; no network.
                                  both:    runs both pollers and waits until
                                           2 blocks past each reorg's high before
                                           emitting an alert that says whether
                                           the sources agreed.
  --local-poll-interval <seconds> Seconds between local DB scans, 5–3600
                                  (default: 10). Independent of --poll-interval.
  --local-lookback <blocks>       Heights to re-check per local scan, 1–1000
                                  (default: 5). Independent of --lookback.
  --db-path <path>                Local SQLite DB path. Required when --source
                                  includes 'local'. Defaults to $CHIA_DB if
                                  set, otherwise ~/.chia/mainnet/db/blockchain_v2_mainnet.sqlite.

  --help, -h                      Show this help and exit

Email alerts require SMTP_HOST; see README for full SMTP env var list.
`;

export async function runReorgMonitorCli(argv: readonly string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof HelpRequested) {
      process.stdout.write(HELP_TEXT);
      return 0;
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write('Run with --help for usage.\n');
    return 2;
  }

  setStderrEnabled(true);
  await setLogFile(args.logFile);
  if (args.logFile !== null) {
    process.stderr.write(`[chia-reorg-info] logging to ${args.logFile}\n`);
  }

  if (args.smtpEnvFile !== null) {
    try {
      const result = await loadEnvFile(args.smtpEnvFile);
      log('info', 'Loaded SMTP env file', {
        path: args.smtpEnvFile,
        loaded: result.loaded,
        skipped: result.skipped,
      });
    } catch (err) {
      log('error', 'Failed to load --smtp-env-file', {
        path: args.smtpEnvFile,
        error: safeMessage(err),
      });
      return 2;
    }
  }

  if (args.recipients.length > 0) {
    logSmtpConfig();
  }

  // Validate --db-path when source includes local. Distinguish "can't see it"
  // (lookup blocked by parent-directory permissions, broken symlink, or wrong
  // path) from "can see it but can't read it" (file perms too tight for the
  // process UID) — they have different fixes and the old combined error left
  // users guessing.
  if (args.source === 'local' || args.source === 'both') {
    const dbError = checkDbPathReadable(args.dbPath);
    if (dbError !== null) {
      log('error', '--db-path check failed', { db_path: args.dbPath, reason: dbError });
      process.stderr.write(
        `Error: --source=${args.source} cannot use ${args.dbPath}\n` +
          `Reason: ${dbError}\n` +
          `Set --db-path, set CHIA_DB, or use --source=coinset.\n`
      );
      return 2;
    }
  }

  // Resolve the bash script path relative to this module's location.
  // From dist/cli/reorg-monitor.js → ../../scripts/reorg-finder.sh.
  // Same shape when run via `tsx src/cli/reorg-monitor.ts`.
  const scriptPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'scripts',
    'reorg-finder.sh'
  );

  // Bridge-info provider: closure capturing the DB path so every dispatch
  // site can call it without repeating the wiring. Only wired when the DB
  // path is readable — coinset-only deployments without a node have nothing
  // to scan, so we skip the closure entirely (cheaper than per-call
  // accessSync() failures) and rely on `searchBridges`'s internal skip
  // to also handle late-vanishing DBs.
  const bridgeInfoProvider: (events: ReorgEvent[]) => Promise<BridgeInfo | undefined> = (
    events
  ) => runBridgeSearchForBatch(events, { dbPath: args.dbPath });

  // -------------------------------------------------------------------------
  // Wire pollers + dispatcher per source mode.
  // -------------------------------------------------------------------------

  const wantsCoinset = args.source === 'coinset' || args.source === 'both';
  const wantsLocal = args.source === 'local' || args.source === 'both';

  if (args.source === 'both') {
    // Dual-source: pollers feed events into the coordinator; dispatch happens
    // on settle (high + 2 blocks past both sources' peaks).
    const coordinator = createDualSource('both', (outcome) => {
      dispatchDualOutcome(outcome, args.recipients, args.network, bridgeInfoProvider);
    });

    // Coinset poller: alert_recipients is empty so inline dispatch is a no-op;
    // hooks forward each poll's batch + peak to the coordinator. The batch
    // hook is critical: the underlying monitor emits one ReorgEvent per
    // changed height, but the dual-source coordinator wants one SourceEvent
    // per logical reorg (cluster). Without consolidation here, a 3-height
    // observed cluster would race against the single local cluster event and
    // produce 1 matched + 2 coinset-only outcomes (i.e. 3 emails for 1 reorg).
    startMonitor({
      network: args.network,
      poll_interval_seconds: args.pollIntervalSeconds,
      lookback_blocks: args.lookbackBlocks,
      alert_recipients: [],
      on_reorg_batch: (events) => {
        for (const cluster of consolidateCoinsetBatch(events)) {
          coordinator.noteReorg(cluster);
        }
      },
      on_peak: (peak) => {
        void coordinator.notePeak('coinset', peak);
      },
    });

    startLocalPoller({
      script_path: scriptPath,
      db_path: args.dbPath,
      poll_interval_seconds: args.localPollIntervalSeconds,
      lookback_blocks: args.localLookbackBlocks,
      on_reorg: (r) =>
        coordinator.noteReorg(localReorgToSourceEvent(r)),
      on_peak: (peak) => {
        void coordinator.notePeak('local', peak);
      },
    });
  } else if (wantsCoinset) {
    // Single-source coinset: today's behavior, plus the bridge-info hook so
    // each per-poll dispatch batch runs the search once before the
    // recipient loop.
    startMonitor({
      network: args.network,
      poll_interval_seconds: args.pollIntervalSeconds,
      lookback_blocks: args.lookbackBlocks,
      alert_recipients: args.recipients,
      bridge_info_provider: bridgeInfoProvider,
    });
  } else {
    // Single-source local: per-recipient dispatch happens directly from the
    // poller's on_reorg hook. No coordinator buffer needed.
    startLocalPoller({
      script_path: scriptPath,
      db_path: args.dbPath,
      poll_interval_seconds: args.localPollIntervalSeconds,
      lookback_blocks: args.localLookbackBlocks,
      on_reorg: (r) => {
        const evt = synthesizeReorgEventFromLocal(r);
        void dispatchToRecipients(
          [evt],
          args.recipients,
          args.network,
          evt.blocks_from_peak + evt.height,
          { bridgeInfoProvider }
        );
      },
    });
  }

  const tick = (): void => {
    const fields: Record<string, unknown> = {};
    if (wantsCoinset) {
      const s = getStatus();
      fields.coinset_polls = s.poll_count;
      fields.coinset_peak = s.peak_height;
      fields.coinset_observations = s.observations_count;
      fields.coinset_reorgs = s.reorgs.length;
      fields.coinset_last_error = s.last_error;
    }
    if (wantsLocal) {
      const l = getLocalStatus();
      fields.local_polls = l.poll_count;
      fields.local_peak = l.peak_at_last_scan;
      fields.local_seen = l.seen_count;
      fields.local_last_error = l.last_error;
    }
    log('info', 'Status', fields);
  };

  // Intentionally NOT unref'd: the pollers' own timers are unref'd, so this
  // interval is what keeps the CLI process running between signals.
  const interval = setInterval(tick, args.statusEverySeconds * 1000);

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      clearInterval(interval);
      if (wantsCoinset) stopMonitor();
      if (wantsLocal) stopLocalPoller();
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
  await closeLogger();
  return 0;
}

// ----- helpers below ------------------------------------------------------

/**
 * Group a poll's worth of per-height Coinset ReorgEvents into one
 * cluster-level SourceEvent per contiguous run of heights. Within a cluster,
 * all events share the same depth + max_depth (computed once by the monitor),
 * so we use either end's values; the cluster's high is widened by
 * (max_depth - depth) to encode the potentially-affected upper extent
 * (see reorgEventToSourceEvent for the rationale).
 *
 * Empty input → empty output. A batch can contain multiple disjoint
 * clusters (e.g. two unrelated reorgs in the same poll); each becomes its
 * own SourceEvent.
 */
export function consolidateCoinsetBatch(events: ReorgEvent[]): SourceEvent[] {
  if (events.length === 0) return [];
  const sorted = [...events].sort((a, b) => a.height - b.height);
  const clusters: SourceEvent[] = [];
  let clusterStart = 0;
  for (let i = 1; i <= sorted.length; i++) {
    const isBreak =
      i === sorted.length || sorted[i]!.height !== sorted[i - 1]!.height + 1;
    if (isBreak) {
      const first = sorted[clusterStart]!;
      const last = sorted[i - 1]!;
      clusters.push({
        source: 'coinset',
        low: first.height,
        high: last.height + (last.max_depth - last.depth),
        // settle_at is the un-widened observed top — see SourceEvent docstring.
        settle_at: last.height,
        depth: first.depth,
        max_depth: first.max_depth,
        detected_at_iso: first.detected_at,
        ts_low_unix: null,
        ts_high_unix: null,
        // The synthesized email reports the cluster top — use last's record.
        old_block_record:
          typeof last.old_block_record === 'object' && last.old_block_record !== null
            ? (last.old_block_record as Record<string, unknown>)
            : null,
      });
      clusterStart = i;
    }
  }
  return clusters;
}

export function reorgEventToSourceEvent(evt: ReorgEvent, source: 'coinset'): SourceEvent {
  // `low` is the actual observed changed height. `high` is widened by the
  // "unobserved upward extent" (max_depth - depth) so the SourceEvent
  // represents the full range of heights that *might* have been part of the
  // cluster — Coinset can only directly observe heights it polled before the
  // chain advanced past them. Without this widening, a Coinset event at
  // height H with depth=1, max_depth=4 (chain advanced 3 blocks past
  // observed peak during the reorg) would only match a local detection at
  // exactly H, missing local detections at H+1..H+3 that are part of the
  // same logical reorg.
  //
  // When depth == max_depth (chain didn't advance into unobserved territory)
  // the widening is zero and behavior is unchanged.
  return {
    source,
    low: evt.height,
    high: evt.height + (evt.max_depth - evt.depth),
    // settle_at is the actual observed height — see SourceEvent docstring.
    settle_at: evt.height,
    depth: evt.depth,
    max_depth: evt.max_depth,
    detected_at_iso: evt.detected_at,
    ts_low_unix: null,
    ts_high_unix: null,
    old_header_hash: evt.old_header_hash,
    new_header_hash: evt.new_header_hash,
    // The Coinset poller already has the full block_record on the ReorgEvent
    // (from get_block_records); propagate it through so the email body keeps
    // the rich record even after going through the dual-source coordinator.
    old_block_record:
      typeof evt.old_block_record === 'object' && evt.old_block_record !== null
        ? (evt.old_block_record as Record<string, unknown>)
        : null,
  };
}

function localReorgToSourceEvent(r: LocalReorg & { detected_at_iso: string }): SourceEvent {
  return {
    source: 'local',
    low: r.low,
    high: r.high,
    settle_at: r.high, // local is exact; settle_at == observed top
    depth: r.depth,
    max_depth: r.depth,
    detected_at_iso: r.detected_at_iso,
    ts_low_unix: r.ts_low_unix,
    ts_high_unix: r.ts_high_unix,
    old_header_hash: r.old_hash,
    new_header_hash: r.new_hash,
    old_block_record: r.old_block_record,
    old_block_record_error: r.old_block_record_error,
  };
}

function synthesizeReorgEventFromLocal(
  r: LocalReorg & { detected_at_iso: string }
): ReorgEvent {
  // When the bash script couldn't decode the orphan's BlockRecord, emit
  // an explicit "unavailable" sentinel rather than fabricating a
  // {timestamp} dict. The old fallback rendered as a one-line tx-block
  // dump in the alert email and looked like the chain's actual content,
  // hiding the underlying decode failure. The new shape is recognized
  // by the email renderer, which prints the failure reason instead.
  const old_block_record: Record<string, unknown> =
    r.old_block_record ??
    {
      _unavailable: r.old_block_record_error ?? 'local poller did not provide a block record',
      // Preserve the foliage timestamp when we have it so the renderer
      // can still identify this as a tx block — we lost the record, not
      // the knowledge that one existed.
      foliage_timestamp_unix: r.ts_high_unix ?? null,
    };
  return {
    height: r.high,
    old_header_hash: r.old_hash ?? '(unavailable — local DB detection)',
    new_header_hash: r.new_hash ?? '(unavailable — local DB detection)',
    detected_at: r.detected_at_iso,
    depth: r.depth,
    max_depth: r.depth,
    blocks_from_peak: 0,
    old_block_record,
  };
}

export async function dispatchToRecipients(
  events: ReorgEvent[],
  recipients: AlertRecipient[],
  network: Network,
  peakHeight: number,
  extras: {
    subjectSuffix?: string;
    introPrepend?: string;
    /** Resolved ONCE here (before iterating recipients) so the python
     *  subprocess doesn't run per recipient. Failure → no bridge section
     *  in any email. Provider also writes the formatted bridge text to
     *  the log file when matches are found, so the log entry happens
     *  regardless of recipient eligibility. */
    bridgeInfoProvider?: (events: ReorgEvent[]) => Promise<BridgeInfo | undefined>;
  } = {}
): Promise<void> {
  let bridgeInfo: BridgeInfo | undefined;
  if (extras.bridgeInfoProvider !== undefined && events.length > 0) {
    try {
      bridgeInfo = await extras.bridgeInfoProvider(events);
    } catch (err) {
      log('warn', 'Bridge info provider threw', { error: safeMessage(err) });
    }
  }
  for (const recipient of recipients) {
    // Two independent triggers (see _pollOnce for the canonical comment): the
    // numeric depth threshold and the bridge subscription. When the bridge
    // trigger fires, send the COMPLETE batch so a recipient subscribed both
    // ways gets one email with the " — bridge transfer" suffix.
    const numericEligible =
      recipient.min_blocks !== null
        ? events.filter((e) => e.max_depth >= recipient.min_blocks!)
        : [];
    const numericMatch = numericEligible.length > 0;
    const bridgeMatch = recipient.bridge && bridgeInfo !== undefined;
    if (!numericMatch && !bridgeMatch) continue;
    const eventsToSend = bridgeMatch ? events : numericEligible;
    const sendExtras: {
      subjectSuffix?: string;
      introPrepend?: string;
      bridgeInfo?: BridgeInfo;
    } = {};
    const suffix = (extras.subjectSuffix ?? '') + (bridgeMatch ? ' — bridge transfer' : '');
    if (suffix !== '') sendExtras.subjectSuffix = suffix;
    if (extras.introPrepend !== undefined) sendExtras.introPrepend = extras.introPrepend;
    if (bridgeInfo !== undefined) sendExtras.bridgeInfo = bridgeInfo;
    sendReorgAlert(recipient.email, network, eventsToSend, peakHeight, sendExtras).catch(
      (err: unknown) => {
        log('error', 'Re-org alert email failed', {
          to: recipient.email,
          error: safeMessage(err),
        });
      }
    );
  }
}

function formatRangeWindow(low: number, high: number, source: 'coinset' | 'local'): string {
  // "from DATE START_TIME to END_TIME" — for now we use current local time
  // as both bounds (we don't always have block timestamps for coinset events).
  // Future enhancement: thread ts_low_unix/ts_high_unix through for accuracy.
  void source; // future use
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const t = now.toLocaleTimeString();
  void high;
  void low;
  return `${date} ${t} (detection time)`;
}

function dispatchDualOutcome(
  outcome: DispatchOutcome,
  recipients: AlertRecipient[],
  network: Network,
  bridgeInfoProvider?: (events: ReorgEvent[]) => Promise<BridgeInfo | undefined>
): void {
  log('info', 'Reorg comparison', {
    kind: outcome.kind,
    coinset: outcome.kind === 'matched' || outcome.kind === 'coinset-only'
      ? `${outcome.kind === 'matched' ? outcome.coinset.low : outcome.event.low}..${outcome.kind === 'matched' ? outcome.coinset.high : outcome.event.high}`
      : undefined,
    local: outcome.kind === 'matched' || outcome.kind === 'local-only'
      ? `${outcome.kind === 'matched' ? outcome.local.low : outcome.event.low}..${outcome.kind === 'matched' ? outcome.local.high : outcome.event.high}`
      : undefined,
  });

  if (outcome.kind === 'matched') {
    const a = outcome.local.low;
    const b = outcome.local.high;
    const n = outcome.local.depth;
    const when = formatRangeWindow(a, b, 'local');
    const intro =
      `The same reorg of ${n} block(s) from height ${a} to ${b} was detected from ` +
      `${when} on both Coinset and the local database.`;
    const evt = synthesizeReorgEventFromSource(outcome.local);
    void dispatchToRecipients([evt], recipients, network, b, {
      subjectSuffix: ' — confirmed by Coinset + local DB',
      introPrepend: intro,
      ...(bridgeInfoProvider !== undefined ? { bridgeInfoProvider } : {}),
    });
    return;
  }

  if (outcome.kind === 'coinset-only') {
    const a = outcome.event.low;
    const b = outcome.event.high;
    const when = formatRangeWindow(a, b, 'coinset');
    const intro =
      `A reorg from height ${a} to ${b} was detected from ${when} on Coinset only. ` +
      `This reorg was not detected in the local database.`;
    const evt = synthesizeReorgEventFromSource(outcome.event);
    void dispatchToRecipients([evt], recipients, network, b, {
      subjectSuffix: ' — Coinset only',
      introPrepend: intro,
      ...(bridgeInfoProvider !== undefined ? { bridgeInfoProvider } : {}),
    });
    return;
  }

  // local-only
  const a = outcome.event.low;
  const b = outcome.event.high;
  const when = formatRangeWindow(a, b, 'local');
  const intro =
    `A reorg from height ${a} to ${b} was detected from ${when} in the local ` +
    `database only. This reorg was not detected on Coinset.`;
  const evt = synthesizeReorgEventFromSource(outcome.event);
  void dispatchToRecipients([evt], recipients, network, b, {
    subjectSuffix: ' — local DB only',
    introPrepend: intro,
    ...(bridgeInfoProvider !== undefined ? { bridgeInfoProvider } : {}),
  });
}

export function synthesizeReorgEventFromSource(s: SourceEvent): ReorgEvent {
  // For Coinset events, `high` may be a widened upper bound (see
  // reorgEventToSourceEvent) — use `low` which is the actual observed
  // changed height. For local events, `high` is the top of the exact
  // observed cluster.
  //
  // Prefer the SourceEvent's hash fields when populated (local: from the
  // bash script's DB queries; coinset: from the original RPC response).
  // Fall back to a per-source placeholder when the source didn't supply
  // them (older bash scripts that omit the field, or a row that vanished
  // mid-scan).
  const localFallback = '(unavailable — local DB detection)';
  const coinsetFallback = '(see Coinset event)';
  const fallback = s.source === 'local' ? localFallback : coinsetFallback;

  // When the source couldn't supply a BlockRecord, emit the same
  // { _unavailable, foliage_timestamp_unix } sentinel as
  // synthesizeReorgEventFromLocal so the email renderer prints the
  // failure reason rather than fabricating a misleading {timestamp}.
  // Per-source default reasons keep the message specific.
  const defaultReason =
    s.source === 'local'
      ? 'local poller did not provide a block record'
      : 'Coinset did not provide a block record';
  const old_block_record: Record<string, unknown> =
    s.old_block_record ??
    {
      _unavailable: s.old_block_record_error ?? defaultReason,
      foliage_timestamp_unix: s.ts_high_unix ?? null,
    };

  return {
    height: s.source === 'coinset' ? s.low : s.high,
    old_header_hash: s.old_header_hash ?? fallback,
    new_header_hash: s.new_header_hash ?? fallback,
    detected_at: s.detected_at_iso,
    depth: s.depth,
    max_depth: s.max_depth,
    blocks_from_peak: 0,
    old_block_record,
  };
}
