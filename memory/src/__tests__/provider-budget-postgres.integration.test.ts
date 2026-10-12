import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { createProviderBudgetStore } from '../model/provider-budget.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const describeWithDatabase = databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1'
  ? describe
  : describe.skip

describeWithDatabase('provider budget reservations (PostgreSQL)', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
  })
  afterAll(async () => pool?.end())
  beforeEach(async () => {
    await pool.query(`TRUNCATE memory_provider_budget_reservations`)
  })

  test('concurrent reservations cannot cross a request cap', async () => {
    const store = createProviderBudgetStore(pool)
    const inputs = Array.from({ length: 4 }, () => store.reserve({
      key: 'concurrent-test', kind: 'text' as const,
      inputTokens: 10, outputTokens: 5,
      maxRequests: 1, maxInputTokens: 100, maxOutputTokens: 100,
    }))
    const results = await Promise.all(inputs)
    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.filter(result => !result.ok)).toHaveLength(3)
  })

  test('daily rejection exposes the next Shanghai budget boundary for deferred work', async () => {
    const input = { key: 'daily-resume', kind: 'text' as const, window: 'daily-asia-shanghai' as const,
      inputTokens: 1, outputTokens: 1, maxRequests: 1, maxInputTokens: 100, maxOutputTokens: 100 }
    const store = createProviderBudgetStore(pool)
    expect((await store.reserve(input)).ok).toBe(true)
    const boundary = (await pool.query("SELECT (date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Shanghai')+interval '1 day') AT TIME ZONE 'Asia/Shanghai' AS next_day")).rows[0].next_day
    await expect(store.reserve(input)).resolves.toMatchObject({ ok: false, dimension: 'text_requests', retryAt: boundary })
    // Move only the isolated fixture reservation into yesterday's window.
    await pool.query("UPDATE memory_provider_budget_reservations SET created_at=$2::timestamptz-interval '1 day 1 second' WHERE budget_key=$1", [input.key, boundary])
    expect((await store.reserve(input)).ok).toBe(true)
  })

  test('lifetime budget exhaustion cannot advertise a daily reset', async () => {
    await expect(createProviderBudgetStore(pool).reserve({ key: 'lifetime-resume', kind: 'text', window: 'lifetime',
      inputTokens: 1, outputTokens: 1, maxRequests: 0, maxInputTokens: 100, maxOutputTokens: 100 }))
      .resolves.toMatchObject({ ok: false, dimension: 'text_requests', retryAt: null })
  })

  test('a stable local request key retains one reservation and refuses an unknown replay result', async () => {
    const store = createProviderBudgetStore(pool)
    const input = { key: 'request-ledger', kind: 'text' as const, requestKey: 'run-1:candidate_extract',
      inputTokens: 1, outputTokens: 1, maxRequests: 10, maxInputTokens: 100, maxOutputTokens: 100 }
    expect((await store.reserve(input)).ok).toBe(true)
    await expect(store.reserve(input)).resolves.toMatchObject({ ok: false, reason: 'provider_result_unknown' })
    expect((await pool.query("SELECT count(*)::int n FROM memory_provider_budget_reservations WHERE budget_key='request-ledger'")).rows[0].n).toBe(1)
  })

  test('an unsettled reservation survives and keeps consuming the cap', async () => {
    const store = createProviderBudgetStore(pool)
    await expect(store.reserve({
      key: 'crash-test', kind: 'text', inputTokens: 10, outputTokens: 5,
      maxRequests: 1, maxInputTokens: 100, maxOutputTokens: 100,
    })).resolves.toMatchObject({ ok: true })
    await expect(store.reserve({
      key: 'crash-test', kind: 'text', inputTokens: 1, outputTokens: 1,
      maxRequests: 1, maxInputTokens: 100, maxOutputTokens: 100,
    })).resolves.toMatchObject({ ok: false, dimension: 'text_requests' })
  })

  test('Shanghai daily text cap ignores yesterday and fences concurrent requests today', async () => {
    const key = 'daily-shanghai-test'
    await pool.query(`
      INSERT INTO memory_provider_budget_reservations
        (reservation_id, budget_key, provider_kind, reserved_input_tokens, reserved_output_tokens, created_at)
      VALUES (gen_random_uuid(), $1, 'text', 10, 5,
        (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') - interval '1 second') AT TIME ZONE 'Asia/Shanghai')
    `, [key])
    const store = createProviderBudgetStore(pool)
    const reserve = () => store.reserve({
      key, kind: 'text', window: 'daily-asia-shanghai',
      inputTokens: 10, outputTokens: 5,
      maxRequests: 2, maxInputTokens: 20, maxOutputTokens: 10,
    })
    const results = await Promise.all(Array.from({ length: 4 }, reserve))
    expect(results.filter(result => result.ok)).toHaveLength(2)
    expect(results.filter(result => !result.ok)).toHaveLength(2)
    expect(await reserve()).toMatchObject({ ok: false, dimension: 'text_requests' })
    expect((await pool.query(`SELECT count(*)::int AS count FROM memory_provider_budget_reservations
      WHERE budget_key = $1`, [key])).rows[0].count).toBe(3)
  })
})
