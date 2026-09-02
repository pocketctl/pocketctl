import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createProviderBudgetStore, withTextProviderBudget } from '../model/provider-budget.js'
import { createOpenAICompatibleTextGenerator } from '../model/openai-compatible-text.js'
import { createSkillGenerator } from '../skills/generator.js'
import type { TextGenerator } from '../ports/text-generator.js'
import type { ResolvedSkillInput } from '../skills/source-resolver.js'
const url = process.env.MEMORY_TEST_DATABASE_URL, db = url && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
db('Phase 5 independent Provider budget', () => {
  let pool: pg.Pool
  beforeAll(async () => { pool = new pg.Pool({ connectionString: url }); await assertMemoryTestDatabase(pool, url!); await applyMemorySchema(pool); await pool.query('TRUNCATE memory_provider_budget_reservations') })
  afterAll(async () => pool?.end())
  test.each([undefined, { prompt_tokens: 2 }, { completion_tokens: 2 }])('missing or partial usage retains the full reservation: %j', async usage => {
    const key = `phase5-missing-usage-${usage === undefined ? 'all' : Object.keys(usage)[0]}`
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }], ...(usage === undefined ? {} : { usage }) }), { status: 200 }))
    const raw = createOpenAICompatibleTextGenerator({ baseUrl: 'https://provider.invalid/v1', model: 'fixture', apiKey: 'fixture', timeoutMs: 100, maxAttempts: 1, maxOutputTokens: 100, fetchImpl })
    const provider = withTextProviderBudget(raw, createProviderBudgetStore(pool), { key, maxRequests: 10, maxInputTokens: 1000000, maxOutputTokens: 100, maxOutputTokensPerRequest: 100 })
    const input = { operation: 'skill_extract' as const, system: 'fixture', document: {}, schema: {}, timeoutMs: 100, signal: new AbortController().signal }
    const result = await provider.generateJson(input)
    expect(result).toMatchObject({ ok: false, code: 'invalid_usage' })
    expect(result).not.toHaveProperty('usage')
    expect((await pool.query(`SELECT state,reserved_output_tokens::text,actual_output_tokens::text,settled_at FROM memory_provider_budget_reservations WHERE budget_key=$1`, [key])).rows)
      .toEqual([{ state: 'reserved', reserved_output_tokens: '100', actual_output_tokens: '0', settled_at: null }])
    expect(await provider.generateJson(input)).toMatchObject({ ok: false, code: 'budget_exceeded', detail: 'text_output_tokens' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  test('reserves before the only Provider attempt and blocks the next request', async () => {
    const value = { schema_version: 'skill-candidate.v1', title: 'x', trigger: 'x', preconditions: ['x'], steps: [{ instruction: 'x', tool: 'search', permissions: ['repository:read'], operation: 'read' }], validation: ['x'], failure_handling: ['x'], rollback: ['x'], source_tokens: ['source-1'] }
    const call = vi.fn().mockResolvedValue({ ok: true, value, usage: { inputTokens: 2, outputTokens: 2, model: 'fixture' } })
    const provider = withTextProviderBudget({ generateJson: call } as TextGenerator, createProviderBudgetStore(pool), { key: 'phase5-skill-only', maxRequests: 1, maxInputTokens: 1000000, maxOutputTokens: 100, maxOutputTokensPerRequest: 100 })
    const source = { installationId: '1', repositoryId: '2', repoSnapshotId: '3', kind: 'episode', episodeId: '4', versionId: null, sessionId: 's', sourceDigest: 'a'.repeat(64), inputDigest: 'b'.repeat(64), ownerKind: 'personal', authorizationEpoch: '1', mode: 'shadow', sources: [{ token: 'source-1', handle: 'e', excerpt: 'test', excerptHash: 'c'.repeat(16), kind: 'episode', eventId: null, artifactId: null, evidenceId: null }] } as ResolvedSkillInput
    const generator = createSkillGenerator({ provider, timeoutMs: 10 })
    expect((await generator.generate(source, new AbortController().signal)).ok).toBe(true)
    expect(await generator.generate(source, new AbortController().signal)).toMatchObject({ ok: false, code: 'budget_exceeded' })
    expect(call).toHaveBeenCalledTimes(1)
    expect((await pool.query(`SELECT state,reserved_output_tokens::text FROM memory_provider_budget_reservations WHERE budget_key='phase5-skill-only'`)).rows).toEqual([{ state: 'settled', reserved_output_tokens: '100' }])
  })
})
