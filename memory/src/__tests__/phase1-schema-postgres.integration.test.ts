import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { JOB_PRIORITIES } from '../jobs/types.js'
import { createJobRepository } from '../jobs/repository.js'
import { createInstallationRegistry } from '../installations/repository.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_INSTALLATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

let chainCounter = 0

const CLAIM_TYPES = [
  'architecture_decision', 'repository_convention', 'bug_root_cause',
  'rejected_hypothesis', 'test_invariant', 'implementation_map',
  'operational_runbook', 'work_method', 'reusable_skill_candidate',
] as const

async function seedInstallation(pool: pg.Pool, installationId: string) {
  await pool.query(`
    INSERT INTO memory_installations
      (installation_id, provider_id, relay_status, local_status, config_version)
    VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
    ON CONFLICT (installation_id) DO NOTHING
  `, [installationId])
}

async function seedEpisode(pool: pg.Pool, installationId: string) {
  await pool.query(`
    INSERT INTO source_sessions
      (installation_id, session_id, first_recorded_at, last_recorded_at)
    VALUES ($1, 'ses-1', NOW(), NOW())
    ON CONFLICT (installation_id, session_id) DO NOTHING
  `, [installationId])
  await pool.query(`
    INSERT INTO source_turns (installation_id, turn_id, session_id, state, terminal_at)
    VALUES ($1, 'turn-1', 'ses-1', 'completed', NOW())
    ON CONFLICT (installation_id, turn_id) DO NOTHING
  `, [installationId])
  await pool.query(`
    INSERT INTO work_episodes
      (installation_id, episode_id, session_id, turn_id, state, compiler_version)
    VALUES ($1, gen_random_uuid(), 'ses-1', 'turn-1', 'ready', 'v1')
    ON CONFLICT (installation_id, turn_id) DO NOTHING
  `, [installationId])
}

/** Insert a minimal accepted claim chain (run + candidate + claim + version). */
async function seedClaimChain(pool: pg.Pool, installationId: string, episodeId: string) {
  chainCounter += 1
  const run = await pool.query<{ run_id: string }>(`
    INSERT INTO memory_extraction_runs
      (run_id, installation_id, episode_id, episode_source_digest, extractor_version,
       prompt_version, model_config_hash, input_digest, mode, state, provider, model)
    VALUES (gen_random_uuid(), $1, $2, 'x'::bytea, $3, 'p-1',
            'x'::bytea, 'x'::bytea, 'enabled', 'succeeded', 'openai-compatible', 'm-1')
    RETURNING run_id::text
  `, [installationId, episodeId, `ext-${chainCounter}`])
  const runId = run.rows[0].run_id
  const candidate = await pool.query<{ candidate_id: string }>(`
    INSERT INTO memory_candidates
      (candidate_id, installation_id, run_id, episode_id, ordinal, claim_type,
       statement, normalized_key, scope_kind, scope_key, confidence, freshness_at, status)
    VALUES (gen_random_uuid(), $1, $2, $3, 0, 'repository_convention',
            'Use vitest for unit tests', 'repo-convention-1', 'installation', 'global',
            0.9, NOW(), 'validated')
    RETURNING candidate_id::text
  `, [installationId, runId, episodeId])
  const candidateId = candidate.rows[0].candidate_id
  const claim = await pool.query<{ claim_id: string }>(`
    INSERT INTO knowledge_claims
      (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
    VALUES (gen_random_uuid(), $1, 'repository_convention', 'installation', 'global',
            'repo-convention-1', 'active')
    RETURNING claim_id::text
  `, [installationId])
  const claimId = claim.rows[0].claim_id
  const version = await pool.query<{ version_id: string }>(`
    INSERT INTO knowledge_versions
      (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
    VALUES (gen_random_uuid(), $1, $2, 1, 'Use vitest for unit tests', 'user_accepted', 0.9)
    RETURNING version_id::text
  `, [installationId, claimId])
  const versionId = version.rows[0].version_id
  await pool.query(`UPDATE knowledge_claims SET current_version_id = $2 WHERE claim_id = $1`, [claimId, versionId])
  await pool.query(`
    INSERT INTO knowledge_evidence
      (evidence_id, installation_id, version_id, episode_id, evidence_kind,
       excerpt, excerpt_hash, occurred_at, ordinal)
    VALUES (gen_random_uuid(), $1, $2, $3, 'episode', 'terminal turn completed',
            'x'::bytea, NOW(), 0)
  `, [installationId, versionId, episodeId])
  return { runId, candidateId, claimId, versionId, episodeId }
}

async function episodeIdFor(pool: pg.Pool, installationId: string): Promise<string> {
  const row = await pool.query<{ episode_id: string }>(`
    SELECT episode_id::text FROM work_episodes WHERE installation_id = $1 LIMIT 1
  `, [installationId])
  return row.rows[0].episode_id
}

async function expectViolation(pool: pg.Pool, sql: string, params: unknown[], fragment: RegExp) {
  await expect(pool.query(sql, params as never[])).rejects.toThrow(fragment)
}

describeWithDatabase('phase one ledger schema (migration 7)', () => {
  let pool: pg.Pool

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
      TRUNCATE memory_purge_receipts, memory_dead_letters, memory_jobs, memory_session_tombstones,
               memory_snapshot_runs, memory_snapshot_events, memory_feed_inbox,
               knowledge_tombstones, memory_idempotency_keys, memory_feedback,
               claim_search_documents, knowledge_evidence, memory_candidates,
               memory_extraction_runs, knowledge_claims, knowledge_versions,
               memory_feature_settings,
               source_artifacts, source_turns, source_events, source_sessions,
               repositories, repo_snapshots, work_episodes, memory_installations,
               memory_provider_state
      RESTART IDENTITY CASCADE
    `)
    await seedInstallation(pool, INSTALLATION)
    await seedEpisode(pool, INSTALLATION)
  })

  test('migration rerun is idempotent', async () => {
    await expect(applyMemorySchema(pool)).resolves.toBeUndefined()
  })

  test('pg_trgm extension and prior phase zero rows survive the upgrade', async () => {
    await seedInstallation(pool, INSTALLATION)
    await seedEpisode(pool, INSTALLATION)
    await applyMemorySchema(pool)
    const extension = await pool.query(
      `SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`,
    )
    expect(extension.rowCount).toBe(1)
    const episodes = await pool.query(
      `SELECT COUNT(*)::int AS count FROM work_episodes WHERE installation_id = $1`,
      [INSTALLATION],
    )
    expect(episodes.rows[0].count).toBeGreaterThanOrEqual(1)
  })

  test('phase one columns and composite uniques exist on phase zero tables', async () => {
    const columns = await pool.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'work_episodes'
        AND column_name IN
        ('repository_id','repo_snapshot_id','branch','source_digest','document',
         'evidence_manifest','document_compiler_version','compiled_at')
    `)
    expect(columns.rowCount).toBe(8)
    const freshness = await pool.query(`
      SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'knowledge_versions' AND column_name = 'freshness_at'
    `)
    expect(freshness.rows[0]?.is_nullable).toBe('NO')
    expect(freshness.rows[0]?.column_default).toContain('now()')
    for (const [table, column] of [
      ['source_events', 'source_event_id'],
      ['source_artifacts', 'artifact_id'],
      ['repositories', 'repository_id'],
      ['repo_snapshots', 'repo_snapshot_id'],
      ['work_episodes', 'episode_id'],
    ] as const) {
      const unique = await pool.query(
        `SELECT 1 FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'u'
         AND pg_get_constraintdef(oid) ILIKE '%' || $2 || '%'`,
        [table, column],
      )
      expect(unique.rowCount).toBeGreaterThanOrEqual(1)
    }
  })

  test('new job types are accepted with frozen priorities', async () => {
    const jobs = createJobRepository(pool)
    const episodeId = await episodeIdFor(pool, INSTALLATION)
    for (const [jobType, key] of [
      ['extract_candidates', `extract:${episodeId}`],
      ['index_claim_version', `index:${episodeId}`],
      ['rebuild_claim_index', `rebuild:${INSTALLATION}`],
      ['expire_claims', `expire:${INSTALLATION}`],
    ] as const) {
      await jobs.enqueueJob({
        installationId: INSTALLATION, jobType, idempotencyKey: key, payload: {},
      })
    }
    expect(JOB_PRIORITIES.extract_candidates).toBe(85)
    expect(JOB_PRIORITIES.index_claim_version).toBe(90)
    expect(JOB_PRIORITIES.rebuild_claim_index).toBe(95)
    expect(JOB_PRIORITIES.expire_claims).toBe(95)
    expect(JOB_PRIORITIES.installation_purge).toBe(0)
  })

  test('feature settings default to off and discovery bootstraps without overwriting', async () => {
    const registry = createInstallationRegistry(pool)
    await registry.applyDiscovery({
      generation: 1,
      items: [{
        installation_id: INSTALLATION,
        status: 'active',
        config_version: '1',
        granted_scopes: ['session:events:read'],
        subscriptions: ['session.event.v1'],
        enabled_services: ['memory.search'],
        event_filter: {},
        snapshot_required: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
    })
    let settings = await pool.query(`
      SELECT extraction_mode, embedding_mode, revision FROM memory_feature_settings
      WHERE installation_id = $1
    `, [INSTALLATION])
    expect(settings.rows[0]).toMatchObject({ extraction_mode: 'off', embedding_mode: 'off' })
    expect(Number(settings.rows[0].revision)).toBe(1)

    // An operator-enabled mode survives any later discovery pass.
    await pool.query(`
      UPDATE memory_feature_settings
      SET extraction_mode = 'shadow', revision = 2 WHERE installation_id = $1
    `, [INSTALLATION])
    await registry.applyDiscovery({
      generation: 2,
      items: [{
        installation_id: INSTALLATION,
        status: 'active',
        config_version: '2',
        granted_scopes: ['session:events:read'],
        subscriptions: ['session.event.v1'],
        enabled_services: ['memory.search'],
        event_filter: {},
        snapshot_required: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
    })
    settings = await pool.query(`
      SELECT extraction_mode, revision FROM memory_feature_settings WHERE installation_id = $1
    `, [INSTALLATION])
    expect(settings.rows[0]).toMatchObject({ extraction_mode: 'shadow' })
    expect(Number(settings.rows[0].revision)).toBe(2)
  })

  test('feature settings reject unknown modes', async () => {
    await seedInstallation(pool, OTHER_INSTALLATION)
    await expectViolation(pool, `
      INSERT INTO memory_feature_settings (installation_id, extraction_mode)
      VALUES ($1, 'sometimes')
    `, [OTHER_INSTALLATION], /extraction_mode/)
  })

  test('the full claim chain satisfies every frozen constraint', async () => {
    const episodeId = await episodeIdFor(pool, INSTALLATION)
    const chain = await seedClaimChain(pool, INSTALLATION, episodeId)
    expect(chain.versionId).toBeTruthy()
  })

  test('claim type, status, confidence and bounds are enforced on candidates', async () => {
    const episodeId = await episodeIdFor(pool, INSTALLATION)
    const chain = await seedClaimChain(pool, INSTALLATION, episodeId)
    await expectViolation(pool, `
      INSERT INTO memory_candidates
        (candidate_id, installation_id, run_id, episode_id, ordinal, claim_type,
         statement, normalized_key, scope_kind, scope_key, confidence, freshness_at, status)
      VALUES (gen_random_uuid(), $1, $2, $3, 1, 'nonexistent_type',
              'x', 'k-2', 'installation', 'global', 0.5, NOW(), 'validated')
    `, [INSTALLATION, chain.runId, episodeId], /claim_type/)
    await expectViolation(pool, `
      INSERT INTO memory_candidates
        (candidate_id, installation_id, run_id, episode_id, ordinal, claim_type,
         statement, normalized_key, scope_kind, scope_key, confidence, freshness_at, status)
      VALUES (gen_random_uuid(), $1, $2, $3, 2, 'work_method',
              'x', 'k-3', 'installation', 'global', 1.5, NOW(), 'validated')
    `, [INSTALLATION, chain.runId, episodeId], /confidence/)
    await expectViolation(pool, `
      INSERT INTO memory_candidates
        (candidate_id, installation_id, run_id, episode_id, ordinal, claim_type,
         statement, normalized_key, scope_kind, scope_key, confidence, freshness_at, status)
      VALUES (gen_random_uuid(), $1, $2, $3, 3, 'work_method',
              'x', 'k-4', 'installation', 'global', 0.5, NOW(), 'not_a_status')
    `, [INSTALLATION, chain.runId, episodeId], /status/)
  })

  test('all nine claim types are accepted by candidates and claims', async () => {
    const episodeId = await episodeIdFor(pool, INSTALLATION)
    const shared = await seedClaimChain(pool, INSTALLATION, episodeId)
    let ordinal = 10
    for (const claimType of CLAIM_TYPES) {
      await pool.query(`
        INSERT INTO memory_candidates
          (candidate_id, installation_id, run_id, episode_id, ordinal, claim_type,
           statement, normalized_key, scope_kind, scope_key, confidence, freshness_at, status)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5,
                's', $6, 'installation', 'global', 0.5, NOW(), 'shadow')
      `, [INSTALLATION, shared.runId, episodeId, ordinal, claimType, `key-${claimType}`])
      await pool.query(`
        INSERT INTO knowledge_claims
          (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
        VALUES (gen_random_uuid(), $1, $2, 'installation', 'global', $3, 'active')
      `, [INSTALLATION, claimType, `key-${claimType}`])
      ordinal++
    }
  })

  test('claim versions are immutable-shaped: authority and version uniqueness hold', async () => {
    const episodeId = await episodeIdFor(pool, INSTALLATION)
    const chain = await seedClaimChain(pool, INSTALLATION, episodeId)
    await expectViolation(pool, `
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES (gen_random_uuid(), $1, $2, 1, 'duplicate number', 'user_accepted', 0.5)
    `, [INSTALLATION, chain.claimId], /version_number/)
    await expectViolation(pool, `
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES (gen_random_uuid(), $1, $2, 2, 'bad authority', 'model_generated', 0.5)
    `, [INSTALLATION, chain.claimId], /authority/)
  })

  test('evidence kind integrity: event requires source_event_id, episode requires none', async () => {
    const episodeId = await episodeIdFor(pool, INSTALLATION)
    const chain = await seedClaimChain(pool, INSTALLATION, episodeId)
    await expectViolation(pool, `
      INSERT INTO knowledge_evidence
        (evidence_id, installation_id, version_id, episode_id, evidence_kind,
         excerpt, excerpt_hash, occurred_at, ordinal)
      VALUES (gen_random_uuid(), $1, $2, $3, 'event',
              'excerpt', 'x'::bytea, NOW(), 1)
    `, [INSTALLATION, chain.versionId, episodeId], /knowledge_evidence_check/)
  })

  test('cross-installation evidence FK fails closed', async () => {
    await seedInstallation(pool, OTHER_INSTALLATION)
    await seedEpisode(pool, OTHER_INSTALLATION)
    const mine = await seedClaimChain(pool, INSTALLATION, await episodeIdFor(pool, INSTALLATION))
    const otherEpisode = await episodeIdFor(pool, OTHER_INSTALLATION)
    await expectViolation(pool, `
      INSERT INTO knowledge_evidence
        (evidence_id, installation_id, version_id, episode_id, evidence_kind,
         excerpt, excerpt_hash, occurred_at, ordinal)
      VALUES (gen_random_uuid(), $1, $2, $3, 'episode',
              'excerpt', 'x'::bytea, NOW(), 5)
    `, [OTHER_INSTALLATION, mine.versionId, otherEpisode], /foreign key/)
  })

  test('search documents carry generated lexical vectors with GIN indexes', async () => {
    const episodeId = await episodeIdFor(pool, INSTALLATION)
    const chain = await seedClaimChain(pool, INSTALLATION, episodeId)
    await pool.query(`
      INSERT INTO claim_search_documents
        (installation_id, version_id, document, embedding, embedding_provider,
         embedding_model, embedding_dimensions, embedding_status)
      VALUES ($1, $2, 'Use vitest for unit tests', ARRAY[0.5, 0.5]::real[],
              'openai-compatible', 'embed-small', 2, 'ready')
    `, [INSTALLATION, chain.versionId])
    const lexical = await pool.query<{ rank: string }>(`
      SELECT ts_rank(search_vector, websearch_to_tsquery('simple', 'vitest'))::text AS rank
      FROM claim_search_documents WHERE installation_id = $1
    `, [INSTALLATION])
    expect(Number(lexical.rows[0].rank)).toBeGreaterThan(0)
    const trigram = await pool.query(`
      SELECT similarity(document, 'vitest') AS s FROM claim_search_documents
      WHERE installation_id = $1
    `, [INSTALLATION])
    expect(Number(trigram.rows[0].s)).toBeGreaterThan(0)
    for (const index of ['claim_search_documents_fts', 'claim_search_documents_trgm']) {
      const exists = await pool.query(
        `SELECT 1 FROM pg_indexes WHERE indexname = $1`, [index],
      )
      expect(exists.rowCount).toBe(1)
    }
    await expectViolation(pool, `
      INSERT INTO claim_search_documents
        (installation_id, version_id, document, embedding, embedding_dimensions)
      VALUES ($1, $2, 'doc', ARRAY[0.1]::real[], 2)
    `, [INSTALLATION, chain.versionId], /claim_search_documents/)
  })

  test('feedback, idempotency keys and tombstones enforce their contracts', async () => {
    await pool.query(`
      INSERT INTO memory_feedback (feedback_id, installation_id, action, reason_code)
      VALUES (gen_random_uuid(), $1, 'recall_used', 'ok')
    `, [INSTALLATION])
    await expectViolation(pool, `
      INSERT INTO memory_feedback (feedback_id, installation_id, action)
      VALUES (gen_random_uuid(), $1, 'made_coffee')
    `, [INSTALLATION], /action/)
    await pool.query(`
      INSERT INTO memory_idempotency_keys
        (installation_id, operation, key_hash, request_hash, expires_at)
      VALUES ($1, 'accept_candidate', 'k'::bytea, 'r'::bytea, NOW() + INTERVAL '1 hour')
    `, [INSTALLATION])
    await expectViolation(pool, `
      INSERT INTO memory_idempotency_keys
        (installation_id, operation, key_hash, request_hash, expires_at)
      VALUES ($1, 'accept_candidate', 'k2'::bytea, 'r2'::bytea, NOW() - INTERVAL '1 hour')
    `, [INSTALLATION], /memory_idempotency_keys_check/)
    await pool.query(`
      INSERT INTO knowledge_tombstones (installation_id, key_id, identity_hmac, reason)
      VALUES ($1, 'normalized-key-1', 'h'::bytea, 'privacy_delete')
    `, [INSTALLATION])
    await expectViolation(pool, `
      INSERT INTO knowledge_tombstones (installation_id, key_id, identity_hmac, reason)
      VALUES ($1, 'normalized-key-2', 'h'::bytea, 'regret')
    `, [INSTALLATION], /reason/)
  })

  test('installation purge removes every phase one content table', async () => {
    const episodeId = await episodeIdFor(pool, INSTALLATION)
    await seedClaimChain(pool, INSTALLATION, episodeId)
    await pool.query(`
      INSERT INTO memory_feedback (feedback_id, installation_id, action)
      VALUES (gen_random_uuid(), $1, 'recall_used')
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO memory_idempotency_keys
        (installation_id, operation, key_hash, request_hash, expires_at)
      VALUES ($1, 'op', 'k'::bytea, 'r'::bytea, NOW() + INTERVAL '1 hour')
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO knowledge_tombstones (installation_id, key_id, identity_hmac, reason)
      VALUES ($1, 'purge-me', 'h'::bytea, 'privacy_delete')
    `, [INSTALLATION])

    await pool.query(`DELETE FROM memory_installations WHERE installation_id = $1`, [INSTALLATION])

    for (const [table, column] of [
      ['memory_feature_settings', 'installation_id'],
      ['memory_extraction_runs', 'installation_id'],
      ['memory_candidates', 'installation_id'],
      ['knowledge_claims', 'installation_id'],
      ['knowledge_versions', 'installation_id'],
      ['knowledge_evidence', 'installation_id'],
      ['claim_search_documents', 'installation_id'],
      ['memory_feedback', 'installation_id'],
      ['memory_idempotency_keys', 'installation_id'],
      ['knowledge_tombstones', 'installation_id'],
    ] as const) {
      const rows = await pool.query(
        `SELECT COUNT(*)::int AS count FROM ${table} WHERE ${column} = $1`,
        [INSTALLATION],
      )
      expect(rows.rows[0].count).toBe(0)
    }
  })
})
