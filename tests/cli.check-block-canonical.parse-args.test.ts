import { describe, expect, it } from 'vitest';
import { HelpRequested, parseArgs } from '../src/cli/check-block-canonical.js';

const HASH = 'a4ec9dc5ddf1dd0b5c894c9989780e6be2bb9e69e418ad037504aa5f15833a41';

describe('check_block_canonical parseArgs', () => {
  it('parses required args with defaults', () => {
    expect(parseArgs(['--height', '100', '--expected-hash', HASH])).toEqual({
      height: 100,
      expectedHash: HASH,
      network: 'mainnet',
    });
  });

  it('strips a 0x prefix from --expected-hash', () => {
    expect(parseArgs(['--height', '100', '--expected-hash', `0x${HASH}`]).expectedHash).toBe(
      HASH
    );
  });

  it('lowercases --expected-hash', () => {
    expect(
      parseArgs(['--height', '100', '--expected-hash', HASH.toUpperCase()])
        .expectedHash
    ).toBe(HASH);
  });

  it('accepts --network testnet11', () => {
    expect(
      parseArgs(['--height', '100', '--expected-hash', HASH, '--network', 'testnet11'])
        .network
    ).toBe('testnet11');
  });

  it('rejects an invalid --network', () => {
    expect(() =>
      parseArgs(['--height', '100', '--expected-hash', HASH, '--network', 'rinkeby'])
    ).toThrow(/--network must be one of/);
  });

  it('rejects a negative --height', () => {
    expect(() => parseArgs(['--height', '-1', '--expected-hash', HASH])).toThrow(
      /--height must be a non-negative integer/
    );
  });

  it('rejects a non-integer --height', () => {
    expect(() => parseArgs(['--height', '3.14', '--expected-hash', HASH])).toThrow(
      /--height must be a non-negative integer/
    );
    expect(() => parseArgs(['--height', 'abc', '--expected-hash', HASH])).toThrow(
      /--height must be a non-negative integer/
    );
  });

  it('rejects a too-short --expected-hash', () => {
    expect(() =>
      parseArgs(['--height', '100', '--expected-hash', 'abcd'])
    ).toThrow(/64-character hex string/);
  });

  it('rejects a non-hex --expected-hash', () => {
    expect(() =>
      parseArgs(['--height', '100', '--expected-hash', 'g'.repeat(64)])
    ).toThrow(/64-character hex string/);
  });

  it('requires --height', () => {
    expect(() => parseArgs(['--expected-hash', HASH])).toThrow(/--height is required/);
  });

  it('requires --expected-hash', () => {
    expect(() => parseArgs(['--height', '100'])).toThrow(/--expected-hash is required/);
  });

  it('throws HelpRequested for --help and -h', () => {
    expect(() => parseArgs(['--help'])).toThrow(HelpRequested);
    expect(() => parseArgs(['-h'])).toThrow(HelpRequested);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown flag/);
  });

  it('rejects a missing flag value', () => {
    expect(() => parseArgs(['--height'])).toThrow(/Missing value/);
  });
});
