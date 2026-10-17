import pg from 'pg'
import { beforeAll, afterAll, describe, test, expect } from 'vitest'
import { initDB } from '../db.js'
import { initTeamSchema } from '../team/schema.js'

const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1' && process.env.TEST_DATABASE_URL
;(enabled ? describe : describe.skip)('Team v2 forward migration (PostgreSQL)', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/team_relay_test' || url.username !== 'team_relay_test') throw new Error('isolated Team database required')
    pool = new pg.Pool({ connectionString: url.toString() })
    await initDB(pool)
  }, 30000)
  afterAll(async () => { await pool?.end() })

  test('adds nullable frozen config and unresolved bindings without rewriting old budgets', async () => {
    await initTeamSchema(pool)
    await initTeamSchema(pool)
    const columns = (await pool.query(`SELECT table_name, column_name, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('collaboration_session_agent_bindings','collaboration_calls','collaboration_runs')`)).rows
    expect(columns).toEqual(expect.arrayContaining([
      expect.objectContaining({table_name:'collaboration_session_agent_bindings',column_name:'config_status',column_default: "'unresolved'::character varying"}),
      expect.objectContaining({table_name:'collaboration_calls',column_name:'requested_config',column_default:null}),
      expect.objectContaining({table_name:'collaboration_runs',column_name:'max_rounds'}),
    ]))
    const tables = (await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'`)).rows.map(r => r.tablename)
    expect(tables).toEqual(expect.arrayContaining(['team_event_journal','team_event_cursors','team_read_positions','team_private_interaction_links']))
  })

  test('journal captures all committed event kinds and never survives event rollback', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const user = (await client.query(`INSERT INTO users(email,password_hash,team_enabled) VALUES ('schema-v2@example.test','x',true) RETURNING id`)).rows[0].id
      await client.query(`INSERT INTO collaboration_teams(team_id,name,creator_user_id) VALUES ('schema-v2-team','schema',$1)`,[user])
      await client.query(`INSERT INTO collaboration_sessions(team_session_id,team_id,creator_user_id,title) VALUES ('schema-v2-session','schema-v2-team',$1,'schema')`,[user])
      await client.query(`INSERT INTO collaboration_events(event_id,team_session_id,event_seq,kind,content) VALUES ('schema-v2-event','schema-v2-session',1,'system','public')`)
      expect((await client.query(`SELECT event_id FROM team_event_journal WHERE team_session_id='schema-v2-session'`)).rows).toEqual([{event_id:'schema-v2-event'}])
      await client.query('ROLLBACK')
      expect((await pool.query(`SELECT 1 FROM team_event_journal WHERE event_id='schema-v2-event'`)).rowCount).toBe(0)
    } finally { await client.query('ROLLBACK'); client.release() }
  })
})
