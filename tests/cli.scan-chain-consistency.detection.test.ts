import { describe, expect, it, vi } from 'vitest';
import { createChiaAgentMocks } from './helpers/chia-agent-mocks.js';

// Tests for runScanChainConsistencyCli's anomaly detection logic.
// Mocks chia-agent's get_block_records to feed synthetic block sequences,
// then captures stdout to inspect the emitted JSON.

const mocks = createChiaAgentMocks();
vi.mock('chia-agent/api/rpc/full_node/index.js', () => mocks);

const { runScanChainConsistencyCli } = await import(
  '../src/cli/scan-chain-consistency.js'
);

function captureStdio(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s: string | Uint8Array): boolean => {
    stdout.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
    return true;
  };
  process.stderr.write = (s: string | Uint8Array): boolean => {
    stderr.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
    return true;
  };
  return {
    stdout,
    stderr,
    restore() {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    },
  };
}

type BlockRow = {
  height: number;
  header_hash: string;
  prev_hash: string;
  weight: number;
  timestamp: number | null;
};

async function scan(blocks: BlockRow[], start: number, end: number): Promise<{
  json: Record<string, unknown>;
  status: number;
}> {
  mocks.get_block_records.mockImplementation(
    (_agent: unknown, args: { start: number; end: number }) => {
      return Promise.resolve({
        block_records: blocks.filter(
          (b) => b.height >= args.start && b.height < args.end
        ),
      });
    }
  );
  const io = captureStdio();
  try {
    const status = await runScanChainConsistencyCli([
      '--start-height',
      String(start),
      '--end-height',
      String(end),
    ]);
    const out = io.stdout.join('');
    if (out === '') {
      throw new Error(`empty stdout; stderr: ${io.stderr.join('')}`);
    }
    return { json: JSON.parse(out) as Record<string, unknown>, status };
  } finally {
    io.restore();
  }
}

function block(opts: Partial<BlockRow> & { height: number; prev_hash: string }): BlockRow {
  return {
    height: opts.height,
    header_hash: opts.header_hash ?? `h${opts.height}`,
    prev_hash: opts.prev_hash,
    weight: opts.weight ?? opts.height * 100,
    timestamp: opts.timestamp ?? null,
  };
}

describe('runScanChainConsistencyCli — anomaly detection', () => {
  it('reports consistent=true with empty anomalies when the chain is well-formed', async () => {
    const blocks: BlockRow[] = [
      block({ height: 100, prev_hash: 'h99', timestamp: 1700000000 }),
      block({ height: 101, prev_hash: 'h100', timestamp: 1700000060 }),
      block({ height: 102, prev_hash: 'h101', timestamp: 1700000120 }),
    ];
    const { json, status } = await scan(blocks, 100, 102);
    expect(status).toBe(0);
    expect(json.consistent).toBe(true);
    expect(json.anomalies_found).toBe(0);
    expect(json.anomalies).toEqual([]);
    expect(json.blocks_scanned).toBe(3);
    expect(json.transaction_blocks_scanned).toBe(3);
  });

  it('detects chain_break when block.prev_hash does not match the previous block.header_hash', async () => {
    const blocks: BlockRow[] = [
      block({ height: 100, header_hash: 'h100', prev_hash: 'h99' }),
      block({ height: 101, header_hash: 'h101', prev_hash: 'WRONG_PARENT' }),
      block({ height: 102, header_hash: 'h102', prev_hash: 'h101' }),
    ];
    const { json } = await scan(blocks, 100, 102);
    expect(json.consistent).toBe(false);
    const anomalies = json.anomalies as Array<Record<string, unknown>>;
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.type).toBe('chain_break');
    expect(anomalies[0]!.height).toBe(101);
    expect(anomalies[0]!.detail).toMatch(/does not match/);
  });

  it('detects weight_regression when weight decreases between consecutive blocks', async () => {
    const blocks: BlockRow[] = [
      block({ height: 100, header_hash: 'h100', prev_hash: 'h99', weight: 50000 }),
      block({ height: 101, header_hash: 'h101', prev_hash: 'h100', weight: 49000 }), // ← regression
      block({ height: 102, header_hash: 'h102', prev_hash: 'h101', weight: 51000 }),
    ];
    const { json } = await scan(blocks, 100, 102);
    const anomalies = json.anomalies as Array<Record<string, unknown>>;
    expect(anomalies.some((a) => a.type === 'weight_regression' && a.height === 101)).toBe(true);
  });

  it('handles bigint weight (the chia-agent type is sometimes number | bigint)', async () => {
    // The production code calls BigInt(weight) before comparing. Verify
    // that path by feeding actual bigint values (which is what chia-agent
    // can return for fields too large for a JS number).
    const blocks = [
      { height: 100, header_hash: 'h100', prev_hash: 'h99', weight: 9_007_199_254_740_993n, timestamp: null },
      { height: 101, header_hash: 'h101', prev_hash: 'h100', weight: 9_007_199_254_740_994n, timestamp: null },
    ] as unknown as BlockRow[];
    const { json } = await scan(blocks, 100, 101);
    expect(json.consistent).toBe(true);
  });

  it('detects timestamp_regression across transaction blocks', async () => {
    const blocks: BlockRow[] = [
      block({ height: 100, header_hash: 'h100', prev_hash: 'h99', timestamp: 1700000000 }),
      block({ height: 101, header_hash: 'h101', prev_hash: 'h100', timestamp: null }), // non-tx
      block({ height: 102, header_hash: 'h102', prev_hash: 'h101', timestamp: 1699999990 }), // ← went backward
    ];
    const { json } = await scan(blocks, 100, 102);
    const anomalies = json.anomalies as Array<Record<string, unknown>>;
    const tsAnomaly = anomalies.find((a) => a.type === 'timestamp_regression');
    expect(tsAnomaly).toBeDefined();
    expect(tsAnomaly!.height).toBe(102);
    expect(tsAnomaly!.detail).toMatch(/Timestamp went backwards/);
  });

  it('does NOT flag timestamp_regression across NON-tx gap when next tx-block restores forward order', async () => {
    // 100 (tx, t=1700000000) → 101 (non-tx) → 102 (tx, t=1700000120) — fine.
    const blocks: BlockRow[] = [
      block({ height: 100, header_hash: 'h100', prev_hash: 'h99', timestamp: 1700000000 }),
      block({ height: 101, header_hash: 'h101', prev_hash: 'h100', timestamp: null }),
      block({ height: 102, header_hash: 'h102', prev_hash: 'h101', timestamp: 1700000120 }),
    ];
    const { json } = await scan(blocks, 100, 102);
    const anomalies = json.anomalies as Array<Record<string, unknown>>;
    expect(anomalies.filter((a) => a.type === 'timestamp_regression')).toHaveLength(0);
  });

  it('does NOT check prev_hash linkage across height gaps (skipped/missing blocks)', async () => {
    // Block 101 missing from the response — the comparison logic only
    // checks linkage when curr.height === prev.height + 1.
    const blocks: BlockRow[] = [
      block({ height: 100, header_hash: 'h100', prev_hash: 'h99' }),
      block({ height: 102, header_hash: 'h102', prev_hash: 'h101' }),
    ];
    const { json } = await scan(blocks, 100, 102);
    expect((json.anomalies as Array<Record<string, unknown>>).filter((a) => a.type === 'chain_break')).toHaveLength(0);
  });

  it('reports all three anomaly types simultaneously when all conditions trigger', async () => {
    const blocks: BlockRow[] = [
      block({ height: 100, header_hash: 'h100', prev_hash: 'h99', weight: 50000, timestamp: 1700000000 }),
      block({ height: 101, header_hash: 'h101', prev_hash: 'WRONG', weight: 49000, timestamp: 1699999990 }),
    ];
    const { json } = await scan(blocks, 100, 101);
    const types = (json.anomalies as Array<Record<string, unknown>>).map((a) => a.type).sort();
    expect(types).toEqual(['chain_break', 'timestamp_regression', 'weight_regression']);
  });

  it('strips 0x prefix from prev_hash and header_hash before comparing (no false chain_break)', async () => {
    const blocks: BlockRow[] = [
      block({ height: 100, header_hash: 'h100', prev_hash: 'h99' }),
      block({ height: 101, header_hash: '0xh101', prev_hash: '0xh100' }),
    ];
    const { json } = await scan(blocks, 100, 101);
    expect(json.consistent).toBe(true);
  });

  it('handles batched fetching: blocks spanning multiple BATCH_SIZE windows', async () => {
    // BATCH_SIZE = 1000 in the production code. Verify the loop concatenates.
    const blocks: BlockRow[] = [];
    for (let h = 100; h < 2500; h++) {
      blocks.push(block({ height: h, prev_hash: `h${h - 1}` }));
    }
    const { json } = await scan(blocks, 100, 2499);
    expect(json.consistent).toBe(true);
    expect(json.blocks_scanned).toBe(2400);
    // Verify get_block_records was called multiple times (batched).
    expect(mocks.get_block_records.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('sorts the assembled blocks by height regardless of fetch order', async () => {
    // Return them out of order to verify the sort step works.
    mocks.get_block_records.mockImplementation(
      (_agent: unknown, args: { start: number; end: number }) => {
        const rows = [
          block({ height: 102, header_hash: 'h102', prev_hash: 'h101' }),
          block({ height: 100, header_hash: 'h100', prev_hash: 'h99' }),
          block({ height: 101, header_hash: 'h101', prev_hash: 'h100' }),
        ].filter((b) => b.height >= args.start && b.height < args.end);
        return Promise.resolve({ block_records: rows });
      }
    );
    const io = captureStdio();
    try {
      const status = await runScanChainConsistencyCli([
        '--start-height',
        '100',
        '--end-height',
        '102',
      ]);
      const json = JSON.parse(io.stdout.join('')) as Record<string, unknown>;
      expect(status).toBe(0);
      expect(json.consistent).toBe(true);
    } finally {
      io.restore();
    }
  });

  it('returns 1 with stderr error message when the RPC throws', async () => {
    mocks.get_block_records.mockRejectedValueOnce(new Error('network unreachable'));
    const io = captureStdio();
    try {
      const status = await runScanChainConsistencyCli([
        '--start-height',
        '100',
        '--end-height',
        '101',
      ]);
      expect(status).toBe(1);
      expect(io.stderr.join('')).toMatch(/Error:.*network unreachable/);
    } finally {
      io.restore();
    }
  });
});
