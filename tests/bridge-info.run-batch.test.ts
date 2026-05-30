import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBridgeSearchForBatch } from '../src/monitor/bridge-info.js';
import { closeLogger, setLogFile, setStderrEnabled } from '../src/util/logger.js';
import type { ReorgEvent } from '../src/monitor/reorg-monitor.js';

// Tests for the runBridgeSearchForBatch wrapper. Covers:
//   - orphan-pair construction from ReorgEvent[]
//   - 0x-prefix stripping on the old_header_hash
//   - 64-char hex filter (events with malformed hashes are dropped)
//   - empty-after-filter early-out with a single log line and undefined
//   - the four outcome-kind switches: matches → logBlock + return; no-matches
//     → log info; skipped → log info; error → log warn (all returning undefined
//     except matches)
//
// We assert log output by routing the logger to a file in a temp dir and
// re-reading it after the run. This exercises the actual logger plumbing
// (logBlock separator format included) instead of mocking it out — which
// also catches a regression if logBlock's signature changes.

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake_bridge_helpers'
);
const PY = 'python3';
const HEADER_HASH =
  'ee1b143321c63a67213ab54532d925c8133a94d276ba926754bbb91a72e1d413';

function evt(overrides: Partial<ReorgEvent> = {}): ReorgEvent {
  return {
    height: 7357253,
    old_header_hash: HEADER_HASH,
    new_header_hash: 'aa'.repeat(32),
    detected_at: '2026-05-30T02:00:00.000Z',
    depth: 1,
    max_depth: 1,
    blocks_from_peak: 0,
    old_block_record: {},
    ...overrides,
  };
}

let work: string;
let logPath: string;
let dbPath: string;

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), 'bridge-run-batch-'));
  logPath = join(work, 'monitor.log');
  dbPath = join(work, 'fake.sqlite');
  writeFileSync(dbPath, 'placeholder');
  setStderrEnabled(false);
  await setLogFile(logPath);
});

afterEach(async () => {
  await closeLogger();
  rmSync(work, { recursive: true, force: true });
});

function readLog(): string {
  // The logger writes asynchronously through a stream; closeLogger awaits
  // flush. But runBridgeSearchForBatch returns BEFORE we assert (no
  // explicit flush API on the logger). The stream's write is synchronous
  // from the writer's perspective for short payloads though, so reading
  // immediately after closeLogger() inside the test body is safe.
  return readFileSync(logPath, 'utf8');
}

describe('runBridgeSearchForBatch — orphan construction + outcome wiring', () => {
  it('returns the BridgeInfo and writes a logBlock entry on matches', async () => {
    const result = await runBridgeSearchForBatch([evt()], {
      dbPath,
      chiaPython: PY,
      helperPath: join(FIXTURES, 'decode_matches.py'),
      formatterPath: join(FIXTURES, 'format_ok.py'),
    });
    expect(result).toBeDefined();
    expect(result?.matchedBlockCount).toBe(1);
    expect(result?.spendCount).toBe(2);

    await closeLogger();
    const logContent = readLog();
    expect(logContent).toMatch(/Bridge Info detected in re-orged blocks/);
    expect(logContent).toMatch(/matched_blocks=1/);
    expect(logContent).toMatch(/matched_spends=2/);
    expect(logContent).toMatch(/height_range=7357253\.\.7357253/);
    // logBlock wraps the body with separator lines.
    expect(logContent).toMatch(/─{60}/);
    expect(logContent).toContain('Found 1 reorged block(s)');
  });

  it('strips the 0x prefix from old_header_hash before passing to the helper', async () => {
    // decode_matches.py asserts argv shape but doesn't validate hash
    // format. To verify stripping happened, we use the decode_empty
    // fixture (returns []) and run with a 0x-prefixed event; we expect
    // no-matches (which we get IF the hash was accepted and the search
    // ran — an invalid hash would have been filtered first and the
    // function would have returned early without spawning).
    const result = await runBridgeSearchForBatch(
      [evt({ old_header_hash: '0x' + HEADER_HASH })],
      {
        dbPath,
        chiaPython: PY,
        helperPath: join(FIXTURES, 'decode_empty.py'),
        formatterPath: join(FIXTURES, 'format_ok.py'),
      }
    );
    expect(result).toBeUndefined();

    await closeLogger();
    expect(readLog()).toMatch(/Bridge search complete \(no matches\).*blocks_searched=1/);
  });

  it('filters out events with malformed old_header_hash (not 64 hex chars)', async () => {
    const result = await runBridgeSearchForBatch(
      [
        evt({ old_header_hash: 'too-short' }),
        evt({ old_header_hash: '' }),
        evt({ old_header_hash: 'g'.repeat(64) }), // non-hex char
      ],
      {
        dbPath,
        chiaPython: PY,
        helperPath: join(FIXTURES, 'decode_matches.py'),
        formatterPath: join(FIXTURES, 'format_ok.py'),
      }
    );
    // All three filtered out → empty orphan list → early return.
    expect(result).toBeUndefined();

    await closeLogger();
    expect(readLog()).toMatch(/Bridge search skipped \(no usable orphan hashes in batch\)/);
  });

  it('mixes valid and invalid hashes; invalid ones are dropped, valid ones pass through', async () => {
    // The decode_matches helper echoes orphan_pair_count into a
    // _test_diagnostics field, so we can't read it back here. Instead,
    // verify behavior indirectly: with at least one valid event, the
    // search runs and returns matches.
    const result = await runBridgeSearchForBatch(
      [
        evt({ old_header_hash: 'too-short' }),
        evt({ old_header_hash: HEADER_HASH }),
        evt({ old_header_hash: 'not-hex' }),
      ],
      {
        dbPath,
        chiaPython: PY,
        helperPath: join(FIXTURES, 'decode_matches.py'),
        formatterPath: join(FIXTURES, 'format_ok.py'),
      }
    );
    expect(result).toBeDefined();
    expect(result?.matchedBlockCount).toBe(1);
  });

  it('returns undefined and logs info on no-matches', async () => {
    const result = await runBridgeSearchForBatch([evt()], {
      dbPath,
      chiaPython: PY,
      helperPath: join(FIXTURES, 'decode_empty.py'),
      formatterPath: join(FIXTURES, 'format_ok.py'),
    });
    expect(result).toBeUndefined();
    await closeLogger();
    const c = readLog();
    expect(c).toMatch(/\[info\] Bridge search complete \(no matches\)/);
    expect(c).not.toMatch(/Bridge Info detected/);
  });

  it('returns undefined and logs info on skipped (e.g. DB unreadable)', async () => {
    const result = await runBridgeSearchForBatch([evt()], {
      dbPath: '/no/such/db.sqlite',
      chiaPython: PY,
      helperPath: join(FIXTURES, 'decode_matches.py'),
      formatterPath: join(FIXTURES, 'format_ok.py'),
    });
    expect(result).toBeUndefined();
    await closeLogger();
    const c = readLog();
    expect(c).toMatch(/\[info\] Bridge search skipped.*reason=.*DB not readable/);
  });

  it('returns undefined and logs WARN (not info) on helper error', async () => {
    const result = await runBridgeSearchForBatch([evt()], {
      dbPath,
      chiaPython: PY,
      helperPath: join(FIXTURES, 'decode_exit2.py'),
      formatterPath: join(FIXTURES, 'format_ok.py'),
    });
    expect(result).toBeUndefined();
    await closeLogger();
    const c = readLog();
    expect(c).toMatch(/\[warn\] Bridge search failed/);
    expect(c).toMatch(/decode helper exited 2/);
  });

  it('passes the lowest/highest orphan heights through as lowHeight/highHeight', async () => {
    const result = await runBridgeSearchForBatch(
      [
        evt({ height: 1003 }),
        evt({ height: 1001 }),
        evt({ height: 1002 }),
      ],
      {
        dbPath,
        chiaPython: PY,
        helperPath: join(FIXTURES, 'decode_matches.py'),
        formatterPath: join(FIXTURES, 'format_ok.py'),
      }
    );
    expect(result?.lowHeight).toBe(1001);
    expect(result?.highHeight).toBe(1003);

    await closeLogger();
    expect(readLog()).toMatch(/height_range=1001\.\.1003/);
  });
});
