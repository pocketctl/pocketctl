import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB, backfillSessionTokens, backfillSessionModel } from '../db.js'
import { assertDurableIngressTestDatabase } from './durable-ingress-test-db.js'

const url = process.env.TEST_DATABASE_URL
const suite = url && process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
suite('startup backfill on PostgreSQL', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, statement_timeout: 15000 })
    await assertDurableIngressTestDatabase(pool, url!)
    await initDB(pool)
  }, 30000)
  beforeEach(async () => {
    await pool.query('TRUNCATE events,sessions,daemons,token_usage_accounting_state CASCADE')
    await pool.query("INSERT INTO daemons(daemon_id) VALUES('backfill-test')")
    await pool.query("INSERT INTO sessions(session_id,daemon_id,total_tokens,tok_input) VALUES('token-test','backfill-test',999,999)")
    await pool.query("INSERT INTO events(session_id,event_type,payload) VALUES('token-test','agent_text',$1)", [{ usage: { input_tokens: 7, output_tokens: 2 } }])
  })
  afterAll(async () => { await pool?.end() })
  test('activated V2 counters and activity timestamps survive restart; legacy bootstrap remains supported', async () => {
    await pool.query("INSERT INTO token_usage_accounting_state(key) VALUES('baseline-v1')")
    const before = (await pool.query("SELECT total_tokens,tok_input,updated_at FROM sessions WHERE session_id='token-test'")).rows[0]
    expect(await backfillSessionTokens(pool)).toBe(0)
    expect((await pool.query("SELECT total_tokens,tok_input,updated_at FROM sessions WHERE session_id='token-test'")).rows[0]).toEqual(before)
    await pool.query('TRUNCATE token_usage_accounting_state')
    expect(await backfillSessionTokens(pool)).toBe(1)
    expect((await pool.query("SELECT total_tokens,tok_input,tok_output FROM sessions WHERE session_id='token-test'")).rows[0]).toEqual({total_tokens:'9',tok_input:'7',tok_output:'2'})
  })
  test('repairs multiple pages, preserves source priority and newer effort, and never overwrites populated metadata', async () => {
    await pool.query(`INSERT INTO sessions(session_id,daemon_id) SELECT 'meta-'||lpad(i::text,3,'0'),'backfill-test' FROM generate_series(1,55) i`)
    await pool.query(`INSERT INTO events(session_id,event_type,payload,created_at)
      SELECT s.session_id,e.kind,e.body::jsonb,e.at::timestamptz FROM sessions s CROSS JOIN (VALUES
        ('session_created','{"model":"original"}','2026-10-01'),
        ('session_meta','{"model":"newer","effort":"low"}','2026-10-02'),
        ('session_meta','{"model":"latest","effort":"high"}','2026-10-03'),
        ('agent_text','{"model":"fallback"}','2026-10-04')
      ) e(kind,body,at) WHERE s.session_id LIKE 'meta-%'`)
    await pool.query("UPDATE sessions SET model='live',effort='medium' WHERE session_id='meta-030'")
    expect(await backfillSessionModel(pool)).toBe(54)
    expect((await pool.query("SELECT count(*)::int n FROM sessions WHERE model='original' AND effort='high'")).rows[0].n).toBe(54)
    expect((await pool.query("SELECT model,effort FROM sessions WHERE session_id='meta-030'")).rows[0]).toEqual({model:'live',effort:'medium'})
    expect(await backfillSessionModel(pool)).toBe(0)
  })
})
