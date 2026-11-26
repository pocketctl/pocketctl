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

  test('examines bounded inbox tuples when claiming two streams with a deep mixed backlog', async () => {
    // Regresses the global DISTINCT scan even when a warm CI database hides
    // its wall-clock cost. Measure the actual claim, including its UPDATE.
    await pool.query(`INSERT INTO event_inbox
      (daemon_id,daemon_generation,seq,dedup_key,event_type,priority_class,payload,status)
      SELECT CASE WHEN g<=40000 THEN 'deep-a' ELSE 'deep-b' END,1,g,'deep-'||g,
        'agent_text',1,jsonb_build_object('text',repeat(md5(g::text),16)),
        CASE WHEN g>80000 THEN 2 ELSE 0 END
      FROM generate_series(1,160000) g`)
    await pool.query('ANALYZE event_inbox')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const repository = new InboxRepository({ query: client.query.bind(client) } as never)
      const claimed = await repository.claimBatch({ workerId: 'bounded', limit: 32, shardCount: 1, shardIndex: 0 })
      expect(claimed.map(row => [row.daemonId, row.seq])).toEqual([['deep-a', 1], ['deep-b', 40001]])
      await client.query('ROLLBACK')
      type Plan = { 'Relation Name'?: string; 'Actual Rows'?: number; 'Actual Loops'?: number;
        'Rows Removed by Filter'?: number; Plans?: Plan[] }
      const examined = (node: Plan): number =>
        (node['Relation Name'] === 'event_inbox'
          ? ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)) * (node['Actual Loops'] ?? 0)
          : 0) + (node.Plans ?? []).reduce((sum, child) => sum + examined(child), 0)
      // A generous resource budget independent of CPU speed, cache warmth or
      // exact planner node names. Full-table and full-pending scans violate it.
      for (const mode of ['force_custom_plan', 'force_generic_plan']) {
        await client.query('BEGIN')
        await client.query(`SET LOCAL plan_cache_mode = ${mode}`)
        const result = await client.query(
          "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE pocketctl_inbox_claim_v1('bounded', 1, 0, 32)",
        )
        expect(examined(result.rows[0]['QUERY PLAN'][0].Plan)).toBeLessThan(1000)
        await client.query('ROLLBACK')
      }
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  }, 30_000)

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
