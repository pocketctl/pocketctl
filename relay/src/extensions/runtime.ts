import type { ExtensionMode } from './types.js'

export interface ExtensionProjectorRuntimeOptions {
  runOnce(): Promise<{ projected: number; skipped: boolean }>
  mode: ExtensionMode
  intervalMs?: number
  /** Immediately drain extra batches while rows remain projected. */
  drainBudget?: number
  /** Periodic retention pass (feed cleanup + snapshot_required marking). */
  retention?: { runOnce(): Promise<unknown>; everyMs?: number }
  onError?(error: unknown): void
  onRetentionError?(error: unknown): void
  setTimer?(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clearTimer?(timer: ReturnType<typeof setTimeout>): void
}

const DEFAULT_INTERVAL_MS = 500
const DEFAULT_DRAIN_BUDGET = 8
// stop() stops scheduling new batches immediately and waits at most this
// long between batches; one in-flight batch may still run to its statement
// timeout (30s worst case) before the pool closes.
const SHUTDOWN_DRAIN_DEADLINE_MS = 5_000

/**
 * Timer-driven projector loop. It owns no process-level lifecycle: stop()
 * waits for the active batch under a bounded deadline and never calls
 * process.exit. Failures back off by one interval; the source rows stay put
 * until a later batch claims them.
 */
export function createExtensionProjectorRuntime(options: ExtensionProjectorRuntimeOptions) {
  const intervalMs = Math.max(1, Math.trunc(options.intervalMs ?? DEFAULT_INTERVAL_MS))
  const drainBudget = Math.max(0, options.drainBudget ?? DEFAULT_DRAIN_BUDGET)
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))

  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = true
  let started = false
  let activeRun: Promise<void> | undefined
  let stopDeadline = Number.POSITIVE_INFINITY

  const schedule = (delayMs: number): void => {
    if (stopped) return
    timer = setTimer(() => {
      timer = undefined
      void runOnce()
        .catch((error) => options.onError?.(error))
        .finally(() => schedule(intervalMs))
    }, delayMs)
    timer.unref?.()
  }

  const retentionEveryMs = Math.max(1, Math.trunc(options.retention?.everyMs ?? 60_000))
  let lastRetentionAt = 0

  const runOnce = async (): Promise<void> => {
    if (activeRun) return activeRun
    const run = (async () => {
      const now = Date.now()
      if (options.retention && now - lastRetentionAt >= retentionEveryMs) {
        lastRetentionAt = now
        await options.retention.runOnce().catch((error) => options.onRetentionError?.(error))
      }
      let drains = 0
      // Keep draining while batches stay productive and within the budget;
      // after stop() begins, only the in-flight batch may finish.
      for (;;) {
        if ((stopped && drains > 0) || Date.now() > stopDeadline) return
        const result = await options.runOnce()
        drains++
        const productive = result.projected > 0 && !result.skipped
        if (!productive || drains > drainBudget) return
      }
    })()
    activeRun = run
    try {
      await run
    } finally {
      if (activeRun === run) activeRun = undefined
    }
  }

  return {
    start(): void {
      if (options.mode === 'off') return
      if (!stopped) return
      stopped = false
      started = true
      schedule(0)
    },
    async stop(): Promise<void> {
      if (!started) return
      stopped = true
      stopDeadline = Date.now() + SHUTDOWN_DRAIN_DEADLINE_MS
      if (timer) {
        clearTimer(timer)
        timer = undefined
      }
      await activeRun
    },
  }
}
