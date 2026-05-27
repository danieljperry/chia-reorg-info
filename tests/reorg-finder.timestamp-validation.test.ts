import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Tests the guard inside scripts/reorg-finder.sh's _lookup_one_timestamp that
// rejects RPC-returned timestamps before they reach `python3 -c` (would be
// RCE) or unquoted JSON emission (would be malformed). The previous version
// of this test inlined a duplicate of the regex into bash, which verified
// regex semantics but NOT the production code — a silent weakening of the
// production guard would have passed. Here we source the script (with the
// new guard at the bottom so sourcing doesn't run main) and call the
// extracted _validate_timestamp_string function directly.

const SCRIPT_PATH = fileURLToPath(
  new URL('../scripts/reorg-finder.sh', import.meta.url)
);

function validate(ts: string): string {
  const r = spawnSync(
    'bash',
    [
      '-c',
      // Source the script (no main invocation thanks to the
      // BASH_SOURCE[0] != $0 guard), then call the function the production
      // _lookup_one_timestamp invokes.
      `source "$1"; _validate_timestamp_string "$2"`,
      '_',
      SCRIPT_PATH,
      ts,
    ],
    { encoding: 'utf8' }
  );
  if (r.status !== 0) {
    throw new Error(`bash exited ${r.status}: ${r.stderr}`);
  }
  return r.stdout;
}

describe('reorg-finder.sh _validate_timestamp_string (production guard)', () => {
  it('returns the input unchanged for ordinary unix timestamps', () => {
    expect(validate('0')).toBe('0');
    expect(validate('1700000000')).toBe('1700000000');
  });

  it('accepts a long integer (no overflow concern)', () => {
    expect(validate('99999999999999')).toBe('99999999999999');
  });

  it('returns empty string for empty input (no-op pass-through)', () => {
    expect(validate('')).toBe('');
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
    ['letter prefix', 'abc'],
  ])('returns empty string for invalid input: %s', (_label, payload) => {
    expect(validate(payload)).toBe('');
  });

  it('_lookup_one_timestamp invokes _validate_timestamp_string (production wiring check)', async () => {
    // Defense against accidentally deleting the call site. The production
    // function should call our validator; verify by reading the source.
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(SCRIPT_PATH, 'utf8');
    // Match the line in _lookup_one_timestamp that wraps `ts` through the
    // validator. If anyone removes or renames that call, this trips.
    expect(src).toMatch(/ts=\$\(_validate_timestamp_string "\$ts"\)/);
  });
});
