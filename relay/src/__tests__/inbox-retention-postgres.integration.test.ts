import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { deleteSession, deleteUserAccount, initDB } from '../db.js'
import { InboxRetention } from '../inbox-retention.js'
import { EventMaterializer } from '../materialization/event-materializer.js'
import { RealtimeOutboxWriter } from '../materialization/realtime-outbox.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

function failureGuard<T>(promise: Promise<T>, label: string, timeoutMs = 1_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
      timer.unref?.()
    }),
  ])
}

describeWithDatabase('InboxRetention PostgreSQL integration', () => {
  let pool: pg.Pool
  let retention: InboxRetention

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    const database = await pool.query<{ database_name: string }>('SELECT current_database() AS database_name')
    if (!/test/i.test(database.rows[0]?.database_name ?? '')) {
      throw new Error('Refusing PostgreSQL integration test against non-test database')
    }
    await initDB(pool)
    retention = new InboxRetention(pool)
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE realtime_outbox, event_inbox_receipt, event_inbox, daemon_ack_checkpoint RESTART IDENTITY CASCADE',
    )
    await pool.query(`DELETE FROM users WHERE email LIKE 'retention-%@example.test'`)
    await pool.query(`DELETE FROM deleted_sessions WHERE session_id LIKE 'retention-%'`)
    await pool.query(`DELETE FROM events WHERE session_id LIKE 'retention-%'`)
    await pool.query(`DELETE FROM sessions WHERE session_id LIKE 'retention-%'`)
    await pool.query(`DELETE FROM daemons WHERE daemon_id LIKE 'retention-%'`)
  })

  test('keeps pending, processing, dead-letter, recent, and undelivered rows', async () => {
    await pool.query(`
      INSERT INTO event_inbox
        (daemon_id, daemon_generation, seq, dedup_key, session_id, event_type, priority_class,
         payload, status, completed_at, claimed_at, claimed_by)
      VALUES
        ('retention-d', 1, 1, 'pending', 'retention-s', 'agent_text', 0, '{}', 0, NULL, NULL, NULL),
        ('retention-d', 1, 2, 'processing', 'retention-s', 'agent_text', 0, '{}', 1, NULL, NOW(), 'worker'),
        ('retention-d', 1, 3, 'eligible', 'retention-s', 'agent_text', 0, '{}', 2, NOW() - INTERVAL '7 hours', NULL, NULL),
        ('retention-d', 1, 4, 'blocked', 'retention-s', 'agent_text', 0, '{}', 2, NOW() - INTERVAL '7 hours', NULL, NULL),
        ('retention-d', 1, 5, 'dead-letter', 'retention-s', 'agent_text', 0, '{}', 3, NOW() - INTERVAL '48 hours', NULL, NULL),
        ('retention-d', 1, 6, 'recent', 'retention-s', 'agent_text', 0, '{}', 2, NOW() - INTERVAL '1 hour', NULL, NULL)
    `)
    await pool.query(`
      INSERT INTO realtime_outbox
        (inbox_id, delivery_key, event_id, user_id, session_id, event_type, audience, request_id, payload, delivered_at)
      SELECT inbox_id, 'inbox:' || inbox_id || ':session:-:0', NULL, NULL, session_id,
             event_type, 'session', NULL, payload,
             CASE WHEN dedup_key = 'eligible' THEN NOW() ELSE NULL END
      FROM event_inbox WHERE dedup_key IN ('eligible', 'blocked')
    `)

    await expect(retention.runOnce()).resolves.toEqual({
      deletedCompleted: 1,
      blockedUndelivered: 1,
    })
    const remaining = await pool.query<{ dedup_key: string }>(
      'SELECT dedup_key FROM event_inbox ORDER BY seq',
    )
    expect(remaining.rows.map((row) => row.dedup_key)).toEqual([
      'pending', 'processing', 'blocked', 'dead-letter', 'recent',
    ])
  })

  test('deletes at most 1000 eligible rows per run', async () => {
    await pool.query(`
      INSERT INTO event_inbox
        (daemon_id, daemon_generation, seq, dedup_key, session_id, event_type, priority_class,
         payload, status, completed_at)
      SELECT 'retention-batch', 1, n, 'batch-' || n, 'retention-batch-session',
             'agent_text', 0, '{}'::jsonb, 2, NOW() - INTERVAL '7 hours'
      FROM generate_series(1, 1001) AS n
    `)

    expect((await retention.runOnce()).deletedCompleted).toBe(1_000)
    const count = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM event_inbox WHERE daemon_id = 'retention-batch'`,
    )
    expect(count.rows[0].count).toBe(1)
  })

  test('deletes only old acknowledged receipt-only rows', async () => {
    await pool.query(
      `INSERT INTO daemon_ack_checkpoint (daemon_id, daemon_generation, ack_seq)
       VALUES ('receipt-only-retention', 1, 5)`,
    )
    await pool.query(
      `INSERT INTO event_inbox_receipt
         (inbox_id, daemon_id, daemon_generation, seq, received_at)
       VALUES
         (NULL, 'receipt-only-retention', 1, 1, NOW() - INTERVAL '7 hours'),
         (NULL, 'receipt-only-retention', 1, 2, NOW() - INTERVAL '1 hour'),
         (NULL, 'receipt-only-retention', 1, 6, NOW() - INTERVAL '7 hours')`,
    )

    await retention.runOnce()

    const remaining = await pool.query<{ seq: string }>(
      `SELECT seq FROM event_inbox_receipt
       WHERE daemon_id = 'receipt-only-retention'
       ORDER BY seq`,
    )
    expect(remaining.rows).toEqual([{ seq: '2' }, { seq: '6' }])
  })

  test('account and session deletion remove owned inbox/outbox while preserving self-hosted rows', async () => {
    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password_hash) VALUES ('retention-user@example.test', '') RETURNING id`,
    )
    const userId = user.rows[0].id
    await pool.query(
      `INSERT INTO daemons (daemon_id, user_id) VALUES ('retention-daemon', $1)`,
      [userId],
    )
    await pool.query(
      `INSERT INTO sessions (session_id, daemon_id, user_id) VALUES ('retention-session', 'retention-daemon', $1)`,
      [userId],
    )
    await pool.query(`
      INSERT INTO event_inbox
        (user_id, daemon_id, daemon_generation, seq, dedup_key, session_id, event_type, priority_class, payload)
      VALUES
        ($1, 'retention-daemon', 1, 1, 'account-owned', 'retention-session', 'agent_text', 0, '{}'),
        (NULL, 'retention-self-hosted', 1, 1, 'self-hosted', 'retention-self', 'agent_text', 0, '{}')
    `, [userId])
    await pool.query(`
      INSERT INTO realtime_outbox
        (inbox_id, delivery_key, event_id, user_id, session_id, event_type, audience, payload)
      SELECT inbox_id, 'inbox:' || inbox_id || ':session:-:0', NULL, user_id, session_id,
             event_type, 'session', payload
      FROM event_inbox
    `)

    await deleteSession(pool, 'retention-session')
    const sessionRows = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM event_inbox WHERE session_id = 'retention-session'`,
    )
    expect(sessionRows.rows[0].count).toBe(0)
    const tombstone = await pool.query(
      `SELECT 1 FROM deleted_sessions WHERE session_id = 'retention-session'`,
    )
    expect(tombstone.rowCount).toBe(1)

    await pool.query(`
      INSERT INTO event_inbox
        (user_id, daemon_id, daemon_generation, seq, dedup_key, session_id, event_type, priority_class, payload)
      VALUES ($1, 'retention-daemon', 1, 2, 'account-owned-after-session-delete',
              'retention-account-session', 'agent_text', 0, '{}')
    `, [userId])
    await pool.query(`
      INSERT INTO realtime_outbox
        (inbox_id, delivery_key, event_id, user_id, session_id, event_type, audience, payload)
      SELECT inbox_id, 'inbox:' || inbox_id || ':session:-:0', NULL, user_id, session_id,
             event_type, 'session', payload
      FROM event_inbox WHERE dedup_key = 'account-owned-after-session-delete'
    `)

    await deleteUserAccount(pool, userId)
    const remaining = await pool.query<{ dedup_key: string }>(
      `SELECT dedup_key FROM event_inbox ORDER BY dedup_key`,
    )
    expect(remaining.rows).toEqual([{ dedup_key: 'self-hosted' }])
    const remainingOutbox = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM realtime_outbox`,
    )
    expect(remainingOutbox.rows[0].count).toBe(1)
  })

  test('session deletion fences an in-flight materialization and leaves no ghost state', async () => {
    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password_hash) VALUES ('retention-race@example.test', '') RETURNING id`,
    )
    const userId = user.rows[0].id
    await pool.query(`INSERT INTO daemons (daemon_id, user_id) VALUES ('retention-race-daemon', $1)`, [userId])
    const inbox = await pool.query<{ inbox_id: string }>(`
      INSERT INTO event_inbox
        (user_id, daemon_id, daemon_generation, seq, dedup_key, session_id, event_type,
         priority_class, payload, status, attempts, claimed_at, claimed_by, materialization_context)
      VALUES ($1, 'retention-race-daemon', 1, 1, 'retention-race-event',
              'retention-race-session', 'session_created', 0,
              '{"type":"session_created","session_id":"retention-race-session"}',
              1, 1, NOW(), 'race-worker',
              '{"agentType":"codex","cwd":"/repo","hostname":"host","reservationId":"pause"}')
      RETURNING inbox_id
    `, [userId])
    let entered!: () => void
    let resume!: () => void
    const paused = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { resume = resolve })
    const materializer = new EventMaterializer({
      pool,
      durableHooks: {
        releaseQuotaReservation: async () => { entered(); await gate },
        notifyUser: async () => undefined,
        notifyProUser: async () => undefined,
      },
    })
    const materializing = materializer.materialize({
      inboxId: Number(inbox.rows[0].inbox_id),
      userId,
      daemonId: 'retention-race-daemon',
      sessionId: 'retention-race-session',
      eventType: 'session_created',
      payload: { type: 'session_created', session_id: 'retention-race-session' },
      context: { agentType: 'codex', cwd: '/repo', hostname: 'host', reservationId: 'pause' },
    })
    await paused
    const deleting = deleteSession(pool, 'retention-race-session')
    resume()
    const result = await materializing
    await new RealtimeOutboxWriter(pool).complete(
      Number(inbox.rows[0].inbox_id), result.eventId, result.deliveries, 'race-worker', 1,
    ).catch(() => undefined)
    await deleting

    const ghosts = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM sessions WHERE session_id = 'retention-race-session') AS sessions,
        (SELECT COUNT(*)::int FROM events WHERE session_id = 'retention-race-session') AS events,
        (SELECT COUNT(*)::int FROM event_inbox WHERE session_id = 'retention-race-session') AS inbox,
        (SELECT COUNT(*)::int FROM realtime_outbox WHERE session_id = 'retention-race-session') AS outbox
    `)
    expect(ghosts.rows[0]).toEqual({ sessions: 0, events: 0, inbox: 0, outbox: 0 })
  })

  test('pool max=1 completes adversarial delete/materialize ordering without ghosts or deadlock', async () => {
    const poolOne = new pg.Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 250,
    })
    try {
      const user = await poolOne.query<{ id: number }>(
        `INSERT INTO users (email, password_hash)
         VALUES ('retention-pool-one@example.test', '')
         ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
         RETURNING id`,
      )
      const userId = user.rows[0].id
      await poolOne.query(
        `INSERT INTO daemons (daemon_id, user_id) VALUES ('retention-pool-one-daemon', $1)
         ON CONFLICT (daemon_id) DO UPDATE SET user_id = EXCLUDED.user_id`,
        [userId],
      )
      const inbox = await poolOne.query<{ inbox_id: string }>(`
        INSERT INTO event_inbox
          (user_id, daemon_id, daemon_generation, seq, dedup_key, session_id, event_type,
           priority_class, payload, status, attempts, claimed_at, claimed_by, materialization_context)
        VALUES ($1, 'retention-pool-one-daemon', 1, 1, 'retention-pool-one-event',
                'retention-pool-one-session', 'session_created', 0,
                '{"type":"session_created","session_id":"retention-pool-one-session"}',
                1, 1, NOW(), 'pool-one-worker',
                '{"agentType":"codex","cwd":"/repo","hostname":"host","reservationId":"pause"}')
        RETURNING inbox_id
      `, [userId])
      let entered!: () => void
      let resume!: () => void
      const paused = new Promise<void>((resolve) => { entered = resolve })
      const gate = new Promise<void>((resolve) => { resume = resolve })
      const materializer = new EventMaterializer({
        pool: poolOne,
        durableHooks: {
          releaseQuotaReservation: async () => { entered(); await gate },
          notifyUser: async () => undefined,
          notifyProUser: async () => undefined,
        },
      })
      const materializing = materializer.materialize({
        inboxId: Number(inbox.rows[0].inbox_id),
        userId,
        daemonId: 'retention-pool-one-daemon',
        sessionId: 'retention-pool-one-session',
        eventType: 'session_created',
        payload: { type: 'session_created', session_id: 'retention-pool-one-session' },
        context: { agentType: 'codex', cwd: '/repo', hostname: 'host', reservationId: 'pause' },
      })
      await failureGuard(paused, 'materialization entering durable effect')
      const deleting = deleteSession(poolOne, 'retention-pool-one-session')
      resume()
      const result = await failureGuard(materializing, 'materialization')
      await new RealtimeOutboxWriter(poolOne).complete(
        Number(inbox.rows[0].inbox_id), result.eventId, result.deliveries, 'pool-one-worker', 1,
      ).catch(() => undefined)
      await failureGuard(deleting, 'deletion')

      const ghosts = await poolOne.query(`
        SELECT
          (SELECT COUNT(*)::int FROM sessions WHERE session_id = 'retention-pool-one-session') AS sessions,
          (SELECT COUNT(*)::int FROM events WHERE session_id = 'retention-pool-one-session') AS events,
          (SELECT COUNT(*)::int FROM event_inbox WHERE session_id = 'retention-pool-one-session') AS inbox,
          (SELECT COUNT(*)::int FROM realtime_outbox WHERE session_id = 'retention-pool-one-session') AS outbox
      `)
      expect(ghosts.rows[0]).toEqual({ sessions: 0, events: 0, inbox: 0, outbox: 0 })
    } finally {
      await poolOne.end()
    }
  })
})
