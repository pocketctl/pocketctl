import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { InboxRetention } from '../inbox-retention.js'
import { assertDurableIngressTestDatabase } from './durable-ingress-test-db.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const suite = databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

suite('inbox retention receipt cascade performance', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })
    await assertDurableIngressTestDatabase(pool, databaseUrl!)
    await initDB(pool)
  }, 30_000)
  afterAll(async () => { await pool?.end() })
  beforeEach(async () => {
    await pool.query('TRUNCATE realtime_outbox, event_inbox_receipt, event_inbox, daemon_ack_checkpoint RESTART IDENTITY CASCADE')
  })

  test('deletes a full batch with 600,000 unrelated receipts inside a 2-second statement budget', async () => {
    await pool.query(`INSERT INTO event_inbox
      (daemon_id,daemon_generation,seq,dedup_key,event_type,priority_class,payload,status,completed_at)
      SELECT 'retention-perf',1,n,'retention-perf-'||n,'tool_result',1,'{}',2,now()-interval '7 hours'
      FROM generate_series(1,1001) n`)
    await pool.query(`INSERT INTO event_inbox_receipt(inbox_id,daemon_id,daemon_generation,seq,received_at)
      SELECT inbox_id,'retention-perf',1,seq,now()-interval '7 hours' FROM event_inbox`)
    // Recent, receipt-only records must survive; they reproduce the large
    // child table scanned once per parent by the formerly unindexed FK.
    await pool.query(`INSERT INTO event_inbox_receipt(inbox_id,daemon_id,daemon_generation,seq)
      SELECT NULL,'retention-perf-unrelated',1,n FROM generate_series(1,600000) n`)
    await pool.query(`INSERT INTO realtime_outbox(inbox_id,delivery_key,event_type,audience,payload,delivered_at)
      SELECT inbox_id,'retention-perf-'||inbox_id,event_type,'session','{}',now()-interval '7 hours' FROM event_inbox`)
    await pool.query("INSERT INTO daemon_ack_checkpoint(daemon_id,daemon_generation,ack_seq) VALUES('retention-perf',1,1001)")
    await pool.query('ANALYZE event_inbox_receipt')
    await pool.query("SET statement_timeout='2s'")
    try {
      expect((await new InboxRetention(pool).runOnce()).deletedCompleted).toBe(1000)
    } finally { await pool.query('RESET statement_timeout') }
    expect((await pool.query('SELECT count(*)::int n FROM event_inbox')).rows[0].n).toBe(1)
    expect((await pool.query('SELECT count(*)::int n FROM realtime_outbox')).rows[0].n).toBe(1)
    expect((await pool.query('SELECT count(*)::int n FROM event_inbox_receipt')).rows[0].n).toBe(600001)
  }, 60_000)
  test('eligible work behind 20,000 accounting-held rows is not starved', async () => {
    await pool.query("INSERT INTO token_usage_accounting_state(key,completed_at) VALUES('baseline-v1',now()-interval '30 days') ON CONFLICT(key) DO UPDATE SET completed_at=EXCLUDED.completed_at")
    await pool.query(`INSERT INTO event_inbox(daemon_id,daemon_generation,seq,dedup_key,event_type,priority_class,payload,status,completed_at,received_at)
      SELECT 'retention-held-prefix',1,n,'retention-held-'||n,'agent_text',0,'{"usage":{"input_tokens":1}}',2,now()-interval '9 hours',now()-interval '9 hours' FROM generate_series(1,20000) n`)
    await pool.query(`INSERT INTO event_inbox(daemon_id,daemon_generation,seq,dedup_key,event_type,priority_class,payload,status,completed_at,received_at)
      SELECT 'retention-ready',1,n,'retention-ready-'||n,'tool_result',0,'{}',2,now()-interval '8 hours',now()-interval '8 hours' FROM generate_series(1,1001) n`)
    await pool.query("INSERT INTO daemon_ack_checkpoint(daemon_id,daemon_generation,ack_seq) VALUES('retention-held-prefix',1,20000),('retention-ready',1,1001)")
    await pool.query("SET statement_timeout='2s'")
    try {
      const result=await new InboxRetention(pool).runOnce()
      expect(result.failures).toEqual([])
      expect(result.deletedCompleted).toBe(1000)
      expect(result.moreWork).toBe(true)
    } finally { await pool.query('RESET statement_timeout') }
    expect((await pool.query("SELECT count(*)::int n FROM event_inbox WHERE daemon_id='retention-held-prefix'")).rows[0].n).toBe(20000)
  }, 30_000)

})
