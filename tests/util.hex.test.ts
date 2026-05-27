import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  hexToBytes,
  isHex32,
  stripHexPrefix,
} from '../src/chia/hex.js';

describe('stripHexPrefix', () => {
  it('strips lowercase 0x', () => {
    expect(stripHexPrefix('0xabc')).toBe('abc');
  });

  it('strips uppercase 0X', () => {
    expect(stripHexPrefix('0Xabc')).toBe('abc');
  });

  it('leaves bare hex alone', () => {
    expect(stripHexPrefix('abc')).toBe('abc');
  });

  it('leaves empty string alone', () => {
    expect(stripHexPrefix('')).toBe('');
  });

  it('leaves a string starting with x (not 0x) alone', () => {
    expect(stripHexPrefix('xabc')).toBe('xabc');
  });

  it('does NOT recursively strip — only the leading 0x', () => {
    expect(stripHexPrefix('0x0xabc')).toBe('0xabc');
  });
});

describe('hexToBytes', () => {
  it('round-trips a simple even-length hex string', () => {
    expect(Array.from(hexToBytes('00ff'))).toEqual([0x00, 0xff]);
  });

  it('strips 0x prefix before decoding', () => {
    expect(Array.from(hexToBytes('0x00ff'))).toEqual([0x00, 0xff]);
  });

  it('accepts both upper and lower case', () => {
    expect(Array.from(hexToBytes('AbCd'))).toEqual([0xab, 0xcd]);
  });

  it('decodes empty string to empty array', () => {
    expect(Array.from(hexToBytes(''))).toEqual([]);
  });

  it('throws on odd-length input', () => {
    expect(() => hexToBytes('abc')).toThrow(/odd length/);
  });

  it('throws on non-hex characters', () => {
    expect(() => hexToBytes('00zz')).toThrow(/non-hex/);
  });

  it('throws on whitespace inside an even-length string', () => {
    // 6 chars: "00 ff0" — even length, so falls past the odd-length check
    // and into the non-hex character validation.
    expect(() => hexToBytes('00 ff0')).toThrow(/non-hex/);
  });
});

describe('bytesToHex', () => {
  it('renders a byte array as lowercase hex', () => {
    expect(bytesToHex(new Uint8Array([0xab, 0xcd]))).toBe('abcd');
  });

  it('zero-pads single-digit bytes', () => {
    expect(bytesToHex(new Uint8Array([0x05, 0x0a]))).toBe('050a');
  });

  it('renders empty array as empty string', () => {
    expect(bytesToHex(new Uint8Array([]))).toBe('');
  });

  it('round-trips with hexToBytes', () => {
    const original = '0123456789abcdef';
    expect(bytesToHex(hexToBytes(original))).toBe(original);
  });
});

describe('isHex32 (security-critical — gates hash strings entering email body)', () => {
  // 64 hex chars = 32 bytes = a SHA-256-sized hash, which is what Chia
  // header_hash and similar fields are. isHex32 is used in two places:
  //   1. validateLocalScanResult (rejects bad hashes from the bash script)
  //   2. reorg-monitor.ts (skips blocks with malformed RPC-supplied hashes)

  it('accepts an all-zero 64-char hex string', () => {
    expect(isHex32('0'.repeat(64))).toBe(true);
  });

  it('accepts a typical block hash', () => {
    expect(
      isHex32('a4ec9dc5ddf1dd0b5c894c9989780e6be2bb9e69e418ad037504aa5f15833a41')
    ).toBe(true);
  });

  it('accepts uppercase hex', () => {
    expect(isHex32('A'.repeat(64))).toBe(true);
  });

  it('accepts mixed case', () => {
    expect(isHex32('AaBb' + '0'.repeat(60))).toBe(true);
  });

  it('accepts a 0x-prefixed 64-hex-char string (66 total)', () => {
    // stripHexPrefix is applied first, so the effective length is 64.
    expect(isHex32('0x' + 'a'.repeat(64))).toBe(true);
  });

  it('rejects too-short input', () => {
    expect(isHex32('a'.repeat(63))).toBe(false);
    expect(isHex32('abcd')).toBe(false);
    expect(isHex32('')).toBe(false);
  });

  it('rejects too-long input', () => {
    expect(isHex32('a'.repeat(65))).toBe(false);
    expect(isHex32('a'.repeat(128))).toBe(false);
  });

  it('rejects a non-hex character (g)', () => {
    expect(isHex32('g' + 'a'.repeat(63))).toBe(false);
  });

  it('rejects a non-hex character (z)', () => {
    expect(isHex32('z'.repeat(64))).toBe(false);
  });

  it('rejects embedded whitespace', () => {
    expect(isHex32('a'.repeat(31) + ' ' + 'a'.repeat(32))).toBe(false);
  });

  it('rejects embedded newline (the canonical email-injection vector)', () => {
    expect(isHex32('a'.repeat(31) + '\n' + 'a'.repeat(32))).toBe(false);
  });

  it('rejects embedded carriage return', () => {
    expect(isHex32('a'.repeat(31) + '\r' + 'a'.repeat(32))).toBe(false);
  });

  it('rejects embedded null byte', () => {
    expect(isHex32('a'.repeat(31) + '\x00' + 'a'.repeat(32))).toBe(false);
  });

  it('rejects a 0x-prefixed string that is NOT 64 hex chars after the prefix', () => {
    expect(isHex32('0x' + 'a'.repeat(63))).toBe(false);
    expect(isHex32('0x' + 'a'.repeat(65))).toBe(false);
  });

  it('rejects double-prefixed strings (because stripHexPrefix only strips once)', () => {
    // '0x0xaaaa...' → after strip: '0xaaaa...' which contains 'x' = non-hex.
    expect(isHex32('0x0x' + 'a'.repeat(62))).toBe(false);
  });
});
