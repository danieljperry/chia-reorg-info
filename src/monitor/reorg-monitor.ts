import { get_blockchain_state, get_block_records } from 'chia-agent/api/rpc/full_node/index.js';
import { getAgent } from '../coinset/agent.js';
import { isHex32, stripHexPrefix } from '../chia/hex.js';
import { Network } from '../network.js';
import { log } from '../util/logger.js';
import { safeMessage } from '../util/safe-message.js';
import { sendReorgAlert } from './email-alert.js';

export type ReorgEvent = {
  height: number;
  old_header_hash: string;
  new_header_hash: string;
  detected_at: string;
  /** Lower bound on depth: consecutive observed heights with hash changes. */
  depth: number;
  /** Upper bound on depth: depth + unobserved blocks above the cluster when the
   * chain advanced past our last fully-observed peak. Equal to depth when we
   * have complete information. The alert filter uses this (worst-case). */
  max_depth: number;
  /** Distance from the peak height observed when this re-org was detected. */
  blocks_from_peak: number;
  old_block_record: unknown;
};

export type AlertRecipient = {
  email: string;
  min_blocks: number; // only alert if max_depth >= min_blocks (worst-case)
};

export type MonitorStatus = {
  active: boolean;
  network: Network;
  started_at: string | null;
  poll_interval_seconds: number;
  lookback_blocks: number;
  alert_recipients: AlertRecipient[];
  poll_count: number;
  peak_height: number | null;
  last_poll_at: string | null;
  last_error: string | null;
  reorgs: ReorgEvent[];
  observations_count: number;
};

const MAX_OBSERVATIONS = 1_000;

const state = {
  active: false,
  network: 'mainnet' as Network,
  started_at: null as string | null,
  poll_interval_seconds: 5,
  lookback_blocks: 5,
  alert_recipients: [] as AlertRecipient[],
  poll_count: 0,
  peak_height: null as number | null,
  // Highest peak from the last poll where we actually completed the comparison
  // loop (i.e., not just announced by get_blockchain_state but also retrieved
  // and processed via get_block_records). Used by the "lower bound" warning so
  // skipped polls don't pollute it.
  last_observed_peak: null as number | null,
  last_poll_at: null as string | null,
  last_error: null as string | null,
  reorgs: [] as ReorgEvent[],
  observations: new Map<number, { hash: string; record: unknown }>(), // height → { hash, full block record }
  alertedReorgs: new Set<string>(), // `${height}:${new_hash}` pairs already alerted on this session
  timer: null as NodeJS.Timeout | null,
  generation: 0, // incremented on start/stop; in-flight polls bail if it changes mid-execution
  // Optional hooks for dual-source mode. onReorgBatch fires once per poll
  // cycle with ALL newly-detected reorgs from that poll (so the CLI can
  // consolidate consecutive heights into one cluster-level SourceEvent
  // instead of emitting N per-height events for one logical reorg). onPeak
  // fires after each successful poll. These do NOT replace the existing
  // per-recipient inline dispatch — they run in addition to it. For
  // dual-source mode the CLI passes an empty alert_recipients (so inline
  // dispatch is a no-op) and routes through the dual-source coordinator.
  onReorgBatch: null as ((events: ReorgEvent[]) => void) | null,
  onPeak: null as ((peak: number) => void) | null,
};

function redactEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/**
 * Returns true if `err` is the chia-agent / coinset rejection shape produced
 * when the upstream node has published a new peak via get_blockchain_state but
 * has not yet written the corresponding BlockRecord row that get_block_records
 * needs. The next poll resolves it, so we want to treat this as benign rather
 * than a hard error.
 */
export function _isBlockDoesNotExistRace(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { structuredError?: { code?: unknown } };
  return e.structuredError?.code === 'BLOCK_DOES_NOT_EXIST';
}

export async function _pollOnce(): Promise<void> {
  const generation = state.generation;
  try {
    const agent = getAgent(state.network);
    const result = await get_blockchain_state(agent);
    if (generation !== state.generation) return;
    const { blockchain_state } = result;
    const peak = blockchain_state.peak?.height;
    if (peak === undefined) return;
    // Snapshot the highest peak from a prior FULLY successful poll. We use this
    // (not state.peak_height) for the "lower bound" warning, because
    // state.peak_height is updated even on skipped polls and would suppress
    // the warning in exactly the case it's meant to fire.
    const prevObservedPeak = state.last_observed_peak;
    state.peak_height = peak;
    state.poll_count++;
    state.last_poll_at = new Date().toISOString();
    state.last_error = null;

    let lowestFetched = Math.max(0, peak - state.lookback_blocks + 1);
    const initial = await get_block_records(agent, { start: lowestFetched, end: peak + 1 });
    if (generation !== state.generation) return;
    let allRecords = initial.block_records ?? [];

    // Walk-back: if the deepest fetched height shows a hash change, the re-org
    // may extend below the lookback window. Keep fetching earlier chunks until
    // we find a height that's still canonical, hit genesis, or run out of
    // prior observations to compare against. Without this, a re-org deeper
    // than lookback_blocks is silently under-reported.
    while (lowestFetched > 0) {
      const lowestRec = allRecords.find((r) => r.height === lowestFetched);
      if (lowestRec === undefined) break;
      const prev = state.observations.get(lowestFetched);
      if (prev === undefined) break;
      const currentHash = stripHexPrefix(lowestRec.header_hash).toLowerCase();
      if (!isHex32(currentHash)) {
        log('warn', 'Skipping block with malformed header_hash during walk-down', {
          height: lowestFetched,
        });
        break;
      }
      if (prev.hash === currentHash) break;

      const newLowest = Math.max(0, lowestFetched - state.lookback_blocks);
      if (newLowest === lowestFetched) break;
      const more = await get_block_records(agent, { start: newLowest, end: lowestFetched });
      if (generation !== state.generation) return;
      const moreRecords = more.block_records ?? [];
      if (moreRecords.length === 0) break;
      allRecords = [...moreRecords, ...allRecords];
      lowestFetched = newLowest;
    }

    // First pass: collect all changed heights in this poll. We don't push the
    // ReorgEvents to state yet because each one's depth depends on how many of
    // its consecutive neighbors also changed.
    type RawReorg = Omit<ReorgEvent, 'depth' | 'max_depth'>;
    const rawReorgs: RawReorg[] = [];
    for (const block of allRecords) {
      const currentHash = stripHexPrefix(block.header_hash).toLowerCase();
      if (!isHex32(currentHash)) {
        // Defensive: a malformed hash from the RPC response would otherwise
        // flow into observations + emails. Skip this block and don't update
        // observations so the next poll re-fetches it cleanly.
        log('warn', 'Skipping block with malformed header_hash', {
          height: block.height,
        });
        continue;
      }
      const prev = state.observations.get(block.height);
      if (prev !== undefined && prev.hash !== currentHash) {
        rawReorgs.push({
          height: block.height,
          old_header_hash: prev.hash,
          new_header_hash: currentHash,
          detected_at: new Date().toISOString(),
          blocks_from_peak: peak - block.height,
          old_block_record: prev.record,
        });
      }
      state.observations.set(block.height, { hash: currentHash, record: block });
    }

    // Group consecutive heights into clusters; each cluster is one logical
    // re-org event. depth = observed cluster size (lower bound). max_depth =
    // worst-case true depth, which includes any unobserved heights above the
    // cluster if it reaches our last fully-observed peak.
    rawReorgs.sort((a, b) => a.height - b.height);
    const reorgsThisPoll: ReorgEvent[] = [];
    let clusterStart = 0;
    for (let i = 1; i <= rawReorgs.length; i++) {
      const breakHere =
        i === rawReorgs.length || rawReorgs[i]!.height !== rawReorgs[i - 1]!.height + 1;
      if (breakHere) {
        const depth = i - clusterStart;
        const clusterHigh = rawReorgs[i - 1]!.height;
        const unobservedAbove =
          prevObservedPeak !== null && clusterHigh === prevObservedPeak && peak > prevObservedPeak
            ? peak - prevObservedPeak
            : 0;
        const max_depth = depth + unobservedAbove;
        for (let j = clusterStart; j < i; j++) {
          const event: ReorgEvent = { ...rawReorgs[j]!, depth, max_depth };
          state.reorgs.push(event);
          reorgsThisPoll.push(event);
          log('warn', 'Re-org detected', {
            network: state.network,
            height: event.height,
            depth:
              event.depth === event.max_depth
                ? `${event.depth}`
                : `${event.depth}-${event.max_depth}`,
            blocks_from_peak: event.blocks_from_peak,
            old_header_hash: event.old_header_hash,
            new_header_hash: event.new_header_hash,
            peak_height: peak,
          });
        }
        clusterStart = i;
      }
    }

    // Update the "last fully observed peak" now that we've made it through
    // the comparison loop. Skipped polls (which throw out of the try block
    // before reaching here) don't advance this — that's the whole point.
    state.last_observed_peak = peak;

    // If we detected a re-org whose top reaches our previous *observed* peak
    // AND the chain has advanced beyond it, the actual cascade may have
    // extended into heights we never observed (no baseline to compare). The
    // reported depth is then a lower bound, not authoritative. Flag it.
    if (
      reorgsThisPoll.length > 0 &&
      prevObservedPeak !== null &&
      peak > prevObservedPeak &&
      reorgsThisPoll.some((r) => r.height === prevObservedPeak)
    ) {
      log('warn', 'Re-org depth may be a lower bound (chain advanced into unobserved territory)', {
        network: state.network,
        unobserved_range: `${prevObservedPeak + 1}..${peak}`,
        unobserved_blocks: peak - prevObservedPeak,
        observed_depths: reorgsThisPoll.map((r) => r.depth),
      });
    }

    // Debounce: only alert on (height, new_hash) pairs we haven't already seen this session.
    // The chain can thrash between two hashes at the same height; this keeps email volume bounded.
    const newReorgsForAlert = reorgsThisPoll.filter((r) => {
      const key = `${r.height}:${r.new_header_hash}`;
      if (state.alertedReorgs.has(key)) return false;
      state.alertedReorgs.add(key);
      return true;
    });

    // Dual-source hooks. ORDER MATTERS: onReorgBatch must fire BEFORE onPeak.
    // notePeak triggers releaseSettled in the coordinator, so if onPeak fired
    // first, a peak advance large enough to release a buffered counterpart
    // event from the other source would dispatch it as single-source-only
    // before this poll's new reorg is added to the buffer — producing two
    // separate outcomes for the same logical reorg.
    if (state.onReorgBatch !== null && newReorgsForAlert.length > 0) {
      state.onReorgBatch(newReorgsForAlert);
    }
    if (state.onPeak !== null) state.onPeak(peak);

    // Send one batched email per recipient containing all eligible reorgs from this poll.
    // Filter on max_depth (worst-case true depth) so a re-org with uncertain
    // depth still alerts everyone whose threshold could be met. Honest by default.
    for (const recipient of state.alert_recipients) {
      const eligible = newReorgsForAlert.filter((r) => r.max_depth >= recipient.min_blocks);
      if (eligible.length > 0) {
        log('info', 'Dispatching re-org alert', {
          to: recipient.email,
          min_blocks: recipient.min_blocks,
          eligible_count: eligible.length,
          eligible_heights: eligible.map((r) => r.height),
          eligible_depth_ranges: eligible.map((r) =>
            r.depth === r.max_depth ? `${r.depth}` : `${r.depth}-${r.max_depth}`
          ),
        });
        sendReorgAlert(recipient.email, state.network, eligible, peak).catch((err: unknown) => {
          state.last_error = `Email alert failed: ${safeMessage(err)}`;
        });
      } else if (newReorgsForAlert.length > 0) {
        log('info', 'Skipping recipient (threshold not met)', {
          to: recipient.email,
          min_blocks: recipient.min_blocks,
          available_max_depths: newReorgsForAlert.map((r) => r.max_depth),
        });
      }
    }

    // Keep memory bounded: drop the oldest observations once the window grows too large.
    if (state.observations.size > MAX_OBSERVATIONS) {
      const sorted = [...state.observations.keys()].sort((a, b) => a - b);
      for (const h of sorted.slice(0, state.observations.size - MAX_OBSERVATIONS)) {
        state.observations.delete(h);
      }
    }
  } catch (err) {
    if (generation === state.generation) {
      if (_isBlockDoesNotExistRace(err)) {
        // Transient race: the node announced a new peak but the BlockRecord for
        // that height is not yet readable. The next poll will succeed. Don't
        // pollute last_error with this expected condition.
        log('info', 'Poll skipped (block not yet readable at tip)', {
          network: state.network,
        });
      } else {
        const msg = safeMessage(err);
        state.last_error = msg;
        log('error', 'Poll failed', { network: state.network, error: msg });
      }
    }
  }
}

function scheduleNext(): void {
  state.timer = setTimeout(() => {
    void _pollOnce().finally(() => {
      if (state.active) scheduleNext();
    });
  }, state.poll_interval_seconds * 1000);
  state.timer.unref();
}

export function startMonitor(opts: {
  poll_interval_seconds: number;
  lookback_blocks: number;
  network: Network;
  alert_recipients?: AlertRecipient[];
  /** Dual-source hook: called once per poll with all newly-detected reorgs
   *  in that poll (so the caller can consolidate consecutive heights into
   *  one cluster). Not called when the batch is empty. */
  on_reorg_batch?: (events: ReorgEvent[]) => void;
  /** Dual-source hook: called after each successful poll completes. */
  on_peak?: (peak: number) => void;
}): void {
  state.generation++;
  if (state.timer !== null) clearTimeout(state.timer);
  state.active = true;
  state.network = opts.network;
  state.poll_interval_seconds = opts.poll_interval_seconds;
  state.lookback_blocks = opts.lookback_blocks;
  state.alert_recipients = opts.alert_recipients ?? [];
  state.onReorgBatch = opts.on_reorg_batch ?? null;
  state.onPeak = opts.on_peak ?? null;
  state.started_at = new Date().toISOString();
  state.poll_count = 0;
  state.peak_height = null;
  state.last_observed_peak = null;
  state.last_poll_at = null;
  state.last_error = null;
  state.reorgs = [];
  state.observations.clear();
  state.alertedReorgs.clear();
  log('info', 'Monitor started', {
    network: state.network,
    poll_interval_seconds: state.poll_interval_seconds,
    lookback_blocks: state.lookback_blocks,
    recipient_count: state.alert_recipients.length,
  });
  void _pollOnce().finally(() => {
    if (state.active) scheduleNext();
  });
}

export function stopMonitor(): void {
  const wasActive = state.active;
  state.generation++;
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.active = false;
  state.onReorgBatch = null;
  state.onPeak = null;
  if (wasActive) {
    log('info', 'Monitor stopped', {
      poll_count: state.poll_count,
      reorgs_detected: state.reorgs.length,
    });
  }
}

export function getStatus(): MonitorStatus {
  return {
    active: state.active,
    network: state.network,
    started_at: state.started_at,
    poll_interval_seconds: state.poll_interval_seconds,
    lookback_blocks: state.lookback_blocks,
    // Email addresses are redacted so callers of get_reorg_monitor_status cannot enumerate
    // the operator's recipient list (the start tool's response echoes them back unredacted).
    alert_recipients: state.alert_recipients.map((r) => ({
      email: redactEmail(r.email),
      min_blocks: r.min_blocks,
    })),
    poll_count: state.poll_count,
    peak_height: state.peak_height,
    last_poll_at: state.last_poll_at,
    last_error: state.last_error,
    reorgs: state.reorgs.map((r) => ({ ...r })),
    observations_count: state.observations.size,
  };
}
