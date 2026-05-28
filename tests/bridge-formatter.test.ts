import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Tests for scripts/_format_bridge_info.py — the JSON-to-text formatter
// that produces the contents of the Bridge Info section under
// reorg-finder.sh -b/--bridge.
//
// We invoke it via subprocess (it's a standalone Python script with no
// chia dependency, so this works on any machine with python3).

const FORMATTER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  '_format_bridge_info.py'
);

function run(level: 'quiet' | 'detailed', stdin: string): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const r = spawnSync('python3', [FORMATTER, level], {
    input: stdin,
    encoding: 'utf8',
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

describe('_format_bridge_info.py', () => {
  it('prints the canonical "no transfers" message for empty matches', () => {
    const r = run('detailed', JSON.stringify({ matches: [] }));
    expect(r.status).toBe(0);
    // Strip only trailing newline so the 2-space indent stays intact.
    expect(r.stdout.replace(/\n$/, '')).toBe(
      '  No bridge transfers were found in any reorged blocks from this query.'
    );
  });

  it('prints the canonical "no transfers" message for empty stdin', () => {
    const r = run('detailed', '');
    expect(r.status).toBe(0);
    // Strip only trailing newline so the 2-space indent stays intact.
    expect(r.stdout.replace(/\n$/, '')).toBe(
      '  No bridge transfers were found in any reorged blocks from this query.'
    );
  });

  it('prints the canonical "no transfers" message in quiet mode too', () => {
    const r = run('quiet', JSON.stringify({ matches: [] }));
    expect(r.status).toBe(0);
    // Strip only trailing newline so the 2-space indent stays intact.
    expect(r.stdout.replace(/\n$/, '')).toBe(
      '  No bridge transfers were found in any reorged blocks from this query.'
    );
  });

  it('quiet: one line per matching spend with height, ts, amount, asset', () => {
    const payload = {
      matches: [
        {
          height: 8773500,
          header_hash: 'aa'.repeat(32),
          timestamp: 1700000000,
          byte_matched_hashes: ['a09eb1ea'],
          generator_parsed: true,
          generator_error: null,
          spends: [
            {
              matched_hashes: ['a09eb1ea'],
              match_reasons: ['create_coin_target'],
              coin: { parent_coin_info: '0xpp', puzzle_hash: '0xqq', amount: 123456 },
              asset_type: 'bridge',
              asset_id: null,
            },
            {
              matched_hashes: ['a09eb1ea'],
              match_reasons: ['create_coin_hint'],
              coin: { parent_coin_info: '0xpp2', puzzle_hash: '0xqq2', amount: 1 },
              asset_type: 'unknown',
              asset_id: null,
            },
          ],
        },
      ],
    };
    const r = run('quiet', JSON.stringify(payload));
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/height=8773500/);
    expect(lines[0]).toMatch(/123456 mojos/);
    expect(lines[0]).toMatch(/asset=bridge/);
    expect(lines[1]).toMatch(/asset=unknown/);
    expect(lines[1]).toMatch(/1 mojos/);
  });

  it('quiet: byte-search-only match (no spend details) reports amount=unknown with a reason', () => {
    const payload = {
      matches: [
        {
          height: 100,
          header_hash: 'bb'.repeat(32),
          timestamp: null,
          byte_matched_hashes: ['a09eb1ea8c6e83c0166801dabcf4a70d361cc7f6d89c4a46bcd400ac57719037'],
          generator_parsed: false,
          generator_error: 'chia not importable',
          spends: [],
        },
      ],
    };
    const r = run('quiet', JSON.stringify(payload));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/height=100/);
    expect(r.stdout).toMatch(/amount=unknown/);
    expect(r.stdout).toMatch(/asset=bridge\?/);
    expect(r.stdout).toMatch(/chia not importable/);
  });

  it('detailed: shows full per-match block with header_hash, timestamp, byte-matched, spends', () => {
    const payload = {
      matches: [
        {
          height: 8781783,
          header_hash: '36'.repeat(32),
          timestamp: 1779831225,
          byte_matched_hashes: ['a09eb1ea8c6e83c0166801dabcf4a70d361cc7f6d89c4a46bcd400ac57719037'],
          generator_parsed: true,
          generator_error: null,
          spends: [
            {
              matched_hashes: ['a09eb1ea8c6e83c0166801dabcf4a70d361cc7f6d89c4a46bcd400ac57719037'],
              match_reasons: ['puzzle_hash'],
              coin: {
                parent_coin_info: '0x' + 'cc'.repeat(32),
                puzzle_hash: '0xa09eb1ea8c6e83c0166801dabcf4a70d361cc7f6d89c4a46bcd400ac57719037',
                amount: 999999,
              },
              asset_type: 'bridge',
              asset_id: null,
            },
          ],
        },
      ],
    };
    const r = run('detailed', JSON.stringify(payload));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Found 1 reorged block\(s\)/);
    expect(r.stdout).toMatch(/1 matching coin spend\(s\)/);
    expect(r.stdout).toMatch(/Block height: {4}8781783/);
    expect(r.stdout).toMatch(new RegExp('36'.repeat(32)));
    expect(r.stdout).toMatch(/Block timestamp:/);
    expect(r.stdout).toMatch(/Byte-matched:/);
    expect(r.stdout).toMatch(/Matching spends \(1\)/);
    expect(r.stdout).toMatch(/parent_coin:/);
    expect(r.stdout).toMatch(/amount: {6}999999/);
    expect(r.stdout).toMatch(/asset: {7}bridge/);
    expect(r.stdout).toMatch(/matched on: {2}puzzle_hash/);
  });

  it('detailed: byte-search-only match reports "Spend details: unavailable" with the error', () => {
    const payload = {
      matches: [
        {
          height: 200,
          header_hash: 'dd'.repeat(32),
          timestamp: null,
          byte_matched_hashes: ['a09eb1ea'],
          generator_parsed: false,
          generator_error: 'ref block at height 199 not available',
          spends: [],
        },
      ],
    };
    const r = run('detailed', JSON.stringify(payload));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Block height: {4}200/);
    expect(r.stdout).toMatch(/Block timestamp: \(non-tx block\)/);
    expect(r.stdout).toMatch(/Spend details: {3}unavailable \(ref block at height 199 not available\)/);
    expect(r.stdout).toMatch(/byte search confirmed/);
  });

  it('detailed: generator parsed but no matching spend reports the right diagnostic', () => {
    const payload = {
      matches: [
        {
          height: 300,
          header_hash: 'ee'.repeat(32),
          timestamp: 1700000000,
          byte_matched_hashes: ['a09eb1ea'],
          generator_parsed: true,
          generator_error: null,
          spends: [],
        },
      ],
    };
    const r = run('detailed', JSON.stringify(payload));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/generator parsed, but no matching spend found/);
    expect(r.stdout).toMatch(/may appear in non-spend context/);
  });

  it('rejects bad usage', () => {
    const r = spawnSync('python3', [FORMATTER, 'whatever'], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/usage:/);
  });

  it('handles invalid JSON gracefully (no false "no transfers")', () => {
    const r = run('detailed', 'not json at all');
    // Exit 0 still (so the bash caller continues), but output flags
    // unavailability rather than claiming no matches were found.
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Bridge Info unavailable/);
    expect(r.stdout).not.toMatch(/No bridge transfers were found/);
  });
});
