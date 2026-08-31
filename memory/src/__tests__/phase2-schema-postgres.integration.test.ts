import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { MEMORY_MIGRATIONS, applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createJobRepository } from '../jobs/repository.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALL_A = '32323232-3232-4322-8322-323232323232'
const INSTALL_B = '43434343-4343-4433-8433-434343434343'

async function seedInstallation(pool: pg.Pool, installationId: string) {
  await pool.query(`
    INSERT INTO memory_installations
      (installation_id, provider_id, relay_status, local_status, config_version)
    VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
  `, [installationId])
}

async function seedClaim(pool: pg.Pool, installationId: string, key: string): Promise<{
  claimId: string
  versionId: string
}> {
  const claim = await pool.query<{ claim_id: string }>(`
    INSERT INTO knowledge_claims
      (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
    VALUES (gen_random_uuid(), $1, 'repository_convention', 'installation', 'global', $2, 'active')
    RETURNING claim_id::text
  `, [installationId, key])
  const claimId = claim.rows[0].claim_id
  const version = await pool.query<{ version_id: string }>(`
    INSERT INTO knowledge_versions
      (version_id, installation_id, claim_id, version_number, statement, authority,
       confidence, freshness_at)
    VALUES (gen_random_uuid(), $1, $2, 1, $3, 'user_accepted', 0.9, NOW())
    RETURNING version_id::text
  `, [installationId, claimId, `statement:${key}`])
  const versionId = version.rows[0].version_id
  await pool.query(`UPDATE knowledge_claims SET current_version_id = $2 WHERE claim_id = $1`, [claimId, versionId])
  return { claimId, versionId }
}

async function seedPolicy(pool: pg.Pool, installationId: string | null): Promise<string> {
  const set = await pool.query<{ policy_id: string }>(`
    INSERT INTO memory_policy_sets (policy_id, installation_id, policy_kind, layer, scope_key)
    VALUES (gen_random_uuid(), $1, 'context', 'system', 'global')
    RETURNING policy_id::text
  `, [installationId])
  const policyId = set.rows[0].policy_id
  const version = await pool.query<{ policy_version_id: string }>(`
    INSERT INTO memory_policy_versions
      (policy_version_id, policy_id, version_number, schema_version, document, content_hash, created_by)
    VALUES (gen_random_uuid(), $1, 1, 1, '{}', decode(md5($2), 'hex'), 'system')
    RETURNING policy_version_id::text
  `, [policyId, `policy:${policyId}`])
  await pool.query(`
    INSERT INTO memory_policy_heads (policy_id, active_version_id)
    VALUES ($1, $2)
  `, [policyId, version.rows[0].policy_version_id])
  return policyId
}

describeWithDatabase('phase two schema invariants (migration 13)', () => {
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
      TRUNCATE memory_context_feedback, memory_context_injections,
               memory_context_pack_evidence, memory_context_pack_items,
               memory_context_packs, memory_retrieval_candidates,
               memory_retrieval_stages, memory_retrieval_trajectories,
               memory_generation_run_policies, memory_generation_runs,
               memory_context_loadout_items, memory_context_loadouts,
               memory_context_settings, memory_policy_heads,
               memory_policy_versions, memory_policy_sets,
               memory_extraction_runs, memory_jobs, knowledge_evidence,
               knowledge_versions, knowledge_claims, repositories,
               memory_installations
      RESTART IDENTITY CASCADE
    `)
    await seedInstallation(pool, INSTALL_A)
    await seedInstallation(pool, INSTALL_B)
  })

  test('phase two job types enqueue with their frozen priorities', async () => {
    const jobs = createJobRepository(pool)
    await jobs.enqueueJob({ installationId: INSTALL_A, jobType: 'invalidate_context_packs', idempotencyKey: 'p2:inv' })
    await jobs.enqueueJob({ installationId: INSTALL_A, jobType: 'recompile_extraction_policy', idempotencyKey: 'p2:re' })
    await jobs.enqueueJob({ installationId: INSTALL_A, jobType: 'compile_context_shadow', idempotencyKey: 'p2:cc' })
    await jobs.enqueueJob({ installationId: INSTALL_A, jobType: 'record_context_delivery', idempotencyKey: 'p2:rc' })
    const priorities = await pool.query<{ job_type: string; priority: number }>(`
      SELECT job_type, priority FROM memory_jobs
      WHERE installation_id = $1 ORDER BY priority ASC
    `, [INSTALL_A])
    const byType = Object.fromEntries(priorities.rows.map(row => [row.job_type, row.priority]))
    expect(byType).toMatchObject({
      invalidate_context_packs: 10,
      recompile_extraction_policy: 84,
      compile_context_shadow: 88,
      record_context_delivery: 100,
    })
  })

  test('policy versions are immutable by content hash within a set', async () => {
    const policyId = await seedPolicy(pool, null)
    await expect(pool.query(`
      INSERT INTO memory_policy_versions
        (policy_version_id, policy_id, version_number, schema_version, document, content_hash, created_by)
      VALUES (gen_random_uuid(), $1, 2, 1, '{}',
              (SELECT content_hash FROM memory_policy_versions WHERE policy_id = $1 LIMIT 1), 'user')
    `, [policyId])).rejects.toThrow(/duplicate key/)
    await expect(pool.query(`
      INSERT INTO memory_policy_sets (policy_id, policy_kind, layer, scope_key)
      VALUES (gen_random_uuid(), 'unknown_kind', 'system', 'x')
    `)).rejects.toThrow(/check constraint/)
  })

  test('context settings dedupe on (installation, scope, key, agent) with NULLS NOT DISTINCT', async () => {
    await pool.query(`
      INSERT INTO memory_context_settings
        (setting_id, installation_id, scope_kind, scope_key, agent, mode)
      VALUES (gen_random_uuid(), $1, 'repository', 'repo-1', NULL, 'shadow')
    `, [INSTALL_A])
    await expect(pool.query(`
      INSERT INTO memory_context_settings
        (setting_id, installation_id, scope_kind, scope_key, agent, mode)
      VALUES (gen_random_uuid(), $1, 'repository', 'repo-1', NULL, 'enabled')
    `, [INSTALL_A])).rejects.toThrow(/duplicate key/)
    // A distinct agent slot is a different setting.
    await pool.query(`
      INSERT INTO memory_context_settings
        (setting_id, installation_id, scope_kind, scope_key, agent, mode)
      VALUES (gen_random_uuid(), $1, 'repository', 'repo-1', 'codex', 'enabled')
    `, [INSTALL_A])
    await expect(pool.query(`
      INSERT INTO memory_context_settings
        (setting_id, installation_id, scope_kind, scope_key, agent, mode)
      VALUES (gen_random_uuid(), $1, 'repository', 'repo-2', NULL, 'loud')
    `, [INSTALL_A])).rejects.toThrow(/check constraint/)
  })

  test('loadout items cannot reference a claim from another installation', async () => {
    const { claimId } = await seedClaim(pool, INSTALL_B, 'foreign-claim')
    const loadout = await pool.query<{ loadout_id: string }>(`
      INSERT INTO memory_context_loadouts (loadout_id, installation_id, repository_id, agent)
      VALUES (gen_random_uuid(), $1, NULL, 'codex')
      RETURNING loadout_id::text
    `, [INSTALL_A])
    await expect(pool.query(`
      INSERT INTO memory_context_loadout_items
        (loadout_id, item_id, asset_kind, installation_id, claim_id, representation, priority)
      VALUES ($1, gen_random_uuid(), 'claim', $2, $3, 'summary', 50)
    `, [loadout.rows[0].loadout_id, INSTALL_A, claimId])).rejects.toThrow(/violates foreign key/)
  })

  test('pack items cannot reference a version from another installation', async () => {
    const { versionId } = await seedClaim(pool, INSTALL_B, 'foreign-version')
    const run = await pool.query<{ run_id: string }>(`
      INSERT INTO memory_generation_runs
        (run_id, installation_id, operation, subject_kind, subject_key_hash,
         input_digest, effective_policy_hash, state)
      VALUES (gen_random_uuid(), $1, 'compile_context', 'session', decode(md5('s1'),'hex'),
              decode(md5('i1'),'hex'), decode(md5('p1'),'hex'), 'succeeded')
      RETURNING run_id::text
    `, [INSTALL_A])
    const pack = await pool.query<{ pack_id: string }>(`
      INSERT INTO memory_context_packs
        (pack_id, installation_id, generation_run_id, session_id, client_request_id,
         agent, mode, effective_policy_hash, input_digest, state)
      VALUES (gen_random_uuid(), $1, $2, 'ses-1', 'cr-1', 'codex', 'shadow',
              decode(md5('p1'),'hex'), decode(md5('i1'),'hex'), 'shadow')
      RETURNING pack_id::text
    `, [INSTALL_A, run.rows[0].run_id])
    const { claimId } = await seedClaim(pool, INSTALL_A, 'own-claim')
    await expect(pool.query(`
      INSERT INTO memory_context_pack_items
        (pack_id, item_id, installation_id, claim_id, version_id, claim_type,
         layer, section, representation, rendered_text, ordinal)
      VALUES ($1, gen_random_uuid(), $2, $3, $4, 'repository_convention',
              'L2', 'dynamic', 'summary', 'text', 0)
    `, [pack.rows[0].pack_id, INSTALL_A, claimId, versionId])).rejects.toThrow(/violates foreign key/)
  })

  test('generation runs dedupe same input+policy and allow a changed policy', async () => {
    const insert = (subject: string, policy: string) => pool.query(`
      INSERT INTO memory_generation_runs
        (run_id, installation_id, operation, subject_kind, subject_key_hash,
         input_digest, effective_policy_hash, state)
      VALUES (gen_random_uuid(), $1, 'compile_context', 'session', decode(md5($2),'hex'),
              decode(md5('i1'),'hex'), decode(md5($3),'hex'), 'succeeded')
    `, [INSTALL_A, subject, policy])
    await insert('subj-1', 'policy-a')
    await expect(insert('subj-1', 'policy-a')).rejects.toThrow(/duplicate key/)
    // A changed effective policy is a NEW run for the same input.
    await insert('subj-1', 'policy-b')
    // A different subject is a different run as well.
    await insert('subj-2', 'policy-a')
    const count = await pool.query<{ n: number }>(`
      SELECT COUNT(*)::int AS n FROM memory_generation_runs WHERE installation_id = $1
    `, [INSTALL_A])
    expect(count.rows[0].n).toBe(3)
  })

  test('only one active admission per (installation, session, client_request)', async () => {
    const { claimId, versionId } = await seedClaim(pool, INSTALL_A, 'adm')
    const run = await pool.query<{ run_id: string }>(`
      INSERT INTO memory_generation_runs
        (run_id, installation_id, operation, subject_kind, subject_key_hash,
         input_digest, effective_policy_hash, state)
      VALUES (gen_random_uuid(), $1, 'compile_context', 'session', decode(md5('adm'),'hex'),
              decode(md5('i'),'hex'), decode(md5('p'),'hex'), 'succeeded')
      RETURNING run_id::text
    `, [INSTALL_A])
    const seedPack = async (cr: string) => {
      const pack = await pool.query<{ pack_id: string }>(`
        INSERT INTO memory_context_packs
          (pack_id, installation_id, generation_run_id, session_id, client_request_id,
           agent, mode, effective_policy_hash, input_digest, state)
        VALUES (gen_random_uuid(), $1, NULL, 'ses-1', $2, 'codex', 'enabled',
                decode(md5($2),'hex'), decode(md5('i'),'hex'), 'ready')
        RETURNING pack_id::text
      `, [INSTALL_A, cr])
      await pool.query(`
        INSERT INTO memory_context_pack_items
          (pack_id, item_id, installation_id, claim_id, version_id, claim_type,
           layer, section, representation, rendered_text, ordinal)
        VALUES ($1, gen_random_uuid(), $2, $3, $4, 'repository_convention',
                'L2', 'stable', 'summary', 'text', 0)
      `, [pack.rows[0].pack_id, INSTALL_A, claimId, versionId])
      return pack.rows[0].pack_id
    }
    const seedInjection = (packId: string, state: string, nonce: string) => pool.query(`
      INSERT INTO memory_context_injections
        (injection_id, installation_id, pack_id, session_id, client_request_id,
         agent, adapter, admission_nonce_hmac, state)
      VALUES (gen_random_uuid(), $1, $2, 'ses-1', 'cr-1', 'codex', 'codex-app-server',
              decode(md5($3),'hex'), $4)
    `, [INSTALL_A, packId, nonce, state])

    const packOne = await seedPack('cr-1')
    await seedInjection(packOne, 'prepared', 'n1')
    const packTwo = await seedPack('cr-2')
    // Two active admissions for the same client request are impossible.
    await expect(seedInjection(packTwo, 'admitted', 'n2')).rejects.toThrow(/duplicate key/)
    // Terminal states free the slot: delivered + a later prepared admission coexist.
    await pool.query(`DELETE FROM memory_context_injections WHERE pack_id = $1`, [packOne])
    await seedInjection(packOne, 'delivered', 'n1')
    await seedInjection(packTwo, 'prepared', 'n3')
  })

  test('feedback requires an injection or pack target', async () => {
    await expect(pool.query(`
      INSERT INTO memory_context_feedback
        (feedback_id, installation_id, actor, action)
      VALUES (gen_random_uuid(), $1, 'user', 'used')
    `, [INSTALL_A])).rejects.toThrow(/check constraint/)
  })

  test('deleting an installation removes every phase two row (purge cascade)', async () => {
    const { claimId, versionId } = await seedClaim(pool, INSTALL_A, 'cascade')
    const run = await pool.query<{ run_id: string }>(`
      INSERT INTO memory_generation_runs
        (run_id, installation_id, operation, subject_kind, subject_key_hash,
         input_digest, effective_policy_hash, state)
      VALUES (gen_random_uuid(), $1, 'compile_context', 'session', decode(md5('c'),'hex'),
              decode(md5('i'),'hex'), decode(md5('p'),'hex'), 'succeeded')
      RETURNING run_id::text
    `, [INSTALL_A])
    const pack = await pool.query<{ pack_id: string }>(`
      INSERT INTO memory_context_packs
        (pack_id, installation_id, session_id, client_request_id, agent, mode,
         effective_policy_hash, input_digest, state)
      VALUES (gen_random_uuid(), $1, 'ses-1', 'cr-1', 'codex', 'enabled',
              decode(md5('p'),'hex'), decode(md5('i'),'hex'), 'ready')
      RETURNING pack_id::text
    `, [INSTALL_A])
    await pool.query(`
      INSERT INTO memory_context_pack_items
        (pack_id, item_id, installation_id, claim_id, version_id, claim_type,
         layer, section, representation, rendered_text, ordinal)
      VALUES ($1, gen_random_uuid(), $2, $3, $4, 'repository_convention',
              'L2', 'stable', 'summary', 'text', 0)
    `, [pack.rows[0].pack_id, INSTALL_A, claimId, versionId])
    await pool.query(`
      INSERT INTO memory_context_injections
        (injection_id, installation_id, pack_id, session_id, client_request_id,
         agent, adapter, admission_nonce_hmac, state)
      VALUES (gen_random_uuid(), $1, $2, 'ses-1', 'cr-1', 'codex', 'codex-app-server',
              decode(md5('n'),'hex'), 'admitted')
    `, [INSTALL_A, pack.rows[0].pack_id])
    await pool.query(`
      INSERT INTO memory_context_settings
        (setting_id, installation_id, scope_kind, scope_key, mode)
      VALUES (gen_random_uuid(), $1, 'installation', 'global', 'shadow')
    `, [INSTALL_A])
    await seedPolicy(pool, INSTALL_A)

    await pool.query(`DELETE FROM memory_installations WHERE installation_id = $1`, [INSTALL_A])

    for (const table of [
      'memory_context_packs', 'memory_context_injections', 'memory_generation_runs',
      'memory_context_settings', 'memory_policy_sets',
    ] as const) {
      const left = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM ${table} WHERE installation_id = $1`, [INSTALL_A])
      expect(left.rows[0].n).toBe(0)
    }
    // System policy rows (installation_id IS NULL) survive an installation purge.
    await seedPolicy(pool, null)
  })
})

/**
 * Upgrade path: a database holding migrations 1-12 plus legacy extraction
 * runs migrates to 13 with a stable backfill and an idempotent re-run.
 * Uses a dedicated database (skipped when the test role cannot create one).
 */
describe('phase two upgrade path (v1-12 with legacy data)', () => {
  let pool: pg.Pool | undefined
  let upgradeDbUrl: string | undefined

  beforeAll(async () => {
    if (!integrationEnabled) return
    const base = new URL(databaseUrl!)
    const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 })
    const upgradeDb = `${base.pathname.slice(1)}_phase2_upgrade`
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${JSON.stringify(upgradeDb)}`)
      await admin.query(`CREATE DATABASE ${JSON.stringify(upgradeDb)}`)
      upgradeDbUrl = new URL(`/${upgradeDb}`, base).toString()
    } catch {
      upgradeDbUrl = undefined
    } finally {
      await admin.end()
    }
    if (!upgradeDbUrl) return
    pool = new pg.Pool({ connectionString: upgradeDbUrl, max: 1 })
    // Apply only migrations 1-12 with the same lock/stamp discipline.
    const client = await pool.connect()
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS memory_schema_migrations (
          version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())
      `)
      for (const migration of MEMORY_MIGRATIONS.filter(m => m.version <= 12)) {
        await client.query('BEGIN')
        try {
          for (const statement of migration.statements) await client.query(statement)
          await client.query('INSERT INTO memory_schema_migrations (version) VALUES ($1)', [migration.version])
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      }
    } finally {
      client.release()
    }
    // Legacy Phase 1 data: one installation and one episode. This episode was
    // first quarantined, then successfully re-extracted with a new extractor
    // configuration. Phase 2 must retain both provenance rows without making
    // the historical retry violate the Generation Run active-key invariant.
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ('54545454-5454-4544-8544-545454545454', 'pocketctl-memory', 'active', 'ready', 1)
    `)
    await pool.query(`
      INSERT INTO source_sessions (installation_id, session_id, first_recorded_at, last_recorded_at)
      VALUES ('54545454-5454-4544-8544-545454545454', 'ses-u', NOW(), NOW())
    `)
    await pool.query(`
      INSERT INTO source_turns (installation_id, turn_id, session_id, state, terminal_at)
      VALUES ('54545454-5454-4544-8544-545454545454', 'turn-u', 'ses-u', 'completed', NOW())
    `)
    await pool.query(`
      INSERT INTO work_episodes
        (installation_id, episode_id, session_id, turn_id, state, compiler_version,
         source_digest, document, evidence_manifest, document_compiler_version, compiled_at)
      VALUES ('54545454-5454-4544-8544-545454545454', gen_random_uuid(), 'ses-u', 'turn-u',
              'ready', 'c-v1', decode(md5('legacy'),'hex'), '{}'::jsonb, '{}'::jsonb,
              'd-v1', NOW())
    `)
    await pool.query(`
      INSERT INTO memory_extraction_runs
        (run_id, installation_id, episode_id, episode_source_digest, extractor_version,
         prompt_version, model_config_hash, input_digest, mode, state, provider, model)
      SELECT gen_random_uuid(), '54545454-5454-4544-8544-545454545454', episode_id,
             source_digest, 'ext-1', 'prompt-1', decode(md5('cfg'),'hex'),
             decode(md5('in'),'hex'), 'enabled', 'succeeded', 'p', 'm'
      FROM work_episodes LIMIT 1
    `)
    await pool.query(`
      INSERT INTO memory_extraction_runs
        (run_id, installation_id, episode_id, episode_source_digest, extractor_version,
         prompt_version, model_config_hash, input_digest, mode, state, provider, model,
         error_code, started_at, completed_at)
      SELECT gen_random_uuid(), '54545454-5454-4544-8544-545454545454', episode_id,
             source_digest, 'ext-2', 'prompt-2', decode(md5('cfg-2'),'hex'),
             decode(md5('in-2'),'hex'), 'enabled', 'quarantined', 'p', 'm',
             'invalid_output', NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '1 minute'
      FROM work_episodes LIMIT 1
    `)
  }, 120_000)

  afterAll(async () => {
    await pool?.end()
    if (upgradeDbUrl) {
      const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 })
      await admin.query(`DROP DATABASE IF EXISTS ${JSON.stringify(`${new URL(databaseUrl!).pathname.slice(1)}_phase2_upgrade`)}`).catch(() => undefined)
      await admin.end()
    }
  })

  test('migration 13 backfills a quarantined-then-succeeded legacy retry without an active-key collision', async () => {
    if (!pool) return
    await applyMemorySchema(pool)

    const legacy = await pool.query<{ generation_run_id: string | null; state: string }>(`
      SELECT generation_run_id::text, state FROM memory_extraction_runs ORDER BY state
    `)
    expect(legacy.rows).toHaveLength(2)
    expect(legacy.rows.map(row => row.generation_run_id)).not.toContain(null)
    expect(new Set(legacy.rows.map(row => row.generation_run_id)).size).toBe(2)

    const generated = await pool.query<{
      operation: string
      subject_kind: string
      state: string
    }>(`
      SELECT operation, subject_kind, state FROM memory_generation_runs
      ORDER BY state
    `)
    expect(generated.rows).toEqual([
      { operation: 'extract_candidates', subject_kind: 'episode', state: 'succeeded' },
      { operation: 'extract_candidates', subject_kind: 'episode', state: 'superseded' },
    ])

    // Re-running the applier is a no-op (13 already stamped).
    await applyMemorySchema(pool)
    const stamps = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM memory_schema_migrations WHERE version = 13`)
    expect(stamps.rows[0].n).toBe(1)
  })
})
