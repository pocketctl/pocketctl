import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createCandidateDeduper } from '../extraction/deduper.js'
import { createExtractionRepository } from '../extraction/repository.js'
import { createCandidateExtractor } from '../extraction/extractor.js'
import { canonicalPayloadHash } from '../inbox/canonical-json.js'
import type { ModelJsonResult } from '../ports/text-generator.js'
import { tombstoneIdentityHmac } from '../claims/tombstones.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = '55555555-5555-4555-8555-555555555555'
const OTHER_INSTALLATION = '66666666-6666-4666-8666-666666666666'
const TOMBSTONE_KEY = { version: 'v1', key: 't'.repeat(32) }

const MANIFEST = {
  'h0-aaaaaaaa': { kind: 'event' },
  'h1-bbbbbbbb': { kind: 'artifact' },
}
const DOCUMENT = {
  schema_version: 1,
  objective: [{ text: 'Fix the login flake', evidence_handle: 'h0-aaaaaaaa' }],
  final_outcome: { text: 'turn completed: done', evidence_handle: 'h1-bbbbbbbb' },
}

function claimTypeRow() {
  return {
    claim_type: 'repository_convention',
    statement: 'Vitest files live next to sources',
    confidence: 0.9,
    scope_kind: 'installation',
    scope_key: 'global',
    evidence_handles: ['h0-aaaaaaaa'],
  }
}

describeWithDatabase('candidate deduper and validation (PostgreSQL)', () => {
  let pool: pg.Pool
  let deduper: ReturnType<typeof createCandidateDeduper>
  let store: ReturnType<typeof createExtractionRepository>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    deduper = createCandidateDeduper(pool, { tombstoneHmacKeys: [TOMBSTONE_KEY] })
    store = createExtractionRepository(pool)
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_usage_outbox, memory_jobs, memory_candidates, memory_extraction_runs,
               knowledge_tombstones, claim_search_documents, knowledge_evidence,
               knowledge_versions, knowledge_claims,
               work_episodes, source_turns, source_events, source_sessions,
               memory_feature_settings, memory_installations
      RESTART IDENTITY CASCADE
    `)
    for (const installationId of [INSTALLATION, OTHER_INSTALLATION]) {
      await pool.query(`
        INSERT INTO memory_installations
          (installation_id, provider_id, relay_status, local_status, config_version)
        VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
      `, [installationId])
      await pool.query(`
        INSERT INTO memory_feature_settings (installation_id, extraction_mode)
        VALUES ($1, 'enabled')
      `, [installationId])
      await pool.query(`
        INSERT INTO source_sessions
          (installation_id, session_id, first_recorded_at, last_recorded_at)
        VALUES ($1, 'ses-1', NOW(), NOW())
      `, [installationId])
      await pool.query(`
        INSERT INTO source_events
          (source_event_id, installation_id, origin, origin_position, session_id, turn_id,
           event_type, occurred_at, payload, payload_hash)
        VALUES (gen_random_uuid(), $1, 'feed', '1', 'ses-1', 'turn-1', 'user_goal', NOW(),
                $2::jsonb, $3)
      `, [installationId, JSON.stringify({ text: 'goal' }), canonicalPayloadHash({ text: 'goal' })])
      await pool.query(`
        INSERT INTO source_turns (installation_id, turn_id, session_id, state, terminal_at)
        VALUES ($1, 'turn-1', 'ses-1', 'completed', NOW())
      `, [installationId])
      await pool.query(`
        INSERT INTO work_episodes
          (installation_id, episode_id, session_id, turn_id, state, compiler_version,
           source_digest, document, evidence_manifest, document_compiler_version, compiled_at)
        VALUES ($1, gen_random_uuid(), 'ses-1', 'turn-1', 'ready', 'v1',
                'x'::bytea, $2::jsonb, $3::jsonb, 'memory-episode-packet-v1', NOW())
      `, [installationId, JSON.stringify(DOCUMENT), JSON.stringify(MANIFEST)])
    }
  })

  async function seedActiveClaim(installationId: string, statement: string): Promise<string> {
    const claim = await pool.query<{ claim_id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES (gen_random_uuid(), $1, 'repository_convention', 'installation', 'global',
              $2, 'active')
      RETURNING claim_id::text
    `, [installationId, `repository_convention|global|${statement}`.slice(0, 512)])
    const claimId = claim.rows[0].claim_id
    const version = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES (gen_random_uuid(), $1, $2, 1, $3, 'user_accepted', 0.9)
      RETURNING version_id::text
    `, [installationId, claimId, statement])
    await pool.query(`
      UPDATE knowledge_claims SET current_version_id = $2 WHERE claim_id = $1
    `, [claimId, version.rows[0].version_id])
    return claimId
  }

  function extractorWith(generatorResults: ModelJsonResult<unknown>[]) {
    const fn = vi.fn(async (): Promise<ModelJsonResult<unknown>> => {
      const next = generatorResults.shift()
      if (!next) throw new Error('exhausted')
      return next
    })
    return createCandidateExtractor({
      store,
      textGenerator: { generateJson: fn as never },
      provider: 'openai-compatible',
      model: 'extractor-small',
      timeoutMs: 5_000,
      deduper,
    })
  }

  test('exact duplicates point at the active claim in the same installation', async () => {
    const claimId = await seedActiveClaim(INSTALLATION, 'Vitest files live next to sources')
    const family = await deduper.activeFamilyFor({
      installationId: INSTALLATION,
      claimType: 'repository_convention',
      scopeKey: 'global',
      statement: 'Vitest files live next to sources',
    })
    expect(family.exactClaimId).toBe(claimId)
    expect(family.family.length).toBe(1)
  })

  test('case-sensitive identifier changes do not become exact duplicates', async () => {
    await seedActiveClaim(INSTALLATION, 'Call verifyToken before refresh')
    const family = await deduper.activeFamilyFor({
      installationId: INSTALLATION,
      claimType: 'repository_convention',
      scopeKey: 'global',
      statement: 'Call verifytoken before refresh',
    })
    expect(family.exactClaimId).toBeNull()
    expect(family.family.length).toBe(1)
  })

  test('another installation claims are invisible (cross-installation exclusion)', async () => {
    await seedActiveClaim(OTHER_INSTALLATION, 'Vitest files live next to sources')
    const family = await deduper.activeFamilyFor({
      installationId: INSTALLATION,
      claimType: 'repository_convention',
      scopeKey: 'global',
      statement: 'Vitest files live next to sources',
    })
    expect(family.exactClaimId).toBeNull()
    expect(family.family).toEqual([])
  })

  test('the active family is deterministic and is not truncated at 64 claims', async () => {
    for (let index = 0; index < 65; index++) {
      await seedActiveClaim(INSTALLATION, `Convention family member ${index}`)
    }
    const family = await deduper.activeFamilyFor({
      installationId: INSTALLATION,
      claimType: 'repository_convention',
      scopeKey: 'global',
      statement: 'A distinct candidate statement',
    })
    expect(family.family).toHaveLength(65)
    expect(family.family.map(item => item.claimId))
      .toEqual([...family.family.map(item => item.claimId)].sort())
  })

  test('tombstoned keys are visible to the validator', async () => {
    await pool.query(`
      INSERT INTO knowledge_tombstones (installation_id, key_id, identity_hmac, reason)
      VALUES ($1, $2, $3, 'privacy_delete')
    `, [INSTALLATION, TOMBSTONE_KEY.version, tombstoneIdentityHmac('dead-key-1', TOMBSTONE_KEY.key)])
    const tombstones = await deduper.tombstonedKeys({
      installationId: INSTALLATION,
      candidateKeys: ['dead-key-1', 'live-key-2'],
    })
    expect(tombstones.has('dead-key-1')).toBe(true)
    expect(tombstones.has('live-key-2')).toBe(false)
  })

  test('enabled-mode extraction persists validated, duplicate and conflict verdicts', async () => {
    await seedActiveClaim(INSTALLATION, 'Vitest files live next to sources')
    const extractor = extractorWith([{
      ok: true,
      value: {
        candidates: [
          claimTypeRow(),
          {
            ...claimTypeRow(),
            claim_type: 'work_method',
            statement: 'Prefer small pure functions during refactors',
          },
          {
            ...claimTypeRow(),
            statement: 'Vitest test files live next to sources and cover every module',
          },
          {
            ...claimTypeRow(),
            evidence_handles: ['h0-aaaaaaaa'],
            scope_kind: 'repository',
            scope_key: 'repo-x',
          },
        ],
      },
      usage: { inputTokens: 5, outputTokens: 5, model: 'm' },
    }])
    const outcome = await extractor.extract({
      installationId: INSTALLATION, turnId: 'turn-1', signal: new AbortController().signal,
    })
    expect(outcome.kind).toBe('succeeded')

    const candidates = await pool.query<{
      status: string; validation: Record<string, unknown>; claim_type: string
    }>(`
      SELECT status, validation, claim_type FROM memory_candidates ORDER BY ordinal
    `)
    expect(candidates.rows.length).toBe(4)
    expect(candidates.rows.some(row => row.status === 'validated')).toBe(true)
    expect(candidates.rows.some(row => row.status === 'duplicate')).toBe(true)
    expect(candidates.rows.some(row => row.status === 'conflict')).toBe(true)
    expect(candidates.rows.some(row => row.status === 'rejected_by_validator')).toBe(true)
    // Verdict details carry bounded codes only.
    for (const row of candidates.rows) {
      expect(JSON.stringify(row.validation).length).toBeLessThan(512)
    }
  })

  test('never touches the active claim while classifying', async () => {
    const claimId = await seedActiveClaim(INSTALLATION, 'Vitest files live next to sources')
    const extractor = extractorWith([{
      ok: true,
      value: { candidates: [claimTypeRow()] },
      usage: { inputTokens: 1, outputTokens: 1, model: 'm' },
    }])
    await extractor.extract({
      installationId: INSTALLATION, turnId: 'turn-1', signal: new AbortController().signal,
    })
    const claim = await pool.query<{ state: string; revision: string; statement: string }>(`
      SELECT state, revision::text, statement FROM knowledge_claims c
      JOIN knowledge_versions v ON v.version_id = c.current_version_id
      WHERE c.claim_id = $1
    `, [claimId])
    expect(claim.rows[0]).toMatchObject({ state: 'active', revision: '1', statement: 'Vitest files live next to sources' })
  })
})
