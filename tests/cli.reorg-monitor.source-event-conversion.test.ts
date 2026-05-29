import { describe, expect, it } from 'vitest';
import {
  consolidateCoinsetBatch,
  reorgEventToSourceEvent,
  synthesizeReorgEventFromSource,
} from '../src/cli/reorg-monitor.js';
import { createDualSource, matches, type DispatchOutcome, type SourceEvent } from '../src/monitor/dual-source.js';
import type { ReorgEvent } from '../src/monitor/reorg-monitor.js';

// Build a ReorgEvent as it would arrive from the Coinset poller. The
// per-height representation: each changed height produces one ReorgEvent;
// `depth` is the size of the observed cluster, `max_depth` is the cluster
// size widened by any unobserved heights above (chain advanced past the
// last fully-observed peak during the reorg window).
function coinsetReorgEvent(opts: {
  height: number;
  depth: number;
  max_depth: number;
}): ReorgEvent {
  return {
    height: opts.height,
    old_header_hash: 'aaaa',
    new_header_hash: 'bbbb',
    detected_at: '2026-05-25T02:45:27.985Z',
    depth: opts.depth,
    max_depth: opts.max_depth,
    blocks_from_peak: 0,
    old_block_record: { timestamp: null },
  };
}

function localSourceEvent(low: number, high: number, depth: number): SourceEvent {
  return {
    source: 'local',
    low,
    high,
    settle_at: high,
    depth,
    max_depth: depth,
    detected_at_iso: '2026-05-25T02:45:27.985Z',
  };
}

describe('reorgEventToSourceEvent — height widening for Coinset uncertainty', () => {
  it('widens high to reflect potentially-affected upper extent when max_depth > depth', () => {
    // The real-world case from the 2026-05-25 log: Coinset observed height
    // 8773500 changed, peak=8773503, so depth=1 and max_depth=4 (3 unobserved
    // heights above). The SourceEvent should span 8773500..8773503.
    const evt = coinsetReorgEvent({ height: 8773500, depth: 1, max_depth: 4 });
    const s = reorgEventToSourceEvent(evt, 'coinset');
    expect(s).toMatchObject({
      source: 'coinset',
      low: 8773500,
      high: 8773503,
      depth: 1,
      max_depth: 4,
    });
  });

  it('does NOT widen when max_depth == depth (no unobserved heights)', () => {
    const evt = coinsetReorgEvent({ height: 100, depth: 3, max_depth: 3 });
    const s = reorgEventToSourceEvent(evt, 'coinset');
    expect(s).toMatchObject({ low: 100, high: 100, depth: 3, max_depth: 3 });
  });

  it('user-reported case: Coinset 8773500 depth 1-4 + local 8773500 → match', () => {
    const cs = reorgEventToSourceEvent(
      coinsetReorgEvent({ height: 8773500, depth: 1, max_depth: 4 }),
      'coinset'
    );
    const local = localSourceEvent(8773500, 8773500, 1);
    expect(matches(cs, local)).toBe(true);
  });

  it('Coinset 8773500 depth 1-4 also matches local detections within the widened range', () => {
    const cs = reorgEventToSourceEvent(
      coinsetReorgEvent({ height: 8773500, depth: 1, max_depth: 4 }),
      'coinset'
    );
    // Local detections anywhere in 8773500..8773503 should match.
    expect(matches(cs, localSourceEvent(8773501, 8773501, 1))).toBe(true);
    expect(matches(cs, localSourceEvent(8773503, 8773503, 1))).toBe(true);
  });

  it('Coinset 8773500 depth 1-4 does NOT match a local detection outside the widened range', () => {
    const cs = reorgEventToSourceEvent(
      coinsetReorgEvent({ height: 8773500, depth: 1, max_depth: 4 }),
      'coinset'
    );
    expect(matches(cs, localSourceEvent(8773504, 8773504, 1))).toBe(false);
    expect(matches(cs, localSourceEvent(8773499, 8773499, 1))).toBe(false);
  });

  it('regression: spec example 3 (Coinset EXACT 1 + local EXACT 3) still does NOT match', () => {
    // depth=max_depth=1 → no widening. Heights overlap at 100, but depths
    // are exactly disagreeing, so this must NOT match (per the original spec).
    const cs = reorgEventToSourceEvent(
      coinsetReorgEvent({ height: 100, depth: 1, max_depth: 1 }),
      'coinset'
    );
    const local = localSourceEvent(100, 102, 3);
    expect(matches(cs, local)).toBe(false);
  });

  it('regression: spec example 4 (heights do not overlap) still does NOT match', () => {
    const cs = reorgEventToSourceEvent(
      coinsetReorgEvent({ height: 100, depth: 1, max_depth: 1 }),
      'coinset'
    );
    const local = localSourceEvent(101, 101, 1);
    expect(matches(cs, local)).toBe(false);
  });
});

describe('consolidateCoinsetBatch — group per-height events into cluster SourceEvents', () => {
  it('empty input → empty output', () => {
    expect(consolidateCoinsetBatch([])).toEqual([]);
  });

  it('single event → single SourceEvent (with widening)', () => {
    const evts = [coinsetReorgEvent({ height: 8773500, depth: 1, max_depth: 4 })];
    const out = consolidateCoinsetBatch(evts);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: 'coinset',
      low: 8773500,
      high: 8773503, // widened by max_depth - depth = 3
      depth: 1,
      max_depth: 4,
    });
  });

  it('3 consecutive heights with shared depth=3, max_depth=3 → 1 SourceEvent spanning the cluster', () => {
    const evts = [
      coinsetReorgEvent({ height: 100, depth: 3, max_depth: 3 }),
      coinsetReorgEvent({ height: 101, depth: 3, max_depth: 3 }),
      coinsetReorgEvent({ height: 102, depth: 3, max_depth: 3 }),
    ];
    const out = consolidateCoinsetBatch(evts);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ low: 100, high: 102, depth: 3, max_depth: 3 });
  });

  it('3 consecutive heights with shared depth=3, max_depth=5 → cluster widened upward by 2', () => {
    const evts = [
      coinsetReorgEvent({ height: 100, depth: 3, max_depth: 5 }),
      coinsetReorgEvent({ height: 101, depth: 3, max_depth: 5 }),
      coinsetReorgEvent({ height: 102, depth: 3, max_depth: 5 }),
    ];
    const out = consolidateCoinsetBatch(evts);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ low: 100, high: 104, depth: 3, max_depth: 5 });
  });

  it('two disjoint clusters in one batch → two SourceEvents', () => {
    const evts = [
      coinsetReorgEvent({ height: 100, depth: 1, max_depth: 1 }),
      coinsetReorgEvent({ height: 200, depth: 2, max_depth: 2 }),
      coinsetReorgEvent({ height: 201, depth: 2, max_depth: 2 }),
    ];
    const out = consolidateCoinsetBatch(evts);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ low: 100, high: 100 });
    expect(out[1]).toMatchObject({ low: 200, high: 201 });
  });

  it('input order does not matter (sorts internally)', () => {
    const evts = [
      coinsetReorgEvent({ height: 102, depth: 3, max_depth: 3 }),
      coinsetReorgEvent({ height: 100, depth: 3, max_depth: 3 }),
      coinsetReorgEvent({ height: 101, depth: 3, max_depth: 3 }),
    ];
    const out = consolidateCoinsetBatch(evts);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ low: 100, high: 102 });
  });

  it('a 3-height observed cluster + local detection of the same 3-height cluster → ONE match (not 3 outcomes)', async () => {
    const evts = [
      coinsetReorgEvent({ height: 100, depth: 3, max_depth: 3 }),
      coinsetReorgEvent({ height: 101, depth: 3, max_depth: 3 }),
      coinsetReorgEvent({ height: 102, depth: 3, max_depth: 3 }),
    ];
    const outcomes: DispatchOutcome[] = [];
    const c = createDualSource('both', (o) => {
      outcomes.push(o);
    });
    for (const s of consolidateCoinsetBatch(evts)) c.noteReorg(s);
    c.noteReorg(localSourceEvent(100, 102, 3));
    await c.notePeak('coinset', 200);
    await c.notePeak('local', 200);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.kind).toBe('matched');
  });
});

describe('old_block_record propagation through the dual-source pipeline', () => {
  it('reorgEventToSourceEvent copies old_block_record from the Coinset ReorgEvent', () => {
    // The Coinset poller already has the full BlockRecord on the ReorgEvent
    // (from get_block_records). Before this propagation was added, the
    // record was dropped at the dual-source boundary, regressing the
    // pre-dual-source coinset-only email body.
    const fullRecord = { weight: 12345, signage_point_index: 49, timestamp: null };
    const evt: ReorgEvent = {
      height: 8773500,
      old_header_hash: 'aa'.repeat(32),
      new_header_hash: 'bb'.repeat(32),
      detected_at: '2026-05-25T02:45:27.985Z',
      depth: 1,
      max_depth: 4,
      blocks_from_peak: 0,
      old_block_record: fullRecord,
    };
    const s = reorgEventToSourceEvent(evt, 'coinset');
    expect(s.old_block_record).toEqual(fullRecord);
  });

  it('reorgEventToSourceEvent passes through null when old_block_record is missing/non-object', () => {
    const evt: ReorgEvent = {
      height: 100,
      old_header_hash: 'aa'.repeat(32),
      new_header_hash: 'bb'.repeat(32),
      detected_at: '2026-05-25T00:00:00Z',
      depth: 1,
      max_depth: 1,
      blocks_from_peak: 0,
      old_block_record: null,
    };
    const s = reorgEventToSourceEvent(evt, 'coinset');
    expect(s.old_block_record).toBeNull();
  });

  it('consolidateCoinsetBatch uses the LAST event\'s old_block_record for the cluster', () => {
    // The synthesized email reports the cluster's top height; using the
    // top (last) event's record keeps email contents consistent with
    // height=last.height.
    const recordA = { tag: 'first', height: 100 };
    const recordB = { tag: 'middle', height: 101 };
    const recordC = { tag: 'top', height: 102 };
    const evts: ReorgEvent[] = [100, 101, 102].map((h, i) => ({
      height: h,
      old_header_hash: 'aa'.repeat(32),
      new_header_hash: 'bb'.repeat(32),
      detected_at: '2026-05-25T00:00:00Z',
      depth: 3,
      max_depth: 3,
      blocks_from_peak: 0,
      old_block_record: [recordA, recordB, recordC][i]!,
    }));
    const out = consolidateCoinsetBatch(evts);
    expect(out).toHaveLength(1);
    expect(out[0]!.old_block_record).toEqual(recordC);
  });

  it('consolidateCoinsetBatch sets old_block_record=null when last has none', () => {
    const evts: ReorgEvent[] = [
      {
        height: 100,
        old_header_hash: 'aa'.repeat(32),
        new_header_hash: 'bb'.repeat(32),
        detected_at: '2026-05-25T00:00:00Z',
        depth: 1,
        max_depth: 1,
        blocks_from_peak: 0,
        old_block_record: null,
      },
    ];
    const out = consolidateCoinsetBatch(evts);
    expect(out[0]!.old_block_record).toBeNull();
  });

  it('synthesizeReorgEventFromSource passes through a populated old_block_record (Coinset)', () => {
    const fullRecord = { weight: 999, signage_point_index: 10 };
    const s: SourceEvent = {
      source: 'coinset',
      low: 100,
      high: 100,
      settle_at: 100,
      depth: 1,
      max_depth: 1,
      detected_at_iso: '2026-05-25T00:00:00Z',
      old_block_record: fullRecord,
    };
    const evt = synthesizeReorgEventFromSource(s);
    expect(evt.old_block_record).toBe(fullRecord);
  });

  it('synthesizeReorgEventFromSource emits unavailable sentinel when old_block_record absent (coinset)', () => {
    // Previously fell back to { timestamp: ts_high_unix } which looked
    // like real block contents in the email. Now we emit an explicit
    // sentinel so the renderer surfaces the failure cause.
    const s: SourceEvent = {
      source: 'coinset',
      low: 100,
      high: 100,
      settle_at: 100,
      depth: 1,
      max_depth: 1,
      detected_at_iso: '2026-05-25T00:00:00Z',
      ts_high_unix: 1700000000,
    };
    const evt = synthesizeReorgEventFromSource(s);
    expect(evt.old_block_record).toEqual({
      _unavailable: 'Coinset did not provide a block record',
      foliage_timestamp_unix: 1700000000,
    });
  });

  it('synthesizeReorgEventFromSource preserves old_block_record_error in the sentinel', () => {
    const s: SourceEvent = {
      source: 'local',
      low: 100,
      high: 100,
      settle_at: 100,
      depth: 1,
      max_depth: 1,
      detected_at_iso: '2026-05-25T00:00:00Z',
      ts_high_unix: 1700000000,
      old_block_record_error: 'decode-failed: 100:aabb: bad BlockRecord blob',
    };
    const evt = synthesizeReorgEventFromSource(s);
    expect(evt.old_block_record).toEqual({
      _unavailable: 'decode-failed: 100:aabb: bad BlockRecord blob',
      foliage_timestamp_unix: 1700000000,
    });
  });
});

describe('synthesizeReorgEventFromSource — uses observed height not widened high', () => {
  it('Coinset event: synthesized ReorgEvent.height = low (the actual observed height)', () => {
    const s: SourceEvent = {
      source: 'coinset',
      low: 8773500,
      high: 8773503, // widened
      settle_at: 8773500, // observed top, un-widened
      depth: 1,
      max_depth: 4,
      detected_at_iso: '2026-05-25T02:45:27.985Z',
    };
    expect(synthesizeReorgEventFromSource(s).height).toBe(8773500);
  });

  it('Local event: synthesized ReorgEvent.height = high (top of the exact cluster)', () => {
    const s: SourceEvent = {
      source: 'local',
      low: 100,
      high: 102,
      settle_at: 102,
      depth: 3,
      max_depth: 3,
      detected_at_iso: '2026-05-25T02:45:27.985Z',
    };
    expect(synthesizeReorgEventFromSource(s).height).toBe(102);
  });
});
