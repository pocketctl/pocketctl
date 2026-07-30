import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { initDB } from '../db.js'
import { InboxRepository } from '../ingress/inbox-repository.js'
import { IngressController } from '../ingress/controller.js'
import { createInboxWorker } from '../inbox-worker.js'
import { EventMaterializer } from '../materialization/event-materializer.js'
import {
  RealtimeOutboxConsumer,
  RealtimeOutboxRepository,
  RealtimeOutboxWriter,
} from '../materialization/realtime-outbox.js'
import { Router } from '../router.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

function ws(): any {
  const sent: unknown[] = []
  return {
    readyState: 1,
    send: vi.fn((raw: string) => sent.push(JSON.parse(raw))),
    close: vi.fn(),
    terminate: vi.fn(),
    _sent: sent,
  }
}

describeWithDatabase('durable ingress controlled recovery', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8 })
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
    await pool.query(`DELETE FROM events WHERE session_id = 'recovery-session'`)
    await pool.query(`DELETE FROM sessions WHERE session_id = 'recovery-session'`)
    await pool.query(`DELETE FROM daemons WHERE daemon_id = 'recovery-daemon'`)
    await pool.query(`DELETE FROM users WHERE email = 'recovery@example.test'`)
    await pool.query(`DELETE FROM events WHERE session_id = 'recovery-push-session'`)
    await pool.query(`DELETE FROM sessions WHERE session_id = 'recovery-push-session'`)
    await pool.query(`DELETE FROM daemons WHERE daemon_id = 'recovery-push-daemon'`)
    await pool.query(`DELETE FROM users WHERE email = 'recovery-push@example.test'`)
  })

  test('deduplicates request-id push effect across fresh Workers without collapsing distinct event ids', async () => {
    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password_hash) VALUES ('recovery-push@example.test', '') RETURNING id`,
    )
    const userId = user.rows[0].id
    await pool.query(`INSERT INTO daemons (daemon_id, user_id) VALUES ('recovery-push-daemon', $1)`, [userId])
    await pool.query(
      `INSERT INTO sessions (session_id, daemon_id, user_id, status)
       VALUES ('recovery-push-session', 'recovery-push-daemon', $1, 'running')`,
      [userId],
    )
    const notifyUser = vi.fn().mockResolvedValue(undefined)
    const hooks = {
      releaseQuotaReservation: vi.fn().mockResolvedValue(undefined),
      notifyUser,
      notifyProUser: vi.fn().mockResolvedValue(undefined),
    }
    const workerPool = new pg.Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 500,
    })
    const input = {
      inboxId: 701,
      userId,
      daemonId: 'recovery-push-daemon',
      sessionId: 'recovery-push-session',
      eventType: 'approval_request',
      payload: {
        type: 'approval_request',
        session_id: 'recovery-push-session',
        request_id: 'restart-safe-request',
        event_id: 'approval-event-1',
        tool: 'Read',
        input: { file_path: '/repo/README.md' },
      },
    }

    try {
      await new EventMaterializer({ pool: workerPool, durableHooks: hooks }).materialize(input)
      await new EventMaterializer({ pool: workerPool, durableHooks: hooks }).materialize({
        ...input,
        inboxId: 702,
        payload: { ...input.payload, event_id: 'approval-event-2' },
      })
    } finally {
      await workerPool.end()
    }

    expect(notifyUser).toHaveBeenCalledOnce()
    const ledger = await pool.query(
      `SELECT effect_status FROM events
       WHERE session_id = 'recovery-push-session' AND event_type = 'approval_request'
       ORDER BY id`,
    )
    expect(ledger.rows).toEqual([
      { effect_status: 'completed' },
      { effect_status: 'completed' },
    ])
    expect((await pool.query(
      `SELECT COUNT(*)::int AS count FROM request_push_effect
       WHERE user_id = $1 AND request_id = 'restart-safe-request'`,
      [userId],
    )).rows[0].count).toBe(1)
    await pool.query(
      `DELETE FROM events
       WHERE session_id = 'recovery-push-session'
         AND payload->>'event_id' = 'approval-event-1'`,
    )
    expect((await pool.query(
      `SELECT COUNT(*)::int AS count FROM request_push_effect
       WHERE user_id = $1 AND request_id = 'restart-safe-request'`,
      [userId],
    )).rows[0].count).toBe(0)
  })

  test('materializes subagent usage through a one-connection Worker pool', async () => {
    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password_hash) VALUES ('recovery@example.test', '') RETURNING id`,
    )
    const userId = user.rows[0].id
    await pool.query(`INSERT INTO daemons (daemon_id, user_id) VALUES ('recovery-daemon', $1)`, [userId])
    await pool.query(
      `INSERT INTO sessions (session_id, daemon_id, user_id, status)
       VALUES ('recovery-session', 'recovery-daemon', $1, 'running')`,
      [userId],
    )
    const workerPool = new pg.Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 500,
    })
    try {
      await new EventMaterializer({ pool: workerPool }).materialize({
        inboxId: 730,
        userId,
        daemonId: 'recovery-daemon',
        sessionId: 'recovery-session',
        eventType: 'subagent_usage',
        payload: {
          type: 'subagent_usage',
          session_id: 'recovery-session',
          agent_id: 'codex-child',
          event_id: 'jsonl:source:3:0:usage',
          seq: 9,
          usage: {
            input_tokens: 2,
            output_tokens: 3,
            cache_read_tokens: 4,
            cache_create_tokens: 5,
          },
        },
      })
    } finally {
      await workerPool.end()
    }

    expect((await pool.query(
      `SELECT token_in, token_out, token_cache, token_cache_create
       FROM subagents
       WHERE parent_session_id = 'recovery-session' AND agent_id = 'codex-child'`,
    )).rows).toEqual([{
      token_in: '2',
      token_out: '3',
      token_cache: '4',
      token_cache_create: '5',
    }])
  })

  test('distinct request ids each receive their durable push effect', async () => {
    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password_hash) VALUES ('recovery-push@example.test', '') RETURNING id`,
    )
    const userId = user.rows[0].id
    await pool.query(`INSERT INTO daemons (daemon_id, user_id) VALUES ('recovery-push-daemon', $1)`, [userId])
    await pool.query(
      `INSERT INTO sessions (session_id, daemon_id, user_id, status)
       VALUES ('recovery-push-session', 'recovery-push-daemon', $1, 'running')`,
      [userId],
    )
    const notifyUser = vi.fn().mockResolvedValue(undefined)
    const hooks = {
      releaseQuotaReservation: vi.fn().mockResolvedValue(undefined),
      notifyUser,
      notifyProUser: vi.fn().mockResolvedValue(undefined),
    }
    const materializer = new EventMaterializer({ pool, durableHooks: hooks })
    for (const [index, requestId] of ['request-a', 'request-b'].entries()) {
      await materializer.materialize({
        inboxId: 710 + index,
        userId,
        daemonId: 'recovery-push-daemon',
        sessionId: 'recovery-push-session',
        eventType: 'question_request',
        payload: {
          type: 'question_request',
          session_id: 'recovery-push-session',
          request_id: requestId,
          event_id: `question-event-${index}`,
          questions: [{ question: `Question ${index}` }],
        },
      })
    }

    expect(notifyUser).toHaveBeenCalledTimes(2)
  })

  test('failed push does not permanently suppress a fresh Worker retry', async () => {
    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password_hash) VALUES ('recovery-push@example.test', '') RETURNING id`,
    )
    const userId = user.rows[0].id
    await pool.query(`INSERT INTO daemons (daemon_id, user_id) VALUES ('recovery-push-daemon', $1)`, [userId])
    await pool.query(
      `INSERT INTO sessions (session_id, daemon_id, user_id, status)
       VALUES ('recovery-push-session', 'recovery-push-daemon', $1, 'running')`,
      [userId],
    )
    const firstNotify = vi.fn().mockRejectedValue(new Error('push unavailable'))
    const retryNotify = vi.fn().mockResolvedValue(undefined)
    const input = {
      inboxId: 720,
      userId,
      daemonId: 'recovery-push-daemon',
      sessionId: 'recovery-push-session',
      eventType: 'interactive_prompt',
      payload: {
        type: 'interactive_prompt',
        session_id: 'recovery-push-session',
        request_id: 'retryable-request',
        event_id: 'interactive-event-1',
        input: { prompt: 'Continue?' },
      },
    }
    const durableHooks = (notifyUser: typeof firstNotify) => ({
      releaseQuotaReservation: vi.fn().mockResolvedValue(undefined),
      notifyUser,
      notifyProUser: vi.fn().mockResolvedValue(undefined),
    })

    await expect(new EventMaterializer({
      pool,
      durableHooks: durableHooks(firstNotify),
    }).materialize(input)).rejects.toThrow('push unavailable')
    expect((await pool.query(
      `SELECT COUNT(*)::int AS count FROM request_push_effect
       WHERE user_id = $1 AND request_id = 'retryable-request'`,
      [userId],
    )).rows[0].count).toBe(0)
    await new EventMaterializer({
      pool,
      durableHooks: durableHooks(retryNotify),
    }).materialize({ ...input, inboxId: 721 })

    expect(firstNotify).toHaveBeenCalledOnce()
    expect(retryNotify).toHaveBeenCalledOnce()
  })

  test('admits before ACK, survives a controlled ten-minute Worker outage, and reconnect-replays once', async () => {
    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password_hash) VALUES ('recovery@example.test', '') RETURNING id`,
    )
    const userId = user.rows[0].id
    const repository = new InboxRepository(pool)
    const acceptedAt = new Date('2026-07-29T00:00:00.000Z')
    let daemonSocket: any
    let ackState: Promise<pg.QueryResult> | undefined
    const controller = new IngressController({
      repository,
      now: () => acceptedAt,
      sendAck: (_daemonId, checkpoint, window) => {
        // The callback is invoked only after persistBatch commits. Capture the
        // authoritative rows as observed at the ACK protocol boundary.
        ackState = pool.query(
          `SELECT
             (SELECT COUNT(*)::int FROM event_inbox
               WHERE daemon_id = 'recovery-daemon' AND seq = 1) AS inbox,
             (SELECT COUNT(*)::int FROM event_inbox_receipt
               WHERE daemon_id = 'recovery-daemon' AND seq = 1) AS receipts`,
        )
        daemonSocket.send(JSON.stringify({
          type: 'event_ack',
          up_to_seq: checkpoint.ackSeq,
          event_window: window,
        }))
      },
      disconnectRetryable: () => undefined,
      setTimer: () => ({ unref: vi.fn() }) as any,
      clearTimer: vi.fn(),
    })
    const router = new Router(pool, {
      durableIngress: { mode: 'on', repository, controller },
    })
    daemonSocket = ws()
    await router.registerDaemon(daemonSocket, {
      type: 'register',
      daemon_id: 'recovery-daemon',
      hostname: 'recovery-host',
      agents: ['codex'],
      started_at: 1,
      acked_seq: 0,
    }, userId)
    await pool.query(
      `INSERT INTO sessions (session_id, daemon_id, user_id, status)
       VALUES ('recovery-session', 'recovery-daemon', $1, 'running')`,
      [userId],
    )
    const stoppedWorker = createInboxWorker({
      repository,
      materializer: new EventMaterializer({ pool }),
      outboxWriter: new RealtimeOutboxWriter(pool),
      workerId: 'worker-before-outage',
      shardCount: 1,
      shardIndex: 0,
      setTimer: () => ({ unref: vi.fn() }) as any,
      clearTimer: vi.fn(),
    })
    stoppedWorker.start()
    await stoppedWorker.stop()

    daemonSocket._sent.length = 0
    router.handleDaemonMessage('recovery-daemon', {
      type: 'agent_text',
      session_id: 'recovery-session',
      event_id: 'recovery-event',
      text: 'done',
      usage: { input_tokens: 3, output_tokens: 2 },
      seq: 1,
    })
    expect(daemonSocket._sent.some((message: any) => message.type === 'event_ack')).toBe(false)
    await controller.flushNow()
    expect(daemonSocket._sent).toContainEqual(expect.objectContaining({
      type: 'event_ack',
      up_to_seq: 1,
    }))
    expect((await ackState!).rows[0]).toEqual({ inbox: 1, receipts: 1 })
    const beforeRecovery = await pool.query(
      `SELECT COUNT(*)::int AS count FROM events WHERE session_id = 'recovery-session'`,
    )
    expect(beforeRecovery.rows[0].count).toBe(0)

    const recoveredAt = new Date(acceptedAt.getTime() + 600_000)
    const restartedWorker = createInboxWorker({
      repository: new InboxRepository(pool),
      materializer: new EventMaterializer({ pool }),
      outboxWriter: new RealtimeOutboxWriter(pool),
      workerId: 'worker-after-outage',
      shardCount: 1,
      shardIndex: 0,
      now: () => recoveredAt,
    })
    await restartedWorker.runOnce()

    const consumer = new RealtimeOutboxConsumer({
      repository: new RealtimeOutboxRepository(pool),
      deliver: (delivery) => router.deliverDurableMaterializedEvent(delivery),
    })
    await consumer.runOnce()
    await restartedWorker.runOnce()
    await consumer.runOnce()

    const reconnect = ws()
    router.registerClient(reconnect, userId)
    await router.handleClientMessage(reconnect, {
      type: 'replay',
      session_id: 'recovery-session',
      last_seq: 0,
      req_id: 77,
    })
    await vi.waitFor(() => {
      expect(reconnect._sent.some((message: any) => message.type === 'replay_end')).toBe(true)
    })
    const replayBatch = reconnect._sent.find((message: any) => message.type === 'replay_batch')
    expect(replayBatch).toEqual(expect.objectContaining({
      type: 'replay_batch',
      session_id: 'recovery-session',
      req_id: 77,
      events: [expect.objectContaining({ type: 'agent_text', text: 'done' })],
    }))
    expect(reconnect._sent).toContainEqual(expect.objectContaining({
      type: 'replay_end',
      session_id: 'recovery-session',
      req_id: 77,
      count: 1,
    }))
    const state = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM events WHERE session_id = 'recovery-session') AS events,
        (SELECT COUNT(*)::int FROM realtime_outbox WHERE session_id = 'recovery-session') AS outbox,
        (SELECT COUNT(*)::int FROM realtime_outbox
          WHERE session_id = 'recovery-session' AND delivered_at IS NOT NULL) AS delivered,
        (SELECT tok_input::int FROM sessions WHERE session_id = 'recovery-session') AS tok_input,
        (SELECT tok_output::int FROM sessions WHERE session_id = 'recovery-session') AS tok_output
    `)
    expect(state.rows[0]).toEqual({
      events: 1,
      outbox: 1,
      delivered: 1,
      tok_input: 3,
      tok_output: 2,
    })
    router.stop()
  })
})
