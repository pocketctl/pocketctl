import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { InboxRepository } from '../ingress/inbox-repository.js'
import { initDurableIngressSchema } from '../schema/durable-ingress.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

// The deterministic gate mirrors the plan: one daemon with a deep same-stream
// backlog must resolve its single head well inside a CI-tolerant 500 ms
// statement budget. The pre-fix correlated anti-join needed seconds at this
// depth and is cancelled by the timeout.
const SAME_DAEMON_BACKLOG_ROWS = 10_000
const CLAIM_STATEMENT_TIMEOUT_MS = 500

describeWithDatabase('inbox claim performance PostgreSQL regression', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8 })
    const database = await pool.query<{ database_name: string }>(
      'SELECT current_database() AS database_name',
    )
    const databaseName = database.rows[0]?.database_name ?? ''
    if (!/test/i.test(databaseName)) {
      throw new Error(`Refusing PostgreSQL integration test against non-test database: ${databaseName || '<unknown>'}`)
    }
    await initDB(pool)
    await initDurableIngressSchema(pool)
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE realtime_outbox, event_inbox_receipt, event_inbox, daemon_ack_checkpoint RESTART IDENTITY CASCADE',
    )
  })

  test('claims the single seq-1 head of a 10,000-row same-daemon backlog inside the statement timeout', async () => {
    // Seed the whole backlog in one SQL statement so the fixture itself never
    // becomes the measured cost.
    await pool.query(
      `INSERT INTO event_inbox
         (daemon_id, daemon_generation, seq, dedup_key, event_type, priority_class, payload)
       SELECT 'perf-daemon', 1, g, 'perf-' || g, 'agent_event', 1,
              jsonb_build_object('agent', 'opencode', 'seq', g)
       FROM generate_series(1, $1::bigint) AS g`,
      [SAME_DAEMON_BACKLOG_ROWS],
    )

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      try {
        await client.query(`SET LOCAL statement_timeout = '${CLAIM_STATEMENT_TIMEOUT_MS}ms'`)
        const transactionRepository = new InboxRepository({
          query: (...args: Parameters<typeof client.query>) =>
            (client.query as (...queryArgs: typeof args) => Promise<unknown>)(...args),
        } as never)

        const claimed = await transactionRepository.claimBatch({
          workerId: 'perf-worker',
          limit: 10,
          shardCount: 1,
          shardIndex: 0,
        })

        expect(claimed).toHaveLength(1)
        expect(claimed[0]).toMatchObject({
          daemonId: 'perf-daemon',
          seq: 1,
          status: 1,
          attempts: 1,
          claimedBy: 'perf-worker',
        })
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    } finally {
      client.release()
    }
  }, 30_000)
})
