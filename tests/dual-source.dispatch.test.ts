import { describe, expect, it, vi } from 'vitest';
import {
  createDualSource,
  PENDING_BUFFER_CAP,
  type DispatchOutcome,
  type SourceEvent,
} from '../src/monitor/dual-source.js';

function coinsetEvt(low: number, high: number, depth: number, max_depth = depth): SourceEvent {
  return {
    source: 'coinset',
    low,
    high,
    settle_at: high,
    depth,
    max_depth,
    detected_at_iso: '2026-05-25T00:00:00Z',
  };
}
function localEvt(low: number, high: number, depth: number): SourceEvent {
  return {
    source: 'local',
    low,
    high,
    settle_at: high,
    depth,
    max_depth: depth,
    detected_at_iso: '2026-05-25T00:00:00Z',
  };
}

describe('dual-source dispatch outcomes', () => {
  it('single-source coinset mode: releases each event on next peak past high+2', async () => {
    const dispatched: DispatchOutcome[] = [];
    const c = createDualSource('coinset', (o) => {
      dispatched.push(o);
    });
    c.noteReorg(coinsetEvt(100, 102, 3));
    await c.notePeak('coinset', 103); // 100+2 = 102 < 103? No: high=102, high+2=104, gate=103 → not released yet
    expect(dispatched).toHaveLength(0);
    await c.notePeak('coinset', 104); // gate=104, settle=high+2=104 → released
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.kind).toBe('coinset-only');
    if (dispatched[0]?.kind === 'coinset-only') {
      expect(dispatched[0].event.low).toBe(100);
      expect(dispatched[0].event.high).toBe(102);
    }
  });

  it('single-source local mode: releases each event on next peak past high+2', async () => {
    const dispatched: DispatchOutcome[] = [];
    const c = createDualSource('local', (o) => {
      dispatched.push(o);
    });
    c.noteReorg(localEvt(100, 102, 3));
    await c.notePeak('local', 104);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.kind).toBe('local-only');
    if (dispatched[0]?.kind === 'local-only') {
      expect(dispatched[0].event.low).toBe(100);
      expect(dispatched[0].event.high).toBe(102);
    }
  });

  it('both mode + identical reorgs from both sources → single matched outcome', async () => {
    const dispatched: DispatchOutcome[] = [];
    const c = createDualSource('both', (o) => {
      dispatched.push(o);
    });
    c.noteReorg(coinsetEvt(100, 102, 3));
    c.noteReorg(localEvt(100, 102, 3));
    await c.notePeak('coinset', 104);
    await c.notePeak('local', 104);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.kind).toBe('matched');
    if (dispatched[0]?.kind === 'matched') {
      expect(dispatched[0].coinset.low).toBe(100);
      expect(dispatched[0].local.low).toBe(100);
    }
  });

  it('both mode + only coinset detects (local poll passed without seeing it) → coinset-only', async () => {
    const dispatched: DispatchOutcome[] = [];
    const c = createDualSource('both', (o) => {
      dispatched.push(o);
    });
    c.noteReorg(coinsetEvt(100, 102, 3));
    // settle_at=102. A single-source (unpaired) event is held until
    // settle_at + SINGLE_SOURCE_MARGIN (=6) so a late local counterpart could
    // still pair; +2 only makes it eligible to pair, not to dispatch alone.
    await c.notePeak('coinset', 104);
    await c.notePeak('local', 104); // local saw no reorg; gate=104 < 108 → held
    expect(dispatched).toHaveLength(0);
    await c.notePeak('coinset', 108);
    await c.notePeak('local', 108); // gate=108 ≥ 102+6 → released single-source
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.kind).toBe('coinset-only');
  });

  it('both mode + only local detects → local-only', async () => {
    const dispatched: DispatchOutcome[] = [];
    const c = createDualSource('both', (o) => {
      dispatched.push(o);
    });
    c.noteReorg(localEvt(100, 102, 3));
    // settle_at=102; held as single-source until settle_at + 6 = 108.
    await c.notePeak('coinset', 104); // coinset saw no reorg
    await c.notePeak('local', 104); // gate=104 < 108 → held
    expect(dispatched).toHaveLength(0);
    await c.notePeak('coinset', 108);
    await c.notePeak('local', 108); // gate=108 ≥ 108 → released
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.kind).toBe('local-only');
  });

  it('both mode + coinset range matches local exact (Example 1) → matched', async () => {
    const dispatched: DispatchOutcome[] = [];
    const c = createDualSource('both', (o) => {
      dispatched.push(o);
    });
    c.noteReorg(coinsetEvt(100, 103, 1, 4)); // 1-4 depth, 100..103
    c.noteReorg(localEvt(100, 102, 3));      // exact 3, 100..102
    await c.notePeak('coinset', 105);
    await c.notePeak('local', 105);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.kind).toBe('matched');
  });

  it('both mode + coinset range adjacent to local (Example 2) → matched', async () => {
    const dispatched: DispatchOutcome[] = [];
    const c = createDualSource('both', (o) => {
      dispatched.push(o);
    });
    c.noteReorg(coinsetEvt(100, 103, 1, 4));
    c.noteReorg(localEvt(99, 101, 3));
    await c.notePeak('coinset', 105);
    await c.notePeak('local', 105);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.kind).toBe('matched');
  });

  it('both mode + coinset exact differs from local (Example 3) → two separate outcomes', async () => {
    const dispatched: DispatchOutcome[] = [];
    const c = createDualSource('both', (o) => {
      dispatched.push(o);
    });
    c.noteReorg(coinsetEvt(100, 100, 1, 1)); // depth=1, exact, settle_at=100
    c.noteReorg(localEvt(100, 102, 3));      // depth=3, settle_at=102, doesn't match
    // Both are settled-and-eligible-to-pair at +2 but DON'T match each other,
    // so each must wait out the single-source window (settle_at + 6) before
    // being declared single-source. Highest gate needed: 102 + 6 = 108.
    await c.notePeak('coinset', 108);
    await c.notePeak('local', 108);
    expect(dispatched).toHaveLength(2);
    const kinds = dispatched.map((o) => o.kind).sort();
    expect(kinds).toEqual(['coinset-only', 'local-only']);
  });

  it('both mode + coinset/local at different heights (Example 4) → two outcomes', async () => {
    const dispatched: DispatchOutcome[] = [];
    const c = createDualSource('both', (o) => {
      dispatched.push(o);
    });
    c.noteReorg(coinsetEvt(100, 100, 1, 1)); // settle_at=100
    c.noteReorg(localEvt(101, 101, 1));      // settle_at=101; different height
    // No match (different heights), so each waits out the single-source window.
    // Highest gate needed: 101 + 6 = 107.
    await c.notePeak('coinset', 107);
    await c.notePeak('local', 107);
    expect(dispatched).toHaveLength(2);
    const kinds = dispatched.map((o) => o.kind).sort();
    expect(kinds).toEqual(['coinset-only', 'local-only']);
  });

  it('both mode: release gate is MIN of both peaks (one source lagging holds events)', async () => {
    const dispatched: DispatchOutcome[] = [];
    const c = createDualSource('both', (o) => {
      dispatched.push(o);
    });
    c.noteReorg(coinsetEvt(100, 100, 1)); // settle_at=100
    await c.notePeak('coinset', 200); // far past, but local hasn't reported yet
    expect(dispatched).toHaveLength(0); // gate is min(200, null) = -Inf
    await c.notePeak('local', 102); // gate = min(200, 102) = 102 < 106 → still held
    expect(dispatched).toHaveLength(0);
    await c.notePeak('local', 106); // gate = min(200, 106) = 106 ≥ 100+6 → release
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.kind).toBe('coinset-only');
  });

  it('both mode: events that arrive after settle still get paired if peer is also still in buffer', async () => {
    const dispatched: DispatchOutcome[] = [];
    const c = createDualSource('both', (o) => {
      dispatched.push(o);
    });
    // Coinset detects first, then local — both before either peak advances.
    c.noteReorg(coinsetEvt(100, 102, 3));
    c.noteReorg(localEvt(100, 102, 3));
    await c.notePeak('coinset', 104);
    await c.notePeak('local', 104);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.kind).toBe('matched');
  });

  it('does not double-dispatch when notePeak fires multiple times', async () => {
    const dispatched: DispatchOutcome[] = [];
    const c = createDualSource('coinset', (o) => {
      dispatched.push(o);
    });
    c.noteReorg(coinsetEvt(100, 100, 1));
    await c.notePeak('coinset', 102);
    await c.notePeak('coinset', 103);
    await c.notePeak('coinset', 104);
    expect(dispatched).toHaveLength(1);
  });

  it('dispatch hook can be async; coordinator awaits it', async () => {
    const calls: string[] = [];
    const c = createDualSource('coinset', async (o) => {
      await new Promise((r) => setTimeout(r, 0));
      calls.push(o.kind);
    });
    c.noteReorg(coinsetEvt(100, 100, 1));
    await c.notePeak('coinset', 102);
    expect(calls).toEqual(['coinset-only']);
  });

  it('dispatch hook receives an outcome with the right shape and source data', async () => {
    // Previously this test only verified that the hook was called at all
    // (tautological — implied by every other test in this file). Now it
    // asserts the outcome's structure matches the contract: kind +
    // appropriately-shaped event field, with the source data preserved
    // verbatim from noteReorg's input.
    const fn = vi.fn<(o: DispatchOutcome) => void>();
    const c = createDualSource('coinset', fn);
    c.noteReorg(coinsetEvt(100, 100, 1));
    await c.notePeak('coinset', 102);
    expect(fn).toHaveBeenCalledOnce();
    const arg = fn.mock.calls[0]![0];
    expect(arg.kind).toBe('coinset-only');
    if (arg.kind === 'coinset-only') {
      expect(arg.event.source).toBe('coinset');
      expect(arg.event.low).toBe(100);
      expect(arg.event.high).toBe(100);
      expect(arg.event.depth).toBe(1);
      expect(arg.event.max_depth).toBe(1);
    }
  });

  it('regression (8773694): widened coinset high does not cause local to release ahead of coinset', async () => {
    // Real-world reproduction from the 2026-05-25 chiafarmer log: local
    // detected a 1-block reorg at 8773694; Coinset detected at the same
    // height with depth=1, max_depth=3 (chain advanced 2 blocks past
    // observed peak during the reorg). Without settle_at, the widened
    // Coinset high=8773696 makes its release threshold 8773698, while
    // local's is 8773696, so they release in different windows and never
    // get paired. With settle_at = observed top (8773694) for both, they
    // settle together and the match loop pairs them.
    const dispatched: DispatchOutcome[] = [];
    const c = createDualSource('both', (o) => {
      dispatched.push(o);
    });

    // 11:35:19 — local detects, notes its peak.
    c.noteReorg({
      source: 'local',
      low: 8773694,
      high: 8773694,
      settle_at: 8773694,
      depth: 1,
      max_depth: 1,
      detected_at_iso: '2026-05-25T03:35:19.162Z',
    });
    await c.notePeak('local', 8773694);
    expect(dispatched).toHaveLength(0); // gate=min(?, 8773694), coinset still null

    // 11:35:49 — coinset detects (depth=1, max_depth=3, peak=8773696) and
    // hands off to the coordinator. Note: noteReorg fires BEFORE notePeak
    // in the new ordering. The Coinset SourceEvent's high is widened to
    // 8773696 (matching range) but settle_at stays at the observed top.
    c.noteReorg({
      source: 'coinset',
      low: 8773694,
      high: 8773694 + (3 - 1), // widened: 8773696
      settle_at: 8773694,       // observed top, un-widened
      depth: 1,
      max_depth: 3,
      detected_at_iso: '2026-05-25T03:35:49.993Z',
    });
    await c.notePeak('coinset', 8773696);
    // gate = min(coinset=8773696, local=8773694) = 8773694
    // both events: settle_at + 2 = 8773696, NOT ≤ 8773694 → stay pending
    expect(dispatched).toHaveLength(0);

    // Next local poll advances local peak to 8773696. Now both settle.
    await c.notePeak('local', 8773696);
    // gate = 8773696, both events settle_at + 2 = 8773696 → release together.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.kind).toBe('matched');
  });

  it('pending buffer is bounded; oldest event is dropped at the cap', () => {
    const dispatched: DispatchOutcome[] = [];
    const c = createDualSource('both', (o) => {
      dispatched.push(o);
    });
    // Fill the buffer to capacity. No peaks reported, so nothing releases.
    for (let i = 0; i < PENDING_BUFFER_CAP; i++) {
      c.noteReorg(coinsetEvt(1_000_000 + i, 1_000_000 + i, 1));
    }
    expect(c._state().pending).toHaveLength(PENDING_BUFFER_CAP);
    expect(c._state().pending[0]!.low).toBe(1_000_000);

    // One more push should drop the oldest, keep length at cap, and the head
    // should now be the second-oldest.
    c.noteReorg(coinsetEvt(2_000_000, 2_000_000, 1));
    expect(c._state().pending).toHaveLength(PENDING_BUFFER_CAP);
    expect(c._state().pending[0]!.low).toBe(1_000_001);
    expect(c._state().pending[PENDING_BUFFER_CAP - 1]!.low).toBe(2_000_000);
    expect(dispatched).toHaveLength(0);
  });

  it('incident regression (8801066): local settles first but is HELD for the late coinset counterpart → single matched', async () => {
    // Real-world reproduction: a 1-block reorg at 8801066. The local poller
    // detected it ~10s before Coinset; Coinset observed it 3 blocks late
    // (depth 1, max_depth 4). Pre-fix, the local event released alone at
    // settle_at + 2 before the Coinset event even entered the buffer → two
    // single-source emails. Post-fix, the unpaired local event is held until
    // settle_at + SINGLE_SOURCE_MARGIN, giving the late Coinset event time to
    // arrive and pair into ONE matched outcome.
    const dispatched: DispatchOutcome[] = [];
    const c = createDualSource('both', (o) => {
      dispatched.push(o);
    });

    // Local detects at 8801066 and its peak begins advancing.
    c.noteReorg(localEvt(8801066, 8801066, 1)); // settle_at=8801066
    await c.notePeak('local', 8801068); // local gate alone would be 8801068
    // Coinset peak is current (it tracks the tip) even though it detected late.
    await c.notePeak('coinset', 8801069);
    // gate = min(8801069, 8801068) = 8801068 ≥ settle_at+2 (8801068): the local
    // event is now PAIR-eligible, but has no counterpart yet and is NOT past
    // the single-source margin (8801066+6=8801072), so it must be HELD.
    expect(dispatched).toHaveLength(0);

    // ~10s later Coinset reports the same reorg, observed 3 blocks late.
    c.noteReorg({
      source: 'coinset',
      low: 8801066,
      high: 8801066 + (4 - 1), // widened to 8801069
      settle_at: 8801066, // observed top, un-widened
      depth: 1,
      max_depth: 4,
      detected_at_iso: '2026-05-31T01:29:49.652Z',
    });
    await c.notePeak('coinset', 8801069);
    await c.notePeak('local', 8801069);
    // Both present and pair-eligible (gate=8801069 ≥ 8801068) → one matched,
    // dispatched immediately without waiting out the single-source window.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.kind).toBe('matched');
  });

  it('genuine single-source still fires, but only after SINGLE_SOURCE_MARGIN (not at +2)', async () => {
    const dispatched: DispatchOutcome[] = [];
    const c = createDualSource('both', (o) => {
      dispatched.push(o);
    });
    c.noteReorg(localEvt(8801066, 8801066, 1)); // settle_at=8801066

    // Between +2 and +6 the event is held (waiting for a possible counterpart).
    await c.notePeak('coinset', 8801070);
    await c.notePeak('local', 8801070); // gate=8801070 ∈ [+2=68, +6=72) → held
    expect(dispatched).toHaveLength(0);

    // Once the gate passes settle_at + 6 with no counterpart, it fires alone.
    await c.notePeak('coinset', 8801072);
    await c.notePeak('local', 8801072); // gate=8801072 ≥ 8801066+6 → local-only
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.kind).toBe('local-only');
  });
});
