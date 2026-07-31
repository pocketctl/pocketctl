import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { initDB } from '../db.js'
import { createInboxWorker } from '../inbox-worker.js'
import { IngressController } from '../ingress/controller.js'
import { InboxRepository } from '../ingress/inbox-repository.js'
import { EventMaterializer } from '../materialization/event-materializer.js'
import {
  assertDurableIngressTestDatabase,
  resetDurableIngressTestDatabase,
} from './durable-ingress-test-db.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const describeWithDatabase = databaseUrl ? describe : describe.skip
const OUTAGE_APPLICATION_NAME = 'pocketctl-durable-ingress-outage-gate'

function timerStub(): ReturnType<typeof setTimeout> {
  return { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>
}

describeWithDatabase('durable ingress PostgreSQL failure release gate', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8 })
    await assertDurableIngressTestDatabase(pool, databaseUrl!)
    await initDB(pool)
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await resetDurableIngressTestDatabase(pool, databaseUrl!)
  })

  test.each([10_000, 60_000])(
    'models a %dms sustained real PostgreSQL connection refusal before recovery and durable ACK',
    async (outageMs) => {
      const outagePool = new pg.Pool({
        connectionString: databaseUrl,
        max: 1,
        connectionTimeoutMillis: 100,
        application_name: OUTAGE_APPLICATION_NAME,
      })
      const controlPool = new pg.Pool({
        connectionString: databaseUrl,
        max: 1,
        application_name: 'pocketctl-durable-ingress-outage-control',
      })
      const config = await assertDurableIngressTestDatabase(controlPool, databaseUrl!)
      const repository = new InboxRepository(outagePool)
      const outageErrors: Error[] = []
      const onOutagePoolError = (error: Error) => outageErrors.push(error)
      outagePool.on('error', onOutagePoolError)
      let nowMs = Date.parse('2026-07-29T00:00:00.000Z')
      let highestAck = 0
      const controller = new IngressController({
        repository,
        now: () => new Date(nowMs),
        sendAck: (_daemonId, checkpoint) => {
          highestAck = Math.max(highestAck, checkpoint.ackSeq)
        },
        disconnectRetryable: () => undefined,
        setTimer: timerStub,
        clearTimer: vi.fn(),
      })
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      try {
        const originalBackend = await outagePool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        for (let seq = 1; seq <= 64; seq++) {
          expect(controller.accept({
            daemonId: 'fault-outage-daemon',
            registrationId: 'fault-outage-registration',
            userId: null,
            daemonGeneration: 101,
          }, {
            type: 'agent_text',
            session_id: 'fault-outage-session',
            event_id: `fault-outage-${seq}`,
            text: `event ${seq}`,
            seq,
          })).toEqual({ kind: 'accepted' })
        }

        // This is not an in-process throw: PostgreSQL refuses all new
        // connections to the dedicated test database after its only ingest
        // backend is terminated. The held control connection restores it.
        await controlPool.query(`ALTER DATABASE "${config.database}" WITH CONNECTION LIMIT 0`)
        await controlPool.query(
          `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND application_name = $1
             AND pid <> pg_backend_pid()`,
          [OUTAGE_APPLICATION_NAME],
        )
        await vi.waitFor(() => {
          expect(outageErrors).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: '57P01' }),
          ]))
        })
        await controller.flushNow()
        nowMs += outageMs / 2
        await controller.flushNow()
        nowMs += outageMs / 2
        await controller.flushNow()
        // The clock is virtual only to cover the configured 10s/60s duration
        // without pretending this is a wall-clock outage benchmark. The DB
        // remained unavailable for three real connection attempts.
        expect(highestAck).toBe(0)
        expect((await pool.query(
          `SELECT COUNT(*)::int AS count FROM event_inbox
           WHERE daemon_id = 'fault-outage-daemon'`,
        )).rows[0].count).toBe(0)

        await controlPool.query(`ALTER DATABASE "${config.database}" WITH CONNECTION LIMIT -1`)
        await controller.flushNow()
        expect(highestAck).toBe(64)
        const recoveredBackend = await outagePool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        expect(recoveredBackend.rows[0].pid).not.toBe(originalBackend.rows[0].pid)
        const durable = await pool.query(`
          SELECT
            (SELECT COUNT(*)::int FROM event_inbox
              WHERE daemon_id = 'fault-outage-daemon') AS inbox,
            (SELECT COUNT(*)::int FROM event_inbox_receipt
              WHERE daemon_id = 'fault-outage-daemon') AS receipts,
            (SELECT ack_seq::int FROM daemon_ack_checkpoint
              WHERE daemon_id = 'fault-outage-daemon' AND daemon_generation = 101) AS ack_seq
        `)
        expect(durable.rows[0]).toEqual({ inbox: 64, receipts: 64, ack_seq: 64 })
      } finally {
        await controlPool.query(`ALTER DATABASE "pocketctl_durable_ingress_test" WITH CONNECTION LIMIT -1`)
          .catch(() => undefined)
        log.mockRestore()
        await outagePool.end()
        outagePool.off('error', onOutagePoolError)
        await controlPool.end()
      }
    },
  )

  test('withholds ACK while the ingest pool is full and resumes after a connection is released', async () => {
    const ingestPool = new pg.Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 50,
    })
    await assertDurableIngressTestDatabase(ingestPool, databaseUrl!)
    const held = await ingestPool.connect()
    let heldReleased = false
    let highestAck = 0
    const controller = new IngressController({
      repository: new InboxRepository(ingestPool),
      sendAck: (_daemonId, checkpoint) => {
        highestAck = Math.max(highestAck, checkpoint.ackSeq)
      },
      disconnectRetryable: () => undefined,
      setTimer: timerStub,
      clearTimer: vi.fn(),
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(controller.accept({
        daemonId: 'fault-pool-daemon',
        registrationId: 'fault-pool-registration',
        userId: null,
        daemonGeneration: 202,
      }, {
        type: 'agent_text',
        session_id: 'fault-pool-session',
        event_id: 'fault-pool-1',
        text: 'pool pressure',
        seq: 1,
      })).toEqual({ kind: 'accepted' })

      await controller.flushNow()
      expect(highestAck).toBe(0)

      held.release()
      heldReleased = true
      await controller.flushNow()
      expect(highestAck).toBe(1)
      expect((await pool.query(
        `SELECT COUNT(*)::int AS count FROM event_inbox_receipt
         WHERE daemon_id = 'fault-pool-daemon' AND seq = 1`,
      )).rows[0].count).toBe(1)
    } finally {
      if (!heldReleased) held.release()
      log.mockRestore()
      await ingestPool.end()
    }
  })

  test('ACKed Inbox survives a stopped Worker and materializes once after Worker recovery', async () => {
    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password_hash)
       VALUES ('fault-gate@example.test', '') RETURNING id`,
    )
    const userId = user.rows[0].id
    await pool.query(
      `INSERT INTO daemons (daemon_id, user_id) VALUES ('fault-worker-daemon', $1)`,
      [userId],
    )
    await pool.query(
      `INSERT INTO sessions (session_id, daemon_id, user_id, status)
       VALUES ('fault-worker-session', 'fault-worker-daemon', $1, 'running')`,
      [userId],
    )
    const repository = new InboxRepository(pool)
    let highestAck = 0
    const controller = new IngressController({
      repository,
      sendAck: (_daemonId, checkpoint) => {
        highestAck = Math.max(highestAck, checkpoint.ackSeq)
      },
      disconnectRetryable: () => undefined,
      setTimer: timerStub,
      clearTimer: vi.fn(),
    })

    controller.accept({
      daemonId: 'fault-worker-daemon',
      registrationId: 'fault-worker-registration',
      userId,
      daemonGeneration: 303,
    }, {
      type: 'agent_text',
      session_id: 'fault-worker-session',
      event_id: 'fault-worker-event',
      text: 'survives worker stop',
      seq: 1,
    })
    await controller.flushNow()

    expect(highestAck).toBe(1)
    expect((await pool.query(
      `SELECT COUNT(*)::int AS count FROM events
       WHERE session_id = 'fault-worker-session'`,
    )).rows[0].count).toBe(0)

    const worker = createInboxWorker({
      repository,
      materializer: new EventMaterializer({
        pool,
        durableHooks: {
          releaseQuotaReservation: async () => undefined,
          notifyUser: async () => undefined,
          notifyProUser: async () => undefined,
        },
      }),
      workerId: 'fault-worker-recovered',
      shardCount: 1,
      shardIndex: 0,
    })
    await worker.runOnce()
    await worker.runOnce()

    const recovered = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM events
          WHERE session_id = 'fault-worker-session') AS events,
        (SELECT COUNT(*)::int FROM event_inbox
          WHERE daemon_id = 'fault-worker-daemon' AND status = 2) AS completed
    `)
    expect(recovered.rows[0]).toEqual({ events: 1, completed: 1 })
  })
})
