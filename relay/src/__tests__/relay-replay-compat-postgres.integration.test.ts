import {planReplayRecovery,applyReplayRecovery,REPLAY_RECOVERY_AUDIT_SQL} from '../ops/replay-recovery.js'
import pg from 'pg'
import { createHash, randomUUID } from 'node:crypto'
import { InboxRepository } from '../ingress/inbox-repository.js'
import { createInboxWorker } from '../inbox-worker.js'
import { RealtimeOutboxWriter } from '../materialization/realtime-outbox.js'
import { installPostgresHistoryBodyReader } from '../session-history/postgres-reader.js'
import { MemoryArchiveStorage, encodeArchiveChunk, archiveObjectKey } from '@pocketctl/session-source'
import { enableSessionColdBodies } from '../session-lifecycle/cold-schema.js'
import { beforeAll, beforeEach, afterAll, describe, test, expect } from 'vitest'
import {ensurePlatformStatisticsSchema} from '../platform-statistics/schema.js'
import { initDB } from '../db.js'
import { EventMaterializer } from '../materialization/event-materializer.js'
import { createPostgresExtensionJournalSink } from '../extensions/journal.js'
import { assertDurableIngressTestDatabase, resetDurableIngressTestDatabase } from './durable-ingress-test-db.js'
import { RELAY_SOURCE_HEADER_SQL } from '../shared-source/header-contract.js'

const url = process.env.TEST_DATABASE_URL
const suite = url && process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
suite('canonical replay compatibility', () => {
  let pool: pg.Pool, owner: number
  beforeAll(async () => {
    pool = new pg.Pool({connectionString:url, max:1})
    await assertDurableIngressTestDatabase(pool,url!)
    await initDB(pool)
    await pool.query(REPLAY_RECOVERY_AUDIT_SQL)
    for (const sql of RELAY_SOURCE_HEADER_SQL.slice(1,-1)) await pool.query(sql)
  },60000)
  afterAll(async () => { await pool?.end() })
  beforeEach(async () => {
    await resetDurableIngressTestDatabase(pool,url!)
    await pool.query('TRUNCATE relay_replay_recovery_audit')
    owner = (await pool.query("INSERT INTO users(email,password_hash) VALUES('replay@test.invalid','x') RETURNING id")).rows[0].id
    await pool.query("INSERT INTO daemons(daemon_id,user_id) VALUES('replay-daemon',$1)",[owner])
    await pool.query("INSERT INTO sessions(session_id,daemon_id,user_id,agent_type,status,cwd) VALUES('replay-session','replay-daemon',$1,'codex','idle','/synthetic')",[owner])
  })
  const body = () => ({type:'tool_call',session_id:'replay-session',event_id:'event-1',turn_id:'turn-1',seq:1,name:'read',input:{file:'synthetic'}})
  const proof = () => ({version:1,producer:'codex',session_id:'replay-session',event_id:'event-1',turn_id:'turn-1',sequence:'1',invocation_id:'turn-1',source_role:'tool',skill_state:'unknown',lineage_complete:false,derived_from_event_ids:[]})
  function materializer(shared=true) { return new EventMaterializer({pool,extensionJournalSink:shared?createPostgresExtensionJournalSink({sharedHeaders:true}):null}) }
  function input(payload:Record<string,unknown>) { return {inboxId:0,userId:owner,daemonId:'replay-daemon',sessionId:'replay-session',eventType:'tool_call',payload} }
  test.each(['seq','resync','legacy-proof'])('accepts %s while retaining canonical headers and body',async kind=>{
    const original=body(), m=materializer()
    const first=await m.materialize(input(original))
    const before=(await pool.query('SELECT payload,source_sequence,canonical_payload_hash,source_classification FROM events WHERE id=$1',[first.eventId])).rows[0]
    const changed={...original,...(kind==='seq'?{seq:99}:kind==='resync'?{resync:true}:{memory_source:proof()})}
    const replay=await m.materialize(input(changed),()=>{throw Error('completed effects must not run')})
    expect(replay.eventId).toBe(first.eventId)
    expect(replay.inserted).toBe(false)
    expect((await pool.query('SELECT payload,source_sequence,canonical_payload_hash,source_classification FROM events WHERE id=$1',[first.eventId])).rows[0]).toEqual(before)
    expect(replay.deliveries[0].payload.input).toEqual({file:'synthetic'})
    expect(replay.deliveries[0].payload.memory_source).toBeUndefined()
  })
  test('pre-header replay repairs journal without replaying completed effects',async()=>{
    const first=await materializer(false).materialize(input(body()))
    const result=await materializer().materialize(input({...body(),seq:55,resync:true,memory_source:proof()}),()=>{throw Error('must not run')})
    expect(result.eventId).toBe(first.eventId)
    expect((await pool.query('SELECT source_header_version FROM events')).rows[0].source_header_version).toBe(1)
    expect((await pool.query('SELECT payload FROM extension_source_outbox')).rows[0].payload).toEqual(body())
  })
  test.each(['body','proof','identity'])('rejects conflicting %s even when journal is disabled',async kind=>{
    const m=materializer(false);await m.materialize(input(body()))
    const changed={...body(),...(kind==='body'?{input:{file:'changed'}}:{memory_source:{...proof(),...(kind==='proof'?{skill_state:'non_skill',lineage_complete:true}:{event_id:'different'})}})}
    await expect(m.materialize(input(changed))).rejects.toThrow(/replay_(payload|provenance)_conflict/)
    expect((await pool.query('SELECT payload FROM events')).rows[0].payload).toEqual(body())
  })
  test('existing pre-header journal sequence is retained', async()=>{
    const legacy = new EventMaterializer({pool,extensionJournalSink:createPostgresExtensionJournalSink()})
    await legacy.materialize(input(body()))
    const seq=(await pool.query('SELECT source_seq FROM extension_source_outbox')).rows[0].source_seq
    await materializer().materialize(input({...body(),seq:9,resync:true}))
    expect((await pool.query('SELECT source_sequence FROM events')).rows[0].source_sequence).toBe(seq)
  })
  test.each(['owner','deleted','alias','retired'])('rejects %s after an event was completed',async kind=>{
    await materializer().materialize(input(body()))
    if(kind==='owner') await pool.query("UPDATE sessions SET user_id=NULL WHERE session_id='replay-session'")
    if(kind==='deleted') await pool.query("INSERT INTO deleted_sessions(session_id) VALUES('replay-session')")
    if(kind==='retired') {
      await pool.query("UPDATE sessions SET user_id=NULL WHERE session_id='replay-session'")
      await pool.query("UPDATE sessions SET user_id=$1 WHERE session_id='replay-session'",[owner])
    }
    if(kind==='alias') await pool.query("INSERT INTO session_aliases(old_session_id,next_session_id,original_daemon_id,owner_user_id,request_daemon_id,blocked) VALUES('replay-session','missing','replay-daemon',$1,'replay-daemon',true)",[owner])
    await expect(materializer().materialize(input({...body(),seq:9}))).rejects.toThrow()
  })
  test('cold replay reads authenticated archive and fails closed on damaged content with pool size one',async()=>{
    const original=body();const first=await materializer().materialize(input(original))
    await enableSessionColdBodies(pool)
    const storage=Object.assign(new MemoryArchiveStorage(),{namespace:'replay-isolated'})
    const limits={maxRawBytes:1048576,maxCompressedBytes:1048576,maxRecords:32}
    installPostgresHistoryBodyReader(pool,storage,limits)
    const manifestId=randomUUID(),epoch=(await pool.query("SELECT activity_epoch::text AS epoch FROM sessions WHERE session_id='replay-session'")).rows[0].epoch
    const encoded=await encodeArchiveChunk({userId:owner,sessionId:'replay-session',activityEpoch:epoch,manifestId,ordinal:0},[{id:String(first.eventId),eventType:'tool_call',payload:original}],limits)
    const key=archiveObjectKey(manifestId,0),m=encoded.manifest;await storage.put(key,encoded.bytes)
    await pool.query("INSERT INTO session_archive_manifests(manifest_id,user_id,session_id,activity_epoch,schema_version,codec,state,event_high_water,published_at,storage_namespace) VALUES($1,$2,'replay-session',$3,1,'gzip','published',$4,NOW(),$5)",[manifestId,owner,epoch,first.eventId,storage.namespace])
    await pool.query('INSERT INTO session_archive_chunks(manifest_id,ordinal,object_key,first_event_id,last_event_id,event_count,raw_bytes,compressed_bytes,raw_sha256,compressed_sha256) VALUES($1,0,$2,$3,$3,1,$4,$5,$6,$7)',[manifestId,key,String(first.eventId),m.rawBytes,m.compressedBytes,m.rawSha256,m.compressedSha256])
    await pool.query("UPDATE events SET body_storage='cold',payload=NULL,body_manifest_id=$1,body_chunk_ordinal=0,body_owner_user_id=$2,body_session_id='replay-session',body_activity_epoch=$3",[manifestId,owner,epoch])
    const replay=await materializer().materialize(input({...original,seq:99,resync:true}))
    expect(replay.deliveries[0].payload.input).toEqual(original.input)
    expect((await pool.query('SELECT payload FROM events')).rows[0].payload).toBeNull()
    await storage.put(key,Buffer.from('corrupt'))
    await expect(materializer().materialize(input({...original,seq:100}))).rejects.toThrow()
  })
  async function enqueue(payloads:Record<string,unknown>[]) {
    const repository=new InboxRepository(pool)
    await repository.persistBatch(payloads.map((payload,i)=>({userId:owner,daemonId:'replay-daemon',registrationId:'fixture',daemonGeneration:1,seq:i+10,dedupKey:'receipt:'+i,sessionId:String(payload.session_id),eventType:String(payload.type),priority:'replay' as const,payload,materializationContext:{},receivedAt:new Date()})))
    return repository
  }
  test('batch replay and completed outbox recovery unblock a second session in the same stream',async()=>{
    const first=await materializer().materialize(input(body())) // simulate commit before outbox
    await pool.query("INSERT INTO sessions(session_id,daemon_id,user_id,agent_type,status,cwd) VALUES('second-session','replay-daemon',$1,'codex','idle','/synthetic')",[owner])
    const repository=await enqueue([{...body(),seq:10,resync:true},{...body(),seq:11,resync:true},
      {type:'agent_text',session_id:'second-session',event_id:'new-body',seq:12,text:'new synthetic body'}])
    const m=materializer(),batch=m.materializeReplayBatch.bind(m);let batches=0
    m.materializeReplayBatch=async(...args)=>{batches++;return batch(...args)}
    const worker=createInboxWorker({repository,materializer:m,outboxWriter:new RealtimeOutboxWriter(pool),workerId:'isolated-worker',shardCount:1,shardIndex:0})
    await worker.runOnce()
    expect(batches).toBeGreaterThan(0)
    expect((await pool.query('SELECT status FROM event_inbox')).rows.map(r=>r.status)).toEqual([2,2,2])
    const outbox=(await pool.query('SELECT event_id,delivery_key,payload FROM realtime_outbox ORDER BY outbox_id')).rows
    expect(outbox).toHaveLength(3)
    expect(outbox[0].event_id).toBe(String(first.eventId));expect(outbox[1].delivery_key).toBe(outbox[0].delivery_key)
    expect(outbox[0].payload.resync).toBe(true);expect(outbox[1].payload.seq).toBe(11)
    expect((await pool.query("SELECT payload->>'text' AS text FROM events WHERE session_id='second-session'")).rows[0].text).toBe('new synthetic body')
    await worker.runOnce();expect((await pool.query('SELECT count(*) FROM realtime_outbox')).rows[0].count).toBe('3')
  })

  test('recovery freezes eligible IDs, excludes unrelated deaths, and resumes without resetting completed rows',async()=>{
    await materializer(false).materialize(input(body()))
    await enqueue([{...body(),seq:10,resync:true},{...body(),seq:11,input:{file:'conflict'}},{...body(),seq:12}])
    await pool.query("UPDATE event_inbox SET status=3,attempts=12,last_error=CASE WHEN seq=12 THEN 'unknown_daemon_session' ELSE 'materialization_failed' END")
    const ids=(await pool.query('SELECT inbox_id::text FROM event_inbox ORDER BY seq')).rows.map(r=>r.inbox_id)
    const manifest=await planReplayRecovery(pool,{daemonId:'replay-daemon',ownerId:owner,generation:'1'},ids)
    expect(manifest.entries.map((e:any)=>e.inboxId)).toEqual([ids[0]])
    expect(manifest.excluded.map((e:any)=>e.inboxId)).toEqual(ids.slice(1))
    expect(JSON.stringify(manifest)).not.toContain('synthetic')
    await pool.query(REPLAY_RECOVERY_AUDIT_SQL)
    await expect(applyReplayRecovery(pool,manifest,manifest.digest,false)).rejects.toThrow('workers_must_be_paused')
    await expect(applyReplayRecovery(pool,manifest,'0'.repeat(64),true)).rejects.toThrow('manifest_digest_mismatch')
    await pool.query('UPDATE event_inbox SET attempts=13 WHERE inbox_id=$1',[ids[0]])
    await expect(applyReplayRecovery(pool,manifest,manifest.digest,true)).rejects.toThrow('candidate_changed')
    expect((await pool.query('SELECT count(*) FROM relay_replay_recovery_audit')).rows[0].count).toBe('0')
    await pool.query('UPDATE event_inbox SET attempts=12 WHERE inbox_id=$1',[ids[0]])
    expect((await applyReplayRecovery(pool,manifest,manifest.digest,true)).applied).toBe(1)
    await pool.query('UPDATE event_inbox SET status=2 WHERE inbox_id=$1',[ids[0]])
    expect((await applyReplayRecovery(pool,manifest,manifest.digest,true)).alreadyApplied).toBe(1)
    expect((await pool.query('SELECT status FROM event_inbox ORDER BY seq')).rows.map(r=>r.status)).toEqual([2,3,3])
  })

  test('recovery rolls back the entire fixed batch on a changed follower and rejects active consumers',async()=>{
    await materializer(false).materialize(input(body()))
    await enqueue([{...body(),seq:10,resync:true},{...body(),seq:11,resync:true}])
    await pool.query("UPDATE event_inbox SET status=3,attempts=12,last_error='materialization_failed'")
    const ids=(await pool.query('SELECT inbox_id::text FROM event_inbox ORDER BY seq')).rows.map(r=>r.inbox_id)
    const manifest=await planReplayRecovery(pool,{daemonId:'replay-daemon',ownerId:owner,generation:'1'},ids)
    await pool.query('UPDATE event_inbox SET attempts=13 WHERE inbox_id=$1',[ids[1]])
    await expect(applyReplayRecovery(pool,manifest,manifest.digest,true)).rejects.toThrow('candidate_changed')
    expect((await pool.query('SELECT status FROM event_inbox ORDER BY seq')).rows.map(r=>r.status)).toEqual([3,3])
    expect((await pool.query('SELECT count(*) FROM relay_replay_recovery_audit')).rows[0].count).toBe('0')
    await pool.query('UPDATE event_inbox SET status=1 WHERE inbox_id=$1',[ids[1]])
    await expect(applyReplayRecovery(pool,manifest,manifest.digest,true)).rejects.toThrow('active_claims_present')
    await pool.query('UPDATE event_inbox SET status=3,attempts=12 WHERE inbox_id=$1',[ids[1]])
    await pool.query("INSERT INTO deleted_sessions(session_id) VALUES('replay-session')")
    await expect(applyReplayRecovery(pool,manifest,manifest.digest,true)).rejects.toThrow()
    expect((await pool.query('SELECT status FROM event_inbox ORDER BY seq')).rows.map(r=>r.status)).toEqual([3,3])
  })
  test('known provenance remains unchanged on old-producer replay and rejects altered proof',async()=>{
    const canonical={...body(),memory_source:{...proof(),skill_state:'non_skill',lineage_complete:true}}
    const m=materializer();await m.materialize(input(canonical))
    const result=await m.materialize(input({...body(),seq:2,resync:true}))
    expect(result.deliveries[0].payload.memory_source).toEqual(canonical.memory_source)
    await expect(m.materialize(input({...canonical,seq:3,memory_source:{...canonical.memory_source,sequence:'2'}}))).rejects.toThrow('replay_provenance_conflict')
  })
  test('batch collisions with changed body roll back and fail closed in ordinary handling',async()=>{
    const repository=await enqueue([{...body(),seq:10,resync:true},{...body(),seq:11,resync:true,input:{file:'conflict'}}])
    const worker=createInboxWorker({repository,materializer:materializer(),outboxWriter:new RealtimeOutboxWriter(pool),workerId:'collision-worker',shardCount:1,shardIndex:0})
    await worker.runOnce()
    expect((await pool.query('SELECT status,last_error FROM event_inbox ORDER BY seq')).rows).toEqual([{status:2,last_error:null},{status:3,last_error:'replay_payload_conflict'}])
    expect((await pool.query('SELECT count(*) FROM realtime_outbox')).rows[0].count).toBe('1')
    expect((await pool.query('SELECT payload FROM events')).rows[0].payload.input).toEqual({file:'synthetic'})
  })

  test('merged statistics keeps replay suppression after selecting canonical content',async()=>{
    const previous=process.env.PLATFORM_STATS_ENABLED
    try {
      process.env.PLATFORM_STATS_ENABLED='false'
      const payload={type:'agent_text',session_id:'replay-session',event_id:'old-activity',text:'synthetic historical output',seq:1}
      const m=materializer()
      const original={...input(payload),eventType:'agent_text',receivedAt:new Date('2026-11-01T00:00:00Z')}
      await m.materialize(original)
      await ensurePlatformStatisticsSchema(pool,{PLATFORM_STATS_ENABLED:'true'},{migrate:true})
      await pool.query('TRUNCATE platform_statistics_facts')
      process.env.PLATFORM_STATS_ENABLED='true'
      await m.materialize({...original,receivedAt:new Date(),payload:{...payload,seq:99,resync:true}})
      expect((await pool.query('SELECT count(*) FROM platform_statistics_facts')).rows[0].count).toBe('0')
      await m.materialize({...original,receivedAt:new Date(),payload:{...payload,event_id:'fresh-activity',seq:100}})
      expect(Number((await pool.query('SELECT count(*) FROM platform_statistics_facts')).rows[0].count)).toBeGreaterThan(0)
    } finally {
      if(previous===undefined)delete process.env.PLATFORM_STATS_ENABLED
      else process.env.PLATFORM_STATS_ENABLED=previous
    }
  })

})
