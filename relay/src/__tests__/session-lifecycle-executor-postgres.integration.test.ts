import { createHash,randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import type pg from 'pg'
import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,test } from 'vitest'
import { initDB,advanceSessionActivity,getSessionAllEvents,renameOwnedDaemonSession } from '../db.js'
import { lifecycleTestPool } from './session-lifecycle-test-database.js'
import { sessionLifecycleConfig } from '../session-lifecycle/config.js'
import { inspectLifecycleEligibility } from '../session-lifecycle/eligibility.js'
import { SessionLifecycleExecutor } from '../session-lifecycle/executor.js'
import { enableSessionColdBodies } from '../session-lifecycle/cold-schema.js'
import { PrivateObjectArchiveStorage } from '../session-archive/object-storage.js'
import type { ArchiveStorage } from '../session-archive/storage.js'
import { installPostgresHistoryBodyReader,withSessionHistoryScope } from '../session-history/postgres-reader.js'
import { installDocumentBodyReader,readDocumentBody } from '../session-documents/body-reader.js'
import { ArchiveObjectCollector } from '../session-archive/object-gc.js'
import { createSessionLifecycleWorker } from '../session-lifecycle/worker.js'

const suite=process.env.RUN_SESSION_LIFECYCLE_POSTGRES==='1'&&process.env.RUN_SESSION_LIFECYCLE_OBJECTS==='1'?describe:describe.skip
suite('actual archive, cooling and business resume PostgreSQL + private objects',()=>{
  let pool:pg.Pool,userId:number,storage:PrivateObjectArchiveStorage,executor:SessionLifecycleExecutor
  let onPut:(()=>Promise<void>)|undefined,failPut=false
  let lastError:unknown
  const keys=new Set<string>(),config=sessionLifecycleConfig({SESSION_LIFECYCLE_EFFECTIVE_AT:'2026-01-01T00:00:00Z',SESSION_LIFECYCLE_TRANSITION_DEADLINE:'2026-01-01T00:00:00Z'})
  const limits={maxRawBytes:config.maxChunkBytes,maxCompressedBytes:config.maxCompressedBytes,maxRecords:1000}
  const adapter:ArchiveStorage={get namespace(){return storage.namespace},put:async(key,bytes)=>{keys.add(key);if(failPut)throw new Error('fixture outage');await storage.put(key,bytes);await onPut?.()},read:key=>storage.read(key),delete:key=>storage.delete(key)}
  beforeAll(async()=>{
    pool=await lifecycleTestPool();await initDB(pool);await enableSessionColdBodies(pool)
    const endpoint=process.env.TEST_SESSION_LIFECYCLE_OBJECT_ENDPOINT??''
    if(endpoint!=='http://127.0.0.1:18690'||process.env.TEST_SESSION_LIFECYCLE_OBJECT_BUCKET!=='pocketctl-session-lifecycle-test')throw new Error('dedicated object fixture required')
    storage=new PrivateObjectArchiveStorage({endpoint,bucket:'pocketctl-session-lifecycle-test',region:'us-east-1',localTest:true,maxObjectBytes:config.maxCompressedBytes,
      credentials:{accessKeyId:'lifecycle-test',secretAccessKey:'lifecycle-test-only'}})
    executor=new SessionLifecycleExecutor(pool,config,adapter,'lifecycle-fixture-secret',error=>{lastError=error})
    installPostgresHistoryBodyReader(pool,adapter,limits);installDocumentBodyReader(pool,adapter,limits)
  },30000)
  beforeEach(async()=>{
    await pool.query('TRUNCATE users,daemons,sessions,events,subagents,deleted_sessions,session_aliases,extension_source_outbox,extension_feed RESTART IDENTITY CASCADE')
    await pool.query('TRUNCATE session_lifecycle_deletions,extension_session_deletions,session_archive_object_deletions')
    userId=(await pool.query("INSERT INTO users(email,password_hash) VALUES('execute@test.invalid','x') RETURNING id")).rows[0].id
    await pool.query("INSERT INTO daemons(daemon_id,user_id,alias) VALUES('host',$1,'Fixture host')",[userId])
    await pool.query(`INSERT INTO sessions(session_id,user_id,daemon_id,status,title,last_activity_at,last_business_activity_at,activity_verified)
      VALUES('root',$1,'host','idle','真实自动归档',NOW()-interval '40 days',NOW()-interval '40 days',true)`,[userId])
    await pool.query(`INSERT INTO events(user_id,session_id,event_type,payload,effect_status) VALUES($1,'root','user_text','{"text":"exact content"}','completed'),
      ($1,'root','agent_text','{"text":"exact response","usage":{"input_tokens":10,"output_tokens":3}}','completed')`,[userId])
    await pool.query("UPDATE events SET created_at=NOW()-interval '40 days'")
    await pool.query('UPDATE attention_projection_cursor SET last_event_id=(SELECT max(id) FROM events)')
    onPut=undefined;failPut=false
  })
  afterEach(async()=>{for(const key of keys)await storage.delete(key);keys.clear()})
  afterAll(async()=>{if(pool){await pool.query('TRUNCATE users,daemons,sessions,events,subagents,deleted_sessions RESTART IDENTITY CASCADE');await pool.query('ALTER TABLE events ALTER COLUMN payload SET NOT NULL');await pool.query('ALTER TABLE session_document_versions ALTER COLUMN content_bytes SET NOT NULL');await pool.end()}storage?.close()})
  async function lease(action:'archive'|'cool'|'purge'='archive',sessionId='root'){
    const row=(await pool.query("SELECT activity_epoch::text FROM sessions WHERE session_id=$1",[sessionId])).rows[0]
    await executor.jobs.enqueue({userId,sessionId,activityEpoch:row.activity_epoch,action,policyVersion:config.policyVersion})
    return (await executor.jobs.claim('fixture-worker',300000))!
  }
  test('real automatic archive publishes exact event bodies and a durable completed notification',async()=>{
    const before=await withSessionHistoryScope({userId},()=>getSessionAllEvents(pool,'root'))
    const result=await executor.execute(await lease())
    expect({result,error:result==='succeeded'?null:String(lastError)}).toEqual({result:'succeeded',error:null})
    const row=(await pool.query("SELECT archive_reason,content_state,last_activity_at FROM sessions WHERE session_id='root'")).rows[0]
    expect(row).toMatchObject({archive_reason:'inactivity',content_state:'cold'})
    expect((await pool.query('SELECT payload FROM events')).rows.every(row=>row.payload===null)).toBe(true)
    const after=await withSessionHistoryScope({userId},()=>getSessionAllEvents(pool,'root'))
    expect(after.map(row=>row.payload)).toEqual(before.map(row=>row.payload))
    expect((await pool.query('SELECT state,stages FROM session_lifecycle_results')).rows).toEqual([{state:'succeeded',stages:{archive:'succeeded',cool:'succeeded'}}])
    expect((await pool.query('SELECT count(*)::int AS n FROM attention_notifications')).rows[0].n).toBe(1)
  })
  test('document version identity and exact content remain readable after actual cooling',async()=>{
    const bytes=Buffer.from('# 生命周期\n真实文档字节'),sha=createHash('sha256').update(bytes).digest('hex')
    await pool.query(`INSERT INTO session_documents(document_id,user_id,session_id,display_name,document_format,state,last_source_turn_id,last_source_event_id,captured_at)
      VALUES('doc',$1,'root','设计.md','markdown','available','turn','source',NOW())`,[userId])
    await pool.query(`INSERT INTO session_document_versions(version_id,user_id,session_id,document_id,source_turn_id,source_event_id,byte_size,sha256,captured_at,content_bytes,committed_at)
      VALUES('version',$1,'root','doc','turn','source',$2,$3,NOW(),$4,NOW()-interval '40 days')`,[userId,bytes.length,sha,bytes])
    expect(await executor.execute(await lease())).toBe('succeeded')
    const version=(await pool.query("SELECT * FROM session_document_versions WHERE version_id='version'")).rows[0]
    expect(version.content_bytes).toBeNull()
    expect(await readDocumentBody(pool,{userId,sessionId:'root',documentId:'doc',versionId:'version'},version)).toEqual(bytes)
  })
  test('object outage retains all hot bodies and the successful archive stage; retry uses one business operation',async()=>{
    const first=await lease();failPut=true
    expect(await executor.execute(first)).toBe('partial')
    expect((await pool.query('SELECT payload FROM events')).rows.every(row=>row.payload!==null)).toBe(true)
    expect((await pool.query('SELECT stages FROM session_lifecycle_results')).rows[0].stages).toEqual({archive:'succeeded',cool:'failed'})
    await pool.query('UPDATE session_lifecycle_jobs SET next_attempt_at=NOW()')
    failPut=false;const retry=(await executor.jobs.claim('retry-worker',300000))!
    expect(retry.operationId).toBe(first.operationId)
    expect(await executor.execute(retry)).toBe('succeeded')
    expect((await pool.query('SELECT count(*)::int AS n FROM attention_notifications')).rows[0].n).toBe(1)
  })
  test('a business message during transfer cancels old publication and restores only inactivity archive',async()=>{
    const old=await lease();onPut=async()=>{onPut=undefined;await advanceSessionActivity(pool,'root',new Date())}
    expect(await executor.execute(old)).toBe('cancelled')
    const row=(await pool.query("SELECT archive_reason,archived_at,content_state FROM sessions WHERE session_id='root'")).rows[0]
    expect(row).toEqual({archive_reason:null,archived_at:null,content_state:'mixed'})
    expect((await pool.query('SELECT payload FROM events')).rows.every(row=>row.payload!==null)).toBe(true)
    expect((await pool.query("SELECT count(*)::int AS n FROM session_lifecycle_results WHERE action='resume'")).rows[0].n).toBe(1)
    await advanceSessionActivity(pool,'root',new Date())
    expect((await pool.query("SELECT count(*)::int AS n FROM session_lifecycle_results WHERE action='resume'")).rows[0].n).toBe(1)
  })
  test('manual archive survives business resume and old cold content stays readable',async()=>{
    await pool.query("UPDATE sessions SET archived_at=NOW(),archive_reason='manual'")
    expect(await executor.execute(await lease('cool'))).toBe('succeeded')
    await advanceSessionActivity(pool,'root',new Date())
    expect((await pool.query('SELECT archive_reason,content_state FROM sessions')).rows[0]).toEqual({archive_reason:'manual',content_state:'mixed'})
    expect((await withSessionHistoryScope({userId},()=>getSessionAllEvents(pool,'root')))[0].payload).toEqual({text:'exact content'})
  })
  test('changed dependency identity prevents stale publication',async()=>{
    const old=await lease();onPut=async()=>{onPut=undefined;await pool.query("UPDATE sessions SET parent_session_id='missing'")}
    expect(await executor.execute(old)).toBe('cancelled')
    expect((await pool.query('SELECT payload FROM events')).rows.every(row=>row.payload!==null)).toBe(true)
    expect((await pool.query('SELECT content_state,cooling_operation_id FROM sessions')).rows[0]).toEqual({content_state:'hot',cooling_operation_id:null})
  })
  test('bounded passes publish a prefix and retry remaining bodies without rewriting published objects',async()=>{
    await pool.query('DELETE FROM events')
    for(let index=0;index<8;index++)await pool.query("INSERT INTO events(session_id,event_type,payload,effect_status,user_id) VALUES('root','user_text',$1,'completed',$2)",[JSON.stringify({text:'a'.repeat(6000),index}),userId])
    await pool.query("UPDATE events SET created_at=NOW()-interval '40 days'")
    await pool.query('UPDATE attention_projection_cursor SET last_event_id=(SELECT max(id) FROM events)')
    const bounded=new SessionLifecycleExecutor(pool,{...config,batchBytes:20000,maxChunkBytes:8000,maxCompressedBytes:10000},adapter,'fixture-secret')
    const first=await lease()
    expect(await bounded.execute(first)).toBe('partial')
    const count=(await pool.query("SELECT count(*)::int AS n FROM events WHERE body_storage='cold'")).rows[0].n
    expect(count).toBeGreaterThan(0);expect(count).toBeLessThan(8)
    expect((await pool.query('SELECT content_state FROM sessions')).rows[0].content_state).toBe('mixed')
    for(let attempt=0;attempt<3;attempt++){
      await pool.query("UPDATE session_lifecycle_jobs SET next_attempt_at=NOW() WHERE state='partial'")
      const next=await bounded.jobs.claim('bounded-worker',300000)
      if(!next)break
      await bounded.execute(next)
    }
    expect((await pool.query('SELECT content_state FROM sessions')).rows[0].content_state).toBe('cold')
    expect((await withSessionHistoryScope({userId},()=>getSessionAllEvents(pool,'root'))).map(row=>row.payload.index)).toEqual([0,1,2,3,4,5,6,7])
  })
  test('60-day purge commits durable tombstone, removes every body and completes only after object compensation',async()=>{
    expect(await executor.execute(await lease())).toBe('succeeded')
    await pool.query("UPDATE sessions SET last_activity_at=NOW()-interval '100 days',last_business_activity_at=NOW()-interval '100 days'")
    await pool.query("UPDATE events SET created_at=NOW()-interval '100 days'")
    const purging=await lease('purge')
    expect(await executor.execute(purging,{extensionMode:'enabled'})).toBe('partial')
    expect((await pool.query("SELECT 1 FROM sessions WHERE session_id='root'")).rows).toEqual([])
    expect((await pool.query("SELECT 1 FROM events WHERE session_id='root'")).rows).toEqual([])
    expect((await pool.query("SELECT 1 FROM deleted_sessions WHERE session_id='root'")).rows).toHaveLength(1)
    const jobs=(await pool.query("SELECT * FROM session_archive_object_deletions WHERE session_id='root'")).rows
    expect(jobs.length).toBeGreaterThan(0)
    expect((await pool.query('SELECT objects_completed_at FROM session_lifecycle_deletions')).rows[0].objects_completed_at).toBeNull()
    await pool.query('UPDATE session_archive_object_deletions SET next_attempt_at=NOW()')
    expect(await new ArchiveObjectCollector(pool,adapter).runOnce()).toBe(jobs.length)
    await createSessionLifecycleWorker(pool,{...config,mode:'off'},adapter,'fixture-secret',{workerId:'compensation-only'}).runOnce()
    expect((await pool.query('SELECT state,stages FROM session_lifecycle_results WHERE operation_id=$1',[purging.operationId])).rows[0])
      .toEqual({state:'succeeded',stages:{database:'succeeded',objects:'succeeded',memory:'succeeded'}})
    for(const job of jobs)await expect(storage.read(job.object_key)).rejects.toThrow()
  })
  test('purging a renamed archive follows owned routes, receipts and deliveries while preserving unrelated data',async()=>{
    const archivedId = 'renamed'
    await renameOwnedDaemonSession(pool,{oldSessionId:'root',newSessionId:archivedId,daemonId:'host',userId})
    expect(await executor.execute(await lease('archive',archivedId))).toBe('succeeded')
    await pool.query("UPDATE sessions SET last_activity_at=NOW()-interval '100 days',last_business_activity_at=NOW()-interval '100 days'")
    await pool.query("UPDATE events SET created_at=NOW()-interval '100 days'")
    await pool.query("INSERT INTO sessions(session_id,user_id,daemon_id,status) VALUES('neighbor',$1,'host','idle')",[userId])
    const otherOwner = (await pool.query("INSERT INTO users(email,password_hash) VALUES('other@test.invalid','x') RETURNING id")).rows[0].id
    await pool.query(`INSERT INTO event_inbox(user_id,daemon_id,daemon_generation,seq,dedup_key,session_id,event_type,priority_class,payload,status,received_at,materialized_event_id)
      VALUES ($1,'host',1,1,'old','root','agent_text',1,'{"usage":{"input_tokens":17}}',2,NOW()-interval '100 days',(SELECT min(id) FROM events)),
             ($1,'host',1,2,'other','neighbor','user_text',1,'{}',2,NOW(),NULL),
             ($2,'elsewhere',1,3,'different-owner','root','user_text',1,'{}',2,NOW(),NULL),
             ($1,'host',1,4,'via-event',NULL,'user_text',1,'{}',2,NOW()-interval '100 days',(SELECT max(id) FROM events))`,[userId,otherOwner])
    await pool.query(`INSERT INTO event_inbox_receipt(inbox_id,daemon_id,daemon_generation,seq)
      SELECT inbox_id,daemon_id,daemon_generation,seq FROM event_inbox`)
    await pool.query(`INSERT INTO realtime_outbox(inbox_id,delivery_key,user_id,session_id,event_type,audience,payload,delivered_at)
      SELECT inbox_id,'old-target',NULL::integer,'root','user_text','session','{}'::jsonb,NULL FROM event_inbox WHERE dedup_key='other'
      UNION ALL SELECT inbox_id,'other-target',$1::integer,'neighbor','user_text','session','{}'::jsonb,NOW() FROM event_inbox WHERE dedup_key='other'`,[userId])
    await pool.query(`INSERT INTO subagents(parent_session_id,agent_id,status,created_at)
      VALUES('root','old-child','completed',NOW()-interval '100 days'),('neighbor','kept-child','completed',NOW())`)
    const eligibility = () => inspectLifecycleEligibility(pool,archivedId,config)
    expect((await eligibility()).prediction.blockedReasons).toContain('outbox_pending')
    await pool.query("UPDATE realtime_outbox SET delivered_at=NOW() WHERE delivery_key='old-target'")
    await pool.query("UPDATE event_inbox SET status=1 WHERE dedup_key='old'")
    expect((await eligibility()).prediction.blockedReasons).toContain('inbox_pending')
    await pool.query("UPDATE event_inbox SET status=2 WHERE dedup_key='old'")
    await pool.query(`INSERT INTO attention_items(item_id,user_id,daemon_id,session_id,request_id,provider,kind,state,source_event_type)
      VALUES(gen_random_uuid(),$1,'host','root','request','codex','question','open','question')`,[userId])
    expect((await eligibility()).prediction.blockedReasons).toContain('attention_pending')
    await pool.query("UPDATE attention_items SET state='resolved' WHERE session_id='root'")
    await pool.query(`INSERT INTO extension_feed(owner_user_id,topic,source_kind,source_id,session_id,payload)
      VALUES($1,'history','canonical_event','old-feed','root','{}'),($2,'history','canonical_event','other-feed','root','{}')`,[userId,otherOwner])
    await pool.query(`INSERT INTO quota_reservations(id,user_id,resource,operation,session_id,request_id,expires_at,state,settled_at)
      VALUES(gen_random_uuid(),$1,'session','create','root','old-quota',NOW(),'settled',NOW()-interval '2 days'),
            (gen_random_uuid(),$1,'session','create','root','recent-quota',NOW(),'settled',NOW())`,[userId])
    await pool.query(`INSERT INTO token_usage_accounting_state(key,completed_at) VALUES('baseline-v1',NOW()-interval '110 days')
      ON CONFLICT(key) DO UPDATE SET completed_at=EXCLUDED.completed_at`)
    // A live child may still store its parent's pre-rename ID.
    await pool.query("UPDATE sessions SET parent_session_id='root' WHERE session_id='neighbor'")
    expect((await eligibility()).sessionIds).toEqual(['neighbor',archivedId])
    expect((await inspectLifecycleEligibility(pool,'neighbor',config)).sessionIds).toEqual(['neighbor',archivedId])
    expect((await eligibility()).prediction.action).not.toBe('purge')
    await pool.query("UPDATE sessions SET parent_session_id=NULL WHERE session_id='neighbor'")
    const job = await lease('purge',archivedId)
    await executor.execute(job,{extensionMode:'enabled',writeUsageFacts:true,usageFactsAuthoritative:true})
    expect((await pool.query('SELECT session_id FROM sessions')).rows).toEqual([{session_id:'neighbor'}])
    expect((await pool.query('SELECT dedup_key FROM event_inbox ORDER BY dedup_key')).rows.map(row=>row.dedup_key)).toEqual(['different-owner','other'])
    expect((await pool.query('SELECT seq::int FROM event_inbox_receipt ORDER BY seq')).rows.map(row=>row.seq)).toEqual([2,3])
    expect((await pool.query('SELECT delivery_key FROM realtime_outbox')).rows).toEqual([{delivery_key:'other-target'}])
    expect((await pool.query('SELECT agent_id FROM subagents')).rows).toEqual([{agent_id:'kept-child'}])
    expect((await pool.query('SELECT 1 FROM attention_items')).rowCount).toBe(0)
    expect((await pool.query('SELECT source_id FROM extension_feed')).rows).toEqual([{source_id:'other-feed'}])
    expect((await pool.query('SELECT request_id FROM quota_reservations')).rows).toEqual([{request_id:'recent-quota'}])
    expect((await pool.query("SELECT input::int,session_attribution_revoked FROM token_usage_facts WHERE fact_key LIKE 'inbox:%'")).rows)
      .toEqual([{input:17,session_attribution_revoked:true}])
    expect((await pool.query("SELECT 1 FROM deleted_sessions WHERE session_id=$1",[archivedId])).rowCount).toBe(1)
    expect((await pool.query("SELECT 1 FROM extension_source_outbox WHERE source_kind='session_deleted' AND session_id=$1",[archivedId])).rowCount).toBe(1)
  })
  test('object collector refuses referenced published bodies',async()=>{
    expect(await executor.execute(await lease())).toBe('succeeded')
    const chunk=(await pool.query('SELECT c.object_key,m.storage_namespace FROM session_archive_chunks c JOIN session_archive_manifests m USING(manifest_id) LIMIT 1')).rows[0]
    await pool.query("INSERT INTO session_archive_object_deletions(storage_namespace,object_key,user_id,session_id,next_attempt_at) VALUES($1,$2,$3,'root',NOW())",[chunk.storage_namespace,chunk.object_key,userId])
    expect(await new ArchiveObjectCollector(pool,adapter).runOnce()).toBe(0)
    expect((await withSessionHistoryScope({userId},()=>getSessionAllEvents(pool,'root'))).length).toBe(2)
  })
  test('remote deletion failure remains pending; expired notices never resurrect when cleanup later completes',async()=>{
    expect(await executor.execute(await lease())).toBe('succeeded')
    await pool.query("UPDATE sessions SET last_activity_at=NOW()-interval '100 days',last_business_activity_at=NOW()-interval '100 days'")
    await pool.query("UPDATE events SET created_at=NOW()-interval '100 days'")
    const purging=await lease('purge')
    expect(await executor.execute(purging,{extensionMode:'enabled'})).toBe('partial')
    await pool.query('UPDATE session_archive_object_deletions SET next_attempt_at=NOW()')
    const outage:ArchiveStorage={...adapter,delete:async()=>{throw new Error('fixture delete outage')}}
    expect(await new ArchiveObjectCollector(pool,outage).runOnce()).toBe(0)
    expect((await pool.query('SELECT state,last_error_code FROM session_archive_object_deletions')).rows[0])
      .toEqual({state:'pending',last_error_code:'object_delete_failed'})
    await pool.query("UPDATE attention_notifications SET expires_at=NOW()-interval '1 day'")
    await pool.query('UPDATE session_archive_object_deletions SET next_attempt_at=NOW()')
    await new ArchiveObjectCollector(pool,adapter).runOnce()
    await createSessionLifecycleWorker(pool,{...config,mode:'off'},adapter,'fixture-secret',{workerId:'expired-compensation'}).runOnce()
    expect((await pool.query('SELECT count(*)::int AS n FROM attention_notifications')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT state,title_snapshot FROM session_lifecycle_results WHERE operation_id=$1',[purging.operationId])).rows[0])
      .toEqual({state:'succeeded',title_snapshot:''})
  })
  test.skipIf(process.env.RUN_SESSION_LIFECYCLE_CAPACITY!=='1')('5000-event incompressible history retains exact bodies under the default transfer budget',async()=>{
    await pool.query('DELETE FROM events')
    const expected=createHash('sha256'),count=5000
    for(let start=0;start<count;start+=100){
      const payloads=[]
      for(let index=start;index<start+100;index++){
        const text=randomBytes(9000).toString('base64');expected.update(text)
        payloads.push({text,index,type:'user_text'})
      }
      await pool.query(`INSERT INTO events(session_id,event_type,payload,effect_status,user_id)
        SELECT 'root','user_text',value,'completed',$2 FROM jsonb_array_elements($1::jsonb)`,[JSON.stringify(payloads),userId])
    }
    await pool.query("UPDATE events SET created_at=NOW()-interval '40 days'")
    await pool.query('UPDATE attention_projection_cursor SET last_event_id=(SELECT max(id) FROM events)')
    const before=(await pool.query(`SELECT sum(pg_column_size(payload))::text AS payload_bytes,pg_total_relation_size('events')::text AS relation_bytes FROM events`)).rows[0]
    const started=performance.now()
    const outcome=await executor.execute(await lease())
    expect({outcome,error:outcome==='succeeded'?null:String(lastError)}).toEqual({outcome:'succeeded',error:null})
    const coolingMs=performance.now()-started,readStarted=performance.now()
    const rows=await withSessionHistoryScope({userId},()=>getSessionAllEvents(pool,'root'))
    const actual=createHash('sha256');for(const row of rows)actual.update(row.payload.text)
    expect(rows).toHaveLength(count);expect(actual.digest('hex')).toBe(expected.digest('hex'))
    const readMs=performance.now()-readStarted
    const after=(await pool.query(`SELECT COALESCE(sum(pg_column_size(payload)),0)::text AS payload_bytes,pg_total_relation_size('events')::text AS relation_bytes FROM events`)).rows[0]
    const chunks=(await pool.query('SELECT count(*)::int AS count,sum(raw_bytes)::text AS raw_bytes,sum(compressed_bytes)::text AS compressed_bytes FROM session_archive_chunks')).rows[0]
    expect(BigInt(chunks.raw_bytes)).toBeLessThanOrEqual(BigInt(config.batchBytes))
    writeFileSync('../docs/reports/session-lifecycle-docker-2026-10-12/capacity.json',JSON.stringify({scope:'isolated PostgreSQL and MinIO; one session; not production capacity acceptance',count,bodyBytes:count*12000,
      before,after,chunks,coolingMs,readMs,processPeakRssKiB:process.resourceUsage().maxRSS,physicalSpaceNote:'relation_bytes includes dead tuples and indexes; no VACUUM FULL was performed'},null,2)+'\n')
  },120000)
})
