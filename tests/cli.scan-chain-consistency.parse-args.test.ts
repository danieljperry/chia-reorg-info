import { describe, expect, it } from 'vitest';
import {
  HelpRequested,
  parseArgs,
} from '../src/cli/scan-chain-consistency.js';

describe('scan_chain_consistency parseArgs', () => {
  it('parses required args with mainnet default', () => {
    expect(parseArgs(['--start-height', '100', '--end-height', '200'])).toEqual({
      startHeight: 100,
      endHeight: 200,
      network: 'mainnet',
    });
  });

  it('accepts --network testnet11', () => {
    expect(
      parseArgs([
        '--start-height',
        '1',
        '--end-height',
        '2',
        '--network',
        'testnet11',
      ]).network
    ).toBe('testnet11');
  });

  it('rejects an invalid --network', () => {
    expect(() =>
      parseArgs([
        '--start-height',
        '1',
        '--end-height',
        '2',
        '--network',
        'sky',
      ])
    ).toThrow(/--network must be one of/);
  });

  it('rejects a non-integer height', () => {
    expect(() =>
      parseArgs(['--start-height', '1.5', '--end-height', '10'])
    ).toThrow(/--start-height must be a non-negative integer/);
  });

  it('rejects a negative height', () => {
    expect(() =>
      parseArgs(['--start-height', '-1', '--end-height', '10'])
    ).toThrow(/--start-height must be a non-negative integer/);
  });

  it('requires --start-height', () => {
    expect(() => parseArgs(['--end-height', '10'])).toThrow(
      /--start-height is required/
    );
  });

  it('requires --end-height', () => {
    expect(() => parseArgs(['--start-height', '1'])).toThrow(
      /--end-height is required/
    );
  });

  it('rejects --end-height < --start-height', () => {
    expect(() =>
      parseArgs(['--start-height', '100', '--end-height', '50'])
    ).toThrow(/--end-height must be >= --start-height/);
  });

  it('rejects a range exceeding the 50000 block cap', () => {
    expect(() =>
      parseArgs(['--start-height', '0', '--end-height', '50000'])
    ).toThrow(/exceeds the maximum/);
  });

  it('accepts a range at exactly the cap', () => {
    // 0..49999 inclusive = 50000 blocks
    expect(
      parseArgs(['--start-height', '0', '--end-height', '49999']).endHeight
    ).toBe(49999);
  });

  it('throws HelpRequested for --help and -h', () => {
    expect(() => parseArgs(['--help'])).toThrow(HelpRequested);
    expect(() => parseArgs(['-h'])).toThrow(HelpRequested);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown flag/);
  });

  it('rejects a missing flag value', () => {
    expect(() => parseArgs(['--start-height'])).toThrow(/Missing value/);
  });
});
