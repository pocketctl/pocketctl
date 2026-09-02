import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { applyMemorySchema, MEMORY_MIGRATIONS } from '../schema.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

async function seedInstallation(pool: pg.Pool): Promise<string> {
  const row = await pool.query<{ id: string }>(`
    INSERT INTO memory_installations
      (installation_id, provider_id, relay_status, local_status, config_version,
       granted_scopes, subscriptions, enabled_services, event_filter)
    VALUES (gen_random_uuid(), 'pocketctl-memory', 'active', 'ready', 1,
            '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
    RETURNING installation_id::text AS id
  `)
  return row.rows[0].id
}

describeWithDatabase('memory phase3 governance schema (migration 20)', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    const database = await pool.query<{ database_name: string }>(
      'SELECT current_database() AS database_name',
    )
    if (!/test/i.test(database.rows[0]?.database_name ?? '')) {
      throw new Error('Refusing integration test against non-test database')
    }
    await applyMemorySchema(pool)
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  test('appends migration 20 after 19 without renumbering', () => {
    const versions = MEMORY_MIGRATIONS.map(migration => migration.version)
    expect(versions).toHaveLength(38)
    expect(versions[19]).toBe(20)
    expect(versions[20]).toBe(21)
    expect(versions[21]).toBe(22)
    expect(versions[22]).toBe(23)
    expect(versions[23]).toBe(24)
  })

  test('creates the governance tables with frozen constraints', async () => {
    const tables = await pool.query<{ tablename: string }>(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = current_schema()
        AND tablename IN (
          'memory_review_policy_sets', 'memory_review_policy_versions', 'memory_review_policy_heads',
          'memory_promotion_candidates', 'memory_promotion_candidate_versions', 'memory_promotion_evidence',
          'memory_review_decisions', 'memory_authority_records', 'memory_governance_events',
          'memory_transfer_runs')
      ORDER BY tablename
    `)
    expect(tables.rows.map(row => row.tablename)).toEqual([
      'memory_authority_records',
      'memory_governance_events',
      'memory_promotion_candidate_versions',
      'memory_promotion_candidates',
      'memory_promotion_evidence',
      'memory_review_decisions',
      'memory_review_policy_heads',
      'memory_review_policy_sets',
      'memory_review_policy_versions',
      'memory_transfer_runs',
    ])

    // Candidate states follow the frozen state machine.
    await expect(pool.query(`
      INSERT INTO memory_promotion_candidates
        (candidate_id, target_installation_id, source_installation_id, source_scope_kind,
         source_claim_id, source_version_id, source_content_hash, target_claim_type,
         scope_key, normalized_key, expires_at)
      VALUES (gen_random_uuid(), $1, $2, 'personal', gen_random_uuid(), gen_random_uuid(),
              'hash', 'repository_convention', '/repo', 'key', NOW() + INTERVAL '30 days')
    `, [await seedInstallation(pool), await seedInstallation(pool)])).resolves.toBeTruthy()
    await expect(pool.query(`
      INSERT INTO memory_promotion_candidates
        (candidate_id, target_installation_id, source_installation_id, source_scope_kind,
         source_claim_id, source_version_id, source_content_hash, target_claim_type,
         scope_key, normalized_key, expires_at, state)
      VALUES (gen_random_uuid(), $1, $2, 'personal', gen_random_uuid(), gen_random_uuid(),
              'hash', 'repository_convention', '/repo', 'key', NOW(), 'teleported')
    `, [await seedInstallation(pool), await seedInstallation(pool)])).rejects.toThrow()
    // Organization promotion edges reject an organization source.
    await expect(pool.query(`
      INSERT INTO memory_promotion_candidates
        (candidate_id, target_installation_id, source_installation_id, source_scope_kind,
         source_claim_id, source_version_id, source_content_hash, target_claim_type,
         scope_key, normalized_key, expires_at)
      VALUES (gen_random_uuid(), $1, $2, 'organization', gen_random_uuid(), gen_random_uuid(),
              'hash', 'repository_convention', '/repo', 'key', NOW() + INTERVAL '30 days')
    `, [await seedInstallation(pool), await seedInstallation(pool)])).rejects.toThrow()
    // Source and target may never be the same installation.
    const same = await seedInstallation(pool)
    await expect(pool.query(`
      INSERT INTO memory_promotion_candidates
        (candidate_id, target_installation_id, source_installation_id, source_scope_kind,
         source_claim_id, source_version_id, source_content_hash, target_claim_type,
         scope_key, normalized_key, expires_at)
      VALUES (gen_random_uuid(), $1, $1, 'personal', gen_random_uuid(), gen_random_uuid(),
              'hash', 'repository_convention', '/repo', 'key', NOW() + INTERVAL '30 days')
    `, [same])).rejects.toThrow()
  })

  test('extends knowledge tables additively with owner scope and conflict columns', async () => {
    const installationId = await seedInstallation(pool)
    const claim = await pool.query<{ claim_id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES (gen_random_uuid(), $1, 'repository_convention', 'repository', '/repo', 'phase3-schema-key', 'active')
      RETURNING claim_id::text
    `, [installationId])
    const backfilled = await pool.query<{ owner_scope_kind: string; owner_scope_id: string; conflict_variant: number }>(`
      SELECT owner_scope_kind, owner_scope_id::text, conflict_variant
      FROM knowledge_claims WHERE claim_id = $1
    `, [claim.rows[0].claim_id])
    expect(backfilled.rows[0].owner_scope_kind).toBe('personal')
    expect(backfilled.rows[0].owner_scope_id).toBe(installationId)
    expect(backfilled.rows[0].conflict_variant).toBe(0)

    // Version authority accepts the shared values; evidence tracks visibility.
    const version = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES (gen_random_uuid(), $1, $2, 1, 'statement', 'team_published', 0.9)
      RETURNING version_id::text
    `, [installationId, claim.rows[0].claim_id])
    expect(version.rows[0].version_id).toBeTruthy()
    await expect(pool.query(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES (gen_random_uuid(), $1, $2, 2, 'statement', 'machine_approved', 0.9)
    `, [installationId, claim.rows[0].claim_id])).rejects.toThrow()

    await pool.query(`
      INSERT INTO work_episodes
        (installation_id, episode_id, session_id, turn_id, state, compiler_version)
      VALUES ($1, gen_random_uuid(), 'phase3-schema-session', 'phase3-schema-turn', 'ready', 'test')
    `, [installationId])
    await expect(pool.query(`
      INSERT INTO knowledge_evidence
        (evidence_id, installation_id, version_id, episode_id, ordinal, evidence_kind,
         excerpt, excerpt_hash, occurred_at, visibility)
      VALUES (gen_random_uuid(), $1, $2,
              (SELECT episode_id FROM work_episodes WHERE installation_id = $1 AND session_id = 'phase3-schema-session'),
              1, 'episode', 'excerpt', 'hash', NOW(), 'shared')
    `, [installationId, version.rows[0].version_id])).resolves.toBeTruthy()
    await expect(pool.query(`
      INSERT INTO knowledge_evidence
        (evidence_id, installation_id, version_id, episode_id, ordinal, evidence_kind,
         excerpt, excerpt_hash, occurred_at, visibility)
      VALUES (gen_random_uuid(), $1, $2,
              (SELECT episode_id FROM work_episodes WHERE installation_id = $1 AND session_id = 'phase3-schema-session'),
              2, 'episode', 'excerpt', 'hash', NOW(), 'public')
    `, [installationId, version.rows[0].version_id])).rejects.toThrow()
  })

  test('extends the job allowlist with the Phase 3 governance job types', async () => {
    const installationId = await seedInstallation(pool)
    for (const jobType of [
      'expire_promotion_candidates', 'index_shared_claim',
      'invalidate_scope_authorization', 'transfer_scope_claims',
    ]) {
      await pool.query(`
        INSERT INTO memory_jobs (job_id, installation_id, job_type, idempotency_key)
        VALUES (gen_random_uuid(), $1, $2, $3)
        ON CONFLICT DO NOTHING
      `, [installationId, jobType, `phase3-schema:${jobType}`])
    }
    const count = await pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM memory_jobs
      WHERE installation_id = $1 AND job_type LIKE '%promotion%' OR installation_id = $1 AND job_type = 'index_shared_claim'
    `, [installationId])
    expect(Number(count.rows[0].count)).toBeGreaterThanOrEqual(2)
  })
})
