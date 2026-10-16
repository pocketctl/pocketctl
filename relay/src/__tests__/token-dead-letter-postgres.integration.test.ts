import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { EventMaterializer } from '../materialization/event-materializer.js'
import { recoverOwnedTokenDeadLetters } from '../token-usage/dead-letter-recovery.js'
import { initDB } from '../db.js'
import { closeTokenUsageDay } from '../token-usage/day-closer.js'
import { assertDurableIngressTestDatabase } from './durable-ingress-test-db.js'

const url = process.env.TEST_DATABASE_URL
const suite = url && process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
suite('token day dead-letter boundaries on PostgreSQL', () => {
  let admin: pg.Pool, pool: pg.Pool
  let userId: number
  const schema = `token_dead_${process.pid}`
  const date = '2026-08-21'
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url })
    await assertDurableIngressTestDatabase(admin, url!)
    await admin.query(`CREATE SCHEMA ${schema}`)
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` })
    await initDB(pool)
  }, 30000)
  beforeEach(async () => {
    await pool.query('TRUNCATE token_usage_accounting_state,users,events,sessions,daemons,audit_log,deleted_sessions,event_inbox,token_daily_closures,token_usage_facts,token_daily_stats,token_session_daily_stats CASCADE')
    await pool.query("INSERT INTO token_usage_accounting_state(key,completed_at) VALUES('baseline-v1','2026-08-01')")
    userId = (await pool.query("INSERT INTO users(email,password_hash) VALUES('dead@example.test','') RETURNING id")).rows[0].id
  })
  afterAll(async () => { await pool?.end(); await admin?.query(`DROP SCHEMA ${schema} CASCADE`); await admin?.end() })
  async function dead(type: string, payload: object) {
    return (await pool.query(`INSERT INTO event_inbox(user_id,daemon_id,daemon_generation,seq,dedup_key,session_id,event_type,priority_class,received_at,payload,status,last_error)
      VALUES($1,'dead-daemon',1,(SELECT count(*)+1 FROM event_inbox),$2::text,'dead-session',$2::text,1,$3::date,$4,3,'unknown_daemon_session') RETURNING inbox_id`, [userId,type,date,payload])).rows[0].inbox_id
  }
  test('non-accounting failures do not block facts; preserve dead letters and audit their count', async () => {
    await dead('session_document_begin', { document_state: 'unavailable' })
    await dead('subagent_usage', { usage: { input_tokens: 7 } })
    await dead('tool_call', { tool: 'read' })
    await expect(closeTokenUsageDay(pool,date)).resolves.toMatchObject({ status: 'sealed', factCount: 0, total: 0, nonAccountingDeadLetterRows: 3 })
    expect((await pool.query('SELECT count(*)::int n FROM event_inbox WHERE status=3')).rows[0].n).toBe(3)
    expect((await pool.query("SELECT details FROM audit_log WHERE action='token_day_non_accounting'")).rows[0].details).toEqual({date,count:3,policy:'non_accounting_v1'})
  })
  test.each([
    ['agent_text', { usage: { input_tokens: 7 } }],
    ['agent_text', { usage: null }],
    ['future_event', {}],
    ['tool_call', { usage: { input_tokens: 7 } }],
  ])('unknown or potentially accounting failure remains blocked: %s %j', async(type,payload) => {
    await dead(type,payload)
    await expect(closeTokenUsageDay(pool,date)).resolves.toMatchObject({ status:'failed', deadLetterRows:1 })
    expect((await pool.query('SELECT count(*)::int n FROM token_daily_stats')).rows[0].n).toBe(0)
  })
  test('explicit owned usage recovery is dry-run by default, audited, and materializes exactly once', async () => {
    await pool.query("INSERT INTO daemons(daemon_id,user_id) VALUES('dead-daemon',$1)", [userId])
    await pool.query("INSERT INTO sessions(session_id,daemon_id,user_id) VALUES('dead-session','dead-daemon',$1)", [userId])
    const payload = { type:'agent_text', session_id:'dead-session', event_id:'usage-1', resync:true, usage:{input_tokens:7,output_tokens:2} }
    const id = await dead('agent_text',payload)
    expect(await recoverOwnedTokenDeadLetters(pool,[id])).toHaveLength(1)
    expect((await pool.query('SELECT status FROM event_inbox WHERE inbox_id=$1',[id])).rows[0].status).toBe(3)
    expect(await recoverOwnedTokenDeadLetters(pool,[id],true)).toHaveLength(1)
    expect((await pool.query('SELECT status,last_error FROM event_inbox WHERE inbox_id=$1',[id])).rows[0]).toEqual({status:0,last_error:null})
    expect((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='token_dead_letter_requeue'")).rows[0].n).toBe(1)
    const mat = new EventMaterializer({pool,writeTokenUsageFacts:true,extensionJournalSink:null})
    const input = {inboxId:Number(id),userId,daemonId:'dead-daemon',sessionId:'dead-session',eventType:'agent_text',payload,receivedAt:new Date(date+'T12:00:00Z')}
    await mat.materialize(input); await mat.materialize(input)
    await mat.materialize({...input,inboxId:Number(id)+1000})
    expect((await pool.query('SELECT input,output FROM token_usage_facts')).rows).toEqual([{input:'7',output:'2'}])
    expect((await pool.query("SELECT total_tokens FROM sessions WHERE session_id='dead-session'")).rows[0].total_tokens).toBe('9')
    await expect(recoverOwnedTokenDeadLetters(pool,[id],true)).rejects.toThrow('preconditions changed')
  })
  test('recovery fails closed for unknown owners, tombstones, non-replay and sealed dates', async () => {
    const id=await dead('agent_text',{type:'agent_text',session_id:'dead-session',event_id:'usage-2',resync:true,usage:{input_tokens:7}})
    expect(await recoverOwnedTokenDeadLetters(pool,[id])).toEqual([])
    await expect(recoverOwnedTokenDeadLetters(pool,[id],true)).rejects.toThrow('preconditions changed')
    await pool.query("INSERT INTO daemons(daemon_id,user_id) VALUES('dead-daemon',$1)",[userId])
    await pool.query("INSERT INTO sessions(session_id,daemon_id,user_id) VALUES('dead-session','dead-daemon',$1)",[userId])
    await pool.query("UPDATE sessions SET user_id=NULL")
    expect(await recoverOwnedTokenDeadLetters(pool,[id])).toEqual([])
    await pool.query("UPDATE sessions SET user_id=$1",[userId])
    await pool.query("INSERT INTO deleted_sessions(session_id) VALUES('dead-session')")
    expect(await recoverOwnedTokenDeadLetters(pool,[id])).toEqual([])
    await pool.query('DELETE FROM deleted_sessions')
    await pool.query("UPDATE event_inbox SET payload=payload-'resync'")
    expect(await recoverOwnedTokenDeadLetters(pool,[id])).toEqual([])
    await pool.query(`UPDATE event_inbox SET payload=payload||'{"resync":true}'::jsonb`)
    await pool.query("INSERT INTO token_daily_closures(date,status) VALUES($1,'sealed')",[date])
    expect(await recoverOwnedTokenDeadLetters(pool,[id])).toEqual([])
  })

})
