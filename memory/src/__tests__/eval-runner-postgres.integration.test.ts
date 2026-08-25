import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createEvalRunner } from '../eval/runner.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const describeWithDatabase = databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1'
  ? describe
  : describe.skip
const INSTALLATION = 'eeeeeee1-eeee-4eee-8eee-eeeeeeeeeeee'
const ALLOWED_REPOSITORY = 'eeeeeee3-eeee-4eee-8eee-eeeeeeeeeeee'
const OTHER_REPOSITORY = 'eeeeeee4-eeee-4eee-8eee-eeeeeeeeeeee'

describeWithDatabase('golden evaluator fail-closed gates (PostgreSQL)', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 2 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
  }, 60_000)

  afterAll(async () => pool?.end())

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE claim_search_documents, knowledge_evidence, knowledge_versions,
               knowledge_claims, memory_feature_settings, memory_installations
      RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
    `, [INSTALLATION])
  })

  test('an empty search cannot hide an active current Version without Evidence', async () => {
    const claim = await pool.query<{ claim_id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES (gen_random_uuid(), $1, 'work_method', 'installation', 'global',
              'work_method|global|missing evidence', 'active')
      RETURNING claim_id::text
    `, [INSTALLATION])
    const version = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES (gen_random_uuid(), $1, $2, 1, 'missing evidence', 'user_accepted', 1)
      RETURNING version_id::text
    `, [INSTALLATION, claim.rows[0].claim_id])
    await pool.query(`UPDATE knowledge_claims SET current_version_id = $2 WHERE claim_id = $1`,
      [claim.rows[0].claim_id, version.rows[0].version_id])

    const report = await createEvalRunner({
      pool, cursorSigningKey: 'eval-test-signing-key', now: () => 1_000,
    }).run({
      schema_version: 1,
      dataset_version: 'fail-closed-v1',
      created_at: '2026-08-25T00:00:00Z',
      cases: [{
        id: 'missing-evidence', schema_version: 1, query: 'nothing indexed',
        installation_id: INSTALLATION,
        allowed: { repository_ids: [], repo_snapshot_ids: [], branches: [] },
        expected: { claim_ids: [claim.rows[0].claim_id], evidence_claim_ids: [claim.rows[0].claim_id] },
      }],
    })
    expect(report.cases[0]).toMatchObject({
      top5ValidHit: false, evidenceCoverage: 0, emptyResult: true,
    })
    expect(report.evidenceCoverageRate).toBe(0)
  })

  test('a missing expected Evidence Claim is uncovered even when no active Claims exist', async () => {
    const missingClaim = 'eeeeeee2-eeee-4eee-8eee-eeeeeeeeeeee'
    const report = await createEvalRunner({
      pool, cursorSigningKey: 'eval-test-signing-key', now: () => 1_000,
    }).run({
      schema_version: 1,
      dataset_version: 'missing-expected-v1',
      created_at: '2026-08-25T00:00:00Z',
      cases: [{
        id: 'missing-expected', schema_version: 1, query: 'nothing indexed',
        installation_id: INSTALLATION,
        allowed: { repository_ids: [], repo_snapshot_ids: [], branches: [] },
        expected: { claim_ids: [], evidence_claim_ids: [missingClaim] },
      }],
    })
    expect(report.cases[0].evidenceCoverage).toBe(0)
    expect(report.evidenceCoverageRate).toBe(0)
    expect(report.top5EvaluatedCases).toBe(0)
    expect(report.top5HitRate).toBe(0)
    expect(report.cases[0].top5ValidHit).toBe(true)
  })

  test('allowed repository scope is applied to the product search before scoring', async () => {
    await pool.query(`
      INSERT INTO repositories
        (repository_id, installation_id, repository_key, first_observed_at, last_observed_at)
      VALUES ($2, $1, 'allowed-repo', NOW(), NOW()),
             ($3, $1, 'other-repo', NOW(), NOW())
    `, [INSTALLATION, ALLOWED_REPOSITORY, OTHER_REPOSITORY])
    await pool.query(`
      INSERT INTO source_sessions
        (installation_id, session_id, first_recorded_at, last_recorded_at)
      VALUES ($1, 'eval-session', NOW(), NOW())
    `, [INSTALLATION])
    const episode = await pool.query<{ episode_id: string }>(`
      INSERT INTO work_episodes
        (installation_id, episode_id, session_id, turn_id, state, compiler_version, compiled_at)
      VALUES ($1, gen_random_uuid(), 'eval-session', 'eval-turn', 'ready', 'v1', NOW())
      RETURNING episode_id::text
    `, [INSTALLATION])
    const rowsSql = `VALUES
        ('eeeeeee5-eeee-4eee-8eee-eeeeeeeeeeee'::uuid,
         'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid, $2::uuid, 'allowed-key'),
        ('eeeeeee6-eeee-4eee-8eee-eeeeeeeeeeee'::uuid,
         '00000000-0000-4000-8000-000000000001'::uuid, $3::uuid, 'other-key')
    `
    await pool.query(`
      WITH rows(claim_id, version_id, repository_id, normalized_key) AS (${rowsSql})
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      SELECT claim_id, $1, 'work_method', 'repository', repository_id::text, normalized_key, 'active'
      FROM rows
    `, [INSTALLATION, ALLOWED_REPOSITORY, OTHER_REPOSITORY])
    await pool.query(`
      WITH rows(claim_id, version_id, repository_id, normalized_key) AS (${rowsSql})
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority,
         confidence, repository_id)
      SELECT version_id, $1, claim_id, 1, 'shared evaluator query', 'user_accepted', 1, repository_id
      FROM rows
    `, [INSTALLATION, ALLOWED_REPOSITORY, OTHER_REPOSITORY])
    await pool.query(`
      WITH rows(claim_id, version_id, repository_id, normalized_key) AS (${rowsSql})
      UPDATE knowledge_claims c SET current_version_id = r.version_id
      FROM rows r WHERE c.claim_id = r.claim_id AND c.installation_id = $1
    `, [INSTALLATION, ALLOWED_REPOSITORY, OTHER_REPOSITORY])
    const seeded = await pool.query<{ claim_id: string; version_id: string; repository_id: string }>(`
      WITH rows(claim_id, version_id, repository_id, normalized_key) AS (${rowsSql}), evidence AS (
        INSERT INTO knowledge_evidence
          (evidence_id, installation_id, version_id, episode_id, evidence_kind,
           excerpt, excerpt_hash, occurred_at, ordinal)
        SELECT gen_random_uuid(), $1, version_id, $4, 'episode', 'eval evidence',
               sha256(convert_to('eval evidence', 'utf8')), NOW(), 0 FROM rows
        RETURNING version_id
      ), documents AS (
        INSERT INTO claim_search_documents (installation_id, version_id, document)
        SELECT $1, version_id, 'shared evaluator query' FROM evidence
      )
      SELECT claim_id::text, version_id::text, repository_id::text FROM rows
    `, [INSTALLATION, ALLOWED_REPOSITORY, OTHER_REPOSITORY, episode.rows[0].episode_id])
    const expected = seeded.rows.find(row => row.repository_id === ALLOWED_REPOSITORY)!

    const report = await createEvalRunner({
      pool, cursorSigningKey: 'eval-test-signing-key', now: () => 1_000,
    }).run({
      schema_version: 1,
      dataset_version: 'scoped-v1',
      created_at: '2026-08-25T00:00:00Z',
      cases: [{
        id: 'allowed-repository', schema_version: 1, query: 'shared evaluator query',
        installation_id: INSTALLATION,
        allowed: { repository_ids: [ALLOWED_REPOSITORY], repo_snapshot_ids: [], branches: [] },
        expected: { claim_ids: [expected.claim_id], evidence_claim_ids: [expected.claim_id] },
      }],
    }, 1)
    expect(report.cases[0]).toMatchObject({ top5ValidHit: true, scopeLeak: false })
    expect(report.top5EvaluatedCases).toBe(1)
    expect(report.top5HitRate).toBe(1)
  })
})
