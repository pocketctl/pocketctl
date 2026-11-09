import {resetNativeInputProofFixture} from './durable-ingress-test-db.js'
import {SessionDocumentRepository} from '../session-documents/repository.js'
import {reserveConcurrentSession} from '../quota.js'
import {readArchiveObject} from '@pocketctl/session-source'
import {aliasLimits,aliasStorage,publishAliasBody} from './native-session-alias-fixture.js'
import {installPostgresHistoryBodyReader,withSessionHistoryScope} from '../session-history/postgres-reader.js'
import {installDocumentBodyReader,readDocumentBody} from '../session-documents/body-reader.js'
import {SessionLifecycleExecutor} from '../session-lifecycle/executor.js'
import {sessionLifecycleConfig} from '../session-lifecycle/config.js'
import {ArchiveObjectCollector} from '../session-archive/object-gc.js'
import {test,beforeAll,afterAll,beforeEach} from 'vitest'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {enableSessionColdBodies} from '../session-lifecycle/cold-schema.js'
import {encodeArchiveChunk,decodeArchiveChunk} from '@pocketctl/session-source'
import pg from 'pg'
import {initDB,renameOwnedDaemonSession,ensureDaemonSessionIdentity,deleteSession,deleteUserAccount,getSessionAllEvents} from '../db.js'
import {EventMaterializer} from '../materialization/event-materializer.js'
const connectionString=process.env.NATIVE_SESSION_ALIAS_TEST_DATABASE_URL
const pool=new pg.Pool({connectionString,max:4,statement_timeout:10000,lock_timeout:1000})
let owner:number,other:number
if(!connectionString) test.skip('requires owned NATIVE_SESSION_ALIAS_TEST_DATABASE_URL',()=>{})
else {
beforeAll(async()=>{const u=new URL(connectionString!);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||!['postgres:','postgresql:'].includes(u.protocol)||u.search||u.hash)throw Error('dedicated_loopback_alias_fixture_required');const identity=(await pool.query("SELECT current_database() AS database_name,current_user AS role_name,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser")).rows[0];assert.deepEqual(identity,{database_name:'shared_native_alias_w3_test',role_name:'shared_native_alias_w3_test',superuser:false});await initDB(pool)})
afterAll(async()=>{await pool.end()})
beforeEach(async()=>{await pool.query('TRUNCATE session_aliases,deleted_sessions,session_lifecycle_deletions,extension_session_deletions,session_archive_object_deletions,users,daemons,sessions,events RESTART IDENTITY CASCADE');await resetNativeInputProofFixture(pool,'shared_native_alias_w3_test');const rows=(await pool.query("INSERT INTO users(email,password_hash) VALUES('alias-owner@test.invalid','x'),('alias-other@test.invalid','x') RETURNING id,email")).rows;owner=rows.find(r=>r.email==='alias-owner@test.invalid').id;other=rows.find(r=>r.email==='alias-other@test.invalid').id;await pool.query("INSERT INTO daemons(daemon_id,hostname,status,user_id) VALUES('alias-daemon','fixture','online',$1),('alias-other-daemon','fixture','online',$2)",[owner,other]);await pool.query("INSERT INTO sessions(session_id,daemon_id,agent_type,cwd,source,status,user_id) VALUES('alias-old','alias-daemon','codex','/fixture','terminal','running',$1)",[owner])})
const rename=()=>renameOwnedDaemonSession(pool,{oldSessionId:'alias-old',newSessionId:'alias-new',daemonId:'alias-daemon',userId:owner})
test('known same-owner current target does not prove an arbitrary missing old identity',async()=>{await rename();await assert.rejects(()=>renameOwnedDaemonSession(pool,{oldSessionId:'alias-never-existed',newSessionId:'alias-new',daemonId:'alias-daemon',userId:owner}),{code:'unknown_daemon_session'})})
test('late allow-create identity helper cannot recreate a retired old route',async()=>{await rename();try{await ensureDaemonSessionIdentity(pool,'alias-old','alias-daemon',owner)}catch(error){assert.ok(['unknown_daemon_session','session_ownership_violation'].includes((error as any).code))}const rows=(await pool.query("SELECT session_id FROM sessions WHERE session_id IN('alias-old','alias-new') ORDER BY session_id")).rows;assert.deepEqual(rows,[{session_id:'alias-new'}])})
test('real materializer retries the same exact rename after an ACK loss',async()=>{const m=new EventMaterializer({pool});const input={inboxId:101,userId:owner,daemonId:'alias-daemon',sessionId:'alias-new',eventType:'session_id_changed',payload:{type:'session_id_changed',session_id:'alias-new',old_session_id:'alias-old',event_id:'alias-exact-rename-1'},context:{hostname:'fixture'}};await m.materialize(input);const before=(await pool.query('SELECT count(*)::int AS rows FROM events')).rows[0];await m.materialize(input);assert.deepEqual((await pool.query('SELECT count(*)::int AS rows FROM events')).rows[0],before)})
test('baseline current ownership still denies a different owner',async()=>{await assert.rejects(()=>renameOwnedDaemonSession(pool,{oldSessionId:'alias-old',newSessionId:'alias-new',daemonId:'alias-other-daemon',userId:other}),{code:'session_ownership_violation'});assert.equal((await pool.query("SELECT count(*)::int AS rows FROM sessions WHERE session_id='alias-old'")).rows[0].rows,1)})

test('cold event rename preserves original exact manifest and codec binding',async()=>{
 await enableSessionColdBodies(pool)
 const event=(await pool.query("INSERT INTO events(session_id,event_type,payload,event_hash,effect_status,user_id) VALUES('alias-old','agent_text',$1,'alias-cold-event','completed',$2) RETURNING id::text AS event_id",[{text:'synthetic archive body'},owner])).rows[0]
 const epoch=(await pool.query("SELECT activity_epoch::text AS activity_epoch FROM sessions WHERE session_id='alias-old'")).rows[0].activity_epoch
 const binding={userId:owner,sessionId:'alias-old',activityEpoch:epoch,manifestId:randomUUID(),ordinal:0},limits={maxRawBytes:1048576,maxCompressedBytes:1048576,maxRecords:32}
 const encoded=await encodeArchiveChunk(binding,[{id:event.event_id,eventType:'agent_text',payload:{text:'synthetic archive body'}}],limits),m=encoded.manifest,originalBytes=Buffer.from(encoded.bytes)
 await pool.query("INSERT INTO session_archive_manifests(manifest_id,user_id,session_id,activity_epoch,schema_version,codec,state,event_high_water,published_at,storage_namespace) VALUES($1,$2,'alias-old',$3,1,'gzip','published',$4,NOW(),'native-alias-fixture')",[binding.manifestId,owner,epoch,event.event_id])
 await pool.query("INSERT INTO session_archive_chunks(manifest_id,ordinal,object_key,first_event_id,last_event_id,event_count,raw_bytes,compressed_bytes,raw_sha256,compressed_sha256) VALUES($1,0,$2,$3,$3,1,$4,$5,$6,$7)",[binding.manifestId,'session-archive/v1/'+binding.manifestId+'/0.gz',event.event_id,m.rawBytes,m.compressedBytes,m.rawSha256,m.compressedSha256])
 await pool.query("UPDATE events SET body_storage='cold',payload=NULL,body_manifest_id=$2,body_chunk_ordinal=0,body_owner_user_id=$3,body_activity_epoch=$4 WHERE id=$1",[event.event_id,binding.manifestId,owner,epoch])
 assert.equal((await decodeArchiveChunk(encoded.bytes,m,binding,limits)).length,1)
 await rename()
 assert.equal((await pool.query('SELECT session_id FROM events WHERE id=$1',[event.event_id])).rows[0].session_id,'alias-new')
 assert.equal((await pool.query('SELECT session_id FROM session_archive_manifests WHERE manifest_id=$1',[binding.manifestId])).rows[0].session_id,'alias-old')
 assert.deepEqual(encoded.bytes,originalBytes);assert.equal((await decodeArchiveChunk(encoded.bytes,m,binding,limits)).length,1)
})
test('hot document version follows a legitimate same-owner route rename',async()=>{
 const documentId=randomUUID(),versionId=randomUUID(),bytes=Buffer.from('synthetic document')
 await pool.query("INSERT INTO session_documents(document_id,user_id,session_id,display_name,document_format,last_source_turn_id,last_source_event_id,state,captured_at) VALUES($1,$2,'alias-old','fixture.md','markdown','fixture-turn','fixture-event','pending',NOW())",[documentId,owner])
 await pool.query("INSERT INTO session_document_versions(version_id,user_id,session_id,document_id,source_turn_id,source_event_id,byte_size,sha256,captured_at,content_bytes) VALUES($1,$2,'alias-old',$3,'fixture-turn','fixture-event',$4,$5,NOW(),$6)",[versionId,owner,documentId,bytes.length,createHash('sha256').update(bytes).digest('hex'),bytes])
 await pool.query("UPDATE session_documents SET latest_version_id=$2,state='available' WHERE document_id=$1",[documentId,versionId])
 await rename()
 assert.equal((await pool.query('SELECT session_id FROM session_document_versions WHERE version_id=$1',[versionId])).rows[0].session_id,'alias-new')
 assert.deepEqual((await pool.query('SELECT content_bytes FROM session_document_versions WHERE version_id=$1',[versionId])).rows[0].content_bytes,bytes)
})
const authority=async(id:string,user:number|null=owner,daemon:string|null=null)=>(await pool.query('SELECT public.native_session_authority($1,$2,$3) AS a',[id,user,daemon])).rows[0].a
const chain=async()=>{await renameOwnedDaemonSession(pool,{oldSessionId:'alias-old',newSessionId:'alias-middle',daemonId:'alias-daemon',userId:owner});await renameOwnedDaemonSession(pool,{oldSessionId:'alias-middle',newSessionId:'alias-new',daemonId:'alias-daemon',userId:owner})}
const publish=(storage:ReturnType<typeof aliasStorage>,sid:string,kind:'event'|'document'='event')=>publishAliasBody(pool,storage,owner,sid,kind)
const history=(sid='alias-new')=>withSessionHistoryScope({userId:owner},()=>getSessionAllEvents(pool,sid))
test('real materializer lost ACK replay after another rename keeps event/hash/effect and skips historical hooks',async()=>{
 let hooks=0;const materializer=new EventMaterializer({pool,hooks:{renameSession:()=>{hooks++}}})
 const input={inboxId:11,userId:owner,daemonId:'alias-daemon',sessionId:'alias-middle',eventType:'session_id_changed',payload:{type:'session_id_changed',session_id:'alias-middle',old_session_id:'alias-old',event_id:'lost-ack-original'},context:{hostname:'fixture'}}
 await materializer.materialize(input);const original=(await pool.query('SELECT id,event_hash,effect_status,logical_source_session_id,payload FROM events')).rows
 await materializer.materialize({...input,sessionId:'alias-new',payload:{...input.payload,session_id:'alias-new',old_session_id:'alias-middle',event_id:'second-rename'}})
 await materializer.materialize(input)
 assert.equal(hooks,2);assert.deepEqual((await pool.query('SELECT id,event_hash,effect_status,logical_source_session_id,payload FROM events ORDER BY id LIMIT 1')).rows,original)
 assert.equal((await pool.query('SELECT count(*)::int n FROM events')).rows[0].n,2)
})
test('late native discovery/created/status/text/terminal/replay/receipt never recreate retired ID or steal current daemon',async()=>{
 await chain();await pool.query("INSERT INTO daemons(daemon_id,user_id) VALUES('same-owner-second',$1)",[owner])
 for(const type of ['session_created','session_discovered','session_status','agent_text','session_exited','user_message_receipt'])await assert.rejects(()=>new EventMaterializer({pool}).materialize({inboxId:12,userId:owner,daemonId:'same-owner-second',sessionId:'alias-old',eventType:type,payload:{type,session_id:'alias-old',event_id:randomUUID(),agent:'codex',status:'running',text:'late',replay:true},context:{hostname:'fixture',agentType:'codex',cwd:'/fixture'}}))
 assert.deepEqual((await pool.query('SELECT session_id,daemon_id FROM sessions')).rows,[{session_id:'alias-new',daemon_id:'alias-daemon'}]);assert.equal((await pool.query('SELECT count(*)::int n FROM events')).rows[0].n,0)
})
test('authenticated same owner across daemons remains allowed and anonymous access stays exact daemon',async()=>{
 await pool.query("INSERT INTO daemons(daemon_id,user_id) VALUES('same-owner-second',$1),('anonymous-one',NULL),('anonymous-two',NULL)",[owner])
 await renameOwnedDaemonSession(pool,{oldSessionId:'alias-old',newSessionId:'alias-new',daemonId:'same-owner-second',userId:owner});assert.equal((await authority('alias-old')).sessionId,'alias-new')
 await pool.query("INSERT INTO sessions(session_id,daemon_id) VALUES('anonymous-old','anonymous-one')")
 await assert.rejects(()=>renameOwnedDaemonSession(pool,{oldSessionId:'anonymous-old',newSessionId:'anonymous-new',daemonId:'anonymous-two',userId:null}),{code:'session_ownership_violation'})
 await renameOwnedDaemonSession(pool,{oldSessionId:'anonymous-old',newSessionId:'anonymous-new',daemonId:'anonymous-one',userId:null})
 assert.equal((await authority('anonymous-old',null,'anonymous-one')).state,'current');assert.equal((await authority('anonymous-old',null,'anonymous-two')).state,'revoked')
})
test('mixed original/new cold events and documents preserve immutable bytes/storage/logical source after chains',async()=>{
 const storage=aliasStorage(),old=await publish(storage,'alias-old'),doc=await publish(storage,'alias-old','document');await chain();const newer=await publish(storage,'alias-new')
 installPostgresHistoryBodyReader(pool,storage,aliasLimits);installDocumentBodyReader(pool,storage,aliasLimits)
 assert.deepEqual((await history()).map((r:any)=>r.payload),[old.row.payload,newer.row.payload])
 const row=(await pool.query('SELECT * FROM session_document_versions WHERE version_id=$1',[doc.doc.versionId])).rows[0]
 assert.equal(row.body_session_id,'alias-old');assert.equal(row.session_id,'alias-new')
 assert.deepEqual(await readDocumentBody(pool,{userId:owner,sessionId:'alias-new',documentId:doc.doc.documentId,versionId:doc.doc.versionId},row),doc.doc.bytes)
 for(const f of [old,doc,newer])assert.deepEqual(await readArchiveObject(storage,f.key,aliasLimits.maxCompressedBytes),f.bytes)
 assert.deepEqual((await pool.query('SELECT logical_source_session_id,body_session_id,session_id FROM events ORDER BY id')).rows,[{logical_source_session_id:'alias-old',body_session_id:'alias-old',session_id:'alias-new'},{logical_source_session_id:'alias-new',body_session_id:'alias-new',session_id:'alias-new'}])
})
test('privacy at any alias hop denies warmed cache and actual archive IO return',async()=>{
 const storage=aliasStorage();await publish(storage,'alias-old');await chain();installPostgresHistoryBodyReader(pool,storage,aliasLimits);await history()
 await pool.query("INSERT INTO deleted_sessions(session_id) VALUES('alias-middle')");await assert.rejects(()=>history(),/not accessible/)
 assert.equal((await authority('alias-new')).state,'deleted')
})
test('privacy committed during actual history object IO denies original storage bytes',async()=>{
 const storage=aliasStorage();await publish(storage,'alias-old');await chain();installPostgresHistoryBodyReader(pool,storage,aliasLimits)
 const read=storage.read.bind(storage);storage.read=async key=>{const bytes=await read(key);await pool.query("INSERT INTO deleted_sessions(session_id) VALUES('alias-old') ON CONFLICT DO NOTHING");return bytes}
 await assert.rejects(()=>history(),/not accessible/)
})
test('privacy during document object IO denies bytes from historical storage',async()=>{
 const storage=aliasStorage(),f=await publish(storage,'alias-old','document');await chain();installDocumentBodyReader(pool,storage,aliasLimits)
 const read=storage.read.bind(storage);storage.read=async key=>{const bytes=await read(key);await pool.query("INSERT INTO deleted_sessions(session_id) VALUES('alias-middle')");return bytes}
 const row=(await pool.query('SELECT * FROM session_document_versions WHERE version_id=$1',[f.doc.versionId])).rows[0]
 await assert.rejects(()=>readDocumentBody(pool,{userId:owner,sessionId:'alias-new',documentId:f.doc.documentId,versionId:f.doc.versionId},row),/accessible/)
})
test('owner transfer and immutable native edge guards deny old evidence to both owners',async()=>{
 await chain();await assert.rejects(()=>pool.query("UPDATE session_aliases SET next_session_id='forged' WHERE old_session_id='alias-old'"),/immutable/)
 await assert.rejects(()=>pool.query("DELETE FROM session_aliases WHERE old_session_id='alias-old'"),/permanent/)
 await assert.rejects(()=>renameOwnedDaemonSession(pool,{oldSessionId:'alias-new',newSessionId:'alias-old',daemonId:'alias-daemon',userId:owner}))
 await pool.query("UPDATE sessions SET user_id=$1,daemon_id='alias-other-daemon' WHERE session_id='alias-new'",[other])
 assert.notEqual((await authority('alias-old')).state,'current');assert.equal((await authority('alias-new',other)).state,'current')
 await assert.rejects(()=>ensureDaemonSessionIdentity(pool,'alias-old','alias-other-daemon',other))
})
test('opposite target renames refuse without deadlock or ambiguous data movement',async()=>{
 await pool.query("INSERT INTO sessions(session_id,daemon_id,user_id) VALUES('alias-second','alias-daemon',$1)",[owner])
 const results=await Promise.allSettled([renameOwnedDaemonSession(pool,{oldSessionId:'alias-old',newSessionId:'alias-second',daemonId:'alias-daemon',userId:owner}),renameOwnedDaemonSession(pool,{oldSessionId:'alias-second',newSessionId:'alias-old',daemonId:'alias-daemon',userId:owner})])
 assert.ok(results.every(r=>r.status==='rejected'&&(r.reason as any).code!=='40P01'));assert.equal((await pool.query('SELECT count(*)::int n FROM sessions')).rows[0].n,2)
})
test('privacy deletion closes original/new and pruned manifests; receipt waits for every immutable object',async()=>{
 const storage=aliasStorage(),old=await publish(storage,'alias-old'),pruned=await publish(storage,'alias-old','document')
 await pool.query('UPDATE session_documents SET latest_version_id=NULL WHERE document_id=$1',[pruned.doc.documentId]);await pool.query('DELETE FROM session_document_versions WHERE version_id=$1',[pruned.doc.versionId])
 await chain();const newer=await publish(storage,'alias-new');await deleteSession(pool,'alias-old',{extensionMode:'off'})
 assert.equal((await pool.query('SELECT count(*)::int n FROM session_archive_manifests')).rows[0].n,0)
 assert.deepEqual((await pool.query('SELECT session_id FROM session_archive_object_deletions')).rows.map(r=>r.session_id).sort(),['alias-new','alias-old','alias-old'])
 assert.equal((await pool.query("SELECT objects_completed_at FROM session_lifecycle_deletions WHERE session_id='alias-new'")).rows[0].objects_completed_at,null)
 await pool.query('UPDATE session_archive_object_deletions SET next_attempt_at=NOW()');assert.equal(await new ArchiveObjectCollector(pool,storage).runOnce(20),3)
 assert.ok((await pool.query("SELECT objects_completed_at FROM session_lifecycle_deletions WHERE session_id='alias-new'")).rows[0].objects_completed_at)
 for(const f of [old,pruned,newer])await assert.rejects(()=>storage.read(f.key),/missing/)
 await assert.rejects(()=>ensureDaemonSessionIdentity(pool,'alias-old','alias-daemon',owner))
})
test('user delete scrubs native historical owners while preserving no-body retired barriers',async()=>{
 await chain();await pool.query('DELETE FROM users WHERE id=$1',[owner])
 assert.ok((await pool.query('SELECT owner_user_id,original_daemon_id,request_daemon_id,blocked FROM session_aliases')).rows.every(r=>r.owner_user_id===null&&r.original_daemon_id===null&&r.request_daemon_id===null&&r.blocked))
 await assert.rejects(()=>ensureDaemonSessionIdentity(pool,'alias-old','alias-other-daemon',other))
})
test('installed old event/document composite and document parent FKs upgrade in place idempotently',async()=>{
 const storage=aliasStorage(),event=await publish(storage,'alias-old'),doc=await publish(storage,'alias-old','document')
 await pool.query(`ALTER TABLE events DROP CONSTRAINT events_body_location;ALTER TABLE events DROP CONSTRAINT events_body_manifest_binding;
  DROP TRIGGER events_body_header ON events;ALTER TABLE events DROP COLUMN body_session_id;
  ALTER TABLE events ADD CONSTRAINT events_body_manifest_binding FOREIGN KEY(body_manifest_id,body_owner_user_id,session_id,body_activity_epoch) REFERENCES session_archive_manifests(manifest_id,user_id,session_id,activity_epoch);
  ALTER TABLE session_document_versions DROP CONSTRAINT document_body_location;ALTER TABLE session_document_versions DROP CONSTRAINT document_body_manifest_binding;
  DROP TRIGGER prevent_session_document_version_update ON session_document_versions;ALTER TABLE session_document_versions DROP COLUMN body_session_id;
  ALTER TABLE session_document_versions ADD CONSTRAINT document_body_manifest_binding FOREIGN KEY(body_manifest_id,user_id,session_id,body_activity_epoch) REFERENCES session_archive_manifests(manifest_id,user_id,session_id,activity_epoch)`)
 const fk=(await pool.query("SELECT conname FROM pg_constraint WHERE conrelid='session_documents'::regclass AND confrelid='sessions'::regclass")).rows[0].conname
 await pool.query('ALTER TABLE session_documents DROP CONSTRAINT '+fk)
 await pool.query('ALTER TABLE session_documents ADD CONSTRAINT '+fk+' FOREIGN KEY(user_id,session_id) REFERENCES sessions(user_id,session_id) ON DELETE CASCADE')
 await initDB(pool);await initDB(pool);await chain()
 const e=(await pool.query('SELECT session_id,body_session_id FROM events WHERE id=$1',[event.row.id])).rows[0],v=(await pool.query('SELECT session_id,body_session_id FROM session_document_versions WHERE version_id=$1',[doc.doc.versionId])).rows[0]
 assert.deepEqual(e,{session_id:'alias-new',body_session_id:'alias-old'});assert.deepEqual(v,e)
 assert.equal((await pool.query("SELECT count(*)::int n FROM pg_constraint WHERE conname IN('events_body_manifest_binding','document_body_manifest_binding') AND pg_get_constraintdef(oid) LIKE '%body_session_id%'")).rows[0].n,2)
})
test('native alias bounds and malformed-state cycle detection refuse unsafe resolution',async()=>{
 let prior='alias-old',refused=false
 for(let i=0;i<35;i++){const next='bounded-'+i;try{await renameOwnedDaemonSession(pool,{oldSessionId:prior,newSessionId:next,daemonId:'alias-daemon',userId:owner});prior=next}catch{refused=true;break}}
 assert.equal(refused,true);assert.equal((await authority('alias-old')).sessionId,prior)
 // Owned disposable corruption fixture: reinstall guard before reading. Never weaken runtime roles.
 await pool.query('ALTER TABLE session_aliases DISABLE TRIGGER native_alias_edge_guard')
 try{await pool.query("UPDATE session_aliases SET next_session_id='alias-old' WHERE old_session_id='bounded-0'")}finally{await pool.query('ALTER TABLE session_aliases ENABLE TRIGGER native_alias_edge_guard')}
 assert.notEqual((await authority('alias-old')).state,'current')
})
test('exact-daemon current-account adoption atomically promotes anonymous aliases without promoting old events',async()=>{
 await pool.query("INSERT INTO daemons(daemon_id,user_id) VALUES('anonymous-adopt',NULL)")
 await pool.query("INSERT INTO sessions(session_id,daemon_id,user_id) VALUES('anonymous-start','anonymous-adopt',NULL)")
 const oldEvent=(await pool.query("INSERT INTO events(session_id,event_type,payload,event_hash,user_id) VALUES('anonymous-start','agent_text','{\"text\":\"original unowned\"}','original-unowned',NULL) RETURNING id")).rows[0].id
 await renameOwnedDaemonSession(pool,{oldSessionId:'anonymous-start',newSessionId:'anonymous-route',daemonId:'anonymous-adopt',userId:null})
 await pool.query("UPDATE daemons SET user_id=$1 WHERE daemon_id='anonymous-adopt'",[owner])
 await renameOwnedDaemonSession(pool,{oldSessionId:'anonymous-route',newSessionId:'adopted-current',daemonId:'anonymous-adopt',userId:owner})
 assert.equal((await authority('anonymous-start')).sessionId,'adopted-current')
 assert.deepEqual((await pool.query('SELECT user_id,logical_source_session_id FROM events WHERE id=$1',[oldEvent])).rows[0],{user_id:null,logical_source_session_id:'anonymous-start'})
 await assert.rejects(()=>pool.query('UPDATE events SET user_id=$1 WHERE id=$2',[owner,oldEvent]),/immutable/)
})
test('rename during real archive upload cancels stale publication and leaves uploaded objects collectible',async()=>{
 const storage=aliasStorage(),objects:string[]=[],config=sessionLifecycleConfig({SESSION_LIFECYCLE_EFFECTIVE_AT:'2026-01-01T00:00:00Z',SESSION_LIFECYCLE_TRANSITION_DEADLINE:'2026-01-01T00:00:00Z'})
 await enableSessionColdBodies(pool)
 await pool.query("UPDATE sessions SET status='idle',last_activity_at=NOW()-interval '40 days',last_business_activity_at=NOW()-interval '40 days',activity_verified=TRUE WHERE session_id='alias-old'")
 await pool.query("INSERT INTO events(session_id,event_type,payload,effect_status,user_id,created_at) VALUES('alias-old','agent_text','{\"text\":\"upload race\"}','completed',$1,NOW()-interval '40 days')",[owner])
 await pool.query('UPDATE attention_projection_cursor SET last_event_id=(SELECT max(id) FROM events)')
 let changed=false
 const adapter={namespace:storage.namespace,read:(key:string)=>storage.read(key),delete:(key:string)=>storage.delete(key),put:async(key:string,bytes:Buffer)=>{objects.push(key);await storage.put(key,bytes);if(!changed){changed=true;await rename()}}}
 const executor=new SessionLifecycleExecutor(pool,config,adapter,'fixture-secret')
 const epoch=(await pool.query("SELECT activity_epoch::text FROM sessions WHERE session_id='alias-old'")).rows[0].activity_epoch
 await executor.jobs.enqueue({userId:owner,sessionId:'alias-old',activityEpoch:epoch,action:'archive',policyVersion:config.policyVersion})
 const lease=(await executor.jobs.claim('alias-upload-fixture',300000))!;assert.ok(lease)
 assert.equal(await executor.execute(lease),'cancelled');assert.equal(changed,true)
 assert.equal((await pool.query("SELECT count(*)::int n FROM events WHERE session_id='alias-new' AND body_storage='hot' AND payload IS NOT NULL")).rows[0].n,1)
 assert.equal((await pool.query("SELECT count(*)::int n FROM session_archive_manifests WHERE state='published'")).rows[0].n,0)
 await pool.query('UPDATE session_archive_object_deletions SET next_attempt_at=NOW()');assert.equal(await new ArchiveObjectCollector(pool,adapter).runOnce(20),objects.length)
 for(const key of objects)await assert.rejects(()=>storage.read(key),/missing/)
})
test('deferred new create preserves allow-create and completes the accepted native ledger exactly once',async()=>{
 const reservation=await reserveConcurrentSession(pool,{userId:owner,requestId:'created-after-accept-request',operation:'create',daemonId:'alias-daemon',limit:10,agentType:'codex',cwd:'/fixture'});assert.equal(reservation.allowed,true)
 const m=new EventMaterializer({pool}),input={inboxId:501,userId:owner,daemonId:'alias-daemon',sessionId:'created-after-accept',eventType:'session_created',payload:{type:'session_created',session_id:'created-after-accept',event_id:'created-after-accept-wire',request_id:'created-after-accept-request',agent:'codex'},context:{hostname:'fixture',agentType:'codex',cwd:'/fixture'}}
 const result=await m.materialize(input,undefined,{deferEffects:true})
 assert.equal((await pool.query("SELECT count(*)::int n FROM sessions WHERE session_id='created-after-accept'")).rows[0].n,0)
 assert.equal((await pool.query('SELECT effect_status FROM events WHERE id=$1',[result.eventId])).rows[0].effect_status,'pending')
 await result.applyEffects!();await result.finalizeEffect!()
 assert.equal((await pool.query("SELECT count(*)::int n FROM sessions WHERE session_id='created-after-accept' AND user_id=$1",[owner])).rows[0].n,1)
 assert.equal((await m.materialize(input)).eventId,result.eventId)
})
test('deferred missing status preserves update-only suppression without creating a phantom Session',async()=>{
 const m=new EventMaterializer({pool}),input={inboxId:502,userId:owner,daemonId:'alias-daemon',sessionId:'missing-status',eventType:'session_status',payload:{type:'session_status',session_id:'missing-status',event_id:'missing-status-wire',status:'idle'},context:{hostname:'fixture'}}
 const result=await m.materialize(input,undefined,{deferEffects:true})
 await result.applyEffects!();await result.finalizeEffect!()
 assert.equal((await pool.query("SELECT count(*)::int n FROM sessions WHERE session_id='missing-status'")).rows[0].n,0)
 assert.deepEqual(result.deliveries,[])
})
test('transferred cold account deletion removes A archive refs before A manifests and preserves B genuine new fact',async()=>{
 const storage=aliasStorage(),cold=await publish(storage,'alias-old');await rename()
 await pool.query("UPDATE sessions SET user_id=$1,daemon_id='alias-other-daemon' WHERE session_id='alias-new'",[other])
 const fresh=(await pool.query("INSERT INTO events(session_id,user_id,event_type,payload,event_hash,effect_status) VALUES('alias-new',$1,'agent_text','{\"text\":\"B genuine new fact\"}','owner-B-new','completed') RETURNING id::text",[other])).rows[0].id
 assert.equal(await deleteUserAccount(pool,owner),true)
 assert.equal((await pool.query('SELECT count(*)::int n FROM events WHERE id=$1',[cold.row.id])).rows[0].n,0)
 assert.equal((await pool.query('SELECT user_id,logical_source_session_id,payload FROM events WHERE id=$1',[fresh])).rows[0].user_id,other)
 assert.equal((await pool.query("SELECT user_id FROM sessions WHERE session_id='alias-new'")).rows[0].user_id,other)
 await pool.query('UPDATE session_archive_object_deletions SET next_attempt_at=NOW()')
 assert.equal(await new ArchiveObjectCollector(pool,storage).runOnce(20),1)
 await assert.rejects(()=>storage.read(cold.key),/missing/)
})
for(const mode of ['hot','cold','pending','unavailable'] as const)test(`document ${mode} keeps original owner through transfer, B route rename and A account deletion`,async()=>{
 const storage=aliasStorage(),repo=new SessionDocumentRepository(pool,{uploadTimeoutMs:60000}),documentId=randomUUID(),versionId=randomUUID(),bytes=Buffer.from('A original hot document'),sha=createHash('sha256').update(bytes).digest('hex')
 let oldCold:any
 if(mode==='cold')oldCold=await publish(storage,'alias-old','document')
 else{
  await repo.beginUpload({userId:owner,sessionId:'alias-old',documentId,versionId,daemonId:'alias-daemon',daemonGeneration:1,displayName:'A-private.md',format:'markdown',sourceTurnId:'A-private-turn',sourceEventId:'A-private-event',totalBytes:bytes.length,sha256:sha,chunkCount:1,capturedAt:new Date()})
  if(mode==='hot'){
   await pool.query("INSERT INTO session_document_versions(version_id,user_id,session_id,document_id,source_turn_id,source_event_id,byte_size,sha256,captured_at,content_bytes) VALUES($1,$2,'alias-old',$3,'A-private-turn','A-private-event',$4,$5,NOW(),$6)",[versionId,owner,documentId,bytes.length,sha,bytes])
   await pool.query("UPDATE session_documents SET latest_version_id=$2,state='available' WHERE document_id=$1",[documentId,versionId])
  }
  if(mode==='unavailable')await pool.query("UPDATE session_documents SET state='unavailable',reason_code='read_failed' WHERE document_id=$1",[documentId])
 }
 const did=oldCold?.doc.documentId??documentId,vid=oldCold?.doc.versionId??versionId
 const unchanged=async()=>({documents:(await pool.query("SELECT to_jsonb(d)-ARRAY['session_id','owner_retired'] AS original FROM session_documents d WHERE user_id=$1",[owner])).rows,versions:(await pool.query("SELECT to_jsonb(v)-'session_id' AS original FROM session_document_versions v WHERE user_id=$1",[owner])).rows,uploads:(await pool.query("SELECT to_jsonb(u)-'session_id' AS original FROM session_document_uploads u WHERE user_id=$1",[owner])).rows})
 const original=await unchanged();await rename()
 await pool.query("UPDATE sessions SET user_id=$1,daemon_id='alias-other-daemon' WHERE session_id='alias-new'",[other])
 assert.deepEqual(await unchanged(),original);assert.equal((await pool.query('SELECT owner_retired FROM session_documents WHERE document_id=$1',[did])).rows[0].owner_retired,true);assert.deepEqual(await repo.listLatest(other,'alias-new'),[])
 await assert.rejects(()=>repo.readCommittedContent(other,'alias-new',did,vid),/not found/)
 await assert.rejects(()=>pool.query('UPDATE session_documents SET user_id=$1 WHERE document_id=$2',[other,did]),/immutable/)
 const fresh=await publishAliasBody(pool,storage,other,'alias-new','document'),freshEvent=await publishAliasBody(pool,storage,other,'alias-new')
 installDocumentBodyReader(pool,storage,aliasLimits)
 assert.deepEqual((await repo.readCommittedContent(other,'alias-new',fresh.doc.documentId,fresh.doc.versionId)).bytes,fresh.doc.bytes)
 await renameOwnedDaemonSession(pool,{oldSessionId:'alias-new',newSessionId:'B-later-route',daemonId:'alias-other-daemon',userId:other})
 assert.deepEqual(await unchanged(),original)
 assert.equal((await pool.query('SELECT session_id FROM session_documents WHERE document_id=$1',[did])).rows[0].session_id,'B-later-route')
 assert.deepEqual((await repo.listLatest(other,'B-later-route')).map(d=>d.documentId),[fresh.doc.documentId])
 await assert.rejects(()=>repo.readCommittedContent(other,'B-later-route',did,vid),/not found/)
 assert.equal(await deleteUserAccount(pool,owner),true)
 assert.equal((await pool.query('SELECT count(*)::int n FROM session_documents WHERE document_id=$1',[did])).rows[0].n,0)
 assert.deepEqual((await repo.readCommittedContent(other,'B-later-route',fresh.doc.documentId,fresh.doc.versionId)).bytes,fresh.doc.bytes)
 assert.equal((await pool.query('SELECT user_id FROM events WHERE id=$1',[freshEvent.row.id])).rows[0].user_id,other)
 await pool.query('UPDATE session_archive_object_deletions SET next_attempt_at=NOW()')
 assert.equal(await new ArchiveObjectCollector(pool,storage).runOnce(20),mode==='cold'?1:0)
 if(oldCold)await assert.rejects(()=>storage.read(oldCold.key),/missing/)
 for(const f of [fresh,freshEvent])assert.deepEqual(await readArchiveObject(storage,f.key,aliasLimits.maxCompressedBytes),f.bytes)
})

test('owner ABA diagnostic: historical blocked aliases do not supply authority to genuinely new current A facts',async()=>{
 const storage=aliasStorage(),oldEvent=await publish(storage,'alias-old'),oldDoc=await publish(storage,'alias-old','document')
 installPostgresHistoryBodyReader(pool,storage,aliasLimits);installDocumentBodyReader(pool,storage,aliasLimits)
 await rename();await pool.query("UPDATE sessions SET user_id=$1,daemon_id='alias-other-daemon' WHERE session_id='alias-new'",[other])
 await pool.query("UPDATE sessions SET user_id=$1,daemon_id='alias-daemon' WHERE session_id='alias-new'",[owner])
 const a=await authority('alias-new');assert.equal(a.state,'current')
 assert.deepEqual(a.sessionIds,['alias-new']);assert.notEqual((await authority('alias-old')).state,'current')
 const repo=new SessionDocumentRepository(pool,{uploadTimeoutMs:60000})
 assert.deepEqual({events:(await history()).map((r:any)=>String(r.id)),documents:(await repo.listLatest(owner,'alias-new')).map(d=>d.documentId)},{events:[],documents:[]})
 await assert.rejects(()=>repo.readCommittedContent(owner,'alias-new',oldDoc.doc.documentId,oldDoc.doc.versionId),/not found/)
 await new EventMaterializer({pool}).materialize({inboxId:503,userId:owner,daemonId:'alias-daemon',sessionId:'alias-new',eventType:'agent_text',payload:{type:'agent_text',session_id:'alias-new',event_id:'A-after-ABA',text:'genuinely new A'},context:{hostname:'fixture'}})
 await pool.query("INSERT INTO deleted_sessions(session_id) VALUES('alias-old')")
 assert.equal((await authority('alias-new')).state,'current');assert.notEqual((await authority('alias-old')).state,'current')
 await assert.rejects(()=>pool.query("UPDATE session_aliases SET owner_boundary=FALSE,revision=nextval('session_alias_revision') WHERE old_session_id='alias-old'"),/immutable/)
 await pool.query("INSERT INTO deleted_sessions(session_id) VALUES('alias-new')");assert.equal((await authority('alias-new')).state,'deleted')
})

test('unproved legacy blocked edge never becomes a trusted owner boundary',async()=>{
 await rename()
 await pool.query("UPDATE session_aliases SET blocked=TRUE,revision=nextval('session_alias_revision') WHERE old_session_id='alias-old'")
 assert.equal((await authority('alias-new')).state,'deleted')
 await assert.rejects(()=>pool.query("UPDATE session_aliases SET owner_boundary=TRUE,revision=nextval('session_alias_revision') WHERE old_session_id='alias-old'"),/immutable/)
 assert.equal((await authority('alias-new')).state,'deleted')
})

for(const mode of ['hot','cold'] as const)for(const renamed of [false,true])test(`owner ABA renamed=${renamed} retires original ${mode} event and document, preserves new facts and denies IO return`,async()=>{
 const storage=aliasStorage(),repo=new SessionDocumentRepository(pool,{uploadTimeoutMs:60000})
 installPostgresHistoryBodyReader(pool,storage,aliasLimits);installDocumentBodyReader(pool,storage,aliasLimits)
 let oldEvent:any,oldDoc:any
 if(mode==='cold'){oldEvent=await publish(storage,'alias-old');oldDoc=await publish(storage,'alias-old','document')}
 else{
  oldEvent={row:(await pool.query("INSERT INTO events(session_id,user_id,event_type,payload,event_hash,effect_status) VALUES('alias-old',$1,'agent_text','{\"text\":\"A original hot\"}','A-hot-original','completed') RETURNING id::text",[owner])).rows[0]}
  const did=randomUUID(),vid=randomUUID(),bytes=Buffer.from('A original hot document')
  await pool.query("INSERT INTO session_documents(document_id,user_id,session_id,display_name,document_format,last_source_turn_id,last_source_event_id,state,captured_at) VALUES($1,$2,'alias-old','A-old.md','markdown','A-turn','A-event','available',NOW())",[did,owner])
  await pool.query("INSERT INTO session_document_versions(version_id,user_id,session_id,document_id,source_turn_id,source_event_id,byte_size,sha256,captured_at,content_bytes) VALUES($1,$2,'alias-old',$3,'A-turn','A-event',$4,$5,NOW(),$6)",[vid,owner,did,bytes.length,createHash('sha256').update(bytes).digest('hex'),bytes])
  await pool.query('UPDATE session_documents SET latest_version_id=$2 WHERE document_id=$1',[did,vid]);oldDoc={doc:{documentId:did,versionId:vid,bytes}}
 }
 const original=(await pool.query('SELECT event_hash,user_id,logical_source_session_id,payload FROM events WHERE id=$1',[oldEvent.row.id])).rows[0]
 const sid=renamed?'alias-new':'alias-old';if(renamed)await rename()
 const cut=async()=>{await pool.query("UPDATE sessions SET user_id=$1,daemon_id='alias-other-daemon' WHERE session_id=$2",[other,sid]);await pool.query("UPDATE sessions SET user_id=$1,daemon_id='alias-daemon' WHERE session_id=$2",[owner,sid])}
 await cut();assert.equal((await authority(sid)).state,'current')
 assert.deepEqual(await history(sid),[]);assert.deepEqual(await repo.listLatest(owner,sid),[])
 await assert.rejects(()=>repo.readCommittedContent(owner,sid,oldDoc.doc.documentId,oldDoc.doc.versionId),/not found/)
 assert.deepEqual((await pool.query('SELECT event_hash,user_id,logical_source_session_id,payload FROM events WHERE id=$1',[oldEvent.row.id])).rows[0],original)
 await assert.rejects(()=>pool.query('UPDATE events SET owner_retired=FALSE WHERE id=$1',[oldEvent.row.id]),/permanent/)
 await assert.rejects(()=>pool.query('UPDATE session_documents SET owner_retired=FALSE WHERE document_id=$1',[oldDoc.doc.documentId]),/permanent/)
 const fresh=await publish(storage,sid),doc=await publish(storage,sid,'document')
 assert.deepEqual((await history(sid)).map((r:any)=>String(r.id)),[fresh.row.id])
 assert.deepEqual((await repo.readCommittedContent(owner,sid,doc.doc.documentId,doc.doc.versionId)).bytes,doc.doc.bytes)
 // Warmed cache must recheck this exact event, even when the owner returns.
 let approvals=0;await assert.rejects(()=>withSessionHistoryScope({userId:owner,authorize:async()=>{if(++approvals===2)await cut();return true}},()=>getSessionAllEvents(pool,sid)),/accessible|binding|manifest/)
 assert.equal((await pool.query('SELECT owner_retired FROM events WHERE id=$1',[fresh.row.id])).rows[0].owner_retired,true)
 const ioEvent=await publish(storage,sid),read=storage.read.bind(storage);let changed=false
 storage.read=async key=>{const value=await read(key);if(!changed){changed=true;await cut()}return value}
 await assert.rejects(()=>history(sid),/accessible|binding|manifest/);assert.equal(changed,true);storage.read=read
 const ioDoc=await publish(storage,sid,'document');changed=false
 storage.read=async key=>{const value=await read(key);if(!changed){changed=true;await cut()}return value}
 await assert.rejects(()=>repo.readCommittedContent(owner,sid,ioDoc.doc.documentId,ioDoc.doc.versionId),/not found/);assert.equal(changed,true);storage.read=read
 assert.equal((await pool.query('SELECT owner_retired FROM events WHERE id=$1',[ioEvent.row.id])).rows[0].owner_retired,true)
})

for(const kind of ['event','document'] as const)test(`owner cut refuses an independently locked ${kind} row without partial retirement`,async()=>{
 const storage=aliasStorage(),e=await publish(storage,'alias-old'),doc=await publish(storage,'alias-old','document'),client=await pool.connect()
 try{
  await client.query('BEGIN');await client.query(kind==='event'?'SELECT id FROM events WHERE id=$1 FOR UPDATE':'SELECT document_id FROM session_documents WHERE document_id=$1 FOR UPDATE',[kind==='event'?e.row.id:doc.doc.documentId])
  const started=Date.now();await assert.rejects(()=>pool.query("UPDATE sessions SET user_id=$1,daemon_id='alias-other-daemon' WHERE session_id='alias-old'",[other]),{code:'55P03'});assert.ok(Date.now()-started<1500)
  assert.equal((await pool.query('SELECT owner_retired FROM events WHERE id=$1',[e.row.id])).rows[0].owner_retired,false)
  assert.equal((await pool.query('SELECT owner_retired FROM session_documents WHERE document_id=$1',[doc.doc.documentId])).rows[0].owner_retired,false)
  assert.equal((await authority('alias-old')).state,'current')
 }finally{await client.query('ROLLBACK');client.release()}
})

test('owner ABA cannot resume an original pending document upload or publish its version',async()=>{
 const repo=new SessionDocumentRepository(pool,{uploadTimeoutMs:60000}),documentId=randomUUID(),versionId=randomUUID(),bytes=Buffer.from('original upload'),sha256=createHash('sha256').update(bytes).digest('hex')
 await repo.beginUpload({userId:owner,sessionId:'alias-old',documentId,versionId,daemonId:'alias-daemon',daemonGeneration:1,displayName:'private.md',format:'markdown',sourceTurnId:'old-turn',sourceEventId:'old-event',totalBytes:bytes.length,sha256,chunkCount:1,capturedAt:new Date()})
 await pool.query("UPDATE sessions SET user_id=$1,daemon_id='alias-other-daemon' WHERE session_id='alias-old'",[other]);await pool.query("UPDATE sessions SET user_id=$1,daemon_id='alias-daemon' WHERE session_id='alias-old'",[owner])
 await assert.rejects(()=>repo.storeChunk({userId:owner,sessionId:'alias-old',documentId,versionId,chunkIndex:0,byteOffset:0,bytes,sha256}),/not found/)
 await assert.rejects(()=>repo.commitUpload({userId:owner,sessionId:'alias-old',documentId,versionId,totalBytes:bytes.length,sha256}),/not found/)
 assert.equal((await pool.query('SELECT count(*)::int n FROM session_document_upload_chunks WHERE version_id=$1',[versionId])).rows[0].n,0)
 assert.equal((await pool.query('SELECT user_id FROM session_document_uploads WHERE version_id=$1',[versionId])).rows[0].user_id,owner)
})

test('owner cut also retires legacy foreign original refs and never accepts caller-forged retirement',async()=>{
 const foreign=(await pool.query("INSERT INTO events(session_id,user_id,event_type,payload,event_hash,effect_status) VALUES('alias-old',$1,'agent_text','{\"text\":\"legacy foreign original\"}','legacy-foreign','completed') RETURNING id::text",[other])).rows[0]
 await assert.rejects(()=>pool.query("INSERT INTO events(session_id,user_id,event_type,payload,owner_retired) VALUES('alias-old',$1,'agent_text','{}',TRUE)",[owner]),/server-owned/)
 await pool.query("UPDATE sessions SET user_id=$1,daemon_id='alias-other-daemon' WHERE session_id='alias-old'",[other])
 assert.equal((await pool.query('SELECT owner_retired FROM events WHERE id=$1',[foreign.id])).rows[0].owner_retired,true)
 assert.equal((await pool.query('SELECT public.native_event_authority($1,$2) AS a',[foreign.id,other])).rows[0].a.state,'revoked')
 const fresh=(await pool.query("INSERT INTO events(session_id,user_id,event_type,payload,event_hash,effect_status) VALUES('alias-old',$1,'agent_text','{\"text\":\"B post-cut genuine\"}','new-B-after-foreign','completed') RETURNING id::text",[other])).rows[0]
 assert.equal((await pool.query('SELECT public.native_event_authority($1,$2) AS a',[fresh.id,other])).rows[0].a.state,'current')
})

}
