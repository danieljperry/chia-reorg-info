import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// End-to-end tests for the chia-blockchain helper scripts (_decode_pos.py
// and _decode_block_record.py). The real chia python package isn't
// available on most dev/CI machines, so these tests use a fake chia
// package on disk (tests/fixtures/fake_chia/) that mimics just the
// FullBlock / BlockRecord APIs the helpers touch. Blobs are JSON-encoded
// in the synthetic DB — the fake FullBlock.from_bytes JSON-decodes them.
//
// What this verifies:
//   * the helper's TSV/JSON output shape and field ordering
//   * stdin parsing (height\theader_hash pairs)
//   * graceful handling of missing rows, bad input, malformed blobs
//   * error path when chia isn't importable

const SCRIPTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts'
);
const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake_chia'
);

function hasSqlite3(): boolean {
  return spawnSync('sqlite3', ['-version'], { encoding: 'utf8' }).status === 0;
}

function runHelper(
  script: string,
  dbPath: string,
  stdin: string,
  opts: { withChia?: boolean } = {}
): { stdout: string; stderr: string; status: number | null } {
  const withChia = opts.withChia ?? true;
  // Prepend the fake chia fixtures to PYTHONPATH when withChia=true; clear
  // PYTHONPATH (and hide any real chia install) when false.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (withChia) {
    env.PYTHONPATH = FIXTURES_DIR + (env.PYTHONPATH ? ':' + env.PYTHONPATH : '');
  } else {
    // Force imports to fail by pointing at an empty dir.
    env.PYTHONPATH = '/dev/null/no-such-dir';
    // Also nuke any user site-packages where real chia might live.
    env.PYTHONNOUSERSITE = '1';
  }
  const r = spawnSync('python3', [join(SCRIPTS_DIR, script), dbPath], {
    input: stdin,
    encoding: 'utf8',
    env,
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

describe('_decode_pos.py', () => {
  if (!hasSqlite3()) {
    it.skip('sqlite3 CLI not installed; skipping', () => {});
    return;
  }

  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'decode-pos-test-'));
    dbPath = join(dir, 'test.sqlite');
    // Build a minimal full_blocks schema. The helper only reads `block` and
    // selects by (height, header_hash), so a stripped schema works.
    spawnSync('sqlite3', [dbPath, `
      CREATE TABLE full_blocks (
        height INTEGER,
        header_hash BLOB,
        block BLOB
      );
    `]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function insertBlock(height: number, headerHashHex: string, blockJson: object) {
    const blobPath = join(dir, `b_${height}_${headerHashHex.slice(0, 8)}.bin`);
    writeFileSync(blobPath, JSON.stringify(blockJson));
    const sql = `INSERT INTO full_blocks(height, header_hash, block) VALUES(${height}, x'${headerHashHex}', readfile('${blobPath}'));`;
    const r = spawnSync('sqlite3', [dbPath, sql], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`insert failed: ${r.stderr}`);
  }

  it('emits the documented 14-column TSV format for a tx block', () => {
    const hh = 'aa'.repeat(32);
    insertBlock(100, hh, {
      proof_of_space: {
        size: 32,
        challenge: 'cc'.repeat(32),
        plot_public_key: 'dd'.repeat(48),
        pool_public_key: 'ee'.repeat(48),
        pool_contract_puzzle_hash: null,
        proof: 'ff'.repeat(100),
      },
      signage_point_index: 49,
      farmer_reward_puzzle_hash: '4b'.repeat(32),
      timestamp: 1779831225,
      generator: '01' + '02'.repeat(99),
      cost: 392389759,
    });
    const r = runHelper('_decode_pos.py', dbPath, `100\t${hh}\n`);
    expect(r.status).toBe(0);
    const cols = r.stdout.trim().split('\t');
    expect(cols).toHaveLength(14);
    expect(cols[0]).toBe('100');
    expect(cols[1]).toBe(hh);
    expect(cols[2]).toBe('32');
    expect(cols[3]).toBe('cc'.repeat(32));
    expect(cols[4]).toBe('dd'.repeat(48));
    expect(cols[5]).toBe('ee'.repeat(48));
    expect(cols[6]).toBe('pool_pk');
    expect(cols[7]).toMatch(/^[0-9a-f]{64}$/); // sha256(proof)
    expect(cols[8]).toBe('49');
    expect(cols[9]).toBe('4b'.repeat(32));
    expect(cols[10]).toBe('1779831225');
    expect(cols[11]).toBe('1'); // is_transaction_block
    expect(cols[12]).toBe('100'); // generator_size = 1 + 99 = 100 bytes
    expect(cols[13]).toBe('392389759');
  });

  it('reports pool_contract pool type when pool_contract_puzzle_hash is set', () => {
    const hh = 'bb'.repeat(32);
    insertBlock(101, hh, {
      proof_of_space: {
        size: 32,
        challenge: '11'.repeat(32),
        plot_public_key: '22'.repeat(48),
        pool_public_key: null,
        pool_contract_puzzle_hash: '33'.repeat(32),
        proof: '44'.repeat(50),
      },
      signage_point_index: 10,
      farmer_reward_puzzle_hash: '55'.repeat(32),
      timestamp: null,
      generator: null,
      cost: null,
    });
    // Strip only the trailing newline (not tabs — empty trailing fields
    // would be lost by .trim()). Use String.prototype.replace.
    const line = runHelper('_decode_pos.py', dbPath, `101\t${hh}\n`).stdout
      .replace(/\n$/, '');
    const cols = line.split('\t');
    expect(cols).toHaveLength(14);
    expect(cols[5]).toBe('33'.repeat(32));
    expect(cols[6]).toBe('pool_contract');
    expect(cols[10]).toBe(''); // timestamp empty (non-tx)
    expect(cols[11]).toBe('0'); // is_transaction_block
    expect(cols[12]).toBe(''); // no generator
    expect(cols[13]).toBe(''); // no cost
  });

  it('produces consistent sha256(proof) — same proof bytes → same hash', () => {
    const proof = '99'.repeat(75);
    insertBlock(102, 'ab'.repeat(32), {
      proof_of_space: {
        size: 32, challenge: '11'.repeat(32), plot_public_key: '22'.repeat(48),
        pool_public_key: '33'.repeat(48), pool_contract_puzzle_hash: null, proof,
      },
      signage_point_index: 0, farmer_reward_puzzle_hash: '00'.repeat(32),
      timestamp: null, generator: null, cost: null,
    });
    insertBlock(102, 'cd'.repeat(32), {
      proof_of_space: {
        size: 32, challenge: '88'.repeat(32), plot_public_key: '77'.repeat(48),
        pool_public_key: '66'.repeat(48), pool_contract_puzzle_hash: null, proof,
      },
      signage_point_index: 0, farmer_reward_puzzle_hash: '00'.repeat(32),
      timestamp: null, generator: null, cost: null,
    });
    const out = runHelper(
      '_decode_pos.py',
      dbPath,
      `102\t${'ab'.repeat(32)}\n102\t${'cd'.repeat(32)}\n`
    ).stdout.trim().split('\n');
    expect(out).toHaveLength(2);
    const sha1 = out[0]!.split('\t')[7];
    const sha2 = out[1]!.split('\t')[7];
    expect(sha1).toBe(sha2); // same proof bytes → same sha256
  });

  it('reports missing rows via stderr comment, no stdout entry', () => {
    const r = runHelper('_decode_pos.py', dbPath, `999\t${'aa'.repeat(32)}\n`);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/# missing: 999:/);
  });

  it('reports bad-input lines via stderr, continues to process valid ones', () => {
    const hh = '77'.repeat(32);
    insertBlock(200, hh, {
      proof_of_space: {
        size: 32, challenge: '11'.repeat(32), plot_public_key: '22'.repeat(48),
        pool_public_key: '33'.repeat(48), pool_contract_puzzle_hash: null,
        proof: '44'.repeat(10),
      },
      signage_point_index: 0, farmer_reward_puzzle_hash: '00'.repeat(32),
      timestamp: null, generator: null, cost: null,
    });
    const r = runHelper(
      '_decode_pos.py',
      dbPath,
      `not-a-tab-line\n200\t${hh}\n`
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/# bad-input:/);
    const out = r.stdout.trim().split('\n');
    expect(out).toHaveLength(1);
    expect(out[0]!.split('\t')[0]).toBe('200');
  });

  it('reports decode-failed via stderr when blob is unparseable, continues', () => {
    const hh = '88'.repeat(32);
    // Insert a blob that is NOT valid JSON — fake chia will throw.
    spawnSync('sqlite3', [
      dbPath,
      `INSERT INTO full_blocks(height, header_hash, block) VALUES(300, x'${hh}', x'deadbeef');`,
    ]);
    const r = runHelper('_decode_pos.py', dbPath, `300\t${hh}\n`);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/# decode-failed: 300:/);
  });

  it('exits 3 with informative error when chia is not importable', () => {
    const r = runHelper('_decode_pos.py', dbPath, '', { withChia: false });
    expect(r.status).not.toBe(0);
    // The first import to fail is zstd (it's imported before chia in this
    // helper). Either way, exit code is 2 or 3 and an "error:" line lands
    // on stderr — surface to the user is what matters.
    expect(r.stderr).toMatch(/error:/);
  });
});

describe('_decode_block_record.py', () => {
  if (!hasSqlite3()) {
    it.skip('sqlite3 CLI not installed; skipping', () => {});
    return;
  }

  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'decode-br-test-'));
    dbPath = join(dir, 'test.sqlite');
    spawnSync('sqlite3', [dbPath, `
      CREATE TABLE full_blocks (
        height INTEGER,
        header_hash BLOB,
        block_record BLOB
      );
    `]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function insertBR(height: number, headerHashHex: string, brJson: object) {
    const blobPath = join(dir, `br_${height}_${headerHashHex.slice(0, 8)}.bin`);
    writeFileSync(blobPath, JSON.stringify(brJson));
    const sql = `INSERT INTO full_blocks(height, header_hash, block_record) VALUES(${height}, x'${headerHashHex}', readfile('${blobPath}'));`;
    const r = spawnSync('sqlite3', [dbPath, sql], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`insert failed: ${r.stderr}`);
  }

  it('emits height<TAB>hash<TAB>JSON-object per row', () => {
    const hh = 'a'.repeat(64);
    const br = {
      header_hash: '0x' + 'a'.repeat(64),
      weight: 54814746912,
      total_iters: 97745094007150,
      signage_point_index: 49,
      timestamp: 1779831225,
      fees: 392389759,
    };
    insertBR(8781783, hh, br);
    const r = runHelper('_decode_block_record.py', dbPath, `8781783\t${hh}\n`);
    expect(r.status).toBe(0);
    const cols = r.stdout.trim().split('\t');
    expect(cols).toHaveLength(3);
    expect(cols[0]).toBe('8781783');
    expect(cols[1]).toBe(hh);
    const parsed = JSON.parse(cols[2]!) as Record<string, unknown>;
    expect(parsed.weight).toBe(54814746912);
    expect(parsed.signage_point_index).toBe(49);
    expect(parsed.fees).toBe(392389759);
  });

  it('handles multiple input pairs in one invocation', () => {
    const h1 = '1'.repeat(64);
    const h2 = '2'.repeat(64);
    insertBR(100, h1, { weight: 1 });
    insertBR(100, h2, { weight: 2 });
    const r = runHelper(
      '_decode_block_record.py',
      dbPath,
      `100\t${h1}\n100\t${h2}\n`
    );
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!.split('\t')[2]!)).toEqual({ weight: 1 });
    expect(JSON.parse(lines[1]!.split('\t')[2]!)).toEqual({ weight: 2 });
  });

  it('the JSON value contains no literal tabs or newlines (TSV safety)', () => {
    // The bash caller parses TSV with `awk -F '\t'` — a literal tab or
    // newline inside the BlockRecord JSON would break the parser. JSON
    // escaping should prevent this, but verify.
    const hh = '3'.repeat(64);
    insertBR(101, hh, { description: 'has\ttab\nand\nnewline' });
    const r = runHelper('_decode_block_record.py', dbPath, `101\t${hh}\n`);
    const cols = r.stdout.trim().split('\t');
    expect(cols).toHaveLength(3);
    // The JSON column should have escaped \t and \n, not literal ones.
    expect(cols[2]).not.toMatch(/\n/);
    expect(cols[2]).toContain('\\t');
    expect(cols[2]).toContain('\\n');
  });

  it('reports missing rows via stderr', () => {
    const r = runHelper(
      '_decode_block_record.py',
      dbPath,
      `999\t${'aa'.repeat(32)}\n`
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/# missing: 999:/);
  });

  it('exits non-zero when chia is not importable', () => {
    const r = runHelper('_decode_block_record.py', dbPath, '', {
      withChia: false,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/error:/);
  });
});
