import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChiaAgentMocks } from './helpers/chia-agent-mocks.js';

// Integration test for runReorgMonitorCli's polling lifecycle. Mocks the
// three I/O boundaries the CLI uses:
//   * chia-agent RPC (Coinset side)
//   * node:child_process.spawn (local-DB side — the bash script)
//   * nodemailer.createTransport().sendMail (alert dispatch)
//
// Then for each source mode, starts the CLI without awaiting, waits a
// short interval for the immediate-first poll to fire, sends SIGINT/
// SIGTERM, and asserts the lifecycle reached its expected end state
// (RPC called, bash spawned, email sent for known reorgs).

const agentMocks = createChiaAgentMocks();
vi.mock('chia-agent/api/rpc/full_node/index.js', () => agentMocks);

const spawnMock = vi.fn();
// spawnSync is used by the startup chia-import probe (warnIfChiaMissing →
// resolveChiaPython). Return a success shape so the probe is a no-op here and
// these tests stay focused on the polling lifecycle.
const spawnSyncMock = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
vi.mock('node:child_process', () => ({ spawn: spawnMock, spawnSync: spawnSyncMock }));

const sendMailMock = vi.fn().mockResolvedValue({ messageId: 'test' });
const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));
vi.mock('nodemailer', () => ({ default: { createTransport: createTransportMock } }));

// Late-import so the mocks above are wired before the CLI module pulls in
// its transitive dependencies.
const { runReorgMonitorCli } = await import('../src/cli/reorg-monitor.js');
const { stopMonitor } = await import('../src/monitor/reorg-monitor.js');
const { stopLocalPoller, _resetLocalStateForTests } = await import(
  '../src/monitor/local-poller.js'
);

/** Build a fake child_process from spawn() that emits canned stdout / exit. */
function fakeChild(opts: { stdout?: string; stderr?: string; exitCode?: number }) {
  const { stdout = '', stderr = '', exitCode = 0 } = opts;
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
  };
  proc.stdout = Readable.from(stdout ? [Buffer.from(stdout, 'utf8')] : []);
  proc.stderr = Readable.from(stderr ? [Buffer.from(stderr, 'utf8')] : []);
  setImmediate(() => proc.emit('close', exitCode));
  return proc;
}

/** Capture stdio so the test output doesn't leak. */
function captureStdio(): { restore: () => void } {
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (): boolean => true;
  process.stderr.write = (): boolean => true;
  return {
    restore() {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    },
  };
}

/** Wait until a predicate returns truthy, or throw after timeoutMs. */
async function waitFor(
  pred: () => boolean,
  timeoutMs = 2000,
  label = 'predicate'
): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

const VALID_HASH = 'a'.repeat(64);
const REORG_HASH = 'b'.repeat(64);

describe('runReorgMonitorCli polling lifecycle (integration)', () => {
  let tempDir: string;
  let dbPath: string;
  let sigintListenersBefore: NodeJS.SignalsListener[];
  let sigtermListenersBefore: NodeJS.SignalsListener[];
  let stdio: { restore: () => void };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cli-lifecycle-'));
    dbPath = join(tempDir, 'db.sqlite');
    writeFileSync(dbPath, 'fake'); // checkDbPathReadable wants any readable file

    agentMocks.get_blockchain_state.mockReset();
    agentMocks.get_block_records.mockReset();
    spawnMock.mockReset();
    sendMailMock.mockClear();
    _resetLocalStateForTests();

    // Snapshot existing signal listeners so we can clean up any
    // added by runReorgMonitorCli without disturbing vitest's own.
    sigintListenersBefore = process.listeners('SIGINT').slice();
    sigtermListenersBefore = process.listeners('SIGTERM').slice();

    stdio = captureStdio();
  });

  afterEach(() => {
    stdio.restore();
    // Make sure any pollers are halted, even if the test failed before
    // sending its shutdown signal.
    stopMonitor();
    stopLocalPoller();
    // Remove any signal listeners runReorgMonitorCli left behind.
    for (const l of process.listeners('SIGINT')) {
      if (!sigintListenersBefore.includes(l)) {
        process.removeListener('SIGINT', l);
      }
    }
    for (const l of process.listeners('SIGTERM')) {
      if (!sigtermListenersBefore.includes(l)) {
        process.removeListener('SIGTERM', l);
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('--source coinset polls the Coinset RPC, dispatches email on reorg, exits 0 on SIGINT', async () => {
    // Both polls peak at 100 so prevObservedPeak === peak and depth stays
    // exact (1, not 1-N). Hash at height 100 changes between polls →
    // 1-block reorg detected.
    agentMocks.get_blockchain_state
      .mockResolvedValueOnce({
        blockchain_state: { peak: { height: 100, header_hash: VALID_HASH } },
      })
      .mockResolvedValueOnce({
        blockchain_state: { peak: { height: 100, header_hash: REORG_HASH } },
      });
    agentMocks.get_block_records
      .mockResolvedValueOnce({
        block_records: [
          { height: 98, header_hash: '8'.repeat(64) },
          { height: 99, header_hash: '9'.repeat(64) },
          { height: 100, header_hash: VALID_HASH },
        ],
      })
      .mockResolvedValueOnce({
        block_records: [
          { height: 98, header_hash: '8'.repeat(64) },
          { height: 99, header_hash: '9'.repeat(64) },
          { height: 100, header_hash: REORG_HASH }, // changed
        ],
      });

    const { _pollOnce } = await import('../src/monitor/reorg-monitor.js');
    const cliPromise = runReorgMonitorCli([
      '--source', 'coinset',
      '--poll-interval', '5',
      '--recipient', 'alice@example.com',
      '--no-log-file',
    ]);

    // First poll runs immediately on startMonitor(); wait for it then
    // drive a second poll manually so we get a state transition.
    await waitFor(
      () => agentMocks.get_blockchain_state.mock.calls.length >= 1,
      2000,
      'first Coinset poll'
    );
    await _pollOnce();

    await waitFor(() => sendMailMock.mock.calls.length >= 1, 2000, 'email dispatch');
    const sent = sendMailMock.mock.calls[0]![0] as { to: string; subject: string };
    expect(sent.to).toBe('alice@example.com');
    expect(sent.subject).toMatch(/Re-org of depth 1 detected on Chia mainnet/);

    process.emit('SIGINT');
    const exitCode = await cliPromise;
    expect(exitCode).toBe(0);
  });

  it('--source local spawns the bash script and dispatches per-recipient on reorg', async () => {
    // Mock spawn to return one reorg per poll. Use mockImplementation (not
    // mockReturnValue) so EACH spawn gets a FRESH fake child — a single shared
    // child's stdout stream drains and 'close' fires only once, so any second
    // spawn in the same flow (e.g. the bridge-decode helper) would hang on a
    // dead child. Fresh-per-call matches real spawn() semantics.
    spawnMock.mockImplementation(() =>
      fakeChild({
        stdout: JSON.stringify({
          network: 'mainnet',
          start_height: 100,
          end_height: 110,
          scanned_at_unix: 1700000000,
          peak_at_scan: 110,
          reorgs: [
            {
              low: 105, high: 105, depth: 1,
              ts_low_unix: 1700000000, ts_high_unix: 1700000000,
              old_hash: 'c'.repeat(64), new_hash: 'd'.repeat(64),
              old_block_record: { timestamp: 1700000000, weight: 999 },
            },
          ],
        }),
      })
    );

    const cliPromise = runReorgMonitorCli([
      '--source', 'local',
      '--db-path', dbPath,
      '--local-poll-interval', '5',
      '--recipient', 'bob@example.com',
      '--no-log-file',
    ]);

    await waitFor(() => spawnMock.mock.calls.length >= 1, 2000, 'bash spawn');
    // Verify it spawned bash with the script path + --json.
    const call = spawnMock.mock.calls[0] as [string, string[]];
    expect(call[0]).toBe('bash');
    expect(call[1]).toContain('--json');
    expect(call[1]).toContain('--peak-from');
    expect(call[1]).toContain(dbPath);

    await waitFor(() => sendMailMock.mock.calls.length >= 1, 2000, 'email dispatch');
    const sent = sendMailMock.mock.calls[0]![0] as { to: string; text: string };
    expect(sent.to).toBe('bob@example.com');
    // The body includes the rich BlockRecord we plumbed through.
    expect(sent.text).toContain('"weight": 999');

    process.emit('SIGINT');
    const exitCode = await cliPromise;
    expect(exitCode).toBe(0);
  });

  it('--source both wires up both pollers and produces a `matched` outcome', async () => {
    // Coinset side: peak=100, then peak=103 with a reorg observed at 100.
    // We need the second poll to fire to trigger detection.
    agentMocks.get_blockchain_state
      .mockResolvedValueOnce({
        blockchain_state: { peak: { height: 100, header_hash: VALID_HASH } },
      })
      .mockResolvedValueOnce({
        blockchain_state: { peak: { height: 103, header_hash: 'e'.repeat(64) } },
      });
    agentMocks.get_block_records
      .mockResolvedValueOnce({
        block_records: [
          { height: 98, header_hash: '8'.repeat(64) },
          { height: 99, header_hash: '9'.repeat(64) },
          { height: 100, header_hash: VALID_HASH },
        ],
      })
      .mockResolvedValueOnce({
        block_records: [
          { height: 98, header_hash: '8'.repeat(64) },
          { height: 99, header_hash: '9'.repeat(64) },
          { height: 100, header_hash: REORG_HASH }, // changed
          { height: 101, header_hash: 'f'.repeat(64) },
          { height: 102, header_hash: '7'.repeat(64) },
          { height: 103, header_hash: 'e'.repeat(64) },
        ],
      });

    // Local side: matching reorg at the same height, peak past settle. Fresh
    // child per spawn (see the --source local test) so the bridge-decode helper
    // spawn doesn't reuse a drained child.
    spawnMock.mockImplementation(() =>
      fakeChild({
        stdout: JSON.stringify({
          network: 'mainnet',
          start_height: 95,
          end_height: 103,
          scanned_at_unix: 1700000000,
          peak_at_scan: 103,
          reorgs: [
            {
              low: 100, high: 100, depth: 1,
              ts_low_unix: 1700000000, ts_high_unix: 1700000000,
              old_hash: 'c'.repeat(64), new_hash: 'd'.repeat(64),
              old_block_record: { timestamp: 1700000000 },
            },
          ],
        }),
      })
    );

    const { _pollOnce } = await import('../src/monitor/reorg-monitor.js');
    const cliPromise = runReorgMonitorCli([
      '--source', 'both',
      '--db-path', dbPath,
      '--poll-interval', '5',
      '--local-poll-interval', '5',
      '--recipient', 'carol@example.com',
      '--no-log-file',
    ]);

    // Let both pollers run their first poll.
    await waitFor(
      () =>
        agentMocks.get_blockchain_state.mock.calls.length >= 1 &&
        spawnMock.mock.calls.length >= 1,
      2000,
      'both pollers initial cycle'
    );
    // Trigger a second Coinset poll so the reorg gets detected.
    await _pollOnce();

    await waitFor(() => sendMailMock.mock.calls.length >= 1, 3000, 'matched email');
    const sent = sendMailMock.mock.calls[0]![0] as { subject: string; text: string };
    expect(sent.subject).toMatch(/confirmed by Coinset \+ local DB/);
    expect(sent.text).toMatch(/The same reorg of 1 block\(s\)/);

    process.emit('SIGINT');
    const exitCode = await cliPromise;
    expect(exitCode).toBe(0);
  });

  it('exits 0 on SIGTERM (not only SIGINT)', async () => {
    agentMocks.get_blockchain_state.mockResolvedValue({
      blockchain_state: { peak: { height: 100, header_hash: VALID_HASH } },
    });
    agentMocks.get_block_records.mockResolvedValue({ block_records: [] });

    const cliPromise = runReorgMonitorCli([
      '--source', 'coinset',
      '--no-log-file',
    ]);
    await waitFor(
      () => agentMocks.get_blockchain_state.mock.calls.length >= 1,
      2000,
      'first poll'
    );
    process.emit('SIGTERM');
    const exitCode = await cliPromise;
    expect(exitCode).toBe(0);
  });

  it('--source local with an unreadable --db-path returns 2 BEFORE starting pollers', async () => {
    const exitCode = await runReorgMonitorCli([
      '--source', 'local',
      '--db-path', '/this/path/does/not/exist.sqlite',
      '--no-log-file',
    ]);
    expect(exitCode).toBe(2);
    // No pollers should have started.
    expect(spawnMock).not.toHaveBeenCalled();
    expect(agentMocks.get_blockchain_state).not.toHaveBeenCalled();
  });
});
