// Dual-source comparison and dispatch.
//
// Two pollers (Coinset and the local DB via reorg-finder.sh) feed reorg
// events here; we buffer them until they "settle" (peak height has advanced
// 2 blocks past the cluster's high), then look for a counterpart from the
// other source and dispatch a single email with a match/no-match outcome.
//
// For single-source modes (`coinset` only or `local` only), the buffer
// holds events from one source only and releases them as soon as they
// settle — no cross-source confirmation needed.

import { log } from '../util/logger.js';

export type Source = 'coinset' | 'local';

export type SourceEvent = {
  source: Source;
  /** Lowest height in the cluster (inclusive). */
  low: number;
  /** Highest height in the cluster (inclusive). */
  high: number;
  /** Lower bound on depth (observed cluster size). */
  depth: number;
  /** Upper bound on depth. Equal to `depth` when fully observed. */
  max_depth: number;
  /** ISO timestamp when the event was first detected. */
  detected_at_iso: string;
  /** Wall-clock start of the cluster (unix seconds, may be null for non-tx). */
  ts_low_unix?: number | null;
  /** Wall-clock end of the cluster (unix seconds, may be null for non-tx). */
  ts_high_unix?: number | null;
};

export type DispatchOutcome =
  | { kind: 'matched'; coinset: SourceEvent; local: SourceEvent }
  | { kind: 'coinset-only'; event: SourceEvent }
  | { kind: 'local-only'; event: SourceEvent };

export type DispatchHook = (outcome: DispatchOutcome) => Promise<void> | void;

/**
 * Two events match iff their height ranges overlap AND their depth ranges
 * overlap. Coinset's depth is often a range (depth..max_depth); local is
 * always exact (depth == max_depth). Walk the user-specified examples:
 *
 *   coinset 100..103, depth 1-4  +  local 100..102, depth 3   → match
 *   coinset 100..103, depth 1-4  +  local  99..101, depth 3   → match
 *   coinset 100..100, depth 1    +  local 100..102, depth 3   → no match (depths)
 *   coinset 100..100, depth 1    +  local 101..101, depth 1   → no match (heights)
 */
export function matches(a: SourceEvent, b: SourceEvent): boolean {
  if (a.source === b.source) return false;
  const heightsOverlap = Math.max(a.low, b.low) <= Math.min(a.high, b.high);
  const depthsOverlap =
    Math.max(a.depth, b.depth) <= Math.min(a.max_depth, b.max_depth);
  return heightsOverlap && depthsOverlap;
}

export type DualSourceMode = 'coinset' | 'local' | 'both';

type State = {
  mode: DualSourceMode;
  pending: SourceEvent[];
  /** Highest peak seen per source. Used to release events from the buffer. */
  peaks: Record<Source, number | null>;
  dispatch: DispatchHook;
};

/**
 * Build a fresh dual-source coordinator. Each running monitor instance gets
 * its own (the state is per-instance, not global), which makes tests easy.
 */
export function createDualSource(mode: DualSourceMode, dispatch: DispatchHook) {
  const state: State = {
    mode,
    pending: [],
    peaks: { coinset: null, local: null },
    dispatch,
  };

  /**
   * Record a reorg detection. Logs immediately, then buffers for comparison.
   * In single-source mode the event will be released on the next notePeak
   * that advances 2 blocks past its high.
   */
  function noteReorg(evt: SourceEvent): void {
    log('warn', 'Re-org detected', {
      source: evt.source,
      low: evt.low,
      high: evt.high,
      depth: evt.depth === evt.max_depth ? `${evt.depth}` : `${evt.depth}-${evt.max_depth}`,
    });
    state.pending.push(evt);
  }

  /**
   * Record the latest peak observed by `source`. May release buffered events
   * whose `high + 2` is now ≤ both pollers' peaks (or just this source's peak
   * in single-source mode).
   */
  async function notePeak(source: Source, peak: number): Promise<void> {
    const prev = state.peaks[source];
    if (prev === null || peak > prev) {
      state.peaks[source] = peak;
    }
    await releaseSettled();
  }

  function releaseGate(): number {
    // The "settle threshold" — the lowest peak above which events are eligible
    // for release. In single-source mode it's just that source's peak; in
    // both-source mode it's the MIN of both, because we want to give the
    // other source a chance to also detect the reorg before declaring it
    // single-source-only.
    if (state.mode === 'coinset') return state.peaks.coinset ?? -Infinity;
    if (state.mode === 'local') return state.peaks.local ?? -Infinity;
    const c = state.peaks.coinset;
    const l = state.peaks.local;
    if (c === null || l === null) return -Infinity;
    return Math.min(c, l);
  }

  async function releaseSettled(): Promise<void> {
    const gate = releaseGate();
    if (gate === -Infinity) return;

    const stillPending: SourceEvent[] = [];
    const released: SourceEvent[] = [];
    for (const evt of state.pending) {
      if (evt.high + 2 <= gate) released.push(evt);
      else stillPending.push(evt);
    }
    state.pending = stillPending;

    // Process released events. In both-source mode, look for a matching
    // counterpart among released events from the OTHER source first; pair
    // them up. Anything left over is a single-source detection.
    if (state.mode !== 'both') {
      for (const evt of released) {
        await state.dispatch(
          evt.source === 'coinset'
            ? { kind: 'coinset-only', event: evt }
            : { kind: 'local-only', event: evt }
        );
      }
      return;
    }

    const coinsetReleases = released.filter((e) => e.source === 'coinset');
    const localReleases = released.filter((e) => e.source === 'local');
    const usedLocal = new Set<number>(); // indices in localReleases already paired

    for (const cEvt of coinsetReleases) {
      let pairedIdx: number | null = null;
      for (let i = 0; i < localReleases.length; i++) {
        if (usedLocal.has(i)) continue;
        if (matches(cEvt, localReleases[i]!)) {
          pairedIdx = i;
          break;
        }
      }
      if (pairedIdx !== null) {
        usedLocal.add(pairedIdx);
        await state.dispatch({
          kind: 'matched',
          coinset: cEvt,
          local: localReleases[pairedIdx]!,
        });
      } else {
        await state.dispatch({ kind: 'coinset-only', event: cEvt });
      }
    }

    for (let i = 0; i < localReleases.length; i++) {
      if (usedLocal.has(i)) continue;
      await state.dispatch({ kind: 'local-only', event: localReleases[i]! });
    }
  }

  function _state(): Readonly<State> {
    return state;
  }

  return { noteReorg, notePeak, _state };
}

export type DualSource = ReturnType<typeof createDualSource>;
