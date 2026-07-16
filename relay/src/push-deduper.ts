/**
 * In-process dedup for push notifications.
 *
 * The relay already dedups persisted events by seq water-mark (see
 * router.ts handleDaemonMessage), but push is a user-facing side-effect that
 * can still fire twice during three gaps:
 *   1. The ack async window — an event is pushed, but markPersisted hasn't
 *      advanced persistedHigh yet when the WS drops; the daemon replays the
 *      seq and it's reprocessed + re-pushed.
 *   2. Legacy daemons that omit seq entirely bypass the seq dedup.
 *   3. persistEvent failures withhold the ack; the daemon replays, the
 *      event_hash unique index keeps the DB clean but the push fires again.
 *
 * Pushing a real notification is not idempotent from the user's POV (they get
 * spammed), so we keep an independent, TTL-bounded "recently pushed" guard
 * keyed on requestId. Single-instance, in-memory — a relay restart may let a
 * single duplicate through, which is acceptable.
 */
export class PushDeduper {
  /** key → expiry timestamp (ms epoch). */
  private seen = new Map<string, number>();
  private readonly ttlMs: number;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(ttlMs = 30_000) {
    this.ttlMs = ttlMs;
  }

  /**
   * Returns true the first time `key` is seen (caller should push), false on
   * any repeat within the TTL window (caller should skip). Recording happens
   * on the first call, so this is both the check and the mark.
   */
  shouldPush(key: string): boolean {
    const now = Date.now();
    const expiry = this.seen.get(key);
    if (expiry !== undefined && now < expiry) {
      return false; // within the window — duplicate, skip
    }
    this.seen.set(key, now + this.ttlMs);
    return true;
  }

  /** Allow a failed delivery attempt to be retried by durable replay. */
  forget(key: string): void {
    this.seen.delete(key);
  }

  /**
   * Start periodic sweeping to reclaim expired entries, keeping the Map
   * bounded over a long-lived process. Idempotent — calling again is a no-op.
   */
  startSweeping(intervalMs = 60_000): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), intervalMs);
    // Don't keep the process alive just for sweeping.
    if (this.sweeper && typeof this.sweeper === 'object' && 'unref' in this.sweeper) {
      (this.sweeper as NodeJS.Timeout).unref();
    }
  }

  /** Remove all entries whose TTL has elapsed. */
  private sweep(): void {
    const now = Date.now();
    for (const [key, expiry] of this.seen) {
      if (expiry <= now) this.seen.delete(key);
    }
  }

  /** Stop the sweeper and clear all state (call on relay shutdown). */
  stop(): void {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    this.seen.clear();
  }
}
