import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// End-to-end tests for scripts/reorg-finder.sh against synthetic SQLite
// fixtures. Verifies the core scan + cluster logic (text mode, -q, -qq,
// --json, -e, -n, -m) — i.e. the parts that don't need chia-blockchain.
// Modes that DO need chia (--compare-proofs, --aggregate-stats, --json
// `old_block_record`) are tested separately in tests/python-helpers.test.ts
// and aren't exercised here because the real chia python package isn't
// reliably available.

const SCRIPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'reorg-finder.sh'
);

function hasSqlite3(): boolean {
  return spawnSync('sqlite3', ['-version'], { encoding: 'utf8' }).status === 0;
}

/** Run the script with given args. Return stdout / stderr / status.
 *  Forces the two RPC endpoints (local node + coinset fallback) at
 *  non-routable addresses so the timestamp-lookup curls fail
 *  instantly (TCP RST on port 1) rather than waiting for the script's
 *  built-in 3s --max-time. Each reorg cluster makes up to 32 such calls
 *  via the forward-walk in get_block_timestamp; without this override,
 *  multi-reorg tests would take minutes. */
function run(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const env = {
    ...process.env,
    NODE_HOST: 'https://127.0.0.1:1',
    COINSET_HOST: 'https://127.0.0.1:1',
    CHIA_SSL_DIR: '/nonexistent/ssl/dir', // local cert check fails before curl
  };
  const r = spawnSync('bash', [SCRIPT_PATH, ...args], { encoding: 'utf8', env });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

/** Build the minimum schema reorg-finder.sh queries and return the DB path. */
function buildDb(
  dir: string,
  blocks: Array<{
    height: number;
    header_hash: string;
    prev_hash?: string;
    in_main_chain: 0 | 1;
  }>
): string {
  const dbPath = join(dir, 'test.sqlite');
  // Schema mirrors the relevant columns of Chia v2's `full_blocks`.
  // The script reads height, header_hash, prev_hash, in_main_chain.
  const createSql = `
    CREATE TABLE full_blocks (
      height INTEGER,
      header_hash BLOB,
      prev_hash BLOB,
      in_main_chain INTEGER
    );
  `;
  const inserts = blocks
    .map((b) => {
      const ph = b.prev_hash ?? '00'.repeat(32);
      return `INSERT INTO full_blocks(height, header_hash, prev_hash, in_main_chain) VALUES(${b.height}, x'${b.header_hash}', x'${ph}', ${b.in_main_chain});`;
    })
    .join('\n');
  const r = spawnSync('sqlite3', [dbPath, createSql + '\n' + inserts], {
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`sqlite3 build failed: ${r.stderr}`);
  return dbPath;
}

describe('reorg-finder.sh end-to-end (synthetic DB)', () => {
  if (!hasSqlite3()) {
    it.skip('sqlite3 CLI not installed; skipping', () => {});
    return;
  }

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reorg-finder-e2e-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports "No re-orged heights found" when every height has exactly one block', () => {
    // 5 heights, each with one canonical block. No siblings → no reorg.
    const db = buildDb(
      dir,
      Array.from({ length: 5 }, (_, i) => ({
        height: 100 + i,
        header_hash: `a${i}`.padEnd(64, '0'),
        in_main_chain: 1 as const,
      }))
    );
    const r = run(['-d', db, '-e', '104', '-n', '5', '--peak-from', 'db']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No re-orged heights found in range.');
  });

  it('detects a 1-block reorg from a height with two records', () => {
    // Height 102 has two records → reorg cluster of size 1.
    const db = buildDb(dir, [
      { height: 100, header_hash: 'a0'.padEnd(64, '0'), in_main_chain: 1 },
      { height: 101, header_hash: 'a1'.padEnd(64, '0'), in_main_chain: 1 },
      { height: 102, header_hash: 'a2'.padEnd(64, '0'), in_main_chain: 1 },
      { height: 102, header_hash: 'b2'.padEnd(64, '0'), in_main_chain: 0 },
      { height: 103, header_hash: 'a3'.padEnd(64, '0'), in_main_chain: 1 },
      { height: 104, header_hash: 'a4'.padEnd(64, '0'), in_main_chain: 1 },
    ]);
    const r = run(['-d', db, '-e', '104', '-n', '5', '--peak-from', 'db']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Found a reorg of 1 block(s) (heights 102..102)');
  });

  it('clusters two consecutive reorged heights into one depth-2 event', () => {
    const db = buildDb(dir, [
      { height: 100, header_hash: 'a0'.padEnd(64, '0'), in_main_chain: 1 },
      { height: 101, header_hash: 'a1'.padEnd(64, '0'), in_main_chain: 1 },
      { height: 101, header_hash: 'b1'.padEnd(64, '0'), in_main_chain: 0 },
      { height: 102, header_hash: 'a2'.padEnd(64, '0'), in_main_chain: 1 },
      { height: 102, header_hash: 'b2'.padEnd(64, '0'), in_main_chain: 0 },
      { height: 103, header_hash: 'a3'.padEnd(64, '0'), in_main_chain: 1 },
    ]);
    const r = run(['-d', db, '-e', '103', '-n', '4', '--peak-from', 'db']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Found a reorg of 2 block(s) (heights 101..102)');
  });

  it('separates non-consecutive reorged heights into distinct events', () => {
    const db = buildDb(dir, [
      { height: 100, header_hash: 'a0'.padEnd(64, '0'), in_main_chain: 1 },
      { height: 100, header_hash: 'b0'.padEnd(64, '0'), in_main_chain: 0 },
      { height: 101, header_hash: 'a1'.padEnd(64, '0'), in_main_chain: 1 },
      { height: 102, header_hash: 'a2'.padEnd(64, '0'), in_main_chain: 1 },
      { height: 103, header_hash: 'a3'.padEnd(64, '0'), in_main_chain: 1 },
      { height: 103, header_hash: 'b3'.padEnd(64, '0'), in_main_chain: 0 },
    ]);
    const r = run(['-d', db, '-e', '103', '-n', '4', '--peak-from', 'db']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Found 2 reorgs:');
    expect(r.stdout).toMatch(/heights 100\.\.100/);
    expect(r.stdout).toMatch(/heights 103\.\.103/);
  });

  it('-m filters out reorgs shallower than the minimum depth', () => {
    // Two reorgs: one depth-1, one depth-2. -m 2 should drop the depth-1.
    const db = buildDb(dir, [
      { height: 100, header_hash: 'a0'.padEnd(64, '0'), in_main_chain: 1 },
      { height: 100, header_hash: 'b0'.padEnd(64, '0'), in_main_chain: 0 },
      { height: 101, header_hash: 'a1'.padEnd(64, '0'), in_main_chain: 1 },
      { height: 102, header_hash: 'a2'.padEnd(64, '0'), in_main_chain: 1 },
      { height: 102, header_hash: 'b2'.padEnd(64, '0'), in_main_chain: 0 },
      { height: 103, header_hash: 'a3'.padEnd(64, '0'), in_main_chain: 1 },
      { height: 103, header_hash: 'b3'.padEnd(64, '0'), in_main_chain: 0 },
    ]);
    const r = run(['-d', db, '-e', '103', '-n', '4', '--peak-from', 'db', '-m', '2']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Found a reorg of 2 block(s) (heights 102..103)');
    expect(r.stdout).not.toMatch(/100\.\.100/);
  });

  it('-qq emits the one-line summary and nothing else', () => {
    const db = buildDb(dir, [
      { height: 100, header_hash: 'a0'.padEnd(64, '0'), in_main_chain: 1 },
      { height: 100, header_hash: 'b0'.padEnd(64, '0'), in_main_chain: 0 },
      { height: 101, header_hash: 'a1'.padEnd(64, '0'), in_main_chain: 1 },
    ]);
    const r = run(['-d', db, '-e', '101', '-n', '2', '--peak-from', 'db', '-qq']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(
      'Found 1 reorgs of at least 1 blocks in the specified range.'
    );
  });

  it('-q suppresses the per-block detail section but keeps the summary', () => {
    const db = buildDb(dir, [
      { height: 100, header_hash: 'a0'.padEnd(64, '0'), in_main_chain: 1 },
      { height: 100, header_hash: 'b0'.padEnd(64, '0'), in_main_chain: 0 },
      { height: 101, header_hash: 'a1'.padEnd(64, '0'), in_main_chain: 1 },
    ]);
    const r = run(['-d', db, '-e', '101', '-n', '2', '--peak-from', 'db', '-q']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Found a reorg of 1 block(s) (heights 100..100)');
    expect(r.stdout).not.toContain('Per-block detail');
  });

  it('--json emits a single JSON object with the documented shape', () => {
    const db = buildDb(dir, [
      { height: 100, header_hash: 'a0'.padEnd(64, '0'), in_main_chain: 1 },
      { height: 100, header_hash: 'b0'.padEnd(64, '0'), in_main_chain: 0 },
      { height: 101, header_hash: 'a1'.padEnd(64, '0'), in_main_chain: 1 },
    ]);
    const r = run(['-d', db, '-e', '101', '-n', '2', '--peak-from', 'db', '--json']);
    expect(r.status).toBe(0);
    // The output may include lines like "# missing:" from the
    // _decode_block_record helper (when chia isn't installed) on stderr,
    // but stdout must be a single valid JSON object.
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(parsed.network).toBe('mainnet');
    expect(parsed.start_height).toBe(100);
    expect(parsed.end_height).toBe(101);
    expect(parsed.peak_at_scan).toBe(101);
    const reorgs = parsed.reorgs as Array<Record<string, unknown>>;
    expect(reorgs).toHaveLength(1);
    expect(reorgs[0]!.low).toBe(100);
    expect(reorgs[0]!.high).toBe(100);
    expect(reorgs[0]!.depth).toBe(1);
    expect(reorgs[0]!.old_hash).toBe('b0'.padEnd(64, '0'));
    expect(reorgs[0]!.new_hash).toBe('a0'.padEnd(64, '0'));
  });

  it('--json emits reorgs: [] for a clean range', () => {
    const db = buildDb(dir, [
      { height: 100, header_hash: 'a0'.padEnd(64, '0'), in_main_chain: 1 },
      { height: 101, header_hash: 'a1'.padEnd(64, '0'), in_main_chain: 1 },
    ]);
    const r = run(['-d', db, '-e', '101', '-n', '2', '--peak-from', 'db', '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(parsed.reorgs).toEqual([]);
  });

  it('--json + -q is rejected with an error', () => {
    const db = buildDb(dir, [
      { height: 100, header_hash: 'a0'.padEnd(64, '0'), in_main_chain: 1 },
    ]);
    const r = run(['-d', db, '-e', '100', '-n', '1', '--peak-from', 'db', '--json', '-q']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--json is incompatible with -q/);
  });

  it('--peak-from db rejects an unreadable DB path with a clear error', () => {
    const r = run(['-d', '/nonexistent/path.sqlite', '--peak-from', 'db', '-n', '5']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--peak-from db requires a readable DB/);
  });

  it('rejects invalid -n value', () => {
    const r = run(['-n', 'oops']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/-n COUNT must be a positive integer/);
  });

  it('rejects invalid --peak-from value', () => {
    const r = run(['--peak-from', 'sky']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--peak-from must be 'rpc' or 'db'/);
  });

  it('--aggregate-stats + --json is rejected (mutually exclusive output modes)', () => {
    const r = run(['--aggregate-stats', '--json']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--aggregate-stats is incompatible with --json/);
  });
});
