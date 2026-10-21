import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { createProviderBudgetStore, withTextProviderBudget } from '../model/provider-budget.js'
import { withTimeoutFallback } from '../model/text-fallback.js'
import type { ModelJsonResult, TextGenerator } from '../ports/text-generator.js'
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

  const timeout = { ok: false as const, code: 'http_error' as const, detail: 'timeout', retryable: true }
  const success = { ok: true as const, value: { provider: 'fallback' },
    usage: { inputTokens: 7, outputTokens: 3, model: 'synthetic' } }
  const routeInput = { operation: 'candidate_extract' as const, requestKey: 'extraction:stable-run:candidate_extract',
    system: 'synthetic', document: {}, schema: {}, timeoutMs: 1000, signal: new AbortController().signal }
  const routeLimits = { key: 'timeout-route', window: 'daily-asia-shanghai' as const,
    maxRequests: 2, maxInputTokens: 100_000, maxOutputTokens: 100, maxOutputTokensPerRequest: 10 }

  function route(fallbackResult: ModelJsonResult<unknown> = success,
    limits = routeLimits, primaryResult: ModelJsonResult<unknown> = timeout) {
    const store = createProviderBudgetStore(pool)
    const primary = { generateJson: vi.fn(async () => primaryResult) } as TextGenerator
    const fallback = { generateJson: vi.fn(async () => fallbackResult) } as TextGenerator
    return { primary, fallback, generator: withTimeoutFallback(
      withTextProviderBudget(primary, store, limits), withTextProviderBudget(fallback, store, limits),
    ) }
  }

  test.each([true, false])('composed timeout fallback preserves two durable attempts and replay fence (settled fallback=%s)', async settled => {
    const f = route(settled ? success : timeout)
    const result = await f.generator.generateJson(routeInput)
    expect(result.ok).toBe(settled)
    expect(result).toMatchObject({ timeoutFallback: { primary: {
      code: 'http_error', detail: 'timeout', billingUncertain: true,
    } } })
    const rows = (await pool.query(`SELECT reservation_id, budget_key, state,
      reserved_output_tokens::int, actual_input_tokens::int, actual_output_tokens::int
      FROM memory_provider_budget_reservations ORDER BY created_at`)).rows
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ budget_key: 'timeout-route', state: 'reserved', reserved_output_tokens: 10,
      actual_input_tokens: 0, actual_output_tokens: 0 })
    expect(rows[1]).toMatchObject({ budget_key: 'timeout-route', state: settled ? 'settled' : 'reserved',
      actual_input_tokens: settled ? 7 : 0, actual_output_tokens: settled ? 3 : 0 })
    expect(rows[0].reservation_id).not.toBe(rows[1].reservation_id)
    expect(result.budgetReservationId).toBe(rows[1].reservation_id)
    expect(result.timeoutFallback?.primary.budgetReservationId).toBe(rows[0].reservation_id)
    // Recreate all wrappers and the store as after a process restart.
    const replay = route()
    await expect(replay.generator.generateJson(routeInput)).resolves.toMatchObject({ ok: false, code: 'provider_result_unknown' })
    expect(replay.primary.generateJson).not.toHaveBeenCalled()
    expect(replay.fallback.generateJson).not.toHaveBeenCalled()
    expect((await pool.query('SELECT count(*)::int n FROM memory_provider_budget_reservations')).rows[0].n).toBe(2)
    expect(f.primary.generateJson).toHaveBeenCalledTimes(1)
    expect(f.fallback.generateJson).toHaveBeenCalledTimes(1)
  })

  test.each([
    { maxRequests: 1, maxOutputTokens: 100, dimension: 'text_requests' },
    { maxRequests: 2, maxOutputTokens: 10, dimension: 'text_output_tokens' },
  ])('timeout reservation still consumes the shared $dimension limit before fallback', async cap => {
    const f = route(success, { ...routeLimits, maxRequests: cap.maxRequests, maxOutputTokens: cap.maxOutputTokens })
    await expect(f.generator.generateJson(routeInput)).resolves.toMatchObject({ ok: false, code: 'budget_exceeded',
      detail: cap.dimension, retryAt: expect.any(String), timeoutFallback: { primary: { billingUncertain: true } } })
    expect(f.primary.generateJson).toHaveBeenCalledTimes(1)
    expect(f.fallback.generateJson).not.toHaveBeenCalled()
    const rows = (await pool.query('SELECT budget_key, state FROM memory_provider_budget_reservations')).rows
    expect(rows).toEqual([{ budget_key: 'timeout-route', state: 'reserved' }])
  })

  test.each(['reserved', 'settled'])('an existing primary identity is preserved across deployment (%s)', async state => {
    // Seed using the old direct budget wrapper without the routing layer.
    const primary = { generateJson: vi.fn(async () => state === 'settled' ? success : timeout) } as TextGenerator
    await withTextProviderBudget(primary, createProviderBudgetStore(pool), routeLimits).generateJson(routeInput)
    const f = route()
    await expect(f.generator.generateJson(routeInput)).resolves.toMatchObject({ ok: false, code: 'provider_result_unknown' })
    expect(f.primary.generateJson).not.toHaveBeenCalled()
    expect(f.fallback.generateJson).not.toHaveBeenCalled()
    expect((await pool.query('SELECT state FROM memory_provider_budget_reservations')).rows).toEqual([{ state }])
  })

})
