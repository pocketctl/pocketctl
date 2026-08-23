import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB, bindUserEmailWithChallenge, createUserWithWelcomeEmail, getUserByEmail, upsertEmailChallenge } from '../db.js'
import { challengeKey, codeHmac } from '../config/verification.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const PEPPER = 'integration-test-pepper-0123456789abcdef'
const VICTIM_EMAIL = 'binding-victim@test.invalid'

describeWithDatabase('verified email binding PostgreSQL integration', () => {
  let pool: pg.Pool
  let userA: number
  let userB: number
  let now: Date

  const bindKey = (userId: number, email = VICTIM_EMAIL) =>
    challengeKey(PEPPER, 'bind_email', email, userId)
  const loginKey = (email = VICTIM_EMAIL) =>
    challengeKey(PEPPER, 'login', email, null)

  const issueBindCode = async (
    code: string,
    userId: number,
    email = VICTIM_EMAIL,
    at = now,
  ) => upsertEmailChallenge(pool, {
    challengeKey: bindKey(userId, email),
    purpose: 'bind_email',
    normalizedEmail: email,
    userId,
    codeHmac: codeHmac(code, PEPPER),
    now: at,
  })

  const bind = async (
    code: string,
    userId: number,
    email = VICTIM_EMAIL,
    at = now,
  ) => bindUserEmailWithChallenge(pool, {
    userId,
    email,
    presentedCodeHmac: codeHmac(code, PEPPER),
    challengeKey: bindKey(userId, email),
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
    await pool.query(`
      TRUNCATE email_verification_challenges, auth_rate_limits
      RESTART IDENTITY CASCADE
    `)
    await pool.query(`DELETE FROM users WHERE email LIKE '%@test.invalid'`)
    const a = await createUserWithWelcomeEmail(pool, 'binder-a@test.invalid', 'test-hash', 'Binder A', 'en')
    const b = await createUserWithWelcomeEmail(pool, 'binder-b@test.invalid', 'test-hash', 'Binder B', 'en')
    userA = a.id
    userB = b.id
    now = new Date('2026-08-17T00:00:00Z')
  })

  test('binding without a challenge leaves the account email untouched', async () => {
    const result = await bind('123456', userA)
    expect(result).toBe('invalid_code')
    const user = await getUserByEmail(pool, 'binder-a@test.invalid')
    expect(user).not.toBeNull()
    expect(user!.email).toBe('binder-a@test.invalid')
  })

  test('a login-purpose code cannot bind an email', async () => {
    await upsertEmailChallenge(pool, {
      challengeKey: loginKey(),
      purpose: 'login',
      normalizedEmail: VICTIM_EMAIL,
      userId: null,
      codeHmac: codeHmac('654321', PEPPER),
      now,
    })
    // The bind key holds no challenge: the login code must not transfer.
    expect(await bind('654321', userA)).toBe('invalid_code')
    expect((await getUserByEmail(pool, 'binder-a@test.invalid'))!.email)
      .toBe('binder-a@test.invalid')
  })

  test("user A's bind code cannot be consumed by user B", async () => {
    await issueBindCode('654321', userA)
    expect(await bind('654321', userB)).toBe('invalid_code')
    expect((await getUserByEmail(pool, 'binder-b@test.invalid'))!.email)
      .toBe('binder-b@test.invalid')
    // The rightful owner can still use it exactly once.
    expect(await bind('654321', userA)).toBe('ok')
    expect((await getUserByEmail(pool, VICTIM_EMAIL))!.id).toBe(userA)
  })

  test('a correct code binds exactly once; replay and wrong codes fail', async () => {
    await issueBindCode('654321', userA)
    expect(await bind('654321', userA)).toBe('ok')
    expect(await bind('654321', userA)).toBe('invalid_code')

    await issueBindCode('777777', userB, 'second-target@test.invalid')
    expect(await bind('000000', userB, 'second-target@test.invalid')).toBe('invalid_code')
    expect((await getUserByEmail(pool, 'binder-b@test.invalid'))!.email)
      .toBe('binder-b@test.invalid')
  })

  test('a raced target email is never stolen: conflict wins over overwrite', async () => {
    await issueBindCode('654321', userA)
    // Between send and verify, user B claims the address through their own
    // verified challenge.
    await issueBindCode('888888', userB)
    expect(await bind('888888', userB)).toBe('ok')
    expect(await bind('654321', userA)).toBe('conflict')
    expect((await getUserByEmail(pool, VICTIM_EMAIL))!.id).toBe(userB)
    expect((await getUserByEmail(pool, 'binder-a@test.invalid'))!.email)
      .toBe('binder-a@test.invalid')
  })

  test('expired and locked bind challenges fail closed', async () => {
    await issueBindCode('654321', userA)
    const expired = new Date(now.getTime() + 6 * 60_000)
    expect(await bind('654321', userA, VICTIM_EMAIL, expired)).toBe('invalid_code')
  })
})
