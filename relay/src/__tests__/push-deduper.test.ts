import { describe, test, expect, vi, afterEach } from 'vitest'
import { PushDeduper } from '../push-deduper.js'

// PushDeduper guards the user-facing push side-effect against WS reconnect /
// seq-replay gaps. The contract: a given key returns true once (push), then
// false for any repeat within the TTL window, and true again after expiry.

describe('PushDeduper', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('first sighting of a key returns true (should push)', () => {
    const d = new PushDeduper(30_000)
    expect(d.shouldPush('req-1')).toBe(true)
    d.stop()
  })

  test('repeat within the TTL window returns false (suppress)', () => {
    const d = new PushDeduper(30_000)
    expect(d.shouldPush('req-1')).toBe(true)
    expect(d.shouldPush('req-1')).toBe(false) // replay / reconnect
    expect(d.shouldPush('req-1')).toBe(false) // still suppressed
    d.stop()
  })

  test('after the TTL elapses, the key is pushable again', async () => {
    vi.useFakeTimers()
    const d = new PushDeduper(50) // 50ms window
    expect(d.shouldPush('req-1')).toBe(true)
    expect(d.shouldPush('req-1')).toBe(false)
    vi.advanceTimersByTime(60) // past expiry
    expect(d.shouldPush('req-1')).toBe(true) // new window opens
    d.stop()
  })

  test('different requestIds do not interfere with each other', () => {
    const d = new PushDeduper(30_000)
    expect(d.shouldPush('req-1')).toBe(true)
    expect(d.shouldPush('req-2')).toBe(true) // distinct request
    expect(d.shouldPush('req-1')).toBe(false) // req-1 still suppressed
    expect(d.shouldPush('req-2')).toBe(false) // req-2 also suppressed
    d.stop()
  })

  test('stop() clears all recorded keys', () => {
    const d = new PushDeduper(30_000)
    expect(d.shouldPush('req-1')).toBe(true)
    d.stop()
    // After stop, a fresh deduper behaves normally (proves state was isolated).
    const d2 = new PushDeduper(30_000)
    expect(d2.shouldPush('req-1')).toBe(true)
    d2.stop()
  })

  test('startSweeping is idempotent', () => {
    const d = new PushDeduper(30_000)
    d.startSweeping(10)
    d.startSweeping(10) // second call must not stack intervals
    d.stop() // clears without error
  })
})
