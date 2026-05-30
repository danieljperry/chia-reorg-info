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

  it('detailed: CAT asset renders with asset_id (TAIL hash)', () => {
    const tailHash = '0x' + 'ee'.repeat(32);
    const payload = {
      matches: [
        {
          height: 100,
          header_hash: 'aa'.repeat(32),
          timestamp: 1700000000,
          byte_matched_hashes: ['a09eb1ea'],
          generator_parsed: true,
          generator_error: null,
          spends: [
            {
              matched_hashes: ['a09eb1ea'],
              match_reasons: ['create_coin_target'],
              coin: { parent_coin_info: '0xpp', puzzle_hash: '0xqq', amount: 1000 },
              asset_type: 'cat',
              asset_id: tailHash,
            },
          ],
        },
      ],
    };
    const r = run('detailed', JSON.stringify(payload));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`asset: {7}cat \\(asset_id: ${tailHash}\\)`));
  });

  it('detailed: singleton asset renders with launcher_id', () => {
    const launcherId = '0x' + 'dd'.repeat(32);
    const payload = {
      matches: [
        {
          height: 100,
          header_hash: 'aa'.repeat(32),
          timestamp: 1700000000,
          byte_matched_hashes: ['a09eb1ea'],
          generator_parsed: true,
          generator_error: null,
          spends: [
            {
              matched_hashes: ['a09eb1ea'],
              match_reasons: ['create_coin_target'],
              coin: { parent_coin_info: '0xpp', puzzle_hash: '0xqq', amount: 1 },
              asset_type: 'singleton',
              asset_id: launcherId,
            },
          ],
        },
      ],
    };
    const r = run('detailed', JSON.stringify(payload));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`asset: {7}singleton \\(asset_id: ${launcherId}\\)`));
  });

  it('detailed: xch asset renders without asset_id (no parens)', () => {
    const payload = {
      matches: [
        {
          height: 100,
          header_hash: 'aa'.repeat(32),
          timestamp: 1700000000,
          byte_matched_hashes: ['a09eb1ea'],
          generator_parsed: true,
          generator_error: null,
          spends: [
            {
              matched_hashes: ['a09eb1ea'],
              match_reasons: ['create_coin_target'],
              coin: { parent_coin_info: '0xpp', puzzle_hash: '0xqq', amount: 1000 },
              asset_type: 'xch',
              asset_id: null,
            },
          ],
        },
      ],
    };
    const r = run('detailed', JSON.stringify(payload));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/asset: {7}xch$/m);
    expect(r.stdout).not.toMatch(/asset_id/);
  });

  it('detailed: warp_locker renders with chain:contract destination in asset_id', () => {
    // The locker classifier emits asset_id as "<chain_tag>:0x<dest_contract>"
    // — extracted from the 7-arg curry layout. We verify the formatter
    // surfaces both that and the classification note's destination /
    // locking-asset / receiver-in-solution wording.
    const dest = 'bse:0xc65151ac284f43a51f0a843f6a46930eff0076c5';
    const lockedAsset =
      '0xb0495abe70851d43d8444f785daa4fb2aaa8dae6312d596ee318d2b5834cc987';
    const payload = {
      matches: [
        {
          height: 7357253,
          header_hash: '20'.repeat(32),
          timestamp: 1753099325,
          byte_matched_hashes: ['a09eb1ea'],
          generator_parsed: true,
          generator_error: null,
          spends: [
            {
              matched_hashes: ['a09eb1ea'],
              match_reasons: ['create_coin_target'],
              coin: { parent_coin_info: '0x35ef', puzzle_hash: '0xc94e', amount: 1000000000 },
              asset_type: 'warp_locker',
              asset_id: dest,
              classification_note:
                `mod_hash=69475cd8d5c2… matches warp.green locker ` +
                `(destination: ${dest}; locking asset: ${lockedAsset}; receiver in solution)`,
            },
          ],
        },
      ],
    };
    const r = run('detailed', JSON.stringify(payload));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      new RegExp(`asset: {7}warp_locker \\(asset_id: ${dest.replace(/:/g, ':')}\\)`)
    );
    expect(r.stdout).toMatch(/matches warp\.green locker/);
    expect(r.stdout).toMatch(/locking asset: 0xb0495abe/);
    expect(r.stdout).toMatch(/receiver in solution/);
  });

  it('detailed: block_spend_count prints "Block spends: N total" when present', () => {
    const payload = {
      matches: [
        {
          height: 7357253,
          header_hash: 'ee'.repeat(32),
          timestamp: 1753099325,
          byte_matched_hashes: ['a09eb1ea'],
          generator_parsed: true,
          generator_error: null,
          block_spend_count: 38,
          spends: [],
        },
      ],
    };
    const r = run('detailed', JSON.stringify(payload));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Block spends: {4}38 total/);
  });

  it('detailed: block_spend_count line is omitted when the field is absent', () => {
    // Backward-compat: older helper output without block_spend_count
    // shouldn't render an empty "Block spends:" line.
    const payload = {
      matches: [
        {
          height: 100,
          header_hash: 'aa'.repeat(32),
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
    expect(r.stdout).not.toMatch(/Block spends:/);
  });

  it('detailed: announcement_linkage_note renders under "Linkage walk:"', () => {
    const payload = {
      matches: [
        {
          height: 100,
          header_hash: 'aa'.repeat(32),
          timestamp: 1700000000,
          byte_matched_hashes: ['a09eb1ea'],
          generator_parsed: true,
          generator_error: null,
          announcement_linkage_note:
            'parsed 38 spend(s), found 2 announcement-linked sibling(s)',
          spends: [],
        },
      ],
    };
    const r = run('detailed', JSON.stringify(payload));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /Linkage walk: {4}parsed 38 spend\(s\), found 2 announcement-linked sibling\(s\)/
    );
  });

  it('detailed: announcement_linked match labels "matched hash:" as transitive', () => {
    // When a spend was pulled in by the announcement walker (rather than
    // matched directly by puzzle_hash / create_coin_target / hint), the
    // "matched hash:" line should carry a parenthetical noting that the
    // hash is transitive — otherwise a reader could mistake an
    // announcement-linked sibling for a direct byte-match.
    const payload = {
      matches: [
        {
          height: 7357253,
          header_hash: 'ee'.repeat(32),
          timestamp: 1753099325,
          byte_matched_hashes: ['a09eb1ea'],
          generator_parsed: true,
          generator_error: null,
          spends: [
            {
              matched_hashes: [
                'a09eb1ea8c6e83c0166801dabcf4a70d361cc7f6d89c4a46bcd400ac57719037',
              ],
              match_reasons: ['announcement_linked'],
              coin: {
                parent_coin_info: '0x0f1d',
                puzzle_hash: '0xdf7a',
                amount: 1000000000,
              },
              asset_type: 'xch',
              asset_id: null,
              classification_note:
                'asserts coin announcement created by 30b15c4e9f17…; matches p2_delegated → xch',
            },
          ],
        },
      ],
    };
    const r = run('detailed', JSON.stringify(payload));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/matched on: {2}announcement_linked/);
    expect(r.stdout).toMatch(
      /matched hash:a09eb1ea.* \(transitive — bridge target carried via announcement chain\)/
    );
  });

  it('detailed: non-announcement_linked match keeps the plain "matched hash:" line', () => {
    // Mirror of the announcement-linked test above — direct matches
    // (puzzle_hash, create_coin_target, create_coin_hint) must NOT carry
    // the transitive suffix.
    const payload = {
      matches: [
        {
          height: 100,
          header_hash: 'aa'.repeat(32),
          timestamp: 1700000000,
          byte_matched_hashes: ['a09eb1ea'],
          generator_parsed: true,
          generator_error: null,
          spends: [
            {
              matched_hashes: ['a09eb1ea'],
              match_reasons: ['create_coin_target'],
              coin: { parent_coin_info: '0xpp', puzzle_hash: '0xqq', amount: 1000 },
              asset_type: 'unknown',
              asset_id: null,
            },
          ],
        },
      ],
    };
    const r = run('detailed', JSON.stringify(payload));
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/transitive — bridge target/);
  });

  it('detailed: unknown_curried renders with mod_hash in asset_id slot', () => {
    const modHash = '0x' + 'cf'.repeat(32);
    const payload = {
      matches: [
        {
          height: 100,
          header_hash: 'aa'.repeat(32),
          timestamp: 1700000000,
          byte_matched_hashes: ['a09eb1ea'],
          generator_parsed: true,
          generator_error: null,
          spends: [
            {
              matched_hashes: ['a09eb1ea'],
              match_reasons: ['create_coin_target'],
              coin: { parent_coin_info: '0xpp', puzzle_hash: '0xqq', amount: 1000 },
              asset_type: 'unknown_curried',
              asset_id: modHash,
              classification_note: `uncurried mod_hash=${modHash}; no template match`,
            },
          ],
        },
      ],
    };
    const r = run('detailed', JSON.stringify(payload));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      new RegExp(`asset: {7}unknown_curried \\(asset_id: ${modHash}\\)`)
    );
  });

  it('detailed: spend with classification_note prints a "note:" line under asset', () => {
    const payload = {
      matches: [
        {
          height: 100,
          header_hash: 'aa'.repeat(32),
          timestamp: 1700000000,
          byte_matched_hashes: ['a09eb1ea'],
          generator_parsed: true,
          generator_error: null,
          spends: [
            {
              matched_hashes: ['a09eb1ea'],
              match_reasons: ['create_coin_target'],
              coin: { parent_coin_info: '0xpp', puzzle_hash: '0xqq', amount: 1000 },
              asset_type: 'unknown',
              asset_id: null,
              classification_note: 'uncurried mod_hash=abc123…; no template match (loaded: p2,cat,singleton)',
            },
          ],
        },
      ],
    };
    const r = run('detailed', JSON.stringify(payload));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/note: {8}uncurried mod_hash=abc123…/);
    expect(r.stdout).toMatch(/no template match \(loaded: p2,cat,singleton\)/);
  });

  it('detailed: spend without classification_note skips the note line', () => {
    const payload = {
      matches: [
        {
          height: 100,
          header_hash: 'aa'.repeat(32),
          timestamp: 1700000000,
          byte_matched_hashes: ['a09eb1ea'],
          generator_parsed: true,
          generator_error: null,
          spends: [
            {
              matched_hashes: ['a09eb1ea'],
              match_reasons: ['create_coin_target'],
              coin: { parent_coin_info: '0xpp', puzzle_hash: '0xqq', amount: 1000 },
              asset_type: 'xch',
              asset_id: null,
            },
          ],
        },
      ],
    };
    const r = run('detailed', JSON.stringify(payload));
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/note:/);
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
