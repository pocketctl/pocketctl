import { afterEach, describe, expect, test, vi } from 'vitest'
import { createRateLimiter } from '../api/rate-limiter.js'

afterEach(() => vi.useRealTimers())

describe('bounded rate limiter', () => {
  test('fails closed at the live-key cap and reclaims expired keys before inserting', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-25T00:00:00Z'))
    const limiter = createRateLimiter(2, 1_000, 2)
    expect(limiter.check('a').allowed).toBe(true)
    expect(limiter.check('b').allowed).toBe(true)
    expect(limiter.check('c').allowed).toBe(false)
    vi.advanceTimersByTime(1_001)
    expect(limiter.check('c').allowed).toBe(true)
  })

  test('counts a stable key inside its fixed window', () => {
    const limiter = createRateLimiter(2, 60_000, 2)
    expect([limiter.check('manage:i').allowed, limiter.check('manage:i').allowed,
      limiter.check('manage:i').allowed]).toEqual([true, true, false])
  })
})
