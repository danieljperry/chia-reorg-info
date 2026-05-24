import { describe, expect, it, vi } from 'vitest';
import {
  createDualSource,
  type DispatchOutcome,
  type SourceEvent,
} from '../src/monitor/dual-source.js';

function coinsetEvt(low: number, high: number, depth: number, max_depth = depth): SourceEvent {
  return {
    source: 'coinset',
    low,
    high,
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
    await c.notePeak('coinset', 104);
    await c.notePeak('local', 104); // local saw no reorg
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.kind).toBe('coinset-only');
  });

  it('both mode + only local detects → local-only', async () => {
    const dispatched: DispatchOutcome[] = [];
    const c = createDualSource('both', (o) => {
      dispatched.push(o);
    });
    c.noteReorg(localEvt(100, 102, 3));
    await c.notePeak('coinset', 104); // coinset saw no reorg
    await c.notePeak('local', 104);
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
    c.noteReorg(coinsetEvt(100, 100, 1, 1)); // depth=1, exact
    c.noteReorg(localEvt(100, 102, 3));      // depth=3, doesn't match
    await c.notePeak('coinset', 104);
    await c.notePeak('local', 104);
    expect(dispatched).toHaveLength(2);
    const kinds = dispatched.map((o) => o.kind).sort();
    expect(kinds).toEqual(['coinset-only', 'local-only']);
  });

  it('both mode + coinset/local at different heights (Example 4) → two outcomes', async () => {
    const dispatched: DispatchOutcome[] = [];
    const c = createDualSource('both', (o) => {
      dispatched.push(o);
    });
    c.noteReorg(coinsetEvt(100, 100, 1, 1));
    c.noteReorg(localEvt(101, 101, 1));
    await c.notePeak('coinset', 103);
    await c.notePeak('local', 103);
    expect(dispatched).toHaveLength(2);
    const kinds = dispatched.map((o) => o.kind).sort();
    expect(kinds).toEqual(['coinset-only', 'local-only']);
  });

  it('both mode: release gate is MIN of both peaks (one source lagging holds events)', async () => {
    const dispatched: DispatchOutcome[] = [];
    const c = createDualSource('both', (o) => {
      dispatched.push(o);
    });
    c.noteReorg(coinsetEvt(100, 100, 1));
    await c.notePeak('coinset', 200); // far past, but local hasn't reported yet
    expect(dispatched).toHaveLength(0); // gate is min(200, null) = -Inf
    await c.notePeak('local', 102); // gate = min(200, 102) = 102, high+2 = 102 → release
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

  it('vi.fn dispatch hook is callable from the coordinator', async () => {
    const fn = vi.fn();
    const c = createDualSource('coinset', fn);
    c.noteReorg(coinsetEvt(100, 100, 1));
    await c.notePeak('coinset', 102);
    expect(fn).toHaveBeenCalledOnce();
  });
});
