import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Phase 2: real-bytes round-trip. Decodes REAL chia-serialized blobs (committed
// under tests/fixtures/real_blocks/, extracted from the production node via
// scripts/_extract_real_block_fixtures.sh) with the actual scripts/_decode_*.py
// helpers and asserts the output against a golden manifest. This is the only
// test that exercises the helpers against real bytes; everything else uses the
// fake_chia stub.
//
// Runs ONLY when (a) chia is importable by CHIA_PYTHON (the chia-required CI
// job) AND (b) the fixtures + manifest are present. Otherwise the whole describe
// SELF-SKIPS, so the main test job / local `npx vitest run` stay green. This
// cannot be validated locally without chia — it's verified by the chia-required
// CI run.

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(TESTS_DIR, '..', 'scripts');
const FIXTURES_DIR = join(TESTS_DIR, 'fixtures', 'real_blocks');
const MANIFEST_PATH = join(FIXTURES_DIR, 'manifest.json');
const CHIA_PYTHON = process.env.CHIA_PYTHON ?? 'python3';

type Manifest = {
  canonical: {
    height: number;
    header_hash: string;
    block_record_bin: string;
    block_bin: string;
    expect: {
      weight: number | string;
      total_iters: number | string;
      signage_point_index: number | string;
      timestamp: number | string;
      header_hash: string;
    };
  };
  bridge: {
    height: number;
    header_hash: string;
    block_bin: string;
    target_hash: string;
  };
};

function hasSqlite3(): boolean {
  return spawnSync('sqlite3', ['-version'], { encoding: 'utf8' }).status === 0;
}

function chiaImportable(): boolean {
  try {
    return spawnSync(CHIA_PYTHON, ['-c', 'import chia, chia_rs'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}

const fixturesPresent = existsSync(MANIFEST_PATH);
const enabled = fixturesPresent && hasSqlite3() && chiaImportable();

// Load the manifest only when enabled (avoids parse errors when fixtures absent).
const manifest: Manifest | null = enabled
  ? (JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest)
  : null;

function runHelper(
  script: string,
  args: string[],
  stdin: string
): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(CHIA_PYTHON, [join(SCRIPTS_DIR, script), ...args], {
    input: stdin,
    encoding: 'utf8',
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

describe.skipIf(!enabled)('real chia block round-trip (chia-required)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chia-real-blocks-'));
    dbPath = join(dir, 'test.sqlite');
    // Real full_blocks column layout the helpers query.
    const r = spawnSync(
      'sqlite3',
      [
        dbPath,
        `CREATE TABLE full_blocks (
         height INTEGER,
         header_hash BLOB,
         prev_hash BLOB,
         in_main_chain INTEGER,
         block BLOB,
         block_record BLOB
       );`,
      ],
      { encoding: 'utf8' }
    );
    if (r.status !== 0) throw new Error(`sqlite3 schema build failed: ${r.stderr}`);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Insert one canonical (in_main_chain=1) row, loading blob columns from the
   *  committed fixture files via sqlite3 readfile(). `cols` maps column → fixture
   *  filename. */
  function insertRow(
    height: number,
    headerHashHex: string,
    cols: { block?: string; block_record?: string }
  ): void {
    const names = ['height', 'header_hash', 'in_main_chain'];
    const vals = [String(height), `x'${headerHashHex}'`, '1'];
    if (cols.block) {
      names.push('block');
      vals.push(`readfile('${join(FIXTURES_DIR, cols.block)}')`);
    }
    if (cols.block_record) {
      names.push('block_record');
      vals.push(`readfile('${join(FIXTURES_DIR, cols.block_record)}')`);
    }
    const sql = `INSERT INTO full_blocks(${names.join(',')}) VALUES(${vals.join(',')});`;
    const r = spawnSync('sqlite3', [dbPath, sql], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`insert failed: ${r.stderr}`);
  }

  it('_decode_block_record.py decodes the real BlockRecord to the manifest golden values', () => {
    const c = manifest!.canonical;
    insertRow(c.height, c.header_hash, { block_record: c.block_record_bin });

    const r = runHelper('_decode_block_record.py', [dbPath], `${c.height}\t${c.header_hash}\n`);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);

    const cols = r.stdout.trim().split('\t');
    expect(cols).toHaveLength(3);
    expect(cols[0]).toBe(String(c.height));
    expect(cols[1]).toBe(c.header_hash);

    const rec = JSON.parse(cols[2]!) as Record<string, unknown>;
    // Compare as strings: chia_rs.to_json_dict() may render large ints as
    // strings while the manifest stored numbers (or vice versa). The golden
    // values came from decoding these exact bytes, so a mismatch = real drift
    // in serialization/field semantics — exactly what this test guards.
    const eq = (actual: unknown, want: number | string) =>
      expect(String(actual)).toBe(String(want));
    eq(rec.weight, c.expect.weight);
    eq(rec.total_iters, c.expect.total_iters);
    eq(rec.signage_point_index, c.expect.signage_point_index);
    eq(rec.timestamp, c.expect.timestamp);
    expect(String(rec.header_hash)).toBe(c.expect.header_hash);
  });

  it('_decode_pos.py emits the 14-column TSV with well-formed PoS fields for the real block', () => {
    const c = manifest!.canonical;
    insertRow(c.height, c.header_hash, { block: c.block_bin });

    const r = runHelper('_decode_pos.py', [dbPath], `${c.height}\t${c.header_hash}\n`);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);

    const cols = r.stdout.trim().split('\t');
    expect(cols).toHaveLength(14);
    expect(cols[0]).toBe(String(c.height)); // height
    expect(cols[1]).toBe(c.header_hash); // header_hash
    expect(Number(cols[2])).toBeGreaterThan(0); // k (plot size)
    expect(cols[3]).toMatch(/^[0-9a-f]{64}$/); // challenge (32 bytes hex)
    expect(cols[4]).toMatch(/^[0-9a-f]{96}$/); // plot_public_key (48 bytes hex)
    expect(['pool_public_key', 'pool_contract', 'none']).toContain(cols[6]); // pool_type
    expect(cols[7]).toMatch(/^[0-9a-f]{64}$/); // sha256(proof)
    expect(Number(cols[8])).toBeGreaterThanOrEqual(0); // signage_point_index
    expect(cols[9]).toMatch(/^[0-9a-f]{64}$/); // farmer_reward_puzzle_hash
    // Canonical fixture is a tx block (manifest timestamp is non-null), so
    // is_tx_block should be 1 and the timestamp column should be populated.
    expect(cols[11]).toBe('1'); // is_tx_block
    expect(cols[10]).toBe(String(c.expect.timestamp)); // timestamp matches the record
  });

  it('_decode_bridge_spends.py byte-matches the bridge puzzle hash in the real block', () => {
    const b = manifest!.bridge;
    insertRow(b.height, b.header_hash, { block: b.block_bin });

    const r = runHelper(
      '_decode_bridge_spends.py',
      [dbPath, b.target_hash],
      `${b.height}\t${b.header_hash}\n`
    );
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);

    const out = JSON.parse(r.stdout) as {
      matches: Array<{
        height: number;
        byte_matched_hashes: string[];
        generator_parsed: boolean;
        spends?: Array<{ matched_hashes: string[]; asset_type: string }>;
      }>;
    };
    expect(out.matches.length).toBeGreaterThanOrEqual(1);
    const m = out.matches.find((x) => x.height === b.height);
    expect(m, 'no match entry for the bridge height').toBeDefined();
    // Robust assertion: the byte search found the target in the real block.
    expect(m!.byte_matched_hashes).toContain(b.target_hash);

    // Spend-level extraction needs the generator + canonical ref blocks, which a
    // single-row fixture DB doesn't supply — so only assert on spends when the
    // generator actually parsed. The helper degrades gracefully otherwise.
    if (m!.generator_parsed && m!.spends && m!.spends.length > 0) {
      const hasBridgeSpend = m!.spends.some((s) => s.matched_hashes.includes(b.target_hash));
      expect(hasBridgeSpend).toBe(true);
    }
  });
});
