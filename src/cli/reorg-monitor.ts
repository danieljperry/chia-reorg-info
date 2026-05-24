import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

function parseIntegerFlag(name: string, raw: string, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

function parseRecipient(raw: string): AlertRecipient {
  const [email, minStr] = raw.split(':');
  if (email === undefined || !email.includes('@')) {
    throw new Error(`--recipient expects email[:min_blocks], got "${raw}"`);
  }
  const min_blocks =
    minStr === undefined ? 1 : parseIntegerFlag('min_blocks', minStr, 1, 1_000_000);
  return { email, min_blocks };
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
  const seenEmails = new Set<string>();

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
        const r = parseRecipient(take());
        if (seenEmails.has(r.email)) break;
        seenEmails.add(r.email);
        if (args.recipients.length >= 10) {
          throw new Error('A maximum of 10 --recipient flags is allowed');
        }
        args.recipients.push(r);
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
  --recipient <email[:min_blocks]>  Email recipient; repeatable, max 10.
                                  min_blocks defaults to 1. Duplicates collapsed.
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

  // Validate --db-path when source includes local.
  if (args.source === 'local' || args.source === 'both') {
    if (!existsSync(args.dbPath)) {
      log('error', '--db-path not readable', { db_path: args.dbPath });
      process.stderr.write(
        `Error: --source=${args.source} requires a readable DB at ${args.dbPath}\n` +
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

  // -------------------------------------------------------------------------
  // Wire pollers + dispatcher per source mode.
  // -------------------------------------------------------------------------

  const wantsCoinset = args.source === 'coinset' || args.source === 'both';
  const wantsLocal = args.source === 'local' || args.source === 'both';

  if (args.source === 'both') {
    // Dual-source: pollers feed events into the coordinator; dispatch happens
    // on settle (high + 2 blocks past both sources' peaks).
    const coordinator = createDualSource('both', (outcome) => {
      dispatchDualOutcome(outcome, args.recipients, args.network);
    });

    // Coinset poller: alert_recipients is empty so inline dispatch is a no-op;
    // hooks forward each detection + peak to the coordinator.
    startMonitor({
      network: args.network,
      poll_interval_seconds: args.pollIntervalSeconds,
      lookback_blocks: args.lookbackBlocks,
      alert_recipients: [],
      on_reorg: (evt) =>
        coordinator.noteReorg(reorgEventToSourceEvent(evt, 'coinset')),
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
    // Single-source coinset: today's behavior, unchanged.
    startMonitor({
      network: args.network,
      poll_interval_seconds: args.pollIntervalSeconds,
      lookback_blocks: args.lookbackBlocks,
      alert_recipients: args.recipients,
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
        dispatchToRecipients([evt], args.recipients, args.network, evt.blocks_from_peak + evt.height);
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

function reorgEventToSourceEvent(evt: ReorgEvent, source: 'coinset'): SourceEvent {
  // Each ReorgEvent represents one changed height; depth/max_depth are the
  // cluster size as computed at detection time. For coinset, low = high =
  // the changed height (the cluster is decomposed into per-height events by
  // the monitor — we treat each event as a single-height "mini-cluster" from
  // the dual-source perspective and let the match logic do the overlap check).
  return {
    source,
    low: evt.height,
    high: evt.height,
    depth: evt.depth,
    max_depth: evt.max_depth,
    detected_at_iso: evt.detected_at,
    ts_low_unix: null,
    ts_high_unix: null,
  };
}

function localReorgToSourceEvent(r: LocalReorg & { detected_at_iso: string }): SourceEvent {
  return {
    source: 'local',
    low: r.low,
    high: r.high,
    depth: r.depth,
    max_depth: r.depth, // local is exact
    detected_at_iso: r.detected_at_iso,
    ts_low_unix: r.ts_low_unix,
    ts_high_unix: r.ts_high_unix,
  };
}

function synthesizeReorgEventFromLocal(
  r: LocalReorg & { detected_at_iso: string }
): ReorgEvent {
  return {
    height: r.high,
    old_header_hash: '(unavailable — local DB detection)',
    new_header_hash: '(unavailable — local DB detection)',
    detected_at: r.detected_at_iso,
    depth: r.depth,
    max_depth: r.depth,
    blocks_from_peak: 0,
    old_block_record: { timestamp: r.ts_high_unix ?? null },
  };
}

function dispatchToRecipients(
  events: ReorgEvent[],
  recipients: AlertRecipient[],
  network: Network,
  peakHeight: number,
  extras: { subjectSuffix?: string; introPrepend?: string } = {}
): void {
  for (const recipient of recipients) {
    const eligible = events.filter((e) => e.max_depth >= recipient.min_blocks);
    if (eligible.length === 0) continue;
    sendReorgAlert(recipient.email, network, eligible, peakHeight, extras).catch(
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
  network: Network
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
    dispatchToRecipients([evt], recipients, network, b, {
      subjectSuffix: ' — confirmed by Coinset + local DB',
      introPrepend: intro,
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
    dispatchToRecipients([evt], recipients, network, b, {
      subjectSuffix: ' — Coinset only',
      introPrepend: intro,
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
  dispatchToRecipients([evt], recipients, network, b, {
    subjectSuffix: ' — local DB only',
    introPrepend: intro,
  });
}

function synthesizeReorgEventFromSource(s: SourceEvent): ReorgEvent {
  return {
    height: s.high,
    old_header_hash:
      s.source === 'local'
        ? '(unavailable — local DB detection)'
        : '(see Coinset event)',
    new_header_hash:
      s.source === 'local'
        ? '(unavailable — local DB detection)'
        : '(see Coinset event)',
    detected_at: s.detected_at_iso,
    depth: s.depth,
    max_depth: s.max_depth,
    blocks_from_peak: 0,
    old_block_record: { timestamp: s.ts_high_unix ?? null },
  };
}
