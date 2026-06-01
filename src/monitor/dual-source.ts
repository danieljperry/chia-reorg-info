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
  /** Highest height that *might* be part of the cluster (inclusive). For
   *  Coinset events this is widened by max_depth - depth to capture
   *  unobserved heights above the observed top, so matches() can pair this
   *  event with a local detection anywhere in [low..high]. */
  high: number;
  /** Highest height that we OBSERVED change at. For local events this
   *  equals `high` (local is always exact). For Coinset events this is the
   *  un-widened observed cluster top — the height past which the chain is
   *  "finalized" enough to safely declare the reorg over. Drives release
   *  timing: an event releases when min(peers' peaks) ≥ settle_at + 2.
   *  Using settle_at rather than high here keeps coinset and local events
   *  for the same reorg releasing in the same window, which is necessary
   *  for the match loop to pair them. */
  settle_at: number;
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
  /** Orphaned block's header_hash at the cluster top (`high`). Lowercase hex,
   *  no `0x` prefix. Null/undefined when the source can't supply it. */
  old_header_hash?: string | null;
  /** Canonical block's header_hash at the cluster top, same encoding. */
  new_header_hash?: string | null;
  /** Decoded BlockRecord of the orphan at the cluster top (the ~25 fields
   *  Chia's BlockRecord exposes: weight, total_iters, signage_point_index,
   *  VDF outputs, reward_claims_incorporated, etc.). Used by the alert
   *  email body so recipients see the full record instead of just the
   *  timestamp. Null/undefined when the source can't supply it (e.g.
   *  older bash script, chia-blockchain not importable, etc.). */
  old_block_record?: Record<string, unknown> | null;
  /** Reason the source couldn't supply `old_block_record`. Surfaced into
   *  the alert email body when the record is null so recipients see the
   *  actual failure cause instead of a misleadingly minimal {timestamp}.
   *  Null/undefined when the record was successfully retrieved OR when
   *  this field isn't carried by this source. */
  old_block_record_error?: string | null;
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

/**
 * Upper bound on the pending-events buffer. In `both` mode events stay
 * buffered until BOTH sources' peaks have advanced past `high + 2`, so a
 * prolonged one-sided outage (e.g. Coinset down for hours while local keeps
 * polling) could otherwise accumulate events without bound. At normal
 * mainnet reorg rates (single digits per day) this cap is well above any
 * realistic backlog; we drop oldest and log if it ever fills.
 */
export const PENDING_BUFFER_CAP = 10_000;

/**
 * Blocks past a cluster's observed top (`settle_at`) before it's considered
 * "settled" — finalized enough that the chain won't still be thrashing at that
 * height. An event is eligible to PAIR with a counterpart once both are settled.
 */
export const SETTLE_MARGIN = 2;

/**
 * Blocks past `settle_at` before an unpaired event is declared single-source
 * (coinset-only / local-only). Larger than SETTLE_MARGIN so that when the two
 * sources detect the same reorg a few blocks/seconds apart (e.g. one observed
 * it late), the earlier event is HELD long enough for the slower source's
 * counterpart to arrive and pair, rather than being dispatched alone. Only the
 * single-source decision waits; `matched` pairs dispatch as soon as both are
 * present and settled. `both` mode only — single-source modes have nothing to
 * wait for and release at SETTLE_MARGIN.
 */
export const SINGLE_SOURCE_MARGIN = 6;

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
    if (state.pending.length > PENDING_BUFFER_CAP) {
      const dropped = state.pending.shift()!;
      log('warn', 'Dual-source pending buffer at cap; dropped oldest event', {
        cap: PENDING_BUFFER_CAP,
        dropped_source: dropped.source,
        dropped_low: dropped.low,
        dropped_high: dropped.high,
      });
    }
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

    // Single-source modes: nothing to pair with, so release as soon as settled
    // and dispatch immediately. settle_at (not high) is the un-widened observed
    // top — see the SourceEvent docstring.
    if (state.mode !== 'both') {
      const stillPending: SourceEvent[] = [];
      for (const evt of state.pending) {
        if (evt.settle_at + SETTLE_MARGIN <= gate) {
          await state.dispatch(
            evt.source === 'coinset'
              ? { kind: 'coinset-only', event: evt }
              : { kind: 'local-only', event: evt }
          );
        } else {
          stillPending.push(evt);
        }
      }
      state.pending = stillPending;
      return;
    }

    // Both mode, two phases over the same gate:
    //
    //   Phase 1 (pair): events settled past SETTLE_MARGIN are eligible to pair.
    //     Pair coinset↔local and dispatch `matched` immediately; remove both.
    //   Phase 2 (single-source): any STILL-unpaired event settled past the
    //     larger SINGLE_SOURCE_MARGIN is declared single-source and dispatched.
    //     Events settled but not yet past SINGLE_SOURCE_MARGIN stay pending so a
    //     late counterpart from the other source can still pair with them.
    //
    // This split is what fixes the duplicate-email race: when the two sources
    // detect the same reorg a few blocks apart, the earlier one is held (not
    // dispatched alone) until the slower one arrives and pairs.
    const pairEligible: SourceEvent[] = [];
    const notYetPairEligible: SourceEvent[] = [];
    for (const evt of state.pending) {
      if (evt.settle_at + SETTLE_MARGIN <= gate) pairEligible.push(evt);
      else notYetPairEligible.push(evt);
    }

    const coinsetReleases = pairEligible.filter((e) => e.source === 'coinset');
    const localReleases = pairEligible.filter((e) => e.source === 'local');
    const usedLocal = new Set<number>(); // indices in localReleases already paired
    const unpaired: SourceEvent[] = [];

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
        unpaired.push(cEvt);
      }
    }
    for (let i = 0; i < localReleases.length; i++) {
      if (!usedLocal.has(i)) unpaired.push(localReleases[i]!);
    }

    // An unpaired-but-settled event is only declared single-source once it has
    // also passed SINGLE_SOURCE_MARGIN; otherwise hold it for a late counterpart.
    const stillPending: SourceEvent[] = [...notYetPairEligible];
    for (const evt of unpaired) {
      if (evt.settle_at + SINGLE_SOURCE_MARGIN <= gate) {
        await state.dispatch(
          evt.source === 'coinset'
            ? { kind: 'coinset-only', event: evt }
            : { kind: 'local-only', event: evt }
        );
      } else {
        stillPending.push(evt);
      }
    }
    state.pending = stillPending;
  }

  function _state(): Readonly<State> {
    return state;
  }

  return { noteReorg, notePeak, _state };
}

export type DualSource = ReturnType<typeof createDualSource>;
