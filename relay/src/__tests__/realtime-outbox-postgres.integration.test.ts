import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import {
  RealtimeOutboxConsumer,
  RealtimeOutboxRepository,
  RealtimeOutboxWriter,
} from '../materialization/realtime-outbox.js'
import { Router } from '../router.js'

function ws(): any {
  const sent: unknown[] = []
  return {
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw)),
    close: () => undefined,
    terminate: () => undefined,
    _sent: sent,
  }
}

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

describeWithDatabase('realtime outbox PostgreSQL integration', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    const database = await pool.query<{ database_name: string }>('SELECT current_database() AS database_name')
    if (!/test/i.test(database.rows[0]?.database_name ?? '')) {
      throw new Error('Refusing PostgreSQL integration test against non-test database')
    }
    await initDB(pool)
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE realtime_outbox, event_inbox_receipt, event_inbox, daemon_ack_checkpoint RESTART IDENTITY CASCADE',
    )
  })

  test('commits inbox completion and distinct deliveries atomically without synthetic event ids', async () => {
    const inbox = await pool.query<{ inbox_id: string }>(
      `INSERT INTO event_inbox
         (daemon_id, daemon_generation, seq, dedup_key, session_id, event_type, priority_class, payload, status, attempts, claimed_at, claimed_by)
       VALUES ('daemon-1', 1, 1, 'outbox-1', 'session-1', 'interaction_result', 0, '{}'::jsonb, 1, 1, NOW(), 'worker-1')
       RETURNING inbox_id`,
    )
    const inboxId = Number(inbox.rows[0].inbox_id)
    const writer = new RealtimeOutboxWriter(pool)
    const delivery = {
      inboxId,
      daemonId: 'daemon-1',
      eventId: null,
      userId: null,
      audience: 'interaction-origin' as const,
      sessionId: 'session-1',
      requestId: 'request-1',
      ordinal: 0,
      deliveryKey: `inbox:${inboxId}:interaction-origin:request-1:0`,
      type: 'interaction_result',
      payload: { type: 'interaction_result', session_id: 'session-1', request_id: 'request-1' },
    }

    await writer.complete(inboxId, null, [delivery, delivery], 'worker-1', 1)

    const state = await pool.query(
      `SELECT i.status, i.materialized_event_id, COUNT(o.outbox_id)::int AS deliveries,
              MIN(o.event_id) AS event_id, MIN(o.delivery_key) AS delivery_key
       FROM event_inbox i LEFT JOIN realtime_outbox o USING (inbox_id)
       WHERE i.inbox_id = $1 GROUP BY i.inbox_id`,
      [inboxId],
    )
    expect(state.rows[0]).toMatchObject({
      status: 2,
      materialized_event_id: null,
      deliveries: 1,
      event_id: null,
      delivery_key: `inbox:${inboxId}:interaction-origin:request-1:0`,
    })
  })

  test('crash-after-send rollback leaves the delivery available for catch-up polling', async () => {
    const inbox = await pool.query<{ inbox_id: string }>(
      `INSERT INTO event_inbox
         (daemon_id, daemon_generation, seq, dedup_key, session_id, event_type, priority_class, payload, status, completed_at)
       VALUES ('daemon-1', 1, 1, 'outbox-2', 'session-1', 'agent_text', 0, '{}'::jsonb, 2, NOW())
       RETURNING inbox_id`,
    )
    const inboxId = Number(inbox.rows[0].inbox_id)
    await pool.query(
      `INSERT INTO realtime_outbox
         (inbox_id, delivery_key, event_id, user_id, session_id, event_type, audience, request_id, payload)
       VALUES ($1, 'event:41:session:-:0', NULL, NULL, 'session-1', 'agent_text', 'session', NULL,
               '{"type":"agent_text","session_id":"session-1","text":"hello"}'::jsonb)`,
      [inboxId],
    )
    const sent: string[] = []
    const consumer = new RealtimeOutboxConsumer({
      repository: new RealtimeOutboxRepository(pool),
      deliver: (delivery) => {
        sent.push(delivery.deliveryKey)
        if (sent.length === 1) throw new Error('crash')
      },
    })

    await expect(consumer.runOnce()).rejects.toThrow('crash')
    await consumer.runOnce()

    expect(sent).toEqual(['event:41:session:-:0', 'event:41:session:-:0'])
    const delivered = await pool.query(`SELECT delivered_at IS NOT NULL AS delivered FROM realtime_outbox`)
    expect(delivered.rows).toEqual([{ delivered: true }])
  })

  test('a restarted Router delivers interaction feedback only to the durable owner', async () => {
    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password_hash)
       VALUES ('outbox-owner-restart@example.test', '')
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
       RETURNING id`,
    )
    const userId = user.rows[0].id
    const inbox = await pool.query<{ inbox_id: string }>(
      `INSERT INTO event_inbox
         (user_id, daemon_id, daemon_generation, seq, dedup_key, session_id, event_type,
          priority_class, payload, status, completed_at)
       VALUES ($1, 'daemon-1', 1, 1, 'interaction-restart', 'session-1',
               'interaction_result', 0, '{}'::jsonb, 2, NOW())
       RETURNING inbox_id`,
      [userId],
    )
    await pool.query(
      `INSERT INTO realtime_outbox
         (inbox_id, delivery_key, event_id, user_id, session_id, event_type,
          audience, request_id, payload)
       VALUES ($1, 'inbox:restart:interaction-origin:request-1:0', NULL, $2,
               'session-1', 'interaction_result', 'interaction-origin', 'request-1',
               '{"type":"interaction_result","session_id":"session-1",
                 "request_id":"request-1","operation":"approval_response"}')`,
      [Number(inbox.rows[0].inbox_id), userId],
    )
    // This fresh Router has no process-local origin map, exactly as after a
    // crash/restart. The durable user id is the recovery/isolation authority.
    const restarted = new Router(pool)
    const owner = ws()
    const otherOwner = ws()
    restarted.registerClient(owner, userId)
    restarted.registerClient(otherOwner, userId + 1)
    const consumer = new RealtimeOutboxConsumer({
      repository: new RealtimeOutboxRepository(pool),
      deliver: (delivery) => restarted.deliverDurableMaterializedEvent(delivery),
    })

    await consumer.runOnce()

    expect(owner._sent).toHaveLength(1)
    expect(otherOwner._sent).toHaveLength(0)
    const state = await pool.query(`SELECT delivered_at IS NOT NULL AS delivered FROM realtime_outbox`)
    expect(state.rows).toEqual([{ delivered: true }])
    restarted.stop()
  })

  test('a restarted Router leaves interaction feedback pending until its owner reconnects', async () => {
    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password_hash)
       VALUES ('outbox-owner-disconnected@example.test', '')
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
       RETURNING id`,
    )
    const userId = user.rows[0].id
    const inbox = await pool.query<{ inbox_id: string }>(
      `INSERT INTO event_inbox
         (user_id, daemon_id, daemon_generation, seq, dedup_key, session_id, event_type,
          priority_class, payload, status, completed_at)
       VALUES ($1, 'daemon-1', 1, 1, 'interaction-disconnected', 'session-1',
               'interaction_result', 0, '{}'::jsonb, 2, NOW())
       RETURNING inbox_id`,
      [userId],
    )
    await pool.query(
      `INSERT INTO realtime_outbox
         (inbox_id, delivery_key, event_id, user_id, session_id, event_type,
          audience, request_id, payload)
       VALUES ($1, 'inbox:disconnected:interaction-origin:request-1:0', NULL, $2,
               'session-1', 'interaction_result', 'interaction-origin', 'request-1',
               '{"type":"interaction_result","operation":"approval_response"}')`,
      [Number(inbox.rows[0].inbox_id), userId],
    )
    const restarted = new Router(pool)
    restarted.registerClient(ws(), userId + 1)
    const consumer = new RealtimeOutboxConsumer({
      repository: new RealtimeOutboxRepository(pool),
      deliver: (delivery) => restarted.deliverDurableMaterializedEvent(delivery),
    })

    await consumer.runOnce()

    const state = await pool.query(`SELECT delivered_at IS NULL AS pending FROM realtime_outbox`)
    expect(state.rows).toEqual([{ pending: true }])
    restarted.stop()
  })
})
