export interface LiveBatchScheduler {
  requestFrame(callback: () => void): number
  cancelFrame(id: number): void
  setFallback(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clearFallback(id: ReturnType<typeof setTimeout>): void
}

export interface LiveSessionEventBatcher<T> {
  enqueue(contextKey: string, event: T): void
  flushNow(): void
  reset(contextKey: string): void
  dispose(): void
  readonly pendingCount: number
}

const DEFAULT_FALLBACK_MS = 50

const browserScheduler: LiveBatchScheduler = {
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
  setFallback: (callback, delayMs) => setTimeout(callback, delayMs),
  clearFallback: (id) => clearTimeout(id),
}

// Coalesces append-only live events into one ordered flush per animation frame
// with a timer fallback, so background tabs and test environments still
// progress. The batcher never merges, sorts, or rewrites payloads: wire order
// is the flush order and downstream reducers stay the single source of truth.
export function createLiveSessionEventBatcher<T>(options: {
  flush(events: readonly T[]): void
  scheduler?: LiveBatchScheduler
  fallbackMs?: number
}): LiveSessionEventBatcher<T> {
  const scheduler = options.scheduler ?? browserScheduler
  const fallbackMs = Math.max(1, Math.trunc(options.fallbackMs ?? DEFAULT_FALLBACK_MS))
  let contextKey: string | undefined
  let pending: T[] = []
  let frameId: number | undefined
  let fallbackId: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const cancelScheduling = (): void => {
    if (frameId !== undefined) {
      scheduler.cancelFrame(frameId)
      frameId = undefined
    }
    if (fallbackId !== undefined) {
      scheduler.clearFallback(fallbackId)
      fallbackId = undefined
    }
  }

  const deliverPending = (): void => {
    if (pending.length === 0) return
    // Swap first so events enqueued from inside the flush callback join the
    // next batch instead of reentering this one.
    const events = pending
    pending = []
    options.flush(events)
  }

  const frameFlush = (): void => {
    frameId = undefined
    if (fallbackId !== undefined) {
      scheduler.clearFallback(fallbackId)
      fallbackId = undefined
    }
    deliverPending()
  }

  const fallbackFlush = (): void => {
    fallbackId = undefined
    if (frameId !== undefined) {
      scheduler.cancelFrame(frameId)
      frameId = undefined
    }
    deliverPending()
  }

  return {
    enqueue(nextContextKey, event) {
      if (disposed) return
      if (contextKey !== undefined && nextContextKey !== contextKey) {
        cancelScheduling()
        pending = []
      }
      contextKey = nextContextKey
      pending.push(event)
      if (frameId === undefined && fallbackId === undefined) {
        frameId = scheduler.requestFrame(frameFlush)
        fallbackId = scheduler.setFallback(fallbackFlush, fallbackMs)
      }
    },
    flushNow() {
      if (disposed) {
        pending = []
        return
      }
      cancelScheduling()
      deliverPending()
    },
    reset(nextContextKey) {
      cancelScheduling()
      pending = []
      contextKey = nextContextKey
    },
    dispose() {
      disposed = true
      cancelScheduling()
      pending = []
    },
    get pendingCount() {
      return pending.length
    },
  }
}
