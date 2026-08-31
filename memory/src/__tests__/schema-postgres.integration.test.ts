import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { applyMemorySchema, MEMORY_MIGRATIONS } from '../schema.js'
import {
  MEMORY_TEST_DATABASE_TABLES,
  assertMemoryTestDatabase,
  memoryTestDatabaseConfig,
} from '../testing/test-db.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

describe('memory schema guard (unit)', () => {
  test('accepts purpose-named loopback test databases', () => {
    expect(() => memoryTestDatabaseConfig(
      'postgresql://pocketctl_memory_test:pocketctl_memory_test@localhost:5432/pocketctl_memory_test',
    )).not.toThrow()
    // Any loopback db whose name contains "test" and whose role matches the
    // name satisfies the generalized purpose-named rule.
    expect(() => memoryTestDatabaseConfig(
      'postgresql://other_test:other_test@localhost:5432/other_test',
    )).not.toThrow()
  })

  test('rejects remote hosts, non-test names, mismatched roles and options', () => {
    for (const candidate of [
      'postgresql://memory:memory@db.internal:5432/memory_test',
      'postgresql://memory:memory@localhost:5432/pocketctl',
      'postgresql://memory_test:memory_test@localhost:5432/memory_test?options=-csearch_path%3Devil',
      'not a url',
    ]) {
      expect(() => memoryTestDatabaseConfig(candidate), candidate).toThrow(/MEMORY_TEST_DATABASE_URL/)
    }
  })
})

describeWithDatabase('memory schema (PostgreSQL)', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  test('applies idempotently and records the migration version', async () => {
    // Drop everything Memory owns, then apply twice.
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`)
    await applyMemorySchema(pool)
    await applyMemorySchema(pool)

    const tables = await pool.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema()
      ORDER BY table_name
    `)
    const names = tables.rows.map(row => row.table_name)
    for (const table of MEMORY_TEST_DATABASE_TABLES) {
      expect(names, table).toContain(table)
    }

    const versions = await pool.query<{ version: number }>(
      `SELECT version FROM memory_schema_migrations ORDER BY version`,
    )
    expect(versions.rows.map(row => Number(row.version))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24])

    // v4 must have removed the obsolete observed_at-bearing unique that v2
    // failed to drop (its auto-generated name is truncated past 63 chars);
    // pinning the surviving constraint list is what catches that class.
    const constraints = await pool.query<{ def: string }>(`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'repo_snapshots'::regclass AND contype = 'u'
      ORDER BY def
    `)
    expect(constraints.rows.map(row => row.def)).toEqual([
      'UNIQUE (installation_id, repo_snapshot_id)',
      'UNIQUE (installation_id, repository_id, commit_sha)',
    ])
  })

  test('allows only one running snapshot generation per installation (v5)', async () => {
    const installation = '44444444-4444-4444-4444-444444444444'
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
    `, [installation])
    const insert = (generation: number) => pool.query(`
      INSERT INTO memory_snapshot_runs (run_id, installation_id, generation, state)
      VALUES (gen_random_uuid(), $1, $2, 'running')
    `, [installation, generation])

    await expect(insert(1)).resolves.toBeDefined()
    await expect(insert(2)).rejects.toThrow(/duplicate key/)
    // Failed generations never block a new run.
    await pool.query(`UPDATE memory_snapshot_runs SET state = 'failed' WHERE generation = 1`)
    await expect(insert(3)).resolves.toBeDefined()
    await pool.query(`DELETE FROM memory_installations WHERE installation_id = $1`, [installation])
  })

  test('persists snapshot reconcile acknowledgements for ack-only retry (v6)', async () => {
    const column = await pool.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'memory_snapshot_runs' AND column_name = 'relay_acked_at'
      ) AS exists
    `)
    expect(column.rows[0].exists).toBe(true)
  })

  test('migration v6 distinguishes pending snapshot acknowledgements from completed jobs', async () => {
    const installation = '66666666-6666-6666-6666-666666666666'
    const ackedInstallation = '77777777-7777-7777-7777-777777777777'
    const supersededInstallation = '88888888-8888-8888-8888-888888888888'
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1),
             ($2, 'pocketctl-memory', 'active', 'ready', 1),
             ($3, 'pocketctl-memory', 'active', 'ready', 1)
    `, [installation, ackedInstallation, supersededInstallation])
    await pool.query(`
      INSERT INTO memory_snapshot_runs
        (run_id, installation_id, generation, state, completed_at)
      VALUES (gen_random_uuid(), $1, 1, 'completed', NOW() - INTERVAL '1 hour'),
             (gen_random_uuid(), $2, 1, 'completed', NOW()),
             (gen_random_uuid(), $3, 1, 'completed', NOW()),
             (gen_random_uuid(), $3, 2, 'failed', NOW())
    `, [installation, ackedInstallation, supersededInstallation])
    await pool.query(`
      INSERT INTO memory_jobs
        (job_id, installation_id, job_type, idempotency_key, state, created_at)
      VALUES (gen_random_uuid(), $1, 'snapshot_reconcile', $3, 'pending', NOW() - INTERVAL '2 hours'),
             (gen_random_uuid(), $2, 'snapshot_reconcile', $4, 'completed', NOW()),
             (gen_random_uuid(), $5, 'snapshot_reconcile', $6, 'pending', NOW())
    `, [
      installation, ackedInstallation,
      `snapshot:${installation}`, `snapshot:${ackedInstallation}`,
      supersededInstallation, `snapshot:${supersededInstallation}`,
    ])

    try {
      await pool.query(`ALTER TABLE memory_snapshot_runs DROP COLUMN relay_acked_at`)
      const v6 = MEMORY_MIGRATIONS.find(migration => migration.version === 6)
      expect(v6).toBeDefined()
      for (const statement of v6!.statements) await pool.query(statement)

      const runs = await pool.query<{ installation_id: string; relay_acked_at: Date | null }>(`
        SELECT installation_id::text, relay_acked_at
        FROM memory_snapshot_runs
        WHERE state = 'completed' AND installation_id = ANY($1::uuid[])
        ORDER BY installation_id
      `, [[installation, ackedInstallation, supersededInstallation]])
      expect(runs.rows[0]).toEqual({ installation_id: installation, relay_acked_at: null })
      expect(runs.rows[1].installation_id).toBe(ackedInstallation)
      expect(runs.rows[1].relay_acked_at).not.toBeNull()
      expect(runs.rows[2].installation_id).toBe(supersededInstallation)
      expect(runs.rows[2].relay_acked_at).not.toBeNull()
    } finally {
      await pool.query(`
        ALTER TABLE memory_snapshot_runs
        ADD COLUMN IF NOT EXISTS relay_acked_at TIMESTAMPTZ
      `)
      await pool.query(`
        DELETE FROM memory_installations WHERE installation_id = ANY($1::uuid[])
      `, [[installation, ackedInstallation, supersededInstallation]])
    }
  })

  test('migration v6 does not treat a newer snapshot job as an old pending acknowledgement', async () => {
    const installation = '99999999-9999-9999-9999-999999999999'
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'syncing', 1)
    `, [installation])
    await pool.query(`
      INSERT INTO memory_snapshot_runs
        (run_id, installation_id, generation, state, completed_at)
      VALUES (gen_random_uuid(), $1, 1, 'completed', NOW() - INTERVAL '2 hours')
    `, [installation])
    await pool.query(`
      INSERT INTO memory_jobs
        (job_id, installation_id, job_type, idempotency_key, state, created_at)
      VALUES (gen_random_uuid(), $1, 'snapshot_reconcile', $2, 'pending',
              NOW() - INTERVAL '1 hour')
    `, [installation, `snapshot:${installation}`])

    try {
      await pool.query(`ALTER TABLE memory_snapshot_runs DROP COLUMN relay_acked_at`)
      const v6 = MEMORY_MIGRATIONS.find(migration => migration.version === 6)
      expect(v6).toBeDefined()
      for (const statement of v6!.statements) await pool.query(statement)

      const run = await pool.query<{ relay_acked_at: Date | null }>(`
        SELECT relay_acked_at FROM memory_snapshot_runs
        WHERE installation_id = $1 AND generation = 1
      `, [installation])
      expect(run.rows[0].relay_acked_at).not.toBeNull()
    } finally {
      await pool.query(`
        ALTER TABLE memory_snapshot_runs
        ADD COLUMN IF NOT EXISTS relay_acked_at TIMESTAMPTZ
      `)
      await pool.query(`DELETE FROM memory_installations WHERE installation_id = $1`, [installation])
    }
  })

  test('migration v18 requeues only repository-less episodes with a trusted same-session lifecycle fact', async () => {
    const installation = '18181818-1818-4818-8818-181818181818'
    const terminalAt = new Date('2026-08-29T06:00:00.000Z')
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
    `, [installation])

    try {
      await pool.query(`
        INSERT INTO source_sessions
          (installation_id, session_id, agent_type, first_recorded_at, last_recorded_at)
        VALUES ($1, 'ses-repository', 'codex', $2, $2),
               ($1, 'ses-without-repository', 'opencode', $2, $2)
      `, [installation, terminalAt])
      await pool.query(`
        INSERT INTO repositories
          (repository_id, installation_id, repository_key, first_observed_at, last_observed_at)
        VALUES (gen_random_uuid(), $1, 'gitee.com/muwb123/pocketctl', $2, $2)
      `, [installation, terminalAt])
      await pool.query(`
        INSERT INTO source_events
          (source_event_id, installation_id, origin, origin_position, session_id,
           turn_id, event_type, occurred_at, payload, payload_hash)
        VALUES (gen_random_uuid(), $1, 'feed', 'v18:lifecycle', 'ses-repository',
                NULL, 'session_created', $2::timestamptz - INTERVAL '1 minute',
                '{"repository_id":"gitee.com/muwb123/pocketctl"}'::jsonb,
                decode(md5('v18:lifecycle'), 'hex'))
      `, [installation, terminalAt])
      await pool.query(`
        INSERT INTO work_episodes
          (installation_id, episode_id, session_id, turn_id, state, outcome,
           terminal_at, ready_at, compiler_version, document_compiler_version)
        VALUES ($1, gen_random_uuid(), 'ses-repository', 'turn-repository',
                'ready', 'completed', $2, $2, 'memory-episode-v1', 'memory-episode-packet-v2'),
               ($1, gen_random_uuid(), 'ses-without-repository', 'turn-without-repository',
                'ready', 'completed', $2, $2, 'memory-episode-v1', 'memory-episode-packet-v2')
      `, [installation, terminalAt])
      await pool.query(`
        INSERT INTO memory_jobs
          (job_id, installation_id, job_type, idempotency_key, priority, state,
           attempts, claimed_by, claim_expires_at, last_error_code, completed_at)
        VALUES (gen_random_uuid(), $1, 'compile_episode', 'compile_episode:turn-repository',
                80, 'completed', 3, 'old-worker', $2, 'old-error', $2),
               (gen_random_uuid(), $1, 'compile_episode', 'compile_episode:turn-without-repository',
                80, 'completed', 2, NULL, NULL, NULL, $2)
      `, [installation, terminalAt])

      const v18 = MEMORY_MIGRATIONS.find(migration => migration.version === 18)
      expect(v18).toBeDefined()
      for (let pass = 0; pass < 2; pass++) {
        for (const statement of v18!.statements) await pool.query(statement)
      }

      const jobs = await pool.query<{
        idempotency_key: string
        state: string
        attempts: number
        claimed_by: string | null
        claim_expires_at: Date | null
        last_error_code: string | null
        completed_at: Date | null
      }>(`
        SELECT idempotency_key, state, attempts, claimed_by, claim_expires_at,
               last_error_code, completed_at
        FROM memory_jobs
        WHERE installation_id = $1 AND job_type = 'compile_episode'
        ORDER BY idempotency_key
      `, [installation])
      expect(jobs.rows).toEqual([
        {
          idempotency_key: 'compile_episode:turn-repository',
          state: 'pending',
          attempts: 0,
          claimed_by: null,
          claim_expires_at: null,
          last_error_code: null,
          completed_at: null,
        },
        {
          idempotency_key: 'compile_episode:turn-without-repository',
          state: 'completed',
          attempts: 2,
          claimed_by: null,
          claim_expires_at: null,
          last_error_code: null,
          completed_at: terminalAt,
        },
      ])
    } finally {
      await pool.query(`DELETE FROM memory_installations WHERE installation_id = $1`, [installation])
    }
  })

  test('migration v5 repairs duplicate running rows before creating its index', async () => {
    const installation = '55555555-5555-5555-5555-555555555555'
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
    `, [installation])
    // Simulate pre-v5 dirty state: index absent, two concurrent running rows.
    // The finally block restores both no matter where the assertions fail —
    // exactly the case this test exists to catch — so later suites never
    // inherit a schema missing the v5 constraint.
    try {
      await pool.query(`DROP INDEX idx_memory_snapshot_runs_one_running`)
      for (const [generation, offset] of [[1, '2 hours'], [2, '1 hour']] as const) {
        await pool.query(`
          INSERT INTO memory_snapshot_runs (run_id, installation_id, generation, state, started_at)
          VALUES (gen_random_uuid(), $1, $2, 'running', NOW() - INTERVAL '${offset}')
        `, [installation, generation])
      }

      // Apply the v5 statements verbatim, twice (the repair must be idempotent).
      const v5 = MEMORY_MIGRATIONS.find(migration => migration.version === 5)
      expect(v5).toBeDefined()
      for (let pass = 0; pass < 2; pass++) {
        for (const statement of v5!.statements) await pool.query(statement)
      }

      const runs = await pool.query<{ generation: string; state: string; error_code: string | null }>(`
        SELECT generation::text, state, error_code FROM memory_snapshot_runs
        WHERE installation_id = $1 ORDER BY generation
      `, [installation])
      expect(runs.rows).toEqual([
        { generation: '1', state: 'failed', error_code: 'superseded_running' },
        { generation: '2', state: 'running', error_code: null },
      ])
      const index = await pool.query<{ regname: string | null }>(`
        SELECT to_regclass('idx_memory_snapshot_runs_one_running') AS regname
      `)
      expect(index.rows[0].regname).not.toBeNull()
    } finally {
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_snapshot_runs_one_running
          ON memory_snapshot_runs (installation_id)
          WHERE state = 'running'
      `)
      await pool.query(`DELETE FROM memory_installations WHERE installation_id = $1`, [installation])
    }
  })

  test('dedupes repo_snapshots per (installation, repository, commit)', async () => {
    const installation = '22222222-2222-2222-2222-222222222222'
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
    `, [installation])
    const repo = await pool.query<{ repository_id: string }>(`
      INSERT INTO repositories (repository_id, installation_id, repository_key, first_observed_at, last_observed_at)
      VALUES (gen_random_uuid(), $1, 'github.com/acme/app', NOW(), NOW())
      RETURNING repository_id
    `, [installation])
    for (let i = 0; i < 3; i++) {
      await pool.query(`
        INSERT INTO repo_snapshots
          (repo_snapshot_id, installation_id, repository_id, commit_sha, branch, observed_at)
        VALUES (gen_random_uuid(), $1, $2, 'abc1234', 'main', NOW() + ($3 * INTERVAL '1 second'))
        ON CONFLICT (installation_id, repository_id, commit_sha) DO UPDATE SET
          observed_at = EXCLUDED.observed_at
      `, [installation, repo.rows[0].repository_id, i])
    }
    const rows = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM repo_snapshots WHERE installation_id = $1`,
      [installation],
    )
    expect(Number(rows.rows[0].count)).toBe(1)
    await pool.query(`DELETE FROM memory_installations WHERE installation_id = $1`, [installation])
  })

  test('never creates Relay extension tables in the memory database', async () => {
    const relayTables = await pool.query<{ regname: string | null }>(`
      SELECT to_regclass('extension_feed') AS regname
      UNION ALL SELECT to_regclass('extension_installations')
      UNION ALL SELECT to_regclass('sessions')
      UNION ALL SELECT to_regclass('events')
      UNION ALL SELECT to_regclass('users')
    `)
    expect(relayTables.rows.every(row => row.regname === null)).toBe(true)
  })

  test('enforces installation identity and status allowlists', async () => {
    await expect(pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ('11111111-1111-1111-1111-111111111111', 'other-provider', 'pending', 'discovering', 1)
    `)).rejects.toThrow(/provider_id/)
    await expect(pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ('11111111-1111-1111-1111-111111111111', 'pocketctl-memory', 'bogus', 'discovering', 1)
    `)).rejects.toThrow(/relay_status/)
    await expect(pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ('11111111-1111-1111-1111-111111111111', 'pocketctl-memory', 'active', 'bogus', 1)
    `)).rejects.toThrow(/local_status/)
    await expect(pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ('11111111-1111-1111-1111-111111111111', 'pocketctl-memory', 'active', 'ready', 0)
    `)).rejects.toThrow(/config_version/)
  })

  test('feed inbox is idempotent on installation_id + feed_id', async () => {
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ('22222222-2222-2222-2222-222222222222', 'pocketctl-memory', 'active', 'ready', 1)
    `)
    const row = {
      installation_id: '22222222-2222-2222-2222-222222222222',
      feed_id: 7,
      envelope_version: 1,
      topic: 'session.event.v1',
      source_kind: 'canonical_event',
      source_id: 'src-1',
      event_type: 'agent_text',
      recorded_at: new Date().toISOString(),
      data: JSON.stringify({ text: 'x' }),
      payload_hash: Buffer.from('a'.repeat(32), 'hex'),
    }
    await pool.query(`
      INSERT INTO memory_feed_inbox
        (installation_id, feed_id, envelope_version, topic, source_kind, source_id,
         event_type, recorded_at, data, payload_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
    `, [row.installation_id, row.feed_id, row.envelope_version, row.topic,
      row.source_kind, row.source_id, row.event_type, row.recorded_at, row.data, row.payload_hash])
    await expect(pool.query(`
      INSERT INTO memory_feed_inbox
        (installation_id, feed_id, envelope_version, topic, source_kind, source_id,
         event_type, recorded_at, data, payload_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
    `, [row.installation_id, row.feed_id, row.envelope_version, row.topic,
      row.source_kind, row.source_id, row.event_type, row.recorded_at, row.data, row.payload_hash])
    ).rejects.toThrow(/duplicate key/)
  })

  test('jobs dedupe with NULLS NOT DISTINCT on nullable installation', async () => {
    const insert = (idempotencyKey: string, installationId: string | null) => pool.query<{ job_id: string }>(`
      INSERT INTO memory_jobs (job_id, installation_id, job_type, idempotency_key, priority)
      VALUES (gen_random_uuid(), $1, 'report_status', $2, 100)
      RETURNING job_id
    `, [installationId, idempotencyKey])
    const first = await insert('status-null', null)
    // NULL installation rows compare as equal under NULLS NOT DISTINCT.
    await expect(insert('status-null', null)).rejects.toThrow(/duplicate key/)
    // A concrete installation id is a distinct key from the NULL row.
    await expect(insert('status-null', '22222222-2222-2222-2222-222222222222')).resolves.toBeDefined()
    await expect(insert('status-null', '22222222-2222-2222-2222-222222222222')).rejects.toThrow(/duplicate key/)
    expect(first.rows).toHaveLength(1)
  })

  test('turn and episode states are constrained', async () => {
    await expect(pool.query(`
      INSERT INTO source_turns (installation_id, turn_id, session_id, state)
      VALUES ('22222222-2222-2222-2222-222222222222', 't-1', 's-1', 'bogus')
    `)).rejects.toThrow(/state/)
    await expect(pool.query(`
      INSERT INTO work_episodes (installation_id, episode_id, session_id, turn_id, state, compiler_version)
      VALUES ('22222222-2222-2222-2222-222222222222', gen_random_uuid(), 's-1', 't-1', 'bogus', 'v1')
    `)).rejects.toThrow(/state/)
  })

  test('purge receipts survive installation deletion (no foreign key)', async () => {
    const receipt = await pool.query<{ request_id: string }>(`
      INSERT INTO memory_purge_receipts (request_id, installation_id, reason, receipt, local_committed_at)
      VALUES (gen_random_uuid(), '33333333-3333-3333-3333-333333333333', 'uninstall', 'memory-phase0:test', NOW())
      RETURNING request_id
    `)
    expect(receipt.rows).toHaveLength(1)
    // The installation row above never existed; the receipt stands alone.
    const count = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memory_purge_receipts`,
    )
    expect(Number(count.rows[0].count)).toBeGreaterThanOrEqual(1)
  })
})
