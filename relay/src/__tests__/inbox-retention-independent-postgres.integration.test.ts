import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { initDurableIngressSchema } from '../schema/durable-ingress.js'
import { TeamRepository } from '../team/repository.js'
import { TeamSessionService } from '../team/session-service.js'
import { TeamContextService } from '../team/context-service.js'
import { InboxRetention } from '../inbox-retention.js'
import { InboxRepository } from '../ingress/inbox-repository.js'
import { resetDurableIngressPublicSchema } from './durable-ingress-test-db.js'

const url = process.env.TEST_DATABASE_URL
const suite = url && process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
suite('independent durable ingress retention', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 3 })
    await resetDurableIngressPublicSchema(pool, url!)
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
  test('preserves pending and processing work and receipts even when old and acknowledged', async () => {
    const id=await heldInbox(); await delivery(id); await receipt(id)
    for (const status of [0,1]) {
      await pool.query('UPDATE event_inbox SET status=$1',[status])
      const result=await new InboxRetention(pool).runOnce()
      expect(result.failures).toEqual([])
      expect(result.inspected[['pending','processing'][status]]).toBe(1)
      expect((await pool.query('SELECT count(*)::int n FROM event_inbox_receipt')).rows[0].n).toBe(1)
      expect((await pool.query('SELECT count(*)::int n FROM realtime_outbox')).rows[0].n).toBe(1)
    }
  })
  test('retires only expired, acknowledged receipts of a failed inbox', async () => {
    const id = await heldInbox()
    await delivery(id)
    await receipt(id, 2)
    const failed = await pool.query(`UPDATE event_inbox SET status=3, attempts=12,
      last_error='materialization_failed', completed_at=NULL WHERE inbox_id=$1 RETURNING *`, [id])
    await pool.query(`INSERT INTO event_inbox_receipt(inbox_id,daemon_id,daemon_generation,seq,received_at)
      VALUES ($1,'gc-test',1,2,now()), ($1,'gc-test',1,3,now()-interval '8 hours'),
             ($1,'gc-test',2,1,now()-interval '8 hours')`, [id])

    const result = await new InboxRetention(pool).runOnce()
    expect(result).toMatchObject({ failures: [], deletedReceipts: 1, deletedCompleted: 0, deletedOutbox: 0 })
    expect(result.inspected.failed_requires_review).toBe(1)
    expect((await pool.query(`SELECT daemon_generation, seq FROM event_inbox_receipt
      WHERE inbox_id=$1 ORDER BY daemon_generation,seq`, [id])).rows).toEqual([
      { daemon_generation: '1', seq: '2' }, // recent
      { daemon_generation: '1', seq: '3' }, // above checkpoint
      { daemon_generation: '2', seq: '1' }, // generation without a checkpoint
    ])
    expect((await pool.query('SELECT * FROM event_inbox WHERE inbox_id=$1', [id])).rows).toEqual(failed.rows)
  })

  test('drains repeated failed-event receipts in bounded batches', async () => {
    const id = await heldInbox()
    await pool.query('UPDATE event_inbox SET status=3 WHERE inbox_id=$1', [id])
    await pool.query("UPDATE daemon_ack_checkpoint SET ack_seq=1001 WHERE daemon_id='gc-test' AND daemon_generation=1")
    await pool.query(`INSERT INTO event_inbox_receipt(inbox_id,daemon_id,daemon_generation,seq,received_at)
      SELECT $1,'gc-test',1,n,now()-interval '8 hours' FROM generate_series(1,1001) n`, [id])

    const retention = new InboxRetention(pool)
    expect(await retention.runOnce()).toMatchObject({ failures: [], deletedReceipts: 1000, moreWork: true })
    expect(await retention.runOnce()).toMatchObject({ failures: [], deletedReceipts: 1, moreWork: false })
    expect((await pool.query('SELECT status FROM event_inbox WHERE inbox_id=$1', [id])).rows).toEqual([{ status: 3 }])
  })

  test('skips the receipt of a failed inbox while recovery is requeuing it', async () => {
    const id = await heldInbox()
    await receipt(id)
    await pool.query('UPDATE event_inbox SET status=3 WHERE inbox_id=$1', [id])
    const recovery = await pool.connect()
    try {
      await recovery.query('BEGIN')
      await recovery.query('UPDATE event_inbox SET status=0 WHERE inbox_id=$1', [id])
      const result = await new InboxRetention(pool).runOnce()
      expect(result).toMatchObject({ failures: [], deletedReceipts: 0 })
      await recovery.query('COMMIT')
    } catch (error) {
      await recovery.query('ROLLBACK')
      throw error
    } finally {
      recovery.release()
    }
    expect((await pool.query('SELECT inbox_id FROM event_inbox_receipt')).rows).toEqual([{ inbox_id: id }])
  })

  test('upgrades the old stage constraint in place and preserves cleanup history', async () => {
    await pool.query(`ALTER TABLE ingress_retention_status DROP CONSTRAINT ingress_retention_status_stage_v2;
      DELETE FROM ingress_retention_status WHERE stage='failed_inbox';
      ALTER TABLE ingress_retention_status ADD CONSTRAINT ingress_retention_status_stage_check
        CHECK(stage IN ('outbox','receipts','inbox','uploads','inspection'));
      INSERT INTO ingress_retention_status(stage,last_attempt_at,deleted_total) VALUES('inbox',now(),1234)
        ON CONFLICT(stage) DO UPDATE SET deleted_total=1234`)
    await initDurableIngressSchema(pool)
    await initDurableIngressSchema(pool)
    expect(await new InboxRetention(pool).runOnce()).toMatchObject({failures:[]})
    const stages = await pool.query("SELECT stage,deleted_total FROM ingress_retention_status WHERE stage IN ('failed_inbox','inbox') ORDER BY stage")
    expect(stages.rows).toEqual([{stage:'failed_inbox',deleted_total:'0'},{stage:'inbox',deleted_total:'1234'}])
  })

  async function failureFixture() {
    const daemon = randomUUID(), session = randomUUID()
    const user = (await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'x') RETURNING id",
      [daemon+'@example.test'])).rows[0].id
    await pool.query('INSERT INTO daemons(daemon_id,user_id) VALUES($1,$2)',[daemon,user])
    await pool.query('INSERT INTO sessions(session_id,daemon_id,user_id) VALUES($1,$2,$3)',[session,daemon,user])
    await pool.query('INSERT INTO daemon_ack_checkpoint(daemon_id,daemon_generation,ack_seq) VALUES($1,1,10000)',[daemon])
    let seq = 0
    async function failed(type: string, error: string, payload: Record<string,unknown>, attempts=1) {
      seq++
      return (await pool.query(`INSERT INTO event_inbox
        (user_id,session_id,daemon_id,daemon_generation,seq,dedup_key,event_type,priority_class,payload,status,
         received_at,completed_at,last_error,attempts)
        VALUES ($1,$2,$3,1,$4,$5,$6,0,$7,3,now()-interval '8 hours',now()-interval '7 hours',$8,$9)
        RETURNING inbox_id`,[user,session,daemon,seq,String(seq),type,{type,session_id:session,...payload},error,attempts])).rows[0].inbox_id as string
    }
    return {user, session, daemon, failed}
  }

  test('retires an exhausted side-effect-free replay only after its original payload is confirmed', async () => {
    const {user,session,failed} = await failureFixture()
    const data = {event_id:'stable',resync:true,text:'one'}
    await pool.query(`INSERT INTO events(user_id,session_id,event_type,event_hash,effect_status,payload)
      VALUES ($1,$2::varchar,'tool_result',left(md5($2::varchar||':tool_result:event:stable'),16),'completed',$3)`,
    [user,session,{type:'tool_result',session_id:session,event_id:'stable',text:'one',seq:4}])
    const retired = await failed('tool_result','materialization_failed',data,12)
    await failed('tool_result','materialization_failed',data,11)
    await failed('tool_result','materialization_failed',{...data,text:'two'},12)
    await failed('tool_result','materialization_failed',{...data,usage:null},12)
    await failed('tool_result','replay_payload_conflict',data,12)
    const pendingEffect = await failed('tool_result','materialization_failed',data,12)
    await pool.query("UPDATE event_inbox SET materialization_context=jsonb_build_object('admission',true) WHERE inbox_id=$1",[pendingEffect])
    const corruptContext = await failed('tool_result','materialization_failed',data,12)
    await pool.query("UPDATE event_inbox SET materialization_context='null'::jsonb WHERE inbox_id=$1",[corruptContext])
    const result = await new InboxRetention(pool).runOnce()
    expect(result).toMatchObject({failures:[],deletedFailed:1,deletedCompleted:0})
    expect((await pool.query('SELECT 1 FROM event_inbox WHERE inbox_id=$1',[retired])).rowCount).toBe(0)
  })

  test('distinguishes a missing session from a deletion tombstone, and preserves recovery and ACK evidence', async () => {
    const {failed,session,daemon} = await failureFixture()
    const missing = randomUUID()
    await failed('tool_call','unknown_daemon_session',{})
    await failed('agent_text','unknown_daemon_session',{usage:{input_tokens:5}})
    await failed('agent_text','unknown_daemon_session',{}) // live statistics watermark
    const recent = await failed('tool_call','unknown_daemon_session',{})
    await pool.query('UPDATE event_inbox SET completed_at=now() WHERE inbox_id=$1',[recent])
    const deliveryId = await failed('tool_call','unknown_daemon_session',{})
    await delivery(deliveryId,'1 minute')
    const receiptId = await failed('tool_call','unknown_daemon_session',{})
    await pool.query(`INSERT INTO event_inbox_receipt(inbox_id,daemon_id,daemon_generation,seq)
      VALUES($1,$2,2,1)`,[receiptId,daemon])
    await pool.query('UPDATE event_inbox SET session_id=$1 WHERE session_id=$2',[missing,session])
    const retention = new InboxRetention(pool)
    expect(await retention.runOnce()).toMatchObject({failures:[],deletedFailed:0})
    await pool.query('INSERT INTO deleted_sessions(session_id) VALUES($1)',[missing])
    const lock = await pool.connect()
    try {
      await lock.query('BEGIN')
      await lock.query('SELECT 1 FROM event_inbox WHERE dedup_key=\'1\' FOR UPDATE')
      expect(await retention.runOnce()).toMatchObject({failures:[],deletedFailed:0})
    } finally { await lock.query('ROLLBACK'); lock.release() }
    expect(await retention.runOnce()).toMatchObject({failures:[],deletedFailed:1})
    expect((await pool.query('SELECT dedup_key FROM event_inbox ORDER BY seq')).rows.map(r=>r.dedup_key))
      .toEqual(['2','3','4','5','6'])
  })

  test('checks the committed document bytes and isolates malformed packets', async () => {
    const {user,session,failed} = await failureFixture()
    const doc=randomUUID(), version=randomUUID()
    await pool.query(`INSERT INTO session_documents(document_id,user_id,session_id,display_name,document_format,
      last_source_turn_id,last_source_event_id,state,captured_at) VALUES($1,$2,$3,'note','markdown','t','e','available',now())`,[doc,user,session])
    const digest = (await pool.query(`INSERT INTO session_document_versions(version_id,user_id,session_id,document_id,
      source_turn_id,source_event_id,byte_size,sha256,captured_at,content_bytes)
      VALUES($1,$2,$3,$4,'t','e',3,encode(sha256('abc'::bytea),'hex'),now(),'abc') RETURNING sha256`,
    [version,user,session,doc])).rows[0].sha256
    const base={document_id:doc,version_id:version,event_id:'e'}
    await failed('session_document_commit','document_upload_expired',{...base,total_bytes:3,content_hash:digest})
    const chunk={...base,chunk_hash:digest,chunk_data:'YWJj',byte_offset:0}
    await failed('session_document_chunk','document_upload_expired',chunk)
    await failed('session_document_chunk','document_upload_expired',{...chunk,chunk_data:'===='})
    await failed('session_document_chunk','document_upload_expired',{...chunk,byte_offset:'invalid'})
    await failed('session_document_commit','document_upload_expired',{...base,total_bytes:4,content_hash:digest})
    await failed('session_document_begin','document_integrity',{event_id:'missing-document-id'})
    await failed('session_document_begin','document_integrity',base)
    await failed('session_document_begin','document_integrity',{...base,document_id:null})
    await failed('session_document_commit','document_integrity',{...base,version_id:' '})
    expect(await new InboxRetention(pool).runOnce()).toMatchObject({failures:[],deletedFailed:5})
    expect((await pool.query('SELECT dedup_key FROM event_inbox ORDER BY seq')).rows.map(r=>r.dedup_key))
      .toEqual(['3','4','5','7'])
    expect((await pool.query('SELECT byte_size FROM session_document_versions WHERE version_id=$1',[version])).rows[0].byte_size).toBe(3)
  })

  test('a failed dead-letter transaction does not stop completed-event cleanup', async () => {
    const {failed} = await failureFixture()
    await failed('session_document_begin','document_integrity',{})
    const completed = await heldInbox()
    await pool.query("UPDATE event_inbox SET payload='{}' WHERE inbox_id=$1",[completed])
    await pool.query(`CREATE FUNCTION reject_failed_gc() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'dead-letter test failure'; END $$;
      CREATE TRIGGER reject_failed_gc BEFORE DELETE ON event_inbox FOR EACH ROW
      WHEN (OLD.status=3) EXECUTE FUNCTION reject_failed_gc()`)
    try {
      const result = await new InboxRetention(pool).runOnce()
      expect(result.deletedCompleted).toBe(1)
      expect(result.deletedFailed).toBe(0)
      expect(result.failures).toEqual([{stage:'failed_inbox',code:'P0001',receiptPersisted:true}])
    } finally {
      await pool.query('DROP TRIGGER reject_failed_gc ON event_inbox; DROP FUNCTION reject_failed_gc()')
    }
  })

  test('advances past a protected page and revisits it after wrapping', async () => {
    const {daemon,failed} = await failureFixture()
    await pool.query(`INSERT INTO event_inbox(daemon_id,daemon_generation,seq,dedup_key,event_type,priority_class,payload,
      status,received_at,completed_at,last_error) SELECT $1,1,n,'held-'||n,'agent_text',1,'{"usage":null}',
      3,now()-interval '9 hours',now()-interval '8 hours','unknown_daemon_session' FROM generate_series(1,250) n`,[daemon])
    await failed('session_document_begin','document_integrity',{})
    const retention = new InboxRetention(pool)
    expect(await retention.runOnce()).toMatchObject({failures:[],deletedFailed:0})
    expect(await retention.runOnce()).toMatchObject({failures:[],deletedFailed:1})
    expect(await retention.runOnce()).toMatchObject({failures:[],deletedFailed:0})
  })

  test.each([
    { status: 2, inspected: 'team_recovery', deletedCompleted: 1, deletedOutbox: 1 },
    { status: 3, inspected: 'failed_requires_review', deletedCompleted: 0, deletedOutbox: 0 },
  ])('retains transport evidence for an uncertain Team call with inbox status $status', async ({
    status, inspected, deletedCompleted, deletedOutbox,
  }) => {
    const user=(await pool.query("INSERT INTO users(email,password_hash,team_enabled) VALUES($1,'x',true) RETURNING id", [`gc-team-${randomUUID()}@example.test`])).rows[0].id
    const teams=new TeamRepository(pool)
    const team=await teams.createTeam({actorUserId:user,name:'GC Team',requestId:'gc-team'})
    const daemonId = `gc-team-daemon-${user}`
    const nativeSessionId = `gc-native-${user}`
    await pool.query(`INSERT INTO daemons(daemon_id,hostname,agents,status,user_id,collaboration_capabilities)
      VALUES($2,'local','[{"type":"codex","manageable":true}]','online',$1,'["team_collaboration_dispatch_v1","team_collaboration_context_v1"]')`,[user,daemonId])
    const offer=await teams.addAgentOffer({teamId:team.team.id,actorUserId:user,daemonId,provider:'codex',runtimeProfileId:null,expectedRevision:1,requestId:'gc-offer'})
    const sessions=new TeamSessionService(pool)
    const shared=await sessions.createSession({teamId:team.team.id,actorUserId:user,title:'GC session',taskId:null,offerIds:[offer.id],requestId:'gc-session'})
    await new TeamContextService(pool).create({sessionId:shared.id,actorUserId:user,expectedRevision:0,requestId:'gc-context',goal:'Test GC',consensus:[],openQuestions:[],references:[]})
    const message=await sessions.appendMessage({sessionId:shared.id,actorUserId:user,requestId:'gc-message',content:'Test',targetMode:'all',targetOfferIds:[],referenceEventId:null})
    await pool.query("UPDATE collaboration_calls SET native_session_id=$2,state='uncertain' WHERE call_id=$1",[message.call_ids[0],nativeSessionId])
    const id=await heldInbox(); await receipt(id); await delivery(id)
    await pool.query("UPDATE event_inbox SET status=$1,session_id=$2,payload='{}',event_type='collaboration_dispatch_receipt' WHERE inbox_id=$3", [status,nativeSessionId,id])
    const first=await new InboxRetention(pool).runOnce()
    expect(first.failures).toEqual([])
    expect(first.inspected[inspected]).toBe(1)
    expect(first.deletedOutbox).toBe(deletedOutbox)
    expect((await pool.query('SELECT inbox_id FROM event_inbox_receipt')).rows).toEqual([{ inbox_id: id }])
    await pool.query("UPDATE collaboration_calls SET state='blocked' WHERE call_id=$1",[message.call_ids[0]])
    expect(await new InboxRetention(pool).runOnce()).toMatchObject({ failures: [], deletedReceipts: 1, deletedCompleted })
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
