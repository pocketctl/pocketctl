import { describe, expect, test } from 'vitest'
import {
  createAuthRateLimiter,
  type HitAuthRateLimitFn,
} from '../auth-rate-limit.js'
import { resolveAuthRateLimitConfig } from '../runtime-config.js'

const PEPPER = 'unit-test-pepper-0123456789abcdef0123456789'

interface RecordedCall {
  limitKey: string
  limit: number
  windowMs: number
  at: number
}

/** Fixed-window fake that mirrors hitAuthRateLimit semantics over shared state. */
function makeSharedFakeHit(options: { failWith?: Error } = {}) {
  const windows = new Map<string, { startedAt: number; count: number }>()
  const calls: RecordedCall[] = []
  const hit: HitAuthRateLimitFn = async (_pool, params) => {
    if (options.failWith) throw options.failWith
    const at = params.now.getTime()
    calls.push({ limitKey: params.limitKey, limit: params.limit, windowMs: params.windowMs, at })
    const key = `${params.limitKey}:${params.windowMs}`
    let entry = windows.get(key)
    if (!entry || at >= entry.startedAt + params.windowMs) {
      entry = { startedAt: at, count: 0 }
      windows.set(key, entry)
    }
    entry.count += 1
    return {
      allowed: entry.count <= params.limit,
      retryAfterMs: entry.count <= params.limit
        ? 0
        : Math.max(1000, entry.startedAt + params.windowMs - at),
      count: entry.count,
    }
  }
  return { hit, calls, windows }
}

const poolStub = {} as never

describe('auth rate limiter unit behavior', () => {
  test('allows requests while every bucket stays within budget', async () => {
    const { hit } = makeSharedFakeHit()
    const limiter = createAuthRateLimiter({ pepper: PEPPER, hit })
    const decision = await limiter.enforce(poolStub, {
      scope: 'register',
      windowMs: 15 * 60_000,
      ip: { value: '203.0.113.10', limit: 10 },
      identity: { value: 'user@example.test', limit: 5 },
      now: new Date(1_000_000),
    })
    expect(decision).toEqual({ ok: true })
  })

  test('rejects with 429 and a consistent retry-after once the IP budget is exhausted', async () => {
    const { hit } = makeSharedFakeHit()
    const limiter = createAuthRateLimiter({ pepper: PEPPER, hit })
    const now = new Date(1_000_000)
    let decision: Awaited<ReturnType<typeof limiter.enforce>> = { ok: true }
    for (let i = 0; i <= 3; i++) {
      decision = await limiter.enforce(poolStub, {
        scope: 'login',
        windowMs: 60_000,
        ip: { value: '198.51.100.7', limit: 3 },
        now,
      })
    }
    expect(decision).toEqual({ ok: false, status: 429, retryAfterMs: 60_000 })
  })

  test('per-identity budget is enforced independently of the IP budget', async () => {
    const { hit } = makeSharedFakeHit()
    const limiter = createAuthRateLimiter({ pepper: PEPPER, hit })
    const now = new Date(5_000_000)
    // Same IP but many identities: IP budget high enough, each identity trips its own limit.
    for (let i = 0; i < 2; i++) {
      const ok = await limiter.enforce(poolStub, {
        scope: 'register',
        windowMs: 60_000,
        ip: { value: '203.0.113.99', limit: 100 },
        identity: { value: `user${i}@example.test`, limit: 1 },
        now,
      })
      expect(ok.ok).toBe(true)
    }
    const third = await limiter.enforce(poolStub, {
      scope: 'register',
      windowMs: 60_000,
      ip: { value: '203.0.113.99', limit: 100 },
      identity: { value: 'user0@example.test', limit: 1 },
      now,
    })
    expect(third).toEqual({ ok: false, status: 429, retryAfterMs: 60_000 })
  })

  test('window rollover restores the budget', async () => {
    const { hit } = makeSharedFakeHit()
    const limiter = createAuthRateLimiter({ pepper: PEPPER, hit })
    const t0 = new Date(1_000_000)
    const exhausted = await limiter.enforce(poolStub, {
      scope: 'login', windowMs: 1_000, ip: { value: '192.0.2.1', limit: 1 }, now: t0,
    })
    expect(exhausted.ok).toBe(true)
    const blocked = await limiter.enforce(poolStub, {
      scope: 'login', windowMs: 1_000, ip: { value: '192.0.2.1', limit: 1 }, now: t0,
    })
    expect(blocked).toEqual({ ok: false, status: 429, retryAfterMs: 1_000 })
    const afterRollover = await limiter.enforce(poolStub, {
      scope: 'login', windowMs: 1_000, ip: { value: '192.0.2.1', limit: 1 }, now: new Date(t0.getTime() + 1_000),
    })
    expect(afterRollover.ok).toBe(true)
  })

  test('database backend errors fail closed with 503 instead of allowing the request', async () => {
    const { hit } = makeSharedFakeHit({ failWith: new Error('connection refused') })
    const limiter = createAuthRateLimiter({ pepper: PEPPER, hit })
    const decision = await limiter.enforce(poolStub, {
      scope: 'device:authorize',
      windowMs: 60_000,
      ip: { value: '203.0.113.10', limit: 10 },
      now: new Date(),
    })
    expect(decision).toEqual({ ok: false, status: 503 })
  })

  test('two limiter instances share the same counters (multi-relay deployment)', async () => {
    const { hit } = makeSharedFakeHit()
    const relayA = createAuthRateLimiter({ pepper: PEPPER, hit })
    const relayB = createAuthRateLimiter({ pepper: PEPPER, hit })
    const now = new Date(1_000_000)
    const a = await relayA.enforce(poolStub, {
      scope: 'refresh', windowMs: 60_000, ip: { value: '203.0.113.4', limit: 2 }, now,
    })
    const b = await relayB.enforce(poolStub, {
      scope: 'refresh', windowMs: 60_000, ip: { value: '203.0.113.4', limit: 2 }, now,
    })
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    const third = await relayA.enforce(poolStub, {
      scope: 'refresh', windowMs: 60_000, ip: { value: '203.0.113.4', limit: 2 }, now,
    })
    expect(third.ok).toBe(false)
    if (!third.ok) expect(third.status).toBe(429)
  })

  test('storage keys are HMAC fingerprints and never contain subject plaintext', async () => {
    const { hit, calls } = makeSharedFakeHit()
    const limiter = createAuthRateLimiter({ pepper: PEPPER, hit })
    await limiter.enforce(poolStub, {
      scope: 'email:send',
      windowMs: 60_000,
      ip: { value: '203.0.113.77', limit: 10 },
      identity: { value: 'secret-mailbox@example.test', limit: 5 },
      now: new Date(),
    })
    expect(calls.length).toBe(2)
    for (const call of calls) {
      expect(call.limitKey).toMatch(/^[0-9a-f]{64}$/)
      expect(call.limitKey).not.toContain('203.0.113.77')
      expect(call.limitKey).not.toContain('example.test')
      expect(call.limitKey).not.toContain('secret-mailbox')
    }
    const ipKey = calls.find(c => c.limit === 10)!.limitKey
    const identityKey = calls.find(c => c.limit === 5)!.limitKey
    expect(ipKey).not.toBe(identityKey)
    // Deterministic across instances (same pepper + subject → same key).
    const { hit: hit2, calls: calls2 } = makeSharedFakeHit()
    const other = createAuthRateLimiter({ pepper: PEPPER, hit: hit2 })
    await other.enforce(poolStub, {
      scope: 'email:send',
      windowMs: 60_000,
      ip: { value: '203.0.113.77', limit: 10 },
      identity: { value: 'secret-mailbox@example.test', limit: 5 },
      now: new Date(),
    })
    expect(calls2.find(c => c.limit === 10)!.limitKey).toBe(ipKey)
    expect(calls2.find(c => c.limit === 5)!.limitKey).toBe(identityKey)
  })

  test('identities differing only by case are separate subjects by caller choice, not silently merged', async () => {
    const { hit, calls } = makeSharedFakeHit()
    const limiter = createAuthRateLimiter({ pepper: PEPPER, hit })
    await limiter.enforce(poolStub, {
      scope: 'device:token',
      windowMs: 60_000,
      identity: { value: 'DEVICECODE123', limit: 5 },
      now: new Date(),
    })
    await limiter.enforce(poolStub, {
      scope: 'device:token',
      windowMs: 60_000,
      identity: { value: 'devicecode123', limit: 5 },
      now: new Date(),
    })
    expect(new Set(calls.map(c => c.limitKey)).size).toBe(2)
  })
})

describe('auth rate limit policy configuration', () => {
  test('defaults match the endpoint policy matrix', () => {
    const config = resolveAuthRateLimitConfig({} as NodeJS.ProcessEnv)
    expect(config.register.ipMax).toBe(10)
    expect(config.register.identityMax).toBe(5)
    expect(config.deviceAuthorize.perMinute).toBe(10)
    expect(config.deviceAuthorize.perHour).toBe(100)
    expect(config.poll.ipMax).toBe(120)
    expect(config.confirm.userMax).toBe(10)
    expect(config.confirm.ipMax).toBe(30)
    expect(config.tokenOps.tokenMax).toBe(30)
    expect(config.tokenOps.ipMax).toBe(120)
    expect(config.wsTicket.userMax).toBe(30)
    expect(config.wsTicket.ipMax).toBe(120)
  })

  test('strict positive integer overrides are honored', () => {
    const config = resolveAuthRateLimitConfig({
      AUTH_RATE_LIMIT_REGISTER_IP_MAX: '3',
      AUTH_RATE_LIMIT_DEVICE_AUTHORIZE_PER_HOUR: '250',
    } as NodeJS.ProcessEnv)
    expect(config.register.ipMax).toBe(3)
    expect(config.deviceAuthorize.perHour).toBe(250)
  })

  test('non-positive or non-decimal values fail startup, in production and elsewhere', () => {
    for (const bad of ['0', '-1', 'abc', '1.5', '']) {
      expect(() => resolveAuthRateLimitConfig({
        AUTH_RATE_LIMIT_REGISTER_IP_MAX: bad,
      } as NodeJS.ProcessEnv)).toThrow('AUTH_RATE_LIMIT_REGISTER_IP_MAX')
    }
  })
})
