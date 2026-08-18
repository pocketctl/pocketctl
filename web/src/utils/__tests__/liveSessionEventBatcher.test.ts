import { describe, expect, test, vi } from 'vitest'
import { createLiveSessionEventBatcher, type LiveBatchScheduler } from '../liveSessionEventBatcher.js'

function controlledScheduler() {
  const frames = new Map<number, () => void>()
  const fallbacks = new Map<number, { callback: () => void; delayMs: number }>()
  let nextFrameId = 1
  let nextFallbackId = 1
  const scheduler: LiveBatchScheduler = {
    requestFrame(callback) {
      const id = nextFrameId
      nextFrameId += 1
      frames.set(id, callback)
      return id
    },
    cancelFrame(id) { frames.delete(id) },
    setFallback(callback, delayMs) {
      const id = nextFallbackId
      nextFallbackId += 1
      fallbacks.set(id, { callback, delayMs })
      return id as never
    },
    clearFallback(id) { fallbacks.delete(id as never) },
  }
  return {
    scheduler,
    frameCount: () => frames.size,
    fallbackCount: () => fallbacks.size,
    fireFrame: () => {
      const entry = [...frames.entries()][0]
      if (!entry) throw new Error('no frame scheduled')
      frames.delete(entry[0])
      entry[1]()
    },
    fireFallback: () => {
      const entry = [...fallbacks.entries()][0]
      if (!entry) throw new Error('no fallback scheduled')
      fallbacks.delete(entry[0])
      entry[1].callback()
    },
  }
}

describe('liveSessionEventBatcher', () => {
  test('coalesces one hundred same-context enqueues into a single ordered flush', () => {
    const harness = controlledScheduler()
    const flush = vi.fn()
    const batcher = createLiveSessionEventBatcher<number>({
      flush,
      scheduler: harness.scheduler,
    })

    for (let index = 0; index < 100; index += 1) batcher.enqueue('session-1', index)

    expect(harness.frameCount()).toBe(1)
    expect(harness.fallbackCount()).toBe(1)
    expect(batcher.pendingCount).toBe(100)

    harness.fireFrame()
    expect(flush).toHaveBeenCalledOnce()
    expect(flush).toHaveBeenCalledWith(Array.from({ length: 100 }, (_, index) => index))
    expect(harness.fallbackCount()).toBe(0)
    expect(batcher.pendingCount).toBe(0)
  })

  test('the fallback path flushes once and cancels the pending frame', () => {
    const harness = controlledScheduler()
    const flush = vi.fn()
    const batcher = createLiveSessionEventBatcher<number>({
      flush,
      scheduler: harness.scheduler,
    })

    batcher.enqueue('session-1', 1)
    batcher.enqueue('session-1', 2)

    harness.fireFallback()
    expect(flush).toHaveBeenCalledOnce()
    expect(flush).toHaveBeenCalledWith([1, 2])
    expect(harness.frameCount()).toBe(0)
    expect(batcher.pendingCount).toBe(0)
  })

  test('the fallback timer uses the configured delay', () => {
    const harness = controlledScheduler()
    const setFallback = vi.fn(harness.scheduler.setFallback)
    const batcher = createLiveSessionEventBatcher<number>({
      flush: vi.fn(),
      scheduler: { ...harness.scheduler, setFallback },
      fallbackMs: 120,
    })

    batcher.enqueue('session-1', 1)

    expect(setFallback).toHaveBeenCalledWith(expect.any(Function), 120)
    harness.fireFallback()
    expect(batcher.pendingCount).toBe(0)
  })

  test('flushNow delivers synchronously and cancels frame and fallback', () => {
    const harness = controlledScheduler()
    const flush = vi.fn()
    const batcher = createLiveSessionEventBatcher<number>({
      flush,
      scheduler: harness.scheduler,
    })

    batcher.enqueue('session-1', 7)
    batcher.flushNow()

    expect(flush).toHaveBeenCalledOnce()
    expect(flush).toHaveBeenCalledWith([7])
    expect(harness.frameCount()).toBe(0)
    expect(harness.fallbackCount()).toBe(0)
  })

  test('reset with a new context drops the old pending batch', () => {
    const harness = controlledScheduler()
    const flush = vi.fn()
    const batcher = createLiveSessionEventBatcher<number>({
      flush,
      scheduler: harness.scheduler,
    })

    batcher.enqueue('session-1', 1)
    batcher.reset('session-2')

    expect(batcher.pendingCount).toBe(0)
    expect(harness.frameCount()).toBe(0)
    expect(harness.fallbackCount()).toBe(0)
    expect(flush).not.toHaveBeenCalled()

    batcher.enqueue('session-2', 99)
    harness.fireFrame()
    expect(flush).toHaveBeenCalledWith([99])
  })

  test('dispose makes enqueue a no-op and clears pending scheduling', () => {
    const harness = controlledScheduler()
    const flush = vi.fn()
    const batcher = createLiveSessionEventBatcher<number>({
      flush,
      scheduler: harness.scheduler,
    })

    batcher.enqueue('session-1', 1)
    batcher.dispose()

    expect(harness.frameCount()).toBe(0)
    expect(harness.fallbackCount()).toBe(0)
    batcher.enqueue('session-1', 2)
    expect(batcher.pendingCount).toBe(0)
    expect(harness.frameCount()).toBe(0)
    expect(flush).not.toHaveBeenCalled()
  })

  test('events enqueued from inside flush land in the next batch', () => {
    const harness = controlledScheduler()
    const flush = vi.fn()
    const batcher = createLiveSessionEventBatcher<number>({
      flush(events) {
        flush(events)
        if (events[0] === 1) batcher.enqueue('session-1', 2)
      },
      scheduler: harness.scheduler,
    })

    batcher.enqueue('session-1', 1)
    harness.fireFrame()
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledWith([1])
    expect(batcher.pendingCount).toBe(1)

    harness.fireFrame()
    expect(flush).toHaveBeenCalledTimes(2)
    expect(flush).toHaveBeenLastCalledWith([2])
  })

  test('a context switch inside enqueue resets the old pending batch', () => {
    const harness = controlledScheduler()
    const flush = vi.fn()
    const batcher = createLiveSessionEventBatcher<number>({
      flush,
      scheduler: harness.scheduler,
    })

    batcher.enqueue('session-1', 1)
    batcher.enqueue('session-2', 100)

    expect(batcher.pendingCount).toBe(1)
    harness.fireFrame()
    expect(flush).toHaveBeenCalledOnce()
    expect(flush).toHaveBeenCalledWith([100])
  })

  test('uses requestAnimationFrame and a 50ms setTimeout fallback by default', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const setTimeoutSpy = vi.fn(() => 2 as never)
    const clearTimeoutSpy = vi.fn()
    vi.stubGlobal('setTimeout', setTimeoutSpy)
    vi.stubGlobal('clearTimeout', clearTimeoutSpy)

    try {
      const flush = vi.fn()
      const batcher = createLiveSessionEventBatcher<number>({ flush })
      batcher.enqueue('session-1', 1)

      expect(vi.mocked(globalThis.requestAnimationFrame)).toHaveBeenCalledOnce()
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 50)

      batcher.dispose()
      expect(vi.mocked(globalThis.cancelAnimationFrame)).toHaveBeenCalledWith(1)
      expect(clearTimeoutSpy).toHaveBeenCalledWith(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
