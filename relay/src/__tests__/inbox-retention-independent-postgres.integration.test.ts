import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { TeamRepository } from '../team/repository.js'
import { TeamSessionService } from '../team/session-service.js'
import { TeamContextService } from '../team/context-service.js'
import { InboxRetention } from '../inbox-retention.js'
import { InboxRepository } from '../ingress/inbox-repository.js'
import { assertDurableIngressTestDatabase } from './durable-ingress-test-db.js'

const url = process.env.TEST_DATABASE_URL
const suite = url && process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
suite('independent durable ingress retention', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 3 })
    await assertDurableIngressTestDatabase(pool, url!)
    await initDB(pool)
  }, 30_000)
  afterAll(async () => { await pool?.end() })
  beforeEach(async () => {
    await pool.query('TRUNCATE event_inbox, event_inbox_receipt, realtime_outbox, daemon_ack_checkpoint RESTART IDENTITY CASCADE')
    await pool.query("DELETE FROM token_usage_accounting_state WHERE key='baseline-v1'")
    await pool.query("INSERT INTO token_usage_accounting_state(key,completed_at) VALUES('baseline-v1',now()-interval '30 days')")
  })
  async function heldInbox() {
    await pool.query("INSERT INTO daemon_ack_checkpoint(daemon_id,daemon_generation,ack_seq) VALUES('gc-test',1,1)")
    return (await pool.query(`INSERT INTO event_inbox(daemon_id,daemon_generation,seq,dedup_key,event_type,priority_class,payload,status,completed_at,received_at)
      VALUES('gc-test',1,1,'gc-held','agent_text',0,'{"usage":{"input_tokens":1}}',2,now()-interval '8 hours',now()-interval '8 hours') RETURNING inbox_id`)).rows[0].inbox_id
  }
  async function delivery(id: string, age='8 hours') {
    await pool.query(`INSERT INTO realtime_outbox(inbox_id,delivery_key,event_type,audience,payload,delivered_at)
      VALUES($1,'gc-delivery','agent_text','session','{}',now()-$2::interval)`,[id,age])
  }
  async function receipt(id: string | null, ack=1) {
    await pool.query(`INSERT INTO daemon_ack_checkpoint(daemon_id,daemon_generation,ack_seq) VALUES('gc-test',1,$1) ON CONFLICT(daemon_id,daemon_generation) DO UPDATE SET ack_seq=EXCLUDED.ack_seq`,[ack])
    await pool.query(`INSERT INTO event_inbox_receipt(inbox_id,daemon_id,daemon_generation,seq,received_at)
      VALUES($1,'gc-test',1,1,now()-interval '8 hours')`,[id])
  }
  test('retires delivered outbox and acknowledged receipts without deleting unsealed usage', async () => {
    const id=await heldInbox(); await delivery(id); await receipt(id)
    await new InboxRetention(pool).runOnce()
    expect((await pool.query('SELECT count(*)::int n FROM realtime_outbox')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM event_inbox_receipt')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT payload FROM event_inbox')).rows).toEqual([{payload:{usage:{input_tokens:1}}}])
    // ACK remains authoritative after receipt GC: replay cannot recreate data.
    const checkpoints=await new InboxRepository(pool).persistBatch([{
      userId:null,daemonId:'gc-test',registrationId:'gc-test',daemonGeneration:1,seq:1,
      dedupKey:'gc-held',sessionId:null,eventType:'agent_text',priority:'live',
      payload:{usage:{input_tokens:1}},materializationContext:{},receivedAt:new Date(),
    }])
    expect([...checkpoints.values()][0].ackSeq).toBe(1)
    expect((await pool.query('SELECT count(*)::int n FROM event_inbox_receipt')).rows[0].n).toBe(0)
  })
  test('does not cascade away a receipt needed to close an ACK gap', async () => {
    const id=await heldInbox(); await receipt(id,0)
    await pool.query("UPDATE event_inbox SET payload='{}'")
    await new InboxRetention(pool).runOnce()
    expect((await pool.query('SELECT count(*)::int n FROM event_inbox')).rows[0].n).toBe(1)
    expect((await pool.query('SELECT count(*)::int n FROM event_inbox_receipt')).rows[0].n).toBe(1)
    await pool.query('UPDATE daemon_ack_checkpoint SET ack_seq=1')
    await new InboxRetention(pool).runOnce()
    expect((await pool.query('SELECT count(*)::int n FROM event_inbox')).rows[0].n).toBe(0)
  })
  test('retains newly delivered outbox even when the parent completed long ago', async () => {
    const id=await heldInbox(); await delivery(id,'1 hour')
    await pool.query("UPDATE event_inbox SET payload='{}'")
    await new InboxRetention(pool).runOnce()
    expect((await pool.query('SELECT count(*)::int n FROM realtime_outbox')).rows[0].n).toBe(1)
    await pool.query("UPDATE realtime_outbox SET delivered_at=now()-interval '7 hours'")
    await new InboxRetention(pool).runOnce()
    expect((await pool.query('SELECT count(*)::int n FROM event_inbox')).rows[0].n).toBe(0)
  })
  test('a failed inbox deletion cannot roll back successful independent cleanup', async () => {
    const id=await heldInbox(); await delivery(id); await receipt(null)
    await pool.query("UPDATE event_inbox SET payload='{}'")
    await pool.query(`CREATE FUNCTION gc_test_reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure' USING ERRCODE='40001'; END $$`)
    await pool.query('CREATE TRIGGER gc_test_reject_delete BEFORE DELETE ON event_inbox FOR EACH ROW EXECUTE FUNCTION gc_test_reject_delete()')
    try {
      const result = await new InboxRetention(pool).runOnce()
      expect(result.failures).toEqual([{stage:'inbox',code:'40001',receiptPersisted:true}])
      const health = (await pool.query("SELECT last_error_code FROM ingress_retention_status WHERE stage='inbox'")).rows[0]
      expect(health.last_error_code).toBe('40001')
      expect((await pool.query('SELECT count(*)::int n FROM realtime_outbox')).rows[0].n).toBe(0)
      expect((await pool.query('SELECT count(*)::int n FROM event_inbox_receipt')).rows[0].n).toBe(0)
    } finally {
      await pool.query('DROP TRIGGER gc_test_reject_delete ON event_inbox')
      await pool.query('DROP FUNCTION gc_test_reject_delete()')
    }
    await new InboxRetention(pool).runOnce()
    expect((await pool.query('SELECT count(*)::int n FROM event_inbox')).rows[0].n).toBe(0)
    expect((await pool.query("SELECT last_error_code,last_success_at FROM ingress_retention_status WHERE stage='inbox'")).rows[0])
      .toMatchObject({last_error_code:null,last_success_at:expect.any(Date)})
  })
  test('an old parent cannot cascade a recent acknowledged replay receipt', async () => {
    const id=await heldInbox(); await receipt(id)
    await pool.query("UPDATE event_inbox SET payload='{}'")
    await pool.query('UPDATE event_inbox_receipt SET received_at=now()')
    const first=await new InboxRetention(pool).runOnce()
    expect(first.inspected.receipt_within_retention).toBe(1)
    expect(first.deletedCompleted).toBe(0)
    await pool.query("UPDATE event_inbox_receipt SET received_at=now()-interval '7 hours'")
    expect((await new InboxRetention(pool).runOnce()).deletedCompleted).toBe(1)
  })
  test('preserves pending/failed work and receipts even when old and acknowledged', async () => {
    const id=await heldInbox(); await delivery(id); await receipt(id)
    for (const status of [0,1,3]) {
      await pool.query('UPDATE event_inbox SET status=$1',[status])
      const result=await new InboxRetention(pool).runOnce()
      expect(result.failures).toEqual([])
      expect(result.inspected[['pending','processing','unused','failed_requires_review'][status]]).toBe(1)
      expect((await pool.query('SELECT count(*)::int n FROM event_inbox_receipt')).rows[0].n).toBe(1)
      expect((await pool.query('SELECT count(*)::int n FROM realtime_outbox')).rows[0].n).toBe(1)
    }
  })
  test('retains Inbox and transport evidence for an uncertain Team call until settled', async () => {
    const user=(await pool.query("INSERT INTO users(email,password_hash,team_enabled) VALUES('gc-team@example.test','x',true) RETURNING id")).rows[0].id
    const teams=new TeamRepository(pool)
    const team=await teams.createTeam({actorUserId:user,name:'GC Team',requestId:'gc-team'})
    await pool.query(`INSERT INTO daemons(daemon_id,hostname,agents,status,user_id,collaboration_capabilities)
      VALUES('gc-team-daemon','local','[{"type":"codex","manageable":true}]','online',$1,'["team_collaboration_dispatch_v1","team_collaboration_context_v1"]')`,[user])
    const offer=await teams.addAgentOffer({teamId:team.team.id,actorUserId:user,daemonId:'gc-team-daemon',provider:'codex',runtimeProfileId:null,expectedRevision:1,requestId:'gc-offer'})
    const sessions=new TeamSessionService(pool)
    const shared=await sessions.createSession({teamId:team.team.id,actorUserId:user,title:'GC session',taskId:null,offerIds:[offer.id],requestId:'gc-session'})
    await new TeamContextService(pool).create({sessionId:shared.id,actorUserId:user,expectedRevision:0,requestId:'gc-context',goal:'Test GC',consensus:[],openQuestions:[],references:[]})
    const message=await sessions.appendMessage({sessionId:shared.id,actorUserId:user,requestId:'gc-message',content:'Test',targetMode:'all',targetOfferIds:[],referenceEventId:null})
    await pool.query("UPDATE collaboration_calls SET native_session_id='gc-native',state='uncertain' WHERE call_id=$1",[message.call_ids[0]])
    const id=await heldInbox(); await receipt(id); await delivery(id)
    await pool.query("UPDATE event_inbox SET session_id='gc-native',payload='{}',event_type='collaboration_dispatch_receipt'")
    const first=await new InboxRetention(pool).runOnce()
    expect(first.inspected.team_recovery).toBe(1)
    expect((await pool.query('SELECT count(*)::int n FROM event_inbox_receipt')).rows[0].n).toBe(1)
    expect((await pool.query('SELECT count(*)::int n FROM realtime_outbox')).rows[0].n).toBe(0)
    await pool.query("UPDATE collaboration_calls SET state='blocked' WHERE call_id=$1",[message.call_ids[0]])
    expect((await new InboxRetention(pool).runOnce()).deletedCompleted).toBe(1)
  })
  test('concurrent passes drain bounded batches and converge without deleting billing evidence', async () => {
    await pool.query(`INSERT INTO event_inbox(daemon_id,daemon_generation,seq,dedup_key,event_type,priority_class,payload,status,completed_at,received_at)
      SELECT 'gc-batch',1,n,'gc-batch-'||n,'agent_text',0,'{"usage":{"input_tokens":1}}',2,now()-interval '8 hours',now()-interval '8 hours' FROM generate_series(1,2001) n`)
    await pool.query(`INSERT INTO realtime_outbox(inbox_id,delivery_key,event_type,audience,payload,delivered_at)
      SELECT inbox_id,'gc-batch-'||inbox_id,'agent_text','session','{}',now()-interval '8 hours' FROM event_inbox`)
    const results=await Promise.all([new InboxRetention(pool).runOnce(),new InboxRetention(pool).runOnce()])
    expect(results.flatMap(x=>x.failures)).toEqual([])
    expect(results.reduce((n,r)=>n+r.deletedOutbox,0)).toBe(2000)
    expect(results.every(r=>r.moreWork)).toBe(true)
    expect((await new InboxRetention(pool).runOnce()).deletedOutbox).toBe(1)
    expect((await new InboxRetention(pool).runOnce()).moreWork).toBe(false)
    expect((await pool.query('SELECT count(*)::int n FROM event_inbox')).rows[0].n).toBe(2001)
  })

  test('a locked health receipt is bounded and cannot stall later cleanup stages', async () => {
    const id=await heldInbox(); await delivery(id); await receipt(id)
    await pool.query("UPDATE event_inbox SET payload='{}'")
    await pool.query("INSERT INTO ingress_retention_status(stage,last_attempt_at) VALUES('inbox',now()) ON CONFLICT DO NOTHING")
    const locker=await pool.connect()
    await locker.query('BEGIN')
    await locker.query("SELECT 1 FROM ingress_retention_status WHERE stage='inbox' FOR UPDATE")
    try {
      const result=await new InboxRetention(pool).runOnce()
      expect(result.failures).toEqual([{stage:'inbox',code:'55P03',receiptPersisted:false}])
      expect(result.deletedOutbox).toBe(1)
      expect(result.deletedReceipts).toBe(1)
      expect(result.inspected.eligible).toBe(1)
    } finally { await locker.query('ROLLBACK'); locker.release() }
    expect((await new InboxRetention(pool).runOnce()).deletedCompleted).toBe(1)
  }, 10_000)

  test('an in-flight transport receipt prevents parent deletion and survives the next pass', async () => {
    const id=await heldInbox()
    await pool.query("UPDATE event_inbox SET payload='{}'")
    const writer=await pool.connect()
    await writer.query('BEGIN')
    try {
      await writer.query(`INSERT INTO event_inbox_receipt(inbox_id,daemon_id,daemon_generation,seq,received_at)
        VALUES($1,'gc-test',2,1,now()-interval '7 hours')`,[id])
      expect((await new InboxRetention(pool).runOnce()).deletedCompleted).toBe(0)
      await writer.query('COMMIT')
    } finally { await writer.query('ROLLBACK'); writer.release() }
    expect((await new InboxRetention(pool).runOnce()).deletedCompleted).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM event_inbox_receipt')).rows[0].n).toBe(1)
    await pool.query("INSERT INTO daemon_ack_checkpoint(daemon_id,daemon_generation,ack_seq) VALUES('gc-test',2,1)")
    expect((await new InboxRetention(pool).runOnce()).deletedCompleted).toBe(1)
  })

})
