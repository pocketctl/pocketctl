/**
 * ADR-0003 backfill policy.
 *
 * There is no feed backfill: `from_now` installations never see history,
 * and `retained_history` installations only ever see rows that still exist
 * in the shared feed. Recovery beyond retention goes through the Snapshot
 * API, which never copies feed rows and never moves an installation's ACK —
 * the provider reconciles its own durable inventory from snapshots.
 */
export interface BackfillWindow {
  strategy: 'none' | 'feed_window' | 'snapshot_required'
  /** Inclusive lower feed boundary for feed_window strategies. */
  fromFeedId: number | null
  snapshotRequired: boolean
}

export function computeBackfillWindow(input: {
  startPolicy: 'from_now' | 'retained_history'
  startFeedId: number
  oldestRetainedFeedId: number | null
}): BackfillWindow {
  if (input.startPolicy === 'from_now') {
    return { strategy: 'none', fromFeedId: null, snapshotRequired: false }
  }
  if (input.oldestRetainedFeedId === null) {
    // The feed is empty: only snapshots can rebuild provider state.
    return { strategy: 'snapshot_required', fromFeedId: null, snapshotRequired: true }
  }
  return {
    strategy: 'feed_window',
    fromFeedId: Math.max(1, input.oldestRetainedFeedId),
    snapshotRequired: false,
  }
}
