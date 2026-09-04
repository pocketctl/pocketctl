import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createClaimIndexer } from '../retrieval/indexer.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describeWithDatabase('claim index projection (PostgreSQL)', () => {
  let pool: pg.Pool
  let claimId: string
  let versionId: string

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_jobs, claim_search_documents, knowledge_evidence,
               memory_candidates, memory_extraction_runs, knowledge_versions,
               knowledge_claims, work_episodes, source_turns, source_events,
               source_sessions, memory_feature_settings, memory_installations
      RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO memory_feature_settings
        (installation_id, embedding_mode, embedding_consent_fingerprint)
      VALUES ($1, 'enabled', 'adapter-small')
    `, [INSTALLATION])
    const claim = await pool.query<{ claim_id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES (gen_random_uuid(), $1, 'repository_convention', 'installation', 'global',
              'key-1', 'active')
      RETURNING claim_id::text
    `, [INSTALLATION])
    claimId = claim.rows[0].claim_id
    const version = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement,
         structured_content, authority, confidence)
      VALUES (gen_random_uuid(), $1, $2, 1,
              'Vitest files live next to sources',
              '{"keywords":["vitest","colocation"]}'::jsonb, 'user_accepted', 0.9)
      RETURNING version_id::text
    `, [INSTALLATION, claimId])
    versionId = version.rows[0].version_id
    await pool.query(`
      UPDATE knowledge_claims SET current_version_id = $2 WHERE claim_id = $1
    `, [claimId, versionId])
  })

  function indexerWithEmbed(behavior: 'ok' | 'fail') {
    const embed = {
      provider: 'openai-compatible',
      model: 'embed-small',
      dimensions: 2,
      embed: vi.fn(async () => {
        if (behavior === 'fail') throw new Error('provider down')
        return { vectors: [[0.6, 0.8]], model: 'embed-small', tokens: 3, costMicros: 4 }
      }),
    }
    return {
      indexer: createClaimIndexer({ pool, embed, embeddingConsentFingerprint: 'adapter-small' }),
      embed,
    }
  }

  test('enabled mode writes the lexical document and a normalized embedding', async () => {
    const { indexer } = indexerWithEmbed('ok')
    await indexer.indexVersion(INSTALLATION, versionId, new AbortController().signal)
    const doc = await pool.query<{
      document: string; embedding: number[] | null; embedding_status: string; embedding_model: string
    }>(`
      SELECT document, embedding, embedding_status, embedding_model
      FROM claim_search_documents WHERE version_id = $1
    `, [versionId])
    expect(doc.rows[0].document).toContain('Vitest files live next to sources')
    expect(doc.rows[0].document).toContain('vitest')
    expect(doc.rows[0].document).not.toContain('payload')
    expect(doc.rows[0].embedding_status).toBe('ready')
    expect(doc.rows[0].embedding_model).toBe('embed-small')
    const usage = await pool.query<{ operation: string; embedding_tokens: string; cost_micros: string }>(`
      SELECT operation, embedding_tokens::text, cost_micros::text
      FROM memory_usage_outbox WHERE installation_id = $1
    `, [INSTALLATION])
    expect(usage.rows).toEqual([{ operation: 'embedding', embedding_tokens: '3', cost_micros: '4' }])
  })

  test('off mode keeps the lexical projection and disables vectors', async () => {
    await pool.query(`
      UPDATE memory_feature_settings SET embedding_mode = 'off' WHERE installation_id = $1
    `, [INSTALLATION])
    const { indexer, embed } = indexerWithEmbed('ok')
    await indexer.indexVersion(INSTALLATION, versionId, new AbortController().signal)
    expect(embed.embed).not.toHaveBeenCalled()
    const doc = await pool.query<{ embedding_status: string; embedding: number[] | null }>(`
      SELECT embedding_status, embedding FROM claim_search_documents WHERE version_id = $1
    `, [versionId])
    expect(doc.rows[0]).toMatchObject({ embedding_status: 'disabled', embedding: null })
  })

  test('embedding failure marks failed while lexical stays ready', async () => {
    const { indexer } = indexerWithEmbed('fail')
    await expect(indexer.indexVersion(
      INSTALLATION, versionId, new AbortController().signal,
    )).rejects.toThrow('claim_embedding_failed')
    const doc = await pool.query<{ document: string; embedding_status: string }>(`
      SELECT document, embedding_status FROM claim_search_documents WHERE version_id = $1
    `, [versionId])
    expect(doc.rows[0].embedding_status).toBe('failed')
    expect(doc.rows[0].document).toContain('Vitest')
  })

  test('re-indexing the same version is idempotent', async () => {
    const { indexer } = indexerWithEmbed('ok')
    await indexer.indexVersion(INSTALLATION, versionId, new AbortController().signal)
    await indexer.indexVersion(INSTALLATION, versionId, new AbortController().signal)
    const docs = await pool.query(`SELECT COUNT(*)::int AS count FROM claim_search_documents`)
    expect(docs.rows[0].count).toBe(1)
  })

  test('stale versions lose their projection when a new current version is indexed', async () => {
    const { indexer } = indexerWithEmbed('ok')
    await indexer.indexVersion(INSTALLATION, versionId, new AbortController().signal)
    const version2 = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES (gen_random_uuid(), $1, $2, 2, 'Vitest colocates with sources',
              'user_corrected', 0.9)
      RETURNING version_id::text
    `, [INSTALLATION, claimId])
    await pool.query(`
      UPDATE knowledge_claims SET current_version_id = $2 WHERE claim_id = $1
    `, [claimId, version2.rows[0].version_id])
    await indexer.indexVersion(INSTALLATION, version2.rows[0].version_id, new AbortController().signal)
    const docs = await pool.query<{ version_id: string }>(`
      SELECT version_id::text FROM claim_search_documents
    `)
    expect(docs.rows.map(row => row.version_id)).toEqual([version2.rows[0].version_id])
  })

  test('a revoked claim keeps no projection at all', async () => {
    const { indexer } = indexerWithEmbed('ok')
    await indexer.indexVersion(INSTALLATION, versionId, new AbortController().signal)
    await pool.query(`
      UPDATE knowledge_claims SET state = 'revoked' WHERE claim_id = $1
    `, [claimId])
    await indexer.indexVersion(INSTALLATION, versionId, new AbortController().signal)
    const docs = await pool.query(`SELECT COUNT(*)::int AS count FROM claim_search_documents`)
    expect(docs.rows[0].count).toBe(0)
  })

  test('an adapter fingerprint change enqueues exactly one bounded rebuild', async () => {
    const { indexer } = indexerWithEmbed('ok')
    await indexer.indexVersion(INSTALLATION, versionId, new AbortController().signal)
    const enqueued = await indexer.enqueueRebuildIfModelChanged(INSTALLATION, {
      provider: 'other-compatible', model: 'embed-small', dimensions: 2, fingerprint: 'adapter-other',
    })
    expect(enqueued).toBe(true)
    const jobs = await pool.query<{ job_type: string }>(`
      SELECT job_type FROM memory_jobs WHERE job_type = 'rebuild_claim_index'
    `)
    expect(jobs.rows.length).toBe(1)
    const unchanged = await indexer.enqueueRebuildIfModelChanged(INSTALLATION, {
      provider: 'openai-compatible', model: 'embed-small', dimensions: 2, fingerprint: 'adapter-small',
    })
    expect(unchanged).toBe(false)
  })

  test('the rebuild sweep re-enqueues only the active current Version without touching the ledger', async () => {
    const { indexer } = indexerWithEmbed('ok')
    await indexer.indexVersion(INSTALLATION, versionId, new AbortController().signal)
    await pool.query(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES (gen_random_uuid(), $1, $2, 2, 'historical correction', 'user_corrected', 0.9)
    `, [INSTALLATION, claimId])
    await pool.query(`
      INSERT INTO memory_jobs (job_id, installation_id, job_type, idempotency_key, priority, payload)
      VALUES (gen_random_uuid(), $1, 'rebuild_claim_index', 'rebuild:test', 95, '{}'::jsonb)
    `, [INSTALLATION])
    const rebuildJob = await pool.query<{ job_id: string }>(`
      SELECT job_id::text FROM memory_jobs
      WHERE installation_id = $1 AND job_type = 'rebuild_claim_index' LIMIT 1
    `, [INSTALLATION])
    await indexer.handleRebuildClaimIndex({
      job_id: rebuildJob.rows[0].job_id,
      installation_id: INSTALLATION,
      job_type: 'rebuild_claim_index',
      idempotency_key: 'rebuild:test',
      payload: { adapter_fingerprint: 'adapter-v2' },
      attempts: 0,
      claim_epoch: 1,
    })
    const indexJobs = await pool.query<{ count: number; idempotency_key: string }>(`
      SELECT COUNT(*)::int AS count, MIN(idempotency_key) AS idempotency_key
      FROM memory_jobs WHERE job_type = 'index_claim_version'
    `)
    expect(indexJobs.rows[0].count).toBe(1)
    expect(indexJobs.rows[0].idempotency_key).toContain('adapter-v2')
    const versions = await pool.query(`SELECT COUNT(*)::int AS count FROM knowledge_versions`)
    expect(versions.rows[0].count).toBe(2)
  })
})
