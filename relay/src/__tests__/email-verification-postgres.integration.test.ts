import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import {
  consumeEmailChallenge,
  hitAuthRateLimit,
  upsertEmailChallenge,
} from '../db.js'
import {
  FAILURE_WINDOW_MS,
  LOCKOUT_MS,
  MAX_VERIFY_ATTEMPTS,
  SEND_COOLDOWN_MS,
  challengeKey,
  codeHmac,
} from '../config/verification.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const PEPPER = 'integration-test-pepper-0123456789abcdef'
const EMAIL = 'challenge-user@test.invalid'

function keyFor(purpose: 'login' | 'bind_email', email = EMAIL, userId: number | null = null): string {
  return challengeKey(PEPPER, purpose, email, userId)
}

describeWithDatabase('email verification challenge PostgreSQL integration', () => {
  let pool: pg.Pool
  let now: Date

  const sendChallenge = async (code: string, at = now, key = keyFor('login')) =>
    upsertEmailChallenge(pool, {
      challengeKey: key,
      purpose: 'login',
      normalizedEmail: EMAIL,
      userId: null,
      codeHmac: codeHmac(code, PEPPER),
      now: at,
    })

  const verifyChallenge = async (code: string, at = now, key = keyFor('login')) =>
    consumeEmailChallenge(pool, {
      challengeKey: key,
      presentedCodeHmac: codeHmac(code, PEPPER),
      now: at,
    })

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    const database = await pool.query<{ database_name: string }>(
      'SELECT current_database() AS database_name',
    )
    const databaseName = database.rows[0]?.database_name ?? ''
    if (!/test/i.test(databaseName)) {
      throw new Error(`Refusing PostgreSQL integration test against non-test database: ${databaseName || '<unknown>'}`)
    }
    await initDB(pool)
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE email_verification_challenges, auth_rate_limits')
    now = new Date('2026-08-17T00:00:00Z')
  })

  test('a correct code verifies exactly once; replay is rejected', async () => {
    await expect(sendChallenge('654321')).resolves.toMatchObject({ status: 'created' })
    await expect(verifyChallenge('654321')).resolves.toBe('ok')
    await expect(verifyChallenge('654321')).resolves.toBe('not_found')
  })

  test('wrong code never succeeds and burns the attempt budget into a lockout', async () => {
    await sendChallenge('654321')
    for (let i = 1; i <= MAX_VERIFY_ATTEMPTS; i++) {
      await expect(verifyChallenge('000000', new Date(now.getTime() + i * 1000)))
        .resolves.toBe('invalid')
    }
    // Budget exhausted: even the correct code is rejected while locked.
    await expect(verifyChallenge('654321', new Date(now.getTime() + 10_000)))
      .resolves.toBe('locked')
  })

  test('resending a code does not reset the failure count', async () => {
    await sendChallenge('111111')
    for (let i = 1; i < MAX_VERIFY_ATTEMPTS; i++) {
      await expect(verifyChallenge('000000', new Date(now.getTime() + i * 1000)))
        .resolves.toBe('invalid')
    }
    const later = new Date(now.getTime() + SEND_COOLDOWN_MS + 1000)
    await expect(sendChallenge('222222', later)).resolves.toMatchObject({ status: 'created' })
    // Fresh code, but the retained budget means this failure is the 5th → lock.
    await expect(verifyChallenge('000000', new Date(later.getTime() + 1000)))
      .resolves.toBe('invalid')
    await expect(verifyChallenge('222222', new Date(later.getTime() + 2000)))
      .resolves.toBe('locked')
  })

  test('lockout expires and a freshly sent code becomes usable again', async () => {
    await sendChallenge('654321')
    for (let i = 1; i <= MAX_VERIFY_ATTEMPTS; i++) {
      await verifyChallenge('000000', new Date(now.getTime() + i * 1000))
    }
    // Lockout starts at the 5th failure (t0+5s), so it outlives LOCKOUT_MS
    // measured from t0 by five seconds.
    const afterLockout = new Date(now.getTime() + LOCKOUT_MS + 10_000)
    // Still locked just before expiry.
    await expect(verifyChallenge('654321', new Date(now.getTime() + LOCKOUT_MS - 1000)))
      .resolves.toBe('locked')
    // TTL is shorter than the lockout, so the old challenge is expired by now…
    await expect(verifyChallenge('654321', afterLockout)).resolves.toBe('expired')
    // …the recovery path is a fresh send (cooldown long passed) + the new code.
    await expect(sendChallenge('999999', afterLockout)).resolves.toMatchObject({ status: 'created' })
    await expect(verifyChallenge('999999', new Date(afterLockout.getTime() + 1000))).resolves.toBe('ok')
  })

  test('expired challenges fail consistently; the row keeps the failure budget', async () => {
    await sendChallenge('654321')
    const expired = new Date(now.getTime() + 5 * 60_000 + 1000)
    await expect(verifyChallenge('654321', expired)).resolves.toBe('expired')
    await expect(verifyChallenge('654321', expired)).resolves.toBe('expired')
  })

  test('challenge scope binds purpose and user id', async () => {
    await sendChallenge('654321', now, keyFor('login'))
    // login code cannot verify under the bind_email purpose key…
    await expect(verifyChallenge('654321', now, keyFor('bind_email'))).resolves.toBe('not_found')
    // …nor under another user's bind key.
    await sendChallenge('654321', now, keyFor('bind_email', EMAIL, 42))
    await expect(verifyChallenge('654321', now, keyFor('bind_email', EMAIL, 43)))
      .resolves.toBe('not_found')
    await expect(verifyChallenge('654321', now, keyFor('bind_email', EMAIL, 42))).resolves.toBe('ok')
  })

  test('concurrent verifies of one correct code allow exactly one success', async () => {
    await sendChallenge('654321')
    const results = await Promise.all(
      Array.from({ length: 4 }, () => verifyChallenge('654321')),
    )
    expect(results.filter((r) => r === 'ok')).toHaveLength(1)
    expect(results.filter((r) => r === 'not_found')).toHaveLength(3)
  })

  test('send cooldown throttles repeated sends on the same challenge', async () => {
    await expect(sendChallenge('111111')).resolves.toMatchObject({ status: 'created' })
    const second = await sendChallenge('222222', new Date(now.getTime() + 30_000))
    expect(second.status).toBe('cooldown')
    expect(second.retryAfterMs).toBeGreaterThan(0)
    const afterCooldown = await sendChallenge('333333', new Date(now.getTime() + SEND_COOLDOWN_MS + 1000))
    expect(afterCooldown.status).toBe('created')
  })

  test('per-key rate limit window counts atomically and resets after the window', async () => {
    const limitKey = 'send:ip:198.51.100.7'
    for (let i = 1; i <= 10; i++) {
      const decision = await hitAuthRateLimit(pool, {
        limitKey,
        limit: 10,
        windowMs: 60 * 60_000,
        now: new Date(now.getTime() + i * 1000),
      })
      expect(decision.allowed).toBe(true)
    }
    const blocked = await hitAuthRateLimit(pool, {
      limitKey,
      limit: 10,
      windowMs: 60 * 60_000,
      now: new Date(now.getTime() + 11_000),
    })
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterMs).toBeGreaterThan(0)

    const afterWindow = await hitAuthRateLimit(pool, {
      limitKey,
      limit: 10,
      windowMs: 60 * 60_000,
      now: new Date(now.getTime() + 60 * 60_000 + 2000),
    })
    expect(afterWindow.allowed).toBe(true)
  })

  test('failure window older than the policy window restarts the budget', async () => {
    await sendChallenge('654321')
    for (let i = 1; i < MAX_VERIFY_ATTEMPTS; i++) {
      await verifyChallenge('000000', new Date(now.getTime() + i * 1000))
    }
    const farLater = new Date(now.getTime() + FAILURE_WINDOW_MS + 60_000)
    // Fresh code after cooldown: the failure budget persists…
    await sendChallenge('654321', farLater)
    // …but the stale window expired, so this failure restarts the budget at 1
    // instead of locking as the 5th attempt.
    await expect(verifyChallenge('000000', new Date(farLater.getTime() + 1000))).resolves.toBe('invalid')
    await expect(verifyChallenge('654321', new Date(farLater.getTime() + 2000))).resolves.toBe('ok')
  })
})
