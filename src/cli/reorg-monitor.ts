import { homedir } from 'node:os';
import { join } from 'node:path';
import { logSmtpConfig } from '../monitor/email-alert.js';
import {
  startMonitor,
  stopMonitor,
  getStatus,
  type AlertRecipient,
} from '../monitor/reorg-monitor.js';
import { type Network, NETWORKS } from '../network.js';
import { loadEnvFile } from '../util/env-file.js';
import { closeLogger, log, setLogFile, setStderrEnabled } from '../util/logger.js';
import { safeMessage } from '../util/safe-message.js';

export type ParsedArgs = {
  network: Network;
  pollIntervalSeconds: number;
  lookbackBlocks: number;
  statusEverySeconds: number;
  recipients: AlertRecipient[];
  logFile: string | null;
  smtpEnvFile: string | null;
};

const DEFAULT_LOG_FILE = join(homedir(), 'logs', 'reorg_monitor.log');

const DEFAULTS = {
  network: 'mainnet' as Network,
  pollIntervalSeconds: 5,
  lookbackBlocks: 5,
  statusEverySeconds: 60,
};

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

  startMonitor({
    network: args.network,
    poll_interval_seconds: args.pollIntervalSeconds,
    lookback_blocks: args.lookbackBlocks,
    alert_recipients: args.recipients,
  });

  const tick = (): void => {
    const s = getStatus();
    log('info', 'Status', {
      polls: s.poll_count,
      peak: s.peak_height,
      observations: s.observations_count,
      reorgs: s.reorgs.length,
      last_error: s.last_error,
    });
  };

  // Intentionally NOT unref'd: the monitor's own poll timer is unref'd (so it
  // doesn't keep the MCP server alive), so this interval is what keeps the CLI
  // process running between signals.
  const interval = setInterval(tick, args.statusEverySeconds * 1000);

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      clearInterval(interval);
      stopMonitor();
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
  await closeLogger();
  return 0;
}
