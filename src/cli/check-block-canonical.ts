import { get_block_record_by_height } from 'chia-agent/api/rpc/full_node/index.js';
import { stripHexPrefix } from '../chia/hex.js';
import { getAgent } from '../coinset/agent.js';
import { type Network, NETWORKS } from '../network.js';
import { safeMessage } from '../util/safe-message.js';

export type ParsedArgs = {
  height: number;
  expectedHash: string;
  network: Network;
};

export class HelpRequested extends Error {
  constructor() {
    super('help');
    this.name = 'HelpRequested';
  }
}

const HELP_TEXT = `Usage: chia-reorg-info check_block_canonical [options]

Check whether the block at <height> on the chain matches an expected
header hash. Returns canonical=true if it matches, canonical=false if
the block has been re-orged out (and reports what is currently at that
height).

Options:
  --height <N>           Block height to check (required)
  --expected-hash <HEX>  32-byte header hash you expect to be canonical
                         (required; \`0x\` prefix optional)
  --network <name>       mainnet (default) or testnet11
  --help, -h             Show this help

Output: JSON object on stdout.
`;

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let height: number | undefined;
  let expectedHash: string | undefined;
  let network: Network = 'mainnet';

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const take = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${flag ?? '<flag>'}`);
      return v;
    };
    switch (flag) {
      case '--height': {
        const raw = take();
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) {
          throw new Error(`--height must be a non-negative integer (got "${raw}")`);
        }
        height = n;
        break;
      }
      case '--expected-hash':
        expectedHash = take();
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

  if (height === undefined) throw new Error('--height is required');
  if (expectedHash === undefined) throw new Error('--expected-hash is required');

  const cleaned = stripHexPrefix(expectedHash).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(cleaned)) {
    throw new Error('--expected-hash must be a 64-character hex string');
  }

  return { height, expectedHash: cleaned, network };
}

export async function runCheckBlockCanonicalCli(argv: readonly string[]): Promise<number> {
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
    const res = await get_block_record_by_height(agent, { height: args.height });
    const currentHashRaw = res.block_record?.header_hash ?? null;
    const current = currentHashRaw ? stripHexPrefix(currentHashRaw).toLowerCase() : null;
    const out = {
      network: args.network,
      height: args.height,
      canonical: current === args.expectedHash,
      expected_header_hash: args.expectedHash,
      current_header_hash: current,
      current_block_record: res.block_record ?? null,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  } catch (err) {
    process.stderr.write(`Error: ${safeMessage(err)}\n`);
    return 1;
  }
}
