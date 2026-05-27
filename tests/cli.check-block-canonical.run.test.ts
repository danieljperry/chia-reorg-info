import { describe, expect, it, vi } from 'vitest';
import { createChiaAgentMocks } from './helpers/chia-agent-mocks.js';

const mocks = createChiaAgentMocks();
vi.mock('chia-agent/api/rpc/full_node/index.js', () => mocks);

const { runCheckBlockCanonicalCli } = await import(
  '../src/cli/check-block-canonical.js'
);

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function captureStdio(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s: string | Uint8Array): boolean => {
    stdout.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
    return true;
  };
  process.stderr.write = (s: string | Uint8Array): boolean => {
    stderr.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
    return true;
  };
  return {
    stdout,
    stderr,
    restore() {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    },
  };
}

describe('runCheckBlockCanonicalCli', () => {
  it('returns 0 and canonical=true when the RPC hash matches --expected-hash', async () => {
    mocks.get_block_record_by_height.mockResolvedValueOnce({
      block_record: { header_hash: HASH_A, height: 100 },
    });
    const io = captureStdio();
    try {
      const status = await runCheckBlockCanonicalCli([
        '--height',
        '100',
        '--expected-hash',
        HASH_A,
      ]);
      expect(status).toBe(0);
      const out = JSON.parse(io.stdout.join('')) as Record<string, unknown>;
      expect(out.canonical).toBe(true);
      expect(out.height).toBe(100);
      expect(out.expected_header_hash).toBe(HASH_A);
      expect(out.current_header_hash).toBe(HASH_A);
      expect(out.network).toBe('mainnet');
    } finally {
      io.restore();
    }
  });

  it('returns 0 and canonical=false when the RPC hash differs from --expected-hash', async () => {
    mocks.get_block_record_by_height.mockResolvedValueOnce({
      block_record: { header_hash: HASH_B, height: 100 },
    });
    const io = captureStdio();
    try {
      const status = await runCheckBlockCanonicalCli([
        '--height',
        '100',
        '--expected-hash',
        HASH_A,
      ]);
      expect(status).toBe(0);
      const out = JSON.parse(io.stdout.join('')) as Record<string, unknown>;
      expect(out.canonical).toBe(false);
      expect(out.expected_header_hash).toBe(HASH_A);
      expect(out.current_header_hash).toBe(HASH_B);
    } finally {
      io.restore();
    }
  });

  it('strips 0x prefix from the RPC hash before comparing (no false negative)', async () => {
    mocks.get_block_record_by_height.mockResolvedValueOnce({
      block_record: { header_hash: `0x${HASH_A}`, height: 100 },
    });
    const io = captureStdio();
    try {
      const status = await runCheckBlockCanonicalCli([
        '--height',
        '100',
        '--expected-hash',
        HASH_A,
      ]);
      expect(status).toBe(0);
      const out = JSON.parse(io.stdout.join('')) as Record<string, unknown>;
      expect(out.canonical).toBe(true);
      expect(out.current_header_hash).toBe(HASH_A);
    } finally {
      io.restore();
    }
  });

  it('reports current_header_hash=null and canonical=false when the height has no record', async () => {
    mocks.get_block_record_by_height.mockResolvedValueOnce({
      block_record: null,
    });
    const io = captureStdio();
    try {
      const status = await runCheckBlockCanonicalCli([
        '--height',
        '999999999',
        '--expected-hash',
        HASH_A,
      ]);
      expect(status).toBe(0);
      const out = JSON.parse(io.stdout.join('')) as Record<string, unknown>;
      expect(out.canonical).toBe(false);
      expect(out.current_header_hash).toBeNull();
      expect(out.current_block_record).toBeNull();
    } finally {
      io.restore();
    }
  });

  it('returns 1 with stderr error message when the RPC throws', async () => {
    mocks.get_block_record_by_height.mockRejectedValueOnce(
      new Error('connection refused')
    );
    const io = captureStdio();
    try {
      const status = await runCheckBlockCanonicalCli([
        '--height',
        '100',
        '--expected-hash',
        HASH_A,
      ]);
      expect(status).toBe(1);
      expect(io.stderr.join('')).toMatch(/Error:.*connection refused/);
      expect(io.stdout.join('')).toBe(''); // no JSON on the error path
    } finally {
      io.restore();
    }
  });

  it('returns 0 and prints help on --help', async () => {
    const io = captureStdio();
    try {
      const status = await runCheckBlockCanonicalCli(['--help']);
      expect(status).toBe(0);
      expect(io.stdout.join('')).toMatch(/Usage: chia-reorg-info check_block_canonical/);
    } finally {
      io.restore();
    }
  });

  it('returns 2 with stderr error on invalid arguments', async () => {
    const io = captureStdio();
    try {
      const status = await runCheckBlockCanonicalCli([
        '--height',
        '100',
        '--expected-hash',
        'not-64-hex',
      ]);
      expect(status).toBe(2);
      expect(io.stderr.join('')).toMatch(/64-character hex string/);
    } finally {
      io.restore();
    }
  });

  it('lowercases --expected-hash before comparing (no false negative on uppercase input)', async () => {
    mocks.get_block_record_by_height.mockResolvedValueOnce({
      block_record: { header_hash: HASH_A, height: 100 },
    });
    const io = captureStdio();
    try {
      const status = await runCheckBlockCanonicalCli([
        '--height',
        '100',
        '--expected-hash',
        HASH_A.toUpperCase(),
      ]);
      expect(status).toBe(0);
      const out = JSON.parse(io.stdout.join('')) as Record<string, unknown>;
      expect(out.canonical).toBe(true);
    } finally {
      io.restore();
    }
  });
});
