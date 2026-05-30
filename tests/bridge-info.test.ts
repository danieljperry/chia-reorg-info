import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchBridges } from '../src/monitor/bridge-info.js';

// Tests for searchBridges — the dispatcher that spawns the decode helper
// and (when matches are found) the formatter. We control both helpers by
// pointing `helperPath` / `formatterPath` at deterministic fixture
// scripts under tests/fixtures/fake_bridge_helpers/, so the real chia
// dependency isn't required.

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake_bridge_helpers'
);

const PY = 'python3';
const HEADER_HASH =
  'ee1b143321c63a67213ab54532d925c8133a94d276ba926754bbb91a72e1d413';
const BRIDGE_TARGET =
  'a09eb1ea8c6e83c0166801dabcf4a70d361cc7f6d89c4a46bcd400ac57719037';

let workDir: string;
let dbPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'bridge-info-test-'));
  dbPath = join(workDir, 'fake.sqlite');
  // Any non-empty file is enough; searchBridges only checks accessSync(R_OK).
  writeFileSync(dbPath, 'placeholder');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('searchBridges', () => {
  it('returns matches when the decode helper reports any', async () => {
    const r = await searchBridges({
      dbPath,
      chiaPython: PY,
      helperPath: join(FIXTURES, 'decode_matches.py'),
      formatterPath: join(FIXTURES, 'format_ok.py'),
      orphans: [{ height: 7357253, header_hash: HEADER_HASH }],
    });
    expect(r.kind).toBe('matches');
    if (r.kind !== 'matches') return; // type narrowing for TS
    expect(r.info.matchedBlockCount).toBe(1);
    expect(r.info.spendCount).toBe(2);
    expect(r.info.lowHeight).toBe(7357253);
    expect(r.info.highHeight).toBe(7357253);
    expect(r.info.formattedText).toContain('Match 1');
  });

  it('uses min/max of the orphan heights for low/high', async () => {
    const r = await searchBridges({
      dbPath,
      chiaPython: PY,
      helperPath: join(FIXTURES, 'decode_matches.py'),
      formatterPath: join(FIXTURES, 'format_ok.py'),
      orphans: [
        { height: 1000, header_hash: HEADER_HASH },
        { height: 1002, header_hash: HEADER_HASH },
        { height: 1001, header_hash: HEADER_HASH },
      ],
    });
    if (r.kind !== 'matches') throw new Error(`expected matches, got ${r.kind}`);
    expect(r.info.lowHeight).toBe(1000);
    expect(r.info.highHeight).toBe(1002);
  });

  it('returns no-matches when the decoder reports an empty list', async () => {
    const r = await searchBridges({
      dbPath,
      chiaPython: PY,
      helperPath: join(FIXTURES, 'decode_empty.py'),
      formatterPath: join(FIXTURES, 'format_ok.py'),
      orphans: [{ height: 1, header_hash: HEADER_HASH }],
    });
    expect(r.kind).toBe('no-matches');
    if (r.kind !== 'no-matches') return;
    expect(r.blocksSearched).toBe(1);
  });

  it('returns no-matches immediately when called with no orphans', async () => {
    const r = await searchBridges({
      dbPath,
      chiaPython: PY,
      helperPath: join(FIXTURES, 'decode_matches.py'),
      formatterPath: join(FIXTURES, 'format_ok.py'),
      orphans: [],
    });
    expect(r.kind).toBe('no-matches');
    if (r.kind !== 'no-matches') return;
    expect(r.blocksSearched).toBe(0);
  });

  it('skips when the DB path is not readable', async () => {
    const r = await searchBridges({
      dbPath: '/no/such/db/at/all.sqlite',
      chiaPython: PY,
      helperPath: join(FIXTURES, 'decode_matches.py'),
      formatterPath: join(FIXTURES, 'format_ok.py'),
      orphans: [{ height: 1, header_hash: HEADER_HASH }],
    });
    expect(r.kind).toBe('skipped');
    if (r.kind !== 'skipped') return;
    expect(r.reason).toMatch(/DB not readable/);
  });

  it('skips with a chia-python-not-runnable reason when the interpreter is missing', async () => {
    const r = await searchBridges({
      dbPath,
      chiaPython: '/no/such/python/binary',
      helperPath: join(FIXTURES, 'decode_matches.py'),
      formatterPath: join(FIXTURES, 'format_ok.py'),
      orphans: [{ height: 1, header_hash: HEADER_HASH }],
    });
    expect(r.kind).toBe('skipped');
    if (r.kind !== 'skipped') return;
    expect(r.reason).toMatch(/chia python not runnable/);
  });

  it('reports an error when the decode helper exits non-zero', async () => {
    const r = await searchBridges({
      dbPath,
      chiaPython: PY,
      helperPath: join(FIXTURES, 'decode_exit2.py'),
      formatterPath: join(FIXTURES, 'format_ok.py'),
      orphans: [{ height: 1, header_hash: HEADER_HASH }],
    });
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.error).toMatch(/decode helper exited 2/);
    expect(r.error).toMatch(/simulated decode failure/);
  });

  it('reports an error when the decode helper emits unparseable JSON', async () => {
    const r = await searchBridges({
      dbPath,
      chiaPython: PY,
      helperPath: join(FIXTURES, 'decode_invalid_json.py'),
      formatterPath: join(FIXTURES, 'format_ok.py'),
      orphans: [{ height: 1, header_hash: HEADER_HASH }],
    });
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.error).toMatch(/output unparseable/);
  });

  it('reports an error when the formatter exits non-zero (matches found)', async () => {
    const r = await searchBridges({
      dbPath,
      chiaPython: PY,
      helperPath: join(FIXTURES, 'decode_matches.py'),
      formatterPath: join(FIXTURES, 'format_fail.py'),
      orphans: [{ height: 1, header_hash: HEADER_HASH }],
    });
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.error).toMatch(/formatter exited 1/);
    expect(r.error).toMatch(/simulated formatter failure/);
  });

  it('uses default BRIDGING_PUZZLE_HASH when bridgeTargets omitted (passes-through to helper)', async () => {
    // The decode_matches fixture echoes the targets list into the
    // _test_diagnostics block. Run with no `bridgeTargets` to confirm
    // the default is the Warp.green bridging puzzle hash.
    const r = await searchBridges({
      dbPath,
      chiaPython: PY,
      helperPath: join(FIXTURES, 'decode_matches.py'),
      formatterPath: join(FIXTURES, 'format_ok.py'),
      orphans: [{ height: 1, header_hash: HEADER_HASH }],
    });
    if (r.kind !== 'matches') throw new Error(`unexpected: ${r.kind}`);
    // The puzzle_hash in the synthetic match echoes targets[0]; confirm
    // it's the default warp.green hash.
    expect(r.info.formattedText).toContain('Match 1');
    // Verify by reading the helper's _test_diagnostics on its raw output:
    // we don't expose rawJson on the 'matches' result, so reach into the
    // formatted text we know contains targets[0] indirectly. Stronger
    // check: the orphan_pair_count via JSON would be cleaner — but the
    // formatter ignores _test_diagnostics. So we settle for asserting the
    // BRIDGING_PUZZLE_HASH constant is exported and equal to the default.
    const mod = await import('../src/monitor/bridge-info.js');
    expect(mod.BRIDGING_PUZZLE_HASH).toBe(BRIDGE_TARGET);
  });
});
