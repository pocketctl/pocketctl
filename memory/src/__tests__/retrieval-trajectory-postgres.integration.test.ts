import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
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

const INSTALLATION = 'bcbcbcbc-bcbc-4bbc-8bbc-bcbcbcbcbcbc'
const SECRET_QUERY = 'secretive query text that must never persist'
const KEY = { keyId: 'ring-v1', hmacKey: Buffer.alloc(32, 9) }

describeWithDatabase('retrieval trajectory audit (PostgreSQL)', () => {
  let pool: pg.Pool
  let trajectory: ReturnType<typeof createTrajectoryRepository>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    trajectory = createTrajectoryRepository(pool)
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
               repositories, memory_installations
      RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO source_sessions (installation_id, session_id, first_recorded_at, last_recorded_at)
      VALUES ($1, 'ses-t', NOW(), NOW())
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO work_episodes
        (installation_id, episode_id, session_id, turn_id, state, compiler_version,
         source_digest, document, evidence_manifest, document_compiler_version, compiled_at)
      VALUES ($1, gen_random_uuid(), 'ses-t', 'turn-1', 'ready', 'c',
              decode(md5('t'),'hex'), '{}'::jsonb, '{}'::jsonb, 'd', NOW())
    `, [INSTALLATION])
    const claim = await pool.query<{ claim_id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES (gen_random_uuid(), $1, 'repository_convention', 'installation', 'global', 'traj-1', 'active')
      RETURNING claim_id::text
    `, [INSTALLATION])
    const version = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence, freshness_at)
      VALUES (gen_random_uuid(), $1, $2, 1, 'trajectory marker statement', 'user_accepted', 0.9, NOW())
      RETURNING version_id::text
    `, [INSTALLATION, claim.rows[0].claim_id])
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
      INSERT INTO claim_search_documents (installation_id, version_id, document)
      VALUES ($1, $2, 'trajectory marker statement')
    `, [INSTALLATION, version.rows[0].version_id])
  })

  test('records stages and candidate decisions without ever storing query text', async () => {
    const search = createSearchService({ pool, recallEmbeddingTimeoutMs: 100, cursorSigningKey: 'k' })
    const retrieval = createContextRetrieval({ pool, search, trajectory })
    const result = await retrieval.retrieve({
      installationId: INSTALLATION,
      query: SECRET_QUERY,
      requestKey: KEY,
    })
    expect(result.outcome).not.toBe('retrieval_failed')

    const stored = await trajectory.get(result.trajectoryId)
    expect(stored).not.toBeNull()
    expect(stored!.stages.length).toBeGreaterThan(0)
    expect(stored!.stages[0]).toMatchObject({ stage: 'pools' })
    if (result.candidates.length > 0) {
      expect(stored!.candidates.some(candidate => candidate.decision === 'selected')).toBe(true)
    }

    // Content-free audit: the query text (and any substring of it) never
    // lands in any trajectory column.
    for (const table of ['memory_retrieval_trajectories', 'memory_retrieval_stages', 'memory_retrieval_candidates'] as const) {
      const leaked = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ${table}
         WHERE ${table}::text LIKE '%' || $1 || '%'`,
        [SECRET_QUERY],
      )
      expect(Number(leaked.rows[0].n)).toBe(0)
    }
  })

  test('records a full recall pool with bounded database round trips and exact audit fields', async () => {
    const seeded = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence, freshness_at)
      SELECT gen_random_uuid(), $1, claim_id, n + 1, 'audit candidate', 'user_accepted', 1, NOW()
      FROM knowledge_claims CROSS JOIN generate_series(1, 250) n
      WHERE installation_id = $1 RETURNING version_id::text
    `, [INSTALLATION])
    const candidates = seeded.rows.map((row, index) => ({
      versionId: row.version_id, metadataRank: index + 1, lexicalRank: index % 2 ? null : index + 2,
      vectorRank: null, fusedScore: 0.5, authorityScore: 0.25, freshnessScore: 0.75,
      scopeScore: 0.5, loadoutScore: 0, estimatedTokens: index + 10,
      decision: index < 24 ? 'selected' as const : 'dropped' as const,
      reasonCode: index < 24 ? 'ranked' : 'beyond_limit', finalOrdinal: index < 24 ? index : null,
    }))
    const querySpy = vi.spyOn(pg.Client.prototype, 'query')
    let id: string
    let roundTrips: number
    try {
      id = await trajectory.record({ installationId: INSTALLATION, requestKey: KEY, query: SECRET_QUERY,
        repositoryId: null, branch: null, rankingPolicyVersionId: null, backendPlan: {},
        resultState: 'completed', degradedComponents: [],
        stages: [{ stage: 'pools', outcome: 'ok', candidateCount: 250, durationMs: 15 }], candidates })
      roundTrips = querySpy.mock.calls.length
    } finally { querySpy.mockRestore() }
    const stored = await pool.query(`SELECT version_id::text, metadata_rank, lexical_rank, vector_rank,
      fused_score, authority_score, freshness_score, scope_score, loadout_score, estimated_tokens,
      decision, reason_code, final_ordinal FROM memory_retrieval_candidates WHERE trajectory_id=$1 ORDER BY metadata_rank`, [id])
    expect(stored.rows).toEqual(candidates.map(c => ({ version_id: c.versionId, metadata_rank: c.metadataRank,
      lexical_rank: c.lexicalRank, vector_rank: c.vectorRank, fused_score: c.fusedScore,
      authority_score: c.authorityScore, freshness_score: c.freshnessScore, scope_score: c.scopeScore,
      loadout_score: c.loadoutScore, estimated_tokens: c.estimatedTokens, decision: c.decision,
      reason_code: c.reasonCode, final_ordinal: c.finalOrdinal })))
    // Audit size must not create one network round trip per candidate.
    expect(roundTrips).toBeLessThanOrEqual(6)
  })

  test('a rejected candidate rolls back the trajectory, candidates, and retrieval usage', async () => {
    const versionId = (await pool.query('SELECT version_id::text FROM knowledge_versions LIMIT 1')).rows[0].version_id
    const candidate = { versionId, metadataRank: 1, lexicalRank: null, vectorRank: null,
      fusedScore: 0.5, authorityScore: 0, freshnessScore: 1, scopeScore: 0, loadoutScore: 0,
      estimatedTokens: 5, decision: 'selected' as const, reasonCode: 'ranked', finalOrdinal: 0 }
    await expect(trajectory.record({ installationId: INSTALLATION, requestKey: KEY, query: SECRET_QUERY,
      repositoryId: null, branch: null, rankingPolicyVersionId: null, backendPlan: {},
      resultState: 'completed', degradedComponents: [],
      stages: [{ stage: 'pools', outcome: 'ok', candidateCount: 2, durationMs: 1 }],
      candidates: [candidate, candidate], retrievedVersionIds: [versionId] })).rejects.toMatchObject({ code: '23505' })
    for (const table of ['memory_retrieval_trajectories', 'memory_retrieval_stages', 'memory_retrieval_candidates', 'memory_claim_usage']) {
      expect((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count).toBe(0)
    }
  })

  test('request identity is a keyed HMAC under a versioned key id, not a plain digest', async () => {
    const identity = trajectory.requestHmac({ ...KEY, query: 'q' })
    const identityB = trajectory.requestHmac({ ...KEY, query: 'q' })
    expect(identity.hmac.equals(identityB.hmac)).toBe(true)
    expect(identity.keyId).toBe('ring-v1')
    // A different key id yields a different HMAC for the same text.
    const otherKey = trajectory.requestHmac({ keyId: 'ring-v2', hmacKey: Buffer.alloc(32, 1), query: 'q' })
    expect(otherKey.hmac.equals(identity.hmac)).toBe(false)
  })
})
