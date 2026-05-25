import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process.spawn so we can drive what stdout/stderr the bash script
// "returns" without ever shelling out.
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

// Late-import so the mock above is wired before the module pulls spawn in.
const { _pollLocalOnce, _resetLocalStateForTests } = await import(
  '../src/monitor/local-poller.js'
);

type SpawnResult = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
};

/** Build a fake child process that emits given stdout/stderr then closes. */
function fakeChild({ stdout = '', stderr = '', exitCode = 0 }: SpawnResult) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
  };
  proc.stdout = Readable.from(stdout ? [Buffer.from(stdout, 'utf8')] : []);
  proc.stderr = Readable.from(stderr ? [Buffer.from(stderr, 'utf8')] : []);
  // close fires after both streams drain
  setImmediate(() => proc.emit('close', exitCode));
  return proc;
}

const baseOpts = {
  script_path: '/fake/scripts/reorg-finder.sh',
  db_path: '/fake/db.sqlite',
  poll_interval_seconds: 10,
  lookback_blocks: 5,
};

describe('local-poller _pollLocalOnce', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    _resetLocalStateForTests();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('parses a successful JSON response and calls on_reorg per cluster', async () => {
    spawnMock.mockReturnValueOnce(
      fakeChild({
        stdout: JSON.stringify({
          network: 'mainnet',
          start_height: 100,
          end_height: 110,
          scanned_at_unix: 1_700_000_000,
          peak_at_scan: 110,
          reorgs: [
            { low: 105, high: 105, depth: 1, ts_low_unix: 1, ts_high_unix: 1 },
            { low: 108, high: 109, depth: 2, ts_low_unix: 2, ts_high_unix: 3 },
          ],
        }),
        exitCode: 0,
      })
    );
    const onReorg = vi.fn();
    const onPeak = vi.fn();
    await _pollLocalOnce({ ...baseOpts, on_reorg: onReorg, on_peak: onPeak });
    expect(onReorg).toHaveBeenCalledTimes(2);
    expect(onReorg.mock.calls[0]![0]).toMatchObject({ low: 105, high: 105, depth: 1 });
    expect(onReorg.mock.calls[1]![0]).toMatchObject({ low: 108, high: 109, depth: 2 });
    expect(onPeak).toHaveBeenCalledWith(110);
  });

  it('dedupes by low:high across multiple polls', async () => {
    const sameReorg = JSON.stringify({
      network: 'mainnet',
      start_height: 100,
      end_height: 110,
      scanned_at_unix: 1,
      peak_at_scan: 110,
      reorgs: [{ low: 105, high: 105, depth: 1, ts_low_unix: 1, ts_high_unix: 1 }],
    });
    spawnMock.mockReturnValueOnce(fakeChild({ stdout: sameReorg }));
    const onReorg = vi.fn();
    await _pollLocalOnce({ ...baseOpts, on_reorg: onReorg });
    expect(onReorg).toHaveBeenCalledTimes(1);

    // Second poll, same reorg again
    spawnMock.mockReturnValueOnce(fakeChild({ stdout: sameReorg }));
    await _pollLocalOnce({ ...baseOpts, on_reorg: onReorg });
    expect(onReorg).toHaveBeenCalledTimes(1); // not called again
  });

  it('does NOT call on_reorg when the JSON has reorgs: []', async () => {
    spawnMock.mockReturnValueOnce(
      fakeChild({
        stdout: JSON.stringify({
          network: 'mainnet',
          start_height: 100,
          end_height: 110,
          scanned_at_unix: 1,
          peak_at_scan: 110,
          reorgs: [],
        }),
      })
    );
    const onReorg = vi.fn();
    const onPeak = vi.fn();
    await _pollLocalOnce({ ...baseOpts, on_reorg: onReorg, on_peak: onPeak });
    expect(onReorg).not.toHaveBeenCalled();
    expect(onPeak).toHaveBeenCalledWith(110); // still fires
  });

  it('handles non-zero exit cleanly — no on_reorg, no throw', async () => {
    spawnMock.mockReturnValueOnce(
      fakeChild({ stdout: '', stderr: 'sqlite3 not found', exitCode: 127 })
    );
    const onReorg = vi.fn();
    await expect(
      _pollLocalOnce({ ...baseOpts, on_reorg: onReorg })
    ).resolves.toBeUndefined();
    expect(onReorg).not.toHaveBeenCalled();
  });

  it('handles unparseable JSON cleanly', async () => {
    spawnMock.mockReturnValueOnce(fakeChild({ stdout: 'not json' }));
    const onReorg = vi.fn();
    await expect(
      _pollLocalOnce({ ...baseOpts, on_reorg: onReorg })
    ).resolves.toBeUndefined();
    expect(onReorg).not.toHaveBeenCalled();
  });

  it('invokes spawn with bash + the expected args', async () => {
    spawnMock.mockReturnValueOnce(
      fakeChild({
        stdout: JSON.stringify({
          network: 'mainnet',
          start_height: 100,
          end_height: 110,
          scanned_at_unix: 1,
          peak_at_scan: 110,
          reorgs: [],
        }),
      })
    );
    const onReorg = vi.fn();
    await _pollLocalOnce({ ...baseOpts, on_reorg: onReorg });
    expect(spawnMock).toHaveBeenCalledOnce();
    const call = spawnMock.mock.calls[0] as [string, string[]];
    expect(call[0]).toBe('bash');
    expect(call[1]).toEqual([
      '/fake/scripts/reorg-finder.sh',
      '-d',
      '/fake/db.sqlite',
      '-n',
      '5',
      '--peak-from',
      'db',
      '--json',
    ]);
  });
});

const { validateLocalScanResult } = await import('../src/monitor/local-poller.js');

describe('validateLocalScanResult', () => {
  const valid = {
    network: 'mainnet',
    start_height: 100,
    end_height: 110,
    scanned_at_unix: 1_700_000_000,
    peak_at_scan: 110,
    reorgs: [{ low: 105, high: 105, depth: 1, ts_low_unix: 1, ts_high_unix: 1 }],
  };

  it('accepts a well-formed payload', () => {
    expect(validateLocalScanResult(valid)).not.toBeNull();
  });

  it('accepts null timestamps on individual reorgs', () => {
    const v = { ...valid, reorgs: [{ low: 1, high: 1, depth: 1, ts_low_unix: null, ts_high_unix: null }] };
    expect(validateLocalScanResult(v)).not.toBeNull();
  });

  it.each<{ label: string; raw: unknown }>([
    { label: 'null root', raw: null },
    { label: 'string root', raw: 'string' },
    { label: 'number root', raw: 42 },
    { label: 'array root', raw: [] },
  ])('rejects non-object root: $label', ({ raw }) => {
    expect(validateLocalScanResult(raw)).toBeNull();
  });

  it('rejects missing or wrongly-typed scalar fields', () => {
    expect(validateLocalScanResult({ ...valid, network: 123 })).toBeNull();
    expect(validateLocalScanResult({ ...valid, peak_at_scan: -1 })).toBeNull();
    expect(validateLocalScanResult({ ...valid, peak_at_scan: 3.14 })).toBeNull();
    expect(validateLocalScanResult({ ...valid, scanned_at_unix: 'now' })).toBeNull();
  });

  it('rejects a non-array reorgs field', () => {
    expect(validateLocalScanResult({ ...valid, reorgs: 'oops' })).toBeNull();
  });

  it('rejects a reorg with non-integer fields (the type-confusion attack)', () => {
    const bad = {
      ...valid,
      reorgs: [{ low: '105', high: 105, depth: 1, ts_low_unix: 1, ts_high_unix: 1 }],
    };
    expect(validateLocalScanResult(bad)).toBeNull();
  });

  it('rejects a reorg with negative height', () => {
    const bad = {
      ...valid,
      reorgs: [{ low: -1, high: 1, depth: 1, ts_low_unix: 1, ts_high_unix: 1 }],
    };
    expect(validateLocalScanResult(bad)).toBeNull();
  });

  it('rejects a non-integer ts_low_unix (non-null, non-int)', () => {
    const bad = {
      ...valid,
      reorgs: [{ low: 1, high: 1, depth: 1, ts_low_unix: 'evil', ts_high_unix: 1 }],
    };
    expect(validateLocalScanResult(bad)).toBeNull();
  });
});

describe('local-poller _pollLocalOnce — schema enforcement', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    _resetLocalStateForTests();
  });

  it('does not call on_reorg / on_peak when JSON parses but fails schema', async () => {
    spawnMock.mockReturnValueOnce(
      fakeChild({
        // Missing required peak_at_scan, plus a malformed reorg entry.
        stdout: JSON.stringify({
          network: 'mainnet',
          start_height: 100,
          end_height: 110,
          scanned_at_unix: 1,
          reorgs: [{ low: 'not-a-number', high: 105, depth: 1 }],
        }),
      })
    );
    const onReorg = vi.fn();
    const onPeak = vi.fn();
    await _pollLocalOnce({ ...baseOpts, on_reorg: onReorg, on_peak: onPeak });
    expect(onReorg).not.toHaveBeenCalled();
    expect(onPeak).not.toHaveBeenCalled();
  });
});
