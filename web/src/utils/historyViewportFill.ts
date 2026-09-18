export type HistoryViewportFillMode = 'initial' | 'older' | 'resize'

export type HistoryViewportFillFinishReason =
  | 'target_reached'
  | 'no_more'
  | 'invalid_cursor'
  | 'cursor_did_not_advance'
  | 'invalid_geometry'
  | 'page_limit_reached'
  | 'time_limit_reached'

export type HistoryViewportFillDecision =
  | { kind: 'continue'; cursor: number }
  | { kind: 'finish'; reason: HistoryViewportFillFinishReason }

interface HistoryViewportFillOptions {
  maxPages?: number
  maxElapsedMs?: number
}

interface HistoryViewportFillStart {
  mode: HistoryViewportFillMode
  baselineContentHeight: number
  requestedCursor?: number
  now?: number
}

interface HistoryViewportPageMeasurement {
  viewportHeight: number
  contentHeight: number
  hasMore: boolean
  cursor?: number
  now?: number
}

interface HistoryViewportResizeMeasurement {
  previousViewportHeight: number
  viewportHeight: number
  contentHeight: number
  scrollTop: number
  hasMore: boolean
  hasCursor: boolean
  isLoading: boolean
}

interface ActiveHistoryViewportFill {
  mode: HistoryViewportFillMode
  baselineContentHeight: number
  requestedCursor?: number
  startedAt: number
  completedPages: number
}

const DEFAULT_MAX_PAGES = 5
const DEFAULT_MAX_ELAPSED_MS = 4_000
const RESIZE_MIN_GROWTH = 80
const BOTTOM_PROXIMITY = 60

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

export function historyInitialTargetHeight(viewportHeight: number): number {
  const buffer = Math.min(160, Math.max(80, viewportHeight * 0.15))
  return viewportHeight + buffer
}

export function historyOlderTargetHeight(viewportHeight: number): number {
  return Math.max(240, viewportHeight * 0.5)
}

export function shouldStartHistoryResizeFill(input: HistoryViewportResizeMeasurement): boolean {
  if (input.isLoading || !input.hasMore || !input.hasCursor) return false
  if (!finitePositive(input.viewportHeight) || !Number.isFinite(input.contentHeight)) return false
  if (input.viewportHeight - input.previousViewportHeight < RESIZE_MIN_GROWTH) return false
  const bottomDistance = Math.max(0, input.contentHeight - input.scrollTop - input.viewportHeight)
  if (bottomDistance > BOTTOM_PROXIMITY) return false
  return input.contentHeight < historyInitialTargetHeight(input.viewportHeight)
}

export class HistoryViewportFillCoordinator {
  private readonly maxPages: number
  private readonly maxElapsedMs: number
  private active?: ActiveHistoryViewportFill

  constructor(options: HistoryViewportFillOptions = {}) {
    this.maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES)
    this.maxElapsedMs = Math.max(1, options.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS)
  }

  get mode(): HistoryViewportFillMode | undefined {
    return this.active?.mode
  }

  begin(input: HistoryViewportFillStart): void {
    this.active = {
      mode: input.mode,
      baselineContentHeight: Math.max(0, input.baselineContentHeight),
      requestedCursor: input.requestedCursor,
      startedAt: input.now ?? Date.now(),
      completedPages: 0,
    }
  }

  cancel(): void {
    this.active = undefined
  }

  recordPage(input: HistoryViewportPageMeasurement): HistoryViewportFillDecision {
    const active = this.active
    if (!active) return { kind: 'finish', reason: 'invalid_geometry' }
    active.completedPages += 1

    if (!finitePositive(input.viewportHeight) || !Number.isFinite(input.contentHeight)) {
      return this.finish('invalid_geometry')
    }

    const targetReached = active.mode === 'older'
      ? input.contentHeight - active.baselineContentHeight >= historyOlderTargetHeight(input.viewportHeight)
      : input.contentHeight >= historyInitialTargetHeight(input.viewportHeight)
    if (targetReached) return this.finish('target_reached')
    if (!input.hasMore) return this.finish('no_more')

    const cursor = input.cursor
    if (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor <= 0) {
      return this.finish('invalid_cursor')
    }
    if (active.requestedCursor !== undefined && cursor >= active.requestedCursor) {
      return this.finish('cursor_did_not_advance')
    }
    if (active.completedPages >= this.maxPages) return this.finish('page_limit_reached')
    if ((input.now ?? Date.now()) - active.startedAt > this.maxElapsedMs) {
      return this.finish('time_limit_reached')
    }

    active.requestedCursor = cursor
    return { kind: 'continue', cursor }
  }

  private finish(reason: HistoryViewportFillFinishReason): HistoryViewportFillDecision {
    this.active = undefined
    return { kind: 'finish', reason }
  }
}
