import { describe, expect, test } from 'vitest'
import {
  createExtensionRateLimiter,
  createExtensionRateLimiterSet,
  DEFAULT_EXTENSION_RATE_LIMITS,
  rateLimitedResponse,
} from '../extensions/rate-limit.js'
import { resolveExtensionRateLimitConfig } from '../runtime-config.js'

describe('extension rate limiter', () => {
  test('allows up to the window budget then denies with retry hint', () => {
    let clock = 0
    const limiter = createExtensionRateLimiter({ maxPerWindow: 3, now: () => clock })
    expect(limiter.check('k').allowed).toBe(true)
    expect(limiter.check('k').allowed).toBe(true)
    expect(limiter.check('k').allowed).toBe(true)
    const denied = limiter.check('k')
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterMs).toBeGreaterThan(0)
    // Distinct keys have independent budgets.
    expect(limiter.check('other').allowed).toBe(true)
    // The window rolls.
    clock = 61_000
    expect(limiter.check('k').allowed).toBe(true)
  })

  test('the policy set covers every control-plane endpoint', () => {
    const set = createExtensionRateLimiterSet(DEFAULT_EXTENSION_RATE_LIMITS)
    for (const key of ['token', 'feed', 'ack', 'snapshot', 'status', 'usage', 'purge', 'grant'] as const) {
      expect(set[key]).toBeDefined()
    }
    expect(rateLimitedResponse(1500)).toMatchObject({
      status: 429,
      retryAfterSeconds: 2,
      body: { error: { code: 'invalid_request' } },
    })
  })

  test('strict env parsing rejects malformed budgets', () => {
    expect(resolveExtensionRateLimitConfig({}).feed).toBe(120)
    expect(resolveExtensionRateLimitConfig({
      RELAY_EXTENSION_RATE_LIMIT_FEED: '5',
    }).feed).toBe(5)
    expect(() => resolveExtensionRateLimitConfig({
      RELAY_EXTENSION_RATE_LIMIT_TOKEN: '12junk',
    })).toThrow('RELAY_EXTENSION_RATE_LIMIT_TOKEN')
    expect(() => resolveExtensionRateLimitConfig({
      RELAY_EXTENSION_RATE_LIMIT_GRANT: '0',
    })).toThrow('RELAY_EXTENSION_RATE_LIMIT_GRANT')
  })
})
