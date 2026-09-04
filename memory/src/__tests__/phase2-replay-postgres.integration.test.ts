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

const INSTALLATION = '3a3a3a3a-3a3a-43a3-83a3-3a3a3a3a3a3a'
const KEY = { keyId: 'replay-v1', hmacKey: Buffer.alloc(32, 6) }

describeWithDatabase('phase two replay semantics', () => {
  let pool: pg.Pool
  let retrieval: ReturnType<typeof createContextRetrieval>
  let trajectory: ReturnType<typeof createTrajectoryRepository>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    const search = createSearchService({ pool, recallEmbeddingTimeoutMs: 100, cursorSigningKey: 'k' })
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
    const claim = await pool.query<{ claim_id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES (gen_random_uuid(), $1, 'repository_convention', 'installation', 'global', 'replay-1', 'active')
      RETURNING claim_id::text
    `, [INSTALLATION])
    const version = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence, freshness_at)
      VALUES (gen_random_uuid(), $1, $2, 1, 'replay marker statement', 'user_accepted', 0.9, NOW())
      RETURNING version_id::text
    `, [INSTALLATION, claim.rows[0].claim_id])
    await pool.query(`UPDATE knowledge_claims SET current_version_id = $2 WHERE claim_id = $1`,
      [claim.rows[0].claim_id, version.rows[0].version_id])
    await pool.query(`
      INSERT INTO knowledge_evidence
        (evidence_id, installation_id, version_id, episode_id, evidence_kind, excerpt, excerpt_hash, occurred_at, ordinal)
      VALUES (gen_random_uuid(), $1, $2,
              (SELECT episode_id FROM work_episodes LIMIT 1), 'episode', 'x',
              sha256(convert_to('x','utf8')), NOW(), 0)
    `, [INSTALLATION, version.rows[0].version_id])
    await pool.query(`
      INSERT INTO claim_search_documents (installation_id, version_id, document)
      VALUES ($1, $2, 'replay marker statement')
    `, [INSTALLATION, version.rows[0].version_id])
  })

  test('re-supplied query replays deterministically and writes a NEW trajectory', async () => {
    const request = {
      installationId: INSTALLATION, query: 'replay marker statement',
      requestKey: KEY,
    }
    const first = await retrieval.retrieve(request)
    const second = await retrieval.retrieve(request)
    if (first.outcome === 'retrieval_failed') throw new Error('setup failed')
    expect(second.candidates.map(c => c.versionId)).toEqual(first.candidates.map(c => c.versionId))
    // Replay writes a new trajectory; the historical one is never edited.
    expect(second.trajectoryId).not.toBe(first.trajectoryId)
    const trajectories = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM memory_retrieval_trajectories WHERE installation_id = $1`,
      [INSTALLATION])
    expect(trajectories.rows[0].n).toBe(2)
  })

  test('audit trails never reconstruct the query without content input', async () => {
    const result = await retrieval.retrieve({
      installationId: INSTALLATION, query: 'replay marker statement', requestKey: KEY,
    })
    const stored = await trajectory.get(result.trajectoryId)
    expect(stored).not.toBeNull()
    // The trajectory carries HMAC identity and decisions only.
    const stored2 = await pool.query<{ request_hmac: Buffer; request_key_id: string }>(
      `SELECT request_hmac, request_key_id FROM memory_retrieval_trajectories WHERE trajectory_id = $1`,
      [result.trajectoryId])
    expect(stored2.rows[0].request_key_id).toBe('replay-v1')
    expect(stored2.rows[0].request_hmac.length).toBe(32)
  })
})
