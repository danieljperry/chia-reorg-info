import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// Verify the bash regex guard added to scripts/reorg-finder.sh's
// _lookup_one_timestamp: anything that's not a non-negative integer must be
// rejected before being interpolated into a `python3 -c` template (the path
// that would otherwise be a code-execution sink).
//
// We test the regex behavior directly by running it under bash with the same
// shape (`[[ "$ts" =~ ^[0-9]+$ ]]`). That mirrors what the script does after
// the python-RPC parser returns its value.
function isAcceptedByGuard(ts: string): boolean {
  const r = spawnSync('bash', ['-c', `ts=$1; [[ "$ts" =~ ^[0-9]+$ ]] && echo accept || echo reject`, '_', ts], {
    encoding: 'utf8',
  });
  return r.stdout.trim() === 'accept';
}

describe('reorg-finder.sh _lookup_one_timestamp guard', () => {
  it('accepts ordinary unix timestamps', () => {
    expect(isAcceptedByGuard('0')).toBe(true);
    expect(isAcceptedByGuard('1700000000')).toBe(true);
  });

  it('accepts a long integer (no overflow concern for bash regex)', () => {
    expect(isAcceptedByGuard('99999999999999')).toBe(true);
  });

  it.each([
    ["python injection: arithmetic + import", "0); __import__('os').system('id'); ("],
    ['shell metachars', '$(touch /tmp/pwned)'],
    ['command substitution backticks', '`whoami`'],
    ['newline injection', '0\nimport os; os.system("id")'],
    ['negative integer', '-1'],
    ['float', '3.14'],
    ['hex', '0x1234'],
    ['leading sign', '+1700000000'],
    ['scientific', '1e10'],
    ['empty space', ' 1700000000'],
    ['trailing space', '1700000000 '],
    ['comma', '1,700,000,000'],
  ])('rejects %s', (_label, payload) => {
    expect(isAcceptedByGuard(payload)).toBe(false);
  });

  it('the script file actually contains the guard (regression: do not remove)', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(
      new URL('../scripts/reorg-finder.sh', import.meta.url),
      'utf8'
    );
    expect(src).toMatch(/\[\[\s*"\$ts"\s*=~\s*\^\[0-9\]\+\$\s*\]\]/);
  });
});
