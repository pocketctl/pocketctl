import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createClaimIndexer } from '../retrieval/indexer.js'
import { createClaimRepository } from '../claims/repository.js'
import { createLifecycleService } from '../claims/lifecycle-service.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = 'bbbbbbb3-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const EVIDENCE_HANDLE = 'h0-aaaaaaaa'

describeWithDatabase('phase one rebuild behavior (PostgreSQL)', () => {
  let pool: pg.Pool
  let indexer: ReturnType<typeof createClaimIndexer>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    indexer = createClaimIndexer({ pool })
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_jobs, claim_search_documents, knowledge_evidence,
               memory_candidates, memory_extraction_runs, knowledge_versions,
               knowledge_claims, knowledge_tombstones, work_episodes,
               source_turns, source_events, source_sessions,
               memory_feature_settings, memory_installations
      RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO memory_feature_settings (installation_id) VALUES ($1)
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO source_sessions
        (installation_id, session_id, first_recorded_at, last_recorded_at)
      VALUES ($1, 'ses-1', NOW(), NOW())
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO source_turns (installation_id, turn_id, session_id, state, terminal_at)
      VALUES ($1, 'turn-1', 'ses-1', 'completed', NOW())
    `, [INSTALLATION])
    const episode = await pool.query<{ episode_id: string }>(`
      INSERT INTO work_episodes
        (installation_id, episode_id, session_id, turn_id, state, compiler_version,
         document, evidence_manifest, compiled_at)
      VALUES ($1, gen_random_uuid(), 'ses-1', 'turn-1', 'ready', 'v1',
              $2::jsonb, $3::jsonb, NOW())
      RETURNING episode_id::text
    `, [INSTALLATION,
      JSON.stringify({ final_outcome: { text: 'Index rebuild never mutates the ledger', evidence_handle: EVIDENCE_HANDLE } }),
      JSON.stringify({ [EVIDENCE_HANDLE]: { kind: 'episode' } })])
    const run = await pool.query<{ run_id: string }>(`
      INSERT INTO memory_extraction_runs
        (run_id, installation_id, episode_id, episode_source_digest, extractor_version,
         prompt_version, model_config_hash, input_digest, mode, state, provider, model)
      VALUES (gen_random_uuid(), $1, $2, 'x'::bytea, 'e', 'p', 'x'::bytea, 'x'::bytea,
              'enabled', 'succeeded', 'openai-compatible', 'm')
      RETURNING run_id::text
    `, [INSTALLATION, episode.rows[0].episode_id])
    const candidate = await pool.query<{ candidate_id: string }>(`
      INSERT INTO memory_candidates
        (candidate_id, installation_id, run_id, episode_id, ordinal, claim_type, statement,
         normalized_key, scope_kind, scope_key, confidence, freshness_at, evidence_handles, status)
      VALUES (gen_random_uuid(), $1, $2, $3, 0, 'work_method',
              'Index rebuild never mutates the ledger', 'key-rebuild-1',
              'installation', 'global', 0.9, NOW(), $4::jsonb, 'validated')
      RETURNING candidate_id::text
    `, [INSTALLATION, run.rows[0].run_id, episode.rows[0].episode_id,
      JSON.stringify([EVIDENCE_HANDLE])])
    const claims = createClaimRepository(pool)
    const accepted = await claims.acceptCandidate({
      installationId: INSTALLATION,
      candidateId: candidate.rows[0].candidate_id,
      expectedRevision: 1,
    })
    if (!accepted.ok) throw new Error('fixture accept failed')
    await indexer.indexVersion(INSTALLATION, accepted.versionId, new AbortController().signal)
  })

  test('reindex reads only active current versions with evidence', async () => {
    const documents = await pool.query<{ document: string }>(`
      SELECT document FROM claim_search_documents WHERE installation_id = $1
    `, [INSTALLATION])
    expect(documents.rows.length).toBe(1)
    expect(documents.rows[0].document).toContain('Index rebuild never mutates the ledger')
  })

  test('revoking then rebuilding leaves no projection and keeps the version history', async () => {
    const claim = await pool.query<{ claim_id: string }>(`
      SELECT claim_id::text FROM knowledge_claims WHERE installation_id = $1
    `, [INSTALLATION])
    const lifecycle = createLifecycleService(pool, createClaimRepository(pool))
    const revoked = await lifecycle.revokeClaim({ installationId: INSTALLATION, claimId: claim.rows[0].claim_id })
    expect(revoked.ok).toBe(true)
    const version = await pool.query<{ version_id: string }>(`
      SELECT version_id::text FROM knowledge_versions WHERE installation_id = $1
    `, [INSTALLATION])
    await indexer.indexVersion(INSTALLATION, version.rows[0].version_id, new AbortController().signal)
    const documents = await pool.query(`SELECT COUNT(*)::int AS count FROM claim_search_documents WHERE installation_id = $1`, [INSTALLATION])
    expect(documents.rows[0].count).toBe(0)
    const versions = await pool.query(`SELECT COUNT(*)::int AS count FROM knowledge_versions WHERE installation_id = $1`, [INSTALLATION])
    expect(versions.rows[0].count).toBe(1)
  })

  test('the rebuild sweep enqueues one job per active current version', async () => {
    await pool.query(`
      INSERT INTO memory_jobs (job_id, installation_id, job_type, idempotency_key, priority, payload)
      VALUES (gen_random_uuid(), $1, 'rebuild_claim_index', 'rebuild:test', 95, '{}'::jsonb)
    `, [INSTALLATION])
    const job = await pool.query<{ job_id: string }>(`
      SELECT job_id::text FROM memory_jobs
      WHERE installation_id = $1 AND job_type = 'rebuild_claim_index' LIMIT 1
    `, [INSTALLATION])
    await indexer.handleRebuildClaimIndex({
      job_id: job.rows[0].job_id,
      installation_id: INSTALLATION,
      job_type: 'rebuild_claim_index',
      idempotency_key: 'rebuild:test',
      payload: {},
      attempts: 0,
      claim_epoch: 1,
    })
    const jobs = await pool.query(`SELECT COUNT(*)::int AS count FROM memory_jobs WHERE installation_id = $1 AND job_type = 'index_claim_version'`, [INSTALLATION])
    expect(jobs.rows[0].count).toBe(1)
    const ledger = await pool.query(`SELECT COUNT(*)::int AS count FROM knowledge_claims WHERE installation_id = $1`, [INSTALLATION])
    expect(ledger.rows[0].count).toBe(1)
  })
})
