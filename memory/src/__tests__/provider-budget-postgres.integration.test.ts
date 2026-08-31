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

  test('an unsettled reservation survives and keeps consuming the cap', async () => {
    const store = createProviderBudgetStore(pool)
    await expect(store.reserve({
      key: 'crash-test', kind: 'text', inputTokens: 10, outputTokens: 5,
      maxRequests: 1, maxInputTokens: 100, maxOutputTokens: 100,
    })).resolves.toMatchObject({ ok: true })
    await expect(store.reserve({
      key: 'crash-test', kind: 'text', inputTokens: 1, outputTokens: 1,
      maxRequests: 1, maxInputTokens: 100, maxOutputTokens: 100,
    })).resolves.toEqual({ ok: false, dimension: 'text_requests' })
  })
})
