import pg from 'pg'
import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { hitAuthRateLimit } from '../db.js'
import { createAuthRateLimiter } from '../auth-rate-limit.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const PEPPER = 'integration-test-pepper-0123456789abcdef0123456789'

function storedKey(scope: string, kind: 'ip' | 'identity', subject: string): string {
  return createHmac('sha256', PEPPER)
    .update(`auth-rate-limit:v1:${scope}:${kind}:${subject}`)
    .digest('hex')
}

function cleanup(pool: pg.Pool, keys: string[]): Promise<unknown> {
  return pool.query(`DELETE FROM auth_rate_limits WHERE limit_key = ANY($1::text[])`, [keys])
}

describeWithDatabase('auth rate limiting PostgreSQL integration (M-2)', () => {
  let pool: pg.Pool
  let secondPool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    secondPool = new pg.Pool({ connectionString: databaseUrl })
  })

  afterAll(async () => {
    if (pool) await pool.end().catch(() => {})
    if (secondPool) await secondPool.end().catch(() => {})
  })

  test('atomic counters shared across pools reject only over-budget requests', async () => {
    const limiterA = createAuthRateLimiter({ pepper: PEPPER, hit: hitAuthRateLimit })
    const limiterB = createAuthRateLimiter({ pepper: PEPPER, hit: hitAuthRateLimit })
    const scope = 'it:atomic'
    const ip = `203.0.113.${Math.floor(Math.random() * 254) + 1}`
    const results: boolean[] = []
    for (let i = 0; i < 5; i++) {
      // Alternate the two "relay instances" (separate pools, shared table).
      const decision = await (i % 2 === 0 ? limiterA : limiterB).enforce(i % 2 === 0 ? pool : secondPool, {
        scope,
        windowMs: 60_000,
        ip: { value: ip, limit: 3 },
        now: new Date(),
      })
      results.push(decision.ok)
    }
    expect(results).toEqual([true, true, true, false, false])
    await cleanup(pool, [storedKey(scope, 'ip', ip)])
  })

  test('concurrent requests in the same window are counted atomically', async () => {
    const limiter = createAuthRateLimiter({ pepper: PEPPER, hit: hitAuthRateLimit })
    const scope = 'it:concurrent'
    const ip = `198.51.100.${Math.floor(Math.random() * 254) + 1}`
    const decisions = await Promise.all(
      Array.from({ length: 6 }, () =>
        limiter.enforce(pool, {
          scope,
          windowMs: 60_000,
          ip: { value: ip, limit: 4 },
          now: new Date(),
        }),
      ),
    )
    expect(decisions.filter(d => d.ok).length).toBe(4)
    await cleanup(pool, [storedKey(scope, 'ip', ip)])
  })

  test('stored keys are opaque HMAC digests, never plaintext subjects', async () => {
    const limiter = createAuthRateLimiter({ pepper: PEPPER, hit: hitAuthRateLimit })
    const scope = 'it:privacy'
    const ip = `192.0.2.${Math.floor(Math.random() * 254) + 1}`
    const email = `probe-${Date.now()}@example.test`
    const decision = await limiter.enforce(pool, {
      scope,
      windowMs: 60_000,
      ip: { value: ip, limit: 10 },
      identity: { value: email, limit: 5 },
      now: new Date(),
    })
    expect(decision.ok).toBe(true)
    const rows = await pool.query<{ limit_key: string }>(
      `SELECT limit_key FROM auth_rate_limits`,
    )
    for (const row of rows.rows) {
      expect(row.limit_key).not.toContain(ip)
      expect(row.limit_key).not.toContain('example.test')
    }
    await cleanup(pool, [storedKey(scope, 'ip', ip), storedKey(scope, 'identity', email)])
  })

  test('window rollover restores the budget against the real database clock semantics', async () => {
    const limiter = createAuthRateLimiter({ pepper: PEPPER, hit: hitAuthRateLimit })
    const scope = 'it:rollover'
    const ip = `198.18.${Math.floor(Math.random() * 254) + 1}.1`
    const start = new Date()
    const first = await limiter.enforce(pool, {
      scope, windowMs: 1_000, ip: { value: ip, limit: 1 }, now: start,
    })
    const blocked = await limiter.enforce(pool, {
      scope, windowMs: 1_000, ip: { value: ip, limit: 1 }, now: start,
    })
    expect(first.ok).toBe(true)
    expect(blocked).toMatchObject({ ok: false, status: 429 })
    if (!blocked.ok && blocked.status === 429) {
      expect(blocked.retryAfterMs).toBeGreaterThan(0)
      expect(blocked.retryAfterMs).toBeLessThanOrEqual(1_000)
    }
    const later = await limiter.enforce(pool, {
      scope, windowMs: 1_000, ip: { value: ip, limit: 1 }, now: new Date(start.getTime() + 1_100),
    })
    expect(later.ok).toBe(true)
    await cleanup(pool, [storedKey(scope, 'ip', ip)])
  })
})
