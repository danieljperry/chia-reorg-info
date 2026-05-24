import { describe, expect, it } from 'vitest';
import { matches, type SourceEvent } from '../src/monitor/dual-source.js';

function coinset(
  low: number,
  high: number,
  depth: number,
  max_depth: number
): SourceEvent {
  return {
    source: 'coinset',
    low,
    high,
    depth,
    max_depth,
    detected_at_iso: '2026-05-25T00:00:00Z',
  };
}

function local(low: number, high: number, depth: number): SourceEvent {
  return {
    source: 'local',
    low,
    high,
    depth,
    max_depth: depth,
    detected_at_iso: '2026-05-25T00:00:00Z',
  };
}

describe('dual-source matches()', () => {
  // The four examples from the user's spec verbatim.

  it('Example 1: Coinset 1-4 depth at 100..103 + local exact 3 at 100..102 → match', () => {
    const c = coinset(100, 103, 1, 4);
    const l = local(100, 102, 3);
    expect(matches(c, l)).toBe(true);
  });

  it('Example 2: Coinset 1-4 at 100..103 + local 3 at 99..101 (overlap by 100..101) → match', () => {
    const c = coinset(100, 103, 1, 4);
    const l = local(99, 101, 3);
    expect(matches(c, l)).toBe(true);
  });

  it('Example 3: Coinset exact-1 at 100 + local exact-3 at 100..102 → NO match (depths)', () => {
    const c = coinset(100, 100, 1, 1);
    const l = local(100, 102, 3);
    expect(matches(c, l)).toBe(false);
  });

  it('Example 4: Coinset exact-1 at 100 + local exact-1 at 101 → NO match (heights)', () => {
    const c = coinset(100, 100, 1, 1);
    const l = local(101, 101, 1);
    expect(matches(c, l)).toBe(false);
  });

  // Boundary / additional cases.

  it('two events from the same source never match', () => {
    expect(matches(coinset(100, 102, 3, 3), coinset(100, 102, 3, 3))).toBe(false);
    expect(matches(local(100, 102, 3), local(100, 102, 3))).toBe(false);
  });

  it('heights that touch but do not overlap → no match', () => {
    // a.high = 100, b.low = 101 → no overlap
    const c = coinset(98, 100, 3, 3);
    const l = local(101, 103, 3);
    expect(matches(c, l)).toBe(false);
  });

  it('heights that overlap at exactly one block AND depths overlap → match', () => {
    const c = coinset(98, 100, 3, 3);
    const l = local(100, 102, 3);
    expect(matches(c, l)).toBe(true);
  });

  it('coinset depth range fully covers local depth → match', () => {
    const c = coinset(100, 100, 1, 5);
    const l = local(100, 100, 3);
    expect(matches(c, l)).toBe(true);
  });

  it('coinset depth range is below local depth, no overlap → no match', () => {
    const c = coinset(100, 100, 1, 2);
    const l = local(100, 100, 5);
    expect(matches(c, l)).toBe(false);
  });

  it('matches is symmetric (a,b) == (b,a)', () => {
    const c = coinset(100, 103, 1, 4);
    const l = local(99, 101, 3);
    expect(matches(c, l)).toBe(matches(l, c));
  });
});
