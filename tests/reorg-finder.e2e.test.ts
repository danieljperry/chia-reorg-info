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

  // ---- -b/--bridge flag tests ----
  // These verify flag parsing, validation, and that Bridge Info shows up
  // in the right places. The actual byte-search / spend-extraction
  // behavior is tested separately in bridge-formatter.test.ts. Here we
  // can't drive the helper end-to-end because the synthetic test DB
  // doesn't have chia FullBlock blobs — the helper would fall through
  // to its "couldn't decompress" path, which is fine for these tests.

  it('-b + -qq is now ACCEPTED and emits the Bridge Info section at full detail', () => {
    // Spec change: -qq used to reject -b. Now it's allowed; the bridge
    // section comes through with the same detail as no-quiet mode. -qq's
    // suppression of the per-reorg list still applies (we get only the
    // one-line count + Bridge Info).
    const db = buildDb(
      dir,
      Array.from({ length: 5 }, (_, i) => ({
        height: 100 + i,
        header_hash: `a${i}`.padEnd(64, '0'),
        in_main_chain: 1 as const,
      }))
    );
    const r = run(['-d', db, '-e', '104', '-n', '5', '--peak-from', 'db', '-b', '-qq']);
    expect(r.status).toBe(0);
    // -qq's normal output: just the one-line count.
    expect(r.stdout).toMatch(/Found 0 reorgs of at least 1 blocks/);
    // Bridge Info still appears.
    expect(r.stdout).toContain('Bridge Info:');
    expect(r.stdout).toContain(
      'No bridge transfers were found in any reorged blocks from this query.'
    );
    // Per-block detail (which -q would also suppress) is NOT present.
    expect(r.stdout).not.toContain('Per-block detail');
  });

  it('--bridge + -qq is also accepted (long form)', () => {
    const db = buildDb(dir, [
      { height: 100, header_hash: 'a0'.padEnd(64, '0'), in_main_chain: 1 },
    ]);
    const r = run(['-d', db, '-e', '100', '-n', '1', '--peak-from', 'db', '--bridge', '-qq']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Bridge Info:');
  });

  it('-b on a clean DB (no reorgs) emits the "no transfers" line', () => {
    const db = buildDb(
      dir,
      Array.from({ length: 5 }, (_, i) => ({
        height: 100 + i,
        header_hash: `a${i}`.padEnd(64, '0'),
        in_main_chain: 1 as const,
      }))
    );
    const r = run(['-d', db, '-e', '104', '-n', '5', '--peak-from', 'db', '-b']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Bridge Info:');
    expect(r.stdout).toContain(
      'No bridge transfers were found in any reorged blocks from this query.'
    );
  });

  it('-b on a DB with reorgs emits the Bridge Info section after the per-block detail', () => {
    // One reorg at 102. The helper will try to decode the orphan block;
    // since the synthetic DB has no real FullBlock blob, decode fails and
    // every orphan returns no match — "no transfers" is the expected line.
    const db = buildDb(dir, [
      { height: 100, header_hash: 'a0'.padEnd(64, '0'), in_main_chain: 1 },
      { height: 101, header_hash: 'a1'.padEnd(64, '0'), in_main_chain: 1 },
      { height: 102, header_hash: 'a2'.padEnd(64, '0'), in_main_chain: 1 },
      { height: 102, header_hash: 'b2'.padEnd(64, '0'), in_main_chain: 0 },
      { height: 103, header_hash: 'a3'.padEnd(64, '0'), in_main_chain: 1 },
      { height: 104, header_hash: 'a4'.padEnd(64, '0'), in_main_chain: 1 },
    ]);
    const r = run(['-d', db, '-e', '104', '-n', '5', '--peak-from', 'db', '-b']);
    expect(r.status).toBe(0);
    // The reorg summary is still emitted.
    expect(r.stdout).toContain('Found a reorg of 1 block(s) (heights 102..102)');
    // Bridge Info section is present at the end.
    expect(r.stdout).toContain('Bridge Info:');
    // Ordering: Bridge Info comes AFTER the reorg summary.
    expect(r.stdout.indexOf('Bridge Info:')).toBeGreaterThan(
      r.stdout.indexOf('Found a reorg of')
    );
  });

  it('-b with --json does NOT inject prose into the JSON (JSON stays valid)', () => {
    const db = buildDb(
      dir,
      Array.from({ length: 5 }, (_, i) => ({
        height: 100 + i,
        header_hash: `a${i}`.padEnd(64, '0'),
        in_main_chain: 1 as const,
      }))
    );
    const r = run(['-d', db, '-e', '104', '-n', '5', '--peak-from', 'db', '-b', '--json']);
    expect(r.status).toBe(0);
    // stdout should be exactly one JSON object — Bridge Info is suppressed
    // under --json since the output is meant to be parsed.
    expect(() => {
      JSON.parse(r.stdout);
    }).not.toThrow();
    expect(r.stdout).not.toContain('Bridge Info');
  });

  it('help text mentions -b/--bridge', () => {
    const r = run(['-h']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/-b, --bridge/);
    expect(r.stdout).toMatch(/Warp\.green/);
    expect(r.stdout).toMatch(/a09eb1ea/);
  });
});
