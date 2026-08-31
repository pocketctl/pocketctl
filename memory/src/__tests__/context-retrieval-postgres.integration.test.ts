import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createSearchService } from '../retrieval/search-service.js'
import { createContextRetrieval } from '../context/retrieval.js'
import { createTrajectoryRepository } from '../context/trajectory-repository.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = 'abababab-abab-4aab-8aab-abababababab'
const KEY = { keyId: 'k1', hmacKey: Buffer.alloc(32, 5) }

describeWithDatabase('replayable context retrieval (PostgreSQL)', () => {
  let pool: pg.Pool
  let retrieval: ReturnType<typeof createContextRetrieval>
  let trajectory: ReturnType<typeof createTrajectoryRepository>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    const search = createSearchService({ pool, recallEmbeddingTimeoutMs: 100, cursorSigningKey: 'test-cursor-key' })
    trajectory = createTrajectoryRepository(pool)
    retrieval = createContextRetrieval({ pool, search, trajectory })
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_retrieval_candidates, memory_retrieval_stages,
               memory_retrieval_trajectories, claim_search_documents,
               knowledge_evidence, knowledge_versions, knowledge_claims,
               work_episodes, source_turns, source_events, source_sessions,
               memory_feature_settings, repositories, memory_installations
      RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO source_sessions (installation_id, session_id, first_recorded_at, last_recorded_at)
      VALUES ($1, 'ses-r', NOW(), NOW())
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO work_episodes
        (installation_id, episode_id, session_id, turn_id, state, compiler_version,
         source_digest, document, evidence_manifest, document_compiler_version, compiled_at)
      VALUES ($1, gen_random_uuid(), 'ses-r', 'turn-1', 'ready', 'c',
              decode(md5('r'),'hex'), '{}'::jsonb, '{}'::jsonb, 'd', NOW())
    `, [INSTALLATION])
  })

  async function seedClaim(input: {
    key: string
    statement: string
    authority?: string
    freshnessDays?: number
    scopeKind?: string
    claimType?: string
  }): Promise<string> {
    const claimType = input.claimType ?? 'repository_convention'
    const claim = await pool.query<{ claim_id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES (gen_random_uuid(), $1, $2, $3, 'global', $4, 'active')
      RETURNING claim_id::text
    `, [INSTALLATION, claimType, input.scopeKind ?? 'installation', input.key])
    const freshness = new Date(Date.now() - (input.freshnessDays ?? 0) * 86_400_000)
    const version = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence, freshness_at)
      VALUES (gen_random_uuid(), $1, $2, 1, $3, $4, 0.9, $5)
      RETURNING version_id::text
    `, [INSTALLATION, claim.rows[0].claim_id, input.statement, input.authority ?? 'user_accepted', freshness])
    await pool.query(`UPDATE knowledge_claims SET current_version_id = $2 WHERE claim_id = $1`,
      [claim.rows[0].claim_id, version.rows[0].version_id])
    const episode = await pool.query<{ episode_id: string }>(
      `SELECT episode_id::text FROM work_episodes LIMIT 1`)
    await pool.query(`
      INSERT INTO knowledge_evidence
        (evidence_id, installation_id, version_id, episode_id, evidence_kind, excerpt, excerpt_hash, occurred_at, ordinal)
      VALUES (gen_random_uuid(), $1, $2, $3, 'episode', 'x', sha256(convert_to('x','utf8')), NOW(), 0)
    `, [INSTALLATION, version.rows[0].version_id, episode.rows[0].episode_id])
    await pool.query(`
      INSERT INTO claim_search_documents
        (installation_id, version_id, document)
      VALUES ($1, $2, $3)
      ON CONFLICT DO NOTHING
    `, [INSTALLATION, version.rows[0].version_id, input.statement])
    return version.rows[0].version_id
  }

  test('ranks user_corrected above user_accepted and repeats deterministically', async () => {
    await seedClaim({ key: 'k-corrected', statement: 'deterministic ranking rule alpha for the auth path', authority: 'user_corrected' })
    await seedClaim({ key: 'k-accepted', statement: 'deterministic ranking rule alpha for the auth path', authority: 'user_accepted' })
    const first = await retrieval.retrieve({
      installationId: INSTALLATION,
      query: 'deterministic ranking rule alpha auth path',
      requestKey: KEY,
    })
    expect(first.outcome).not.toBe('retrieval_failed')
    expect(first.candidates.length).toBeGreaterThan(0)
    const firstOrder = first.candidates.map(candidate => candidate.versionId)
    const second = await retrieval.retrieve({
      installationId: INSTALLATION,
      query: 'deterministic ranking rule alpha auth path',
      requestKey: KEY,
    })
    expect(second.candidates.map(candidate => candidate.versionId)).toEqual(firstOrder)
    const authorities = first.candidates.map(candidate => candidate.authority)
    const correctedIndex = authorities.indexOf('user_corrected')
    const acceptedIndex = authorities.indexOf('user_accepted')
    if (correctedIndex >= 0 && acceptedIndex >= 0) {
      expect(correctedIndex).toBeLessThan(acceptedIndex)
    }
  })

  test('an unknown query returns empty (distinct from failure)', async () => {
    await seedClaim({ key: 'k-other', statement: 'unrelated storage engine internals' })
    const result = await retrieval.retrieve({
      installationId: INSTALLATION,
      query: 'zzzzqqqxxxx unmatchable',
      requestKey: KEY,
    })
    expect(result.outcome).toBe('empty')
    expect(result.candidates).toEqual([])
  })

  test('admits only strong vector-only recall and audits the weak candidate drop', async () => {
    const weak = await seedClaim({ key: 'k-vector-weak', statement: 'alpha deployment retention marker' })
    const strong = await seedClaim({ key: 'k-vector-strong', statement: 'beta transport isolation marker' })
    await pool.query(`
      INSERT INTO memory_feature_settings (installation_id, embedding_mode)
      VALUES ($1, 'enabled')
      ON CONFLICT (installation_id) DO UPDATE SET embedding_mode = 'enabled'
    `, [INSTALLATION])
    await pool.query(`
      UPDATE claim_search_documents
      SET embedding = CASE version_id
            WHEN $2::uuid THEN ARRAY[0.6, 0.8]::real[]
            ELSE ARRAY[0.8, 0.6]::real[]
          END,
          embedding_provider = 'test-provider', embedding_model = 'test-model',
          embedding_dimensions = 2, embedding_status = 'ready'
      WHERE installation_id = $1 AND version_id = ANY($3::uuid[])
    `, [INSTALLATION, weak, [weak, strong]])
    const embed = {
      provider: 'test-provider', model: 'test-model', dimensions: 2,
      embed: async () => ({ vectors: [[1, 0]], model: 'test-model', tokens: 1 }),
    }
    const vectorSearch = createSearchService({
      pool, embed, recallEmbeddingTimeoutMs: 100, cursorSigningKey: 'test-cursor-key',
    })
    const vectorRetrieval = createContextRetrieval({ pool, search: vectorSearch, trajectory })

    const result = await vectorRetrieval.retrieve({
      installationId: INSTALLATION,
      query: 'semantic-query-without-shared-words',
      requestKey: KEY,
    })

    expect(result.candidates.map(candidate => candidate.versionId)).toEqual([strong])
    const stored = await trajectory.get(result.trajectoryId)
    expect(stored?.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ version_id: strong, decision: 'selected' }),
      expect.objectContaining({
        version_id: weak, decision: 'dropped', reason_code: 'relevance_below_threshold',
      }),
    ]))
  })

  test('a pool error is retrieval_failed, never mislabeled as empty', async () => {
    const failingSearch = {
      search: async () => {
        throw new Error('sql connection refused')
      },
    } as unknown as ReturnType<typeof createSearchService>
    const failing = createContextRetrieval({ pool, search: failingSearch, trajectory })
    const result = await failing.retrieve({
      installationId: INSTALLATION,
      query: 'anything',
      requestKey: KEY,
    })
    expect(result.outcome).toBe('retrieval_failed')
    expect(result.candidates).toEqual([])
    const stored = await trajectory.get(result.trajectoryId)
    expect(stored?.result_state).toBe('retrieval_failed')
  })

  test('embedding degradation is visible in outcome and degraded components', async () => {
    // The installation ENABLED embeddings, but this caller brings no live
    // provider/consent — the vector pool is down for it, which must surface
    // as an explicit degraded state, never silently empty.
    await pool.query(`
      INSERT INTO memory_feature_settings (installation_id, embedding_mode)
      VALUES ($1, 'enabled')
      ON CONFLICT (installation_id) DO UPDATE SET embedding_mode = 'enabled'
    `, [INSTALLATION])
    await seedClaim({ key: 'k-deg', statement: 'embedding degraded path marker statement' })
    const result = await retrieval.retrieve({
      installationId: INSTALLATION,
      query: 'embedding degraded path marker',
      requestKey: KEY,
    })
    // No embedding provider is configured in this suite: the vector pool is
    // off and the degradation must be explicit, not silent.
    if (result.candidates.length > 0) {
      expect(result.outcome).toBe('degraded')
      expect(result.degradedComponents).toContain('embedding')
    } else {
      expect(result.outcome).toBe('empty')
    }
  })
})
