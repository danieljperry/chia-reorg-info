import { createReadStream, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { safeMessage } from '../util/safe-message.js';

export type ParsedArgs = {
  logFile: string;
};

export class HelpRequested extends Error {
  constructor() {
    super('help');
    this.name = 'HelpRequested';
  }
}

const DEFAULT_LOG_FILE = join(homedir(), 'logs', 'reorg_monitor.log');

const HELP_TEXT = `Usage: chia-reorg-info status [options]

Print the most recent monitor status line from the log file. The
reorg_monitor subcommand writes a status snapshot at every
--status-every interval; this prints just the latest one.

Options:
  --log-file <path>  Log file to read (default: ~/logs/reorg_monitor.log)
  --help, -h         Show this help

Exit codes:
  0  printed a status line
  1  log file is missing or contains no Status lines
  2  invalid arguments
`;

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let logFile = DEFAULT_LOG_FILE;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const take = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${flag ?? '<flag>'}`);
      return v;
    };
    switch (flag) {
      case '--log-file':
        logFile = take();
        break;
      case '--help':
      case '-h':
        throw new HelpRequested();
      default:
        throw new Error(`Unknown flag: ${flag ?? ''}`);
    }
  }
  return { logFile };
}

export async function runStatusCli(argv: readonly string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof HelpRequested) {
      process.stdout.write(HELP_TEXT);
      return 0;
    }
    process.stderr.write(`${safeMessage(err)}\n`);
    process.stderr.write('Run with --help for usage.\n');
    return 2;
  }

  if (!existsSync(args.logFile)) {
    process.stderr.write(`Log file not found: ${args.logFile}\n`);
    process.stderr.write('Is the monitor running? Pass --log-file to point at a different path.\n');
    return 1;
  }

  // Stream the file line by line, remember the last matching line.
  let latest: string | null = null;
  const rl = createInterface({ input: createReadStream(args.logFile, 'utf8') });
  for await (const line of rl) {
    if (line.includes('[info] Status ')) latest = line;
  }

  if (latest === null) {
    process.stderr.write(`No Status lines found in ${args.logFile}.\n`);
    return 1;
  }
  process.stdout.write(latest + '\n');
  return 0;
}
