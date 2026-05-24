import { get_block_records } from 'chia-agent/api/rpc/full_node/index.js';
import { stripHexPrefix } from '../chia/hex.js';
import { getAgent } from '../coinset/agent.js';
import { type Network, NETWORKS } from '../network.js';
import { safeMessage } from '../util/safe-message.js';

const MAX_RANGE = 50_000;
const BATCH_SIZE = 1_000;

type Anomaly = {
  type: 'chain_break' | 'weight_regression' | 'timestamp_regression';
  height: number;
  timestamp: string | null;
  detail: string;
};

export type ParsedArgs = {
  startHeight: number;
  endHeight: number;
  network: Network;
};

export class HelpRequested extends Error {
  constructor() {
    super('help');
    this.name = 'HelpRequested';
  }
}

const HELP_TEXT = `Usage: chia-reorg-info scan_chain_consistency [options]

Scan a range of blocks for structural evidence of past re-orgs:
broken prev_hash linkage (chain_break), decreasing weight
(weight_regression), and decreasing timestamps across transaction
blocks (timestamp_regression).

Note: shallow re-orgs (1–3 blocks) replace orphaned blocks invisibly
on the canonical chain; only deeper re-orgs leave traces here.

Options:
  --start-height <N>  First block height to scan, inclusive (required)
  --end-height <N>    Last block height to scan, inclusive (required)
  --network <name>    mainnet (default) or testnet11
  --help, -h          Show this help

Max range: ${MAX_RANGE.toLocaleString()} blocks.
Output: JSON object on stdout.
`;

function parseInt0(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer (got "${raw}")`);
  }
  return n;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let startHeight: number | undefined;
  let endHeight: number | undefined;
  let network: Network = 'mainnet';

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const take = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${flag ?? '<flag>'}`);
      return v;
    };
    switch (flag) {
      case '--start-height':
        startHeight = parseInt0('--start-height', take());
        break;
      case '--end-height':
        endHeight = parseInt0('--end-height', take());
        break;
      case '--network': {
        const v = take();
        if (!(NETWORKS as readonly string[]).includes(v)) {
          throw new Error(`--network must be one of ${NETWORKS.join(', ')} (got "${v}")`);
        }
        network = v as Network;
        break;
      }
      case '--help':
      case '-h':
        throw new HelpRequested();
      default:
        throw new Error(`Unknown flag: ${flag ?? ''}`);
    }
  }

  if (startHeight === undefined) throw new Error('--start-height is required');
  if (endHeight === undefined) throw new Error('--end-height is required');
  if (endHeight < startHeight) throw new Error('--end-height must be >= --start-height');
  const range = endHeight - startHeight + 1;
  if (range > MAX_RANGE) {
    throw new Error(
      `Range of ${range.toLocaleString()} blocks exceeds the maximum of ${MAX_RANGE.toLocaleString()}`
    );
  }

  return { startHeight, endHeight, network };
}

export async function runScanChainConsistencyCli(argv: readonly string[]): Promise<number> {
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

  try {
    const agent = getAgent(args.network);

    const blocks: Array<{
      height: number;
      header_hash: string;
      prev_hash: string;
      weight: number | bigint;
      timestamp: number | null;
    }> = [];

    for (let h = args.startHeight; h <= args.endHeight; h += BATCH_SIZE) {
      const batchEnd = Math.min(h + BATCH_SIZE, args.endHeight + 1);
      const res = await get_block_records(agent, { start: h, end: batchEnd });
      if (res.block_records) blocks.push(...(res.block_records as typeof blocks));
    }

    blocks.sort((a, b) => a.height - b.height);

    const anomalies: Anomaly[] = [];
    const fmt = (ts: number | null) => (ts != null ? new Date(ts * 1000).toISOString() : null);

    let prevTxHeight: number | null = null;
    let prevTxTimestamp: number | null = null;

    for (let i = 0; i < blocks.length; i++) {
      const curr = blocks[i]!;
      const prev = blocks[i - 1];

      if (prev !== undefined && curr.height === prev.height + 1) {
        const currPrev = stripHexPrefix(curr.prev_hash).toLowerCase();
        const prevHash = stripHexPrefix(prev.header_hash).toLowerCase();
        if (currPrev !== prevHash) {
          anomalies.push({
            type: 'chain_break',
            height: curr.height,
            timestamp: fmt(curr.timestamp),
            detail: `Block ${curr.height}.prev_hash (${currPrev.slice(0, 12)}…) does not match block ${prev.height}.header_hash (${prevHash.slice(0, 12)}…)`,
          });
        }

        const currW = BigInt(curr.weight);
        const prevW = BigInt(prev.weight);
        if (currW < prevW) {
          anomalies.push({
            type: 'weight_regression',
            height: curr.height,
            timestamp: fmt(curr.timestamp),
            detail: `Weight decreased from ${prev.weight} at height ${prev.height} to ${curr.weight} at height ${curr.height}`,
          });
        }
      }

      if (curr.timestamp != null) {
        if (prevTxTimestamp != null && curr.timestamp < prevTxTimestamp) {
          anomalies.push({
            type: 'timestamp_regression',
            height: curr.height,
            timestamp: fmt(curr.timestamp),
            detail: `Timestamp went backwards: block ${prevTxHeight} (${fmt(prevTxTimestamp)}) → block ${curr.height} (${fmt(curr.timestamp)})`,
          });
        }
        prevTxHeight = curr.height;
        prevTxTimestamp = curr.timestamp;
      }
    }

    const txBlockCount = blocks.filter((b) => b.timestamp != null).length;

    const out = {
      network: args.network,
      start_height: args.startHeight,
      end_height: args.endHeight,
      blocks_scanned: blocks.length,
      transaction_blocks_scanned: txBlockCount,
      anomalies_found: anomalies.length,
      anomalies,
      consistent: anomalies.length === 0,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  } catch (err) {
    process.stderr.write(`Error: ${safeMessage(err)}\n`);
    return 1;
  }
}
