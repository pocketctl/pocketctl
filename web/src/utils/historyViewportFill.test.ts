import { describe, expect, test } from 'vitest'
import {
  HistoryViewportFillCoordinator,
  historyInitialTargetHeight,
  historyOlderTargetHeight,
  shouldStartHistoryResizeFill,
} from './historyViewportFill'

describe('HistoryViewportFillCoordinator', () => {
  test('continues initial history until rendered content covers the viewport buffer', () => {
    const fill = new HistoryViewportFillCoordinator()
    fill.begin({ mode: 'initial', baselineContentHeight: 0, now: 1_000 })

    expect(fill.recordPage({
      viewportHeight: 800,
      contentHeight: 850,
      hasMore: true,
      cursor: 900,
      now: 1_100,
    })).toEqual({ kind: 'continue', cursor: 900 })

    expect(fill.recordPage({
      viewportHeight: 800,
      contentHeight: 930,
      hasMore: true,
      cursor: 800,
      now: 1_200,
    })).toEqual({ kind: 'finish', reason: 'target_reached' })
  })

  test('continues older history until one gesture adds a visibly useful height', () => {
    const fill = new HistoryViewportFillCoordinator()
    fill.begin({ mode: 'older', baselineContentHeight: 1_600, requestedCursor: 1_000, now: 2_000 })

    expect(fill.recordPage({
      viewportHeight: 800,
      contentHeight: 1_680,
      hasMore: true,
      cursor: 900,
      now: 2_100,
    })).toEqual({ kind: 'continue', cursor: 900 })

    expect(fill.recordPage({
      viewportHeight: 800,
      contentHeight: 2_020,
      hasMore: true,
      cursor: 800,
      now: 2_200,
    })).toEqual({ kind: 'finish', reason: 'target_reached' })
  })

  test('stops when history is exhausted or the backward cursor does not advance', () => {
    const exhausted = new HistoryViewportFillCoordinator()
    exhausted.begin({ mode: 'initial', baselineContentHeight: 0, now: 1_000 })
    expect(exhausted.recordPage({
      viewportHeight: 800, contentHeight: 400, hasMore: false, cursor: 900, now: 1_100,
    })).toEqual({ kind: 'finish', reason: 'no_more' })

    const stalled = new HistoryViewportFillCoordinator()
    stalled.begin({ mode: 'older', baselineContentHeight: 1_600, requestedCursor: 1_000, now: 1_000 })
    expect(stalled.recordPage({
      viewportHeight: 800, contentHeight: 1_700, hasMore: true, cursor: 1_000, now: 1_100,
    })).toEqual({ kind: 'finish', reason: 'cursor_did_not_advance' })
  })

  test('stops safely for invalid geometry, page exhaustion, and elapsed-time exhaustion', () => {
    const invalid = new HistoryViewportFillCoordinator()
    invalid.begin({ mode: 'initial', baselineContentHeight: 0, now: 1_000 })
    expect(invalid.recordPage({
      viewportHeight: 0, contentHeight: 0, hasMore: true, cursor: 900, now: 1_100,
    })).toEqual({ kind: 'finish', reason: 'invalid_geometry' })

    const pageLimited = new HistoryViewportFillCoordinator({ maxPages: 2 })
    pageLimited.begin({ mode: 'initial', baselineContentHeight: 0, now: 1_000 })
    expect(pageLimited.recordPage({
      viewportHeight: 800, contentHeight: 300, hasMore: true, cursor: 900, now: 1_100,
    }).kind).toBe('continue')
    expect(pageLimited.recordPage({
      viewportHeight: 800, contentHeight: 400, hasMore: true, cursor: 800, now: 1_200,
    })).toEqual({ kind: 'finish', reason: 'page_limit_reached' })

    const timedOut = new HistoryViewportFillCoordinator({ maxElapsedMs: 4_000 })
    timedOut.begin({ mode: 'initial', baselineContentHeight: 0, now: 1_000 })
    expect(timedOut.recordPage({
      viewportHeight: 800, contentHeight: 400, hasMore: true, cursor: 900, now: 5_001,
    })).toEqual({ kind: 'finish', reason: 'time_limit_reached' })
  })
})

describe('history viewport thresholds', () => {
  test('uses a bounded initial buffer and a half-screen older-page target', () => {
    expect(historyInitialTargetHeight(400)).toBe(480)
    expect(historyInitialTargetHeight(800)).toBe(920)
    expect(historyInitialTargetHeight(2_000)).toBe(2_160)
    expect(historyOlderTargetHeight(300)).toBe(240)
    expect(historyOlderTargetHeight(800)).toBe(400)
  })

  test('starts resize fill only after meaningful growth while idle at the bottom', () => {
    const eligible = {
      previousViewportHeight: 600,
      viewportHeight: 800,
      contentHeight: 850,
      scrollTop: 50,
      hasMore: true,
      hasCursor: true,
      isLoading: false,
    }
    expect(shouldStartHistoryResizeFill(eligible)).toBe(true)
    expect(shouldStartHistoryResizeFill({ ...eligible, viewportHeight: 650 })).toBe(false)
    expect(shouldStartHistoryResizeFill({ ...eligible, scrollTop: 0, contentHeight: 1_200 })).toBe(false)
    expect(shouldStartHistoryResizeFill({ ...eligible, isLoading: true })).toBe(false)
    expect(shouldStartHistoryResizeFill({ ...eligible, hasMore: false })).toBe(false)
  })
})

describe('mobile visible-message history budget', () => {
  test('continues past tall tool-only pages and stops at 20 visible messages', () => {
    const fill = new HistoryViewportFillCoordinator()
    fill.begin({ mode: 'older', baselineContentHeight: 500, requestedCursor: 500, targetVisibleMessages: 20, now: 0 })
    expect(fill.recordPage({ viewportHeight: 500, contentHeight: 2000, hasMore: true, cursor: 400, visibleMessages: 0, now: 10 })).toEqual({ kind: 'continue', cursor: 400 })
    expect(fill.recordPage({ viewportHeight: 500, contentHeight: 2000, hasMore: true, cursor: 300, visibleMessages: 20, now: 20 })).toEqual({ kind: 'finish', reason: 'target_reached' })
  })
  test('recounts after toggling without resetting time or cursor limits', () => {
    const fill = new HistoryViewportFillCoordinator()
    fill.begin({ mode: 'initial', baselineContentHeight: 0, targetVisibleMessages: 20, now: 0 })
    expect(fill.recordPage({ viewportHeight: 500, contentHeight: 2000, hasMore: true, cursor: 400, visibleMessages: 19, now: 10 }).kind).toBe('continue')
    expect(fill.recordPage({ viewportHeight: 500, contentHeight: 2000, hasMore: true, cursor: 300, visibleMessages: 0, now: 3001 })).toEqual({ kind: 'finish', reason: 'time_limit_reached' })
  })
  test('caps hidden-only pages at ten and rejects a repeated cursor', () => {
    const fill = new HistoryViewportFillCoordinator()
    fill.begin({ mode: 'older', baselineContentHeight: 0, targetVisibleMessages: 20, now: 0 })
    for (let n = 0; n < 9; n++) expect(fill.recordPage({ viewportHeight: 0, contentHeight: 0, hasMore: true, cursor: 100 - n, visibleMessages: 0, now: n }).kind).toBe('continue')
    expect(fill.recordPage({ viewportHeight: 0, contentHeight: 0, hasMore: true, cursor: 90, visibleMessages: 0, now: 10 })).toEqual({ kind: 'finish', reason: 'page_limit_reached' })
    fill.begin({ mode: 'older', baselineContentHeight: 0, requestedCursor: 100, targetVisibleMessages: 20, now: 0 })
    expect(fill.recordPage({ viewportHeight: 0, contentHeight: 0, hasMore: true, cursor: 100, visibleMessages: 0, now: 10 })).toEqual({ kind: 'finish', reason: 'cursor_did_not_advance' })
  })
})
