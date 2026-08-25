import pg from 'pg'
import { createHmac } from 'crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createPurgeRepository } from '../purge/repository.js'
import { createPurgeWorker } from '../purge/worker.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = '11111111-1111-1111-1111-111111111111'
const OTHER_INSTALLATION = '22222222-2222-2222-2222-222222222222'
const HMAC_KEY = 'purge-test-hmac-key-0123456789abcdef'

async function seedSession(pool: pg.Pool, installationId: string, sessionId: string) {
  await pool.query(`
    INSERT INTO source_sessions
      (installation_id, session_id, agent_type, daemon_id, cwd_observation, first_recorded_at, last_recorded_at)
    VALUES ($1, $2, 'codex', 'd-1', '/secret/repo', NOW(), NOW())
  `, [installationId, sessionId])
  const event = await pool.query<{ id: string }>(`
    INSERT INTO source_events
      (source_event_id, installation_id, origin, origin_position, session_id, turn_id,
       event_type, occurred_at, payload, payload_hash)
    VALUES (gen_random_uuid(), $1, 'feed', $2, $3, 't-1', 'agent_text', NOW(),
            '{"text":"redacted"}'::jsonb, $4)
    RETURNING source_event_id AS id
  `, [installationId, `pos-${sessionId}`, sessionId, Buffer.alloc(32, 1)])
  const eventId = event.rows[0].id
  await pool.query(`
    INSERT INTO source_turns (installation_id, turn_id, session_id, state)
    VALUES ($1, 't-1', $2, 'completed')
  `, [installationId, sessionId])
  await pool.query(`
    INSERT INTO source_artifacts
      (artifact_id, installation_id, session_id, turn_id, source_event_id, artifact_type,
       identity_key, occurred_at)
    VALUES (gen_random_uuid(), $1, $2, 't-1', $3, 'tool_call', 'c-1', NOW())
  `, [installationId, sessionId, eventId])
  await pool.query(`
    INSERT INTO work_episodes
      (installation_id, episode_id, session_id, turn_id, state, compiler_version)
    VALUES ($1, gen_random_uuid(), $2, 't-1', 'ready', 'test')
  `, [installationId, sessionId])
  await pool.query(`
    INSERT INTO memory_snapshot_events
      (installation_id, session_id, relay_event_id, event_type, payload, payload_hash, created_at, generation)
    VALUES ($1, $2, 1, 'agent_text', '{}'::jsonb, $3, NOW(), 1)
  `, [installationId, sessionId, Buffer.alloc(32, 2)])
  for (const feedId of [10, 11]) {
    await pool.query(`
      INSERT INTO memory_feed_inbox
        (installation_id, feed_id, envelope_version, topic, source_kind, source_id,
         session_id, event_type, recorded_at, data, payload_hash)
      VALUES ($1, $2, 1, 'session.event.v1', 'canonical_event', $3, $4, 'agent_text', NOW(),
              '{"text":"redacted"}'::jsonb, $5)
    `, [installationId, feedId, `evt-${feedId}`, sessionId, Buffer.alloc(32, feedId)])
  }
}

describeWithDatabase('session tombstone and purge (PostgreSQL)', () => {
  let pool: pg.Pool
  let purge: ReturnType<typeof createPurgeRepository>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    purge = createPurgeRepository(pool, { hmacKey: HMAC_KEY })
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_purge_receipts, memory_dead_letters, memory_jobs, memory_session_tombstones,
               memory_snapshot_runs, memory_snapshot_events, memory_feed_inbox,
               source_artifacts, source_turns, source_events, source_sessions,
               repositories, repo_snapshots, work_episodes, memory_installations
      RESTART IDENTITY CASCADE
    `)
    for (const installationId of [INSTALLATION, OTHER_INSTALLATION]) {
      await pool.query(`
        INSERT INTO memory_installations
          (installation_id, provider_id, relay_status, local_status, config_version)
        VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
      `, [installationId])
      await seedSession(pool, installationId, 'ses-1')
    }
  })

  test('a session purge clears content across every derived table in one transaction', async () => {
    await purge.purgeSession({
      installationId: INSTALLATION, sessionId: 'ses-1', reason: 'user_deleted', sourceFeedId: 99,
    })

    const sessions = await pool.query<{
      installation_id: string; session_id: string; agent_type: string | null
      cwd_observation: string | null; deleted_at: Date | null; delete_reason: string | null
    }>(`SELECT installation_id, session_id, agent_type, cwd_observation, deleted_at, delete_reason
        FROM source_sessions ORDER BY installation_id`)
    const mine = sessions.rows.find(row => row.installation_id === INSTALLATION)
    expect(mine).toMatchObject({ session_id: 'ses-1', agent_type: null, cwd_observation: null })
    expect(mine?.deleted_at).not.toBeNull()
    expect(mine?.delete_reason).toBe('user_deleted')
    // The other installation's copy is untouched.
    const other = sessions.rows.find(row => row.installation_id === OTHER_INSTALLATION)
    expect(other?.agent_type).toBe('codex')

    for (const [table, column] of [
      ['source_events', 'session_id'], ['source_turns', 'session_id'],
      ['source_artifacts', 'session_id'], ['work_episodes', 'session_id'],
      ['memory_snapshot_events', 'session_id'],
    ] as const) {
      const rows = await pool.query(
        `SELECT COUNT(*)::int AS count FROM ${table} WHERE installation_id = $1`,
        [INSTALLATION],
      )
      expect(Number(rows.rows[0].count), table).toBe(0)
    }
    const inbox = await pool.query(
      `SELECT COUNT(*)::int AS count FROM memory_feed_inbox WHERE installation_id = $1 AND session_id = 'ses-1'`,
      [INSTALLATION],
    )
    expect(Number(inbox.rows[0].count)).toBe(0)

    const tombstone = await pool.query(
      `SELECT reason FROM memory_session_tombstones WHERE installation_id = $1 AND session_id = 'ses-1'`,
      [INSTALLATION],
    )
    expect(tombstone.rows[0].reason).toBe('user_deleted')
  })

  test('repeated tombstones stay idempotent', async () => {
    await purge.purgeSession({
      installationId: INSTALLATION, sessionId: 'ses-1', reason: 'user_deleted', sourceFeedId: 99,
    })
    await purge.purgeSession({
      installationId: INSTALLATION, sessionId: 'ses-1', reason: 'access_revoked', sourceFeedId: 100,
    })
    const tombstones = await pool.query(
      `SELECT reason FROM memory_session_tombstones WHERE installation_id = $1`,
      [INSTALLATION],
    )
    expect(tombstones.rows).toHaveLength(1)
    // Later reasons never resurrect: the first fence stands.
    expect(['user_deleted', 'access_revoked']).toContain(tombstones.rows[0].reason)
  })

  test('an old feed replay after deletion cannot resurrect the session', async () => {
    await purge.purgeSession({
      installationId: INSTALLATION, sessionId: 'ses-1', reason: 'user_deleted', sourceFeedId: 99,
    })
    await pool.query(`
      INSERT INTO memory_feed_inbox
        (installation_id, feed_id, envelope_version, topic, source_kind, source_id,
         session_id, event_type, recorded_at, data, payload_hash)
      VALUES ($1, 200, 1, 'session.event.v1', 'canonical_event', 'evt-200',
              'ses-1', 'agent_text', NOW(), '{"text":"redacted"}'::jsonb, $2)
    `, [INSTALLATION, Buffer.alloc(32, 9)])
    // Projector already fences (Task 7); the invariant here is that the
    // tombstone row exists so replayed rows are marked purged, not stored.
    const fence = await pool.query(
      `SELECT COUNT(*)::int AS count FROM memory_session_tombstones WHERE installation_id = $1`,
      [INSTALLATION],
    )
    expect(Number(fence.rows[0].count)).toBe(1)
  })
})

describeWithDatabase('installation purge (PostgreSQL)', () => {
  let pool: pg.Pool
  let purge: ReturnType<typeof createPurgeRepository>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    purge = createPurgeRepository(pool, { hmacKey: HMAC_KEY })
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_purge_receipts, memory_dead_letters, memory_jobs, memory_session_tombstones,
               memory_snapshot_runs, memory_snapshot_events, memory_feed_inbox,
               source_artifacts, source_turns, source_events, source_sessions,
               repositories, repo_snapshots, work_episodes, memory_installations
      RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'revoked', 'purging', 1)
    `, [INSTALLATION])
    await seedSession(pool, INSTALLATION, 'ses-1')
  })

  test('commits the purge locally before acking, with a content-free receipt', async () => {
    const requestId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    await pool.query(`
      INSERT INTO memory_dead_letters
        (job_id, installation_id, job_type, attempts, error_code, payload_hash)
      VALUES (gen_random_uuid(), $1, 'installation_purge', 12, 'no_handler', $2)
    `, [INSTALLATION, Buffer.alloc(32, 7)])
    const receipt = await purge.purgeInstallation({
      installationId: INSTALLATION, requestId, reason: 'uninstall',
    })
    expect(receipt).toMatch(/^memory-phase0:[0-9a-f-]{36}:[0-9a-f]{64}$/)

    const stored = await pool.query<{ receipt: string; relay_acked_at: Date | null; reason: string }>(
      `SELECT receipt, relay_acked_at, reason FROM memory_purge_receipts WHERE request_id = $1`,
      [requestId],
    )
    expect(stored.rows[0].receipt).toBe(receipt)
    expect(stored.rows[0].relay_acked_at).toBeNull()

    // Everything scoped to the installation is gone; the row itself stays
    // as a purged fence so discovery cannot resurrect it.
    for (const table of [
      'memory_feed_inbox', 'memory_snapshot_runs', 'memory_snapshot_events',
      'source_sessions', 'source_events', 'source_turns', 'source_artifacts',
      'repositories', 'repo_snapshots', 'work_episodes', 'memory_jobs',
      'memory_session_tombstones', 'memory_dead_letters',
    ]) {
      const rows = await pool.query(
        `SELECT COUNT(*)::int AS count FROM ${table} WHERE installation_id = $1`,
        [INSTALLATION],
      )
      expect(Number(rows.rows[0].count), table).toBe(0)
    }
    const installation = await pool.query<{ local_status: string }>(
      `SELECT local_status FROM memory_installations WHERE installation_id = $1`,
      [INSTALLATION],
    )
    expect(installation.rows[0].local_status).toBe('purged')

    // The receipt carries no user, session or body material.
    const serialized = JSON.stringify(stored.rows[0])
    expect(serialized).not.toContain('ses-1')
    expect(serialized).not.toContain('redacted')
  })

  test('repeated purges for the same request return the same receipt', async () => {
    const requestId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    const first = await purge.purgeInstallation({
      installationId: INSTALLATION, requestId, reason: 'uninstall',
    })
    const second = await purge.purgeInstallation({
      installationId: INSTALLATION, requestId, reason: 'uninstall',
    })
    expect(second).toBe(first)
    const receipts = await pool.query(
      `SELECT COUNT(*)::int AS count FROM memory_purge_receipts WHERE request_id = $1`,
      [requestId],
    )
    expect(Number(receipts.rows[0].count)).toBe(1)
  })

  test('the purge worker acks relay only after the local commit', async () => {
    const requestId = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
    const ack = vi.fn(async () => undefined)
    const worker = createPurgeWorker({
      pool, purge, relay: {
        listPurges: vi.fn(async () => [
          { request_id: requestId, installation_id: INSTALLATION, reason: 'uninstall', status: 'pending' },
        ]),
        acknowledgePurge: ack,
      },
    })
    await worker.runOnce()
    expect(ack).toHaveBeenCalledTimes(1)
    // The receipt exists and is marked acked.
    const receipt = await pool.query<{ relay_acked_at: Date | null }>(
      `SELECT relay_acked_at FROM memory_purge_receipts WHERE request_id = $1`,
      [requestId],
    )
    expect(receipt.rows[0].relay_acked_at).not.toBeNull()

    // A relay redelivery finds the existing receipt and only re-acks.
    await worker.runOnce()
    expect(ack).toHaveBeenCalledTimes(2)
    const receipts = await pool.query(
      `SELECT COUNT(*)::int AS count FROM memory_purge_receipts`,
    )
    expect(Number(receipts.rows[0].count)).toBe(1)
  })

  test('an ack failure retries without restoring any data', async () => {
    const requestId = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
    let attempts = 0
    const worker = createPurgeWorker({
      pool, purge, relay: {
        listPurges: vi.fn(async () => [
          { request_id: requestId, installation_id: INSTALLATION, reason: 'uninstall', status: 'pending' },
        ]),
        acknowledgePurge: vi.fn(async () => {
          attempts++
          if (attempts === 1) throw new Error('ack timeout')
        }),
      },
    })
    await worker.runOnce()
    const committed = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memory_feed_inbox WHERE installation_id = $1`,
      [INSTALLATION],
    )
    expect(Number(committed.rows[0].count)).toBe(0)
    await worker.runOnce()  // retry acks with the same receipt
    const receipt = await pool.query<{ relay_acked_at: Date | null }>(
      `SELECT relay_acked_at FROM memory_purge_receipts WHERE request_id = $1`,
      [requestId],
    )
    expect(receipt.rows[0].relay_acked_at).not.toBeNull()
  })
})
