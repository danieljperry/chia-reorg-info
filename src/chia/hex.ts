export function stripHexPrefix(s: string): string {
  return s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
}

export function hexToBytes(hex: string): Uint8Array {
  const stripped = stripHexPrefix(hex);
  if (stripped.length % 2 !== 0) throw new Error('hex string has odd length');
  if (!/^[0-9a-fA-F]*$/.test(stripped)) throw new Error('hex string contains non-hex characters');
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function isHex32(s: string): boolean {
  const stripped = stripHexPrefix(s);
  return stripped.length === 64 && /^[0-9a-fA-F]+$/.test(stripped);
}
