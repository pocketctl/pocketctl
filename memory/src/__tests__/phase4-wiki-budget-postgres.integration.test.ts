import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import { createProviderBudgetStore, withTextProviderBudget } from '../model/provider-budget.js'
import type { ModelJsonResult, TextGenerator } from '../ports/text-generator.js'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createWikiGenerator, generateWikiCandidateOrFallback } from '../wiki/generator.js'
import type { WikiBuildSource } from '../wiki/repository.js'
import type { WikiCandidateDocumentV1 } from '../wiki/types.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const describeWithDatabase = databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1'
  ? describe
  : describe.skip

const snapshotId = '11111111-1111-4111-8111-111111111111'
const commitSha = 'a'.repeat(40)
const sources: WikiBuildSource[] = [{
  sourceToken: 'src_budget', ordinal: 0, sourceKind: 'file', stableKey: 'file:README.md',
  sourceRefId: '22222222-2222-4222-8222-222222222222', sourceSnapshotId: snapshotId,
  commitSha, path: 'README.md', contentHash: 'b'.repeat(64), excerpt: 'safe source',
}]
const skeleton: WikiCandidateDocumentV1 = {
  schema_version: 'wiki-candidate.v1',
  pages: [{ page_key: 'repository-overview', title: 'Repository overview', sections: [{
    section_key: 'source-snapshot', heading: 'Source snapshot', markdown: 'fallback',
    source_tokens: ['src_budget'], coverage: 'partial',
  }] }],
}

function mockProvider(response: ModelJsonResult<unknown>) {
  const request = vi.fn().mockResolvedValue(response)
  const provider: TextGenerator = {
    generateJson: <T>(input: Parameters<TextGenerator['generateJson']>[0]) =>
      request(input) as Promise<ModelJsonResult<T>>,
  }
  return { request, provider }
}

describeWithDatabase('Phase 4 Wiki provider budget', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
  })
  afterAll(async () => pool?.end())
  beforeEach(async () => pool.query(`TRUNCATE memory_provider_budget_reservations`))

  test('reserves worst-case usage before dispatch and rejects a second request without provider retry', async () => {
    const { request, provider } = mockProvider({
      ok: true, value: skeleton,
      usage: { inputTokens: 10, outputTokens: 5, model: 'mock-budget' },
    })
    const budgeted = withTextProviderBudget(provider, createProviderBudgetStore(pool), {
      key: 'wiki-one-shot', maxRequests: 1, maxInputTokens: 1_000_000,
      maxOutputTokens: 1_000, maxOutputTokensPerRequest: 1_000,
    })
    const generator = createWikiGenerator({ provider: budgeted, timeoutMs: 50 })
    const input = { generator, skeleton, sources, coverage: 'partial' as const,
      commitSha, snapshotId, signal: new AbortController().signal }
    const generated = await generateWikiCandidateOrFallback(input)
    expect(generated.source).toBe('model')
    expect(generated.budgetReservationId).toMatch(/^[0-9a-f-]{36}$/)
    const rejected = await generateWikiCandidateOrFallback(input)
    expect(rejected).toMatchObject({ source: 'deterministic', failureCode: 'budget_exceeded' })
    expect(request).toHaveBeenCalledTimes(1)
    const row = await pool.query<{ state: string; reserved_output_tokens: string }>(`
      SELECT state, reserved_output_tokens::text FROM memory_provider_budget_reservations
      WHERE budget_key = 'wiki-one-shot'
    `)
    expect(row.rows).toEqual([{ state: 'settled', reserved_output_tokens: '1000' }])
  })

  test('unknown usage leaves the reservation charged after a simulated crash response', async () => {
    const { request, provider } = mockProvider({
      ok: false, code: 'invalid_usage', retryable: false,
    })
    const budgeted = withTextProviderBudget(provider, createProviderBudgetStore(pool), {
      key: 'wiki-crash', maxRequests: 1, maxInputTokens: 1_000_000,
      maxOutputTokens: 1_000, maxOutputTokensPerRequest: 1_000,
    })
    const generator = createWikiGenerator({ provider: budgeted, timeoutMs: 50 })
    const input = { generator, skeleton, sources, coverage: 'partial' as const,
      commitSha, snapshotId, signal: new AbortController().signal }
    expect(await generateWikiCandidateOrFallback(input)).toMatchObject({
      source: 'deterministic', failureCode: 'invalid_usage',
    })
    expect(await generateWikiCandidateOrFallback(input)).toMatchObject({
      source: 'deterministic', failureCode: 'budget_exceeded',
    })
    expect(request).toHaveBeenCalledTimes(1)
    const states = await pool.query<{ state: string }>(`
      SELECT state FROM memory_provider_budget_reservations WHERE budget_key = 'wiki-crash'
    `)
    expect(states.rows).toEqual([{ state: 'reserved' }])
  })
})
