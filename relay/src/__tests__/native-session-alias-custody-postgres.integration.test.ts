/** Actual native custody, account-erasure and migration-input regressions. */
import {test,beforeAll,beforeEach,afterAll} from 'vitest'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import pg from 'pg'
import {initDB,ensureDaemonSessionIdentity,renameOwnedDaemonSession,deleteUserAccount} from '../db.js'
import {EventMaterializer} from '../materialization/event-materializer.js'
import {SessionLifecycleExecutor} from '../session-lifecycle/executor.js'
import {sessionLifecycleConfig} from '../session-lifecycle/config.js'
import {enableSessionColdBodies} from '../session-lifecycle/cold-schema.js'
import {inspectLifecycleEligibility} from '../session-lifecycle/eligibility.js'
import {decodeArchiveChunk,encodeArchiveChunk,archiveObjectKey} from '@pocketctl/session-source'
import {installPostgresHistoryBodyReader,withSessionHistoryScope} from '../session-history/postgres-reader.js'
import {installDocumentBodyReader} from '../session-documents/body-reader.js'
import {SessionDocumentRepository} from '../session-documents/repository.js'
import {getSessionAllEvents} from '../db.js'
import {ArchiveObjectCollector} from '../session-archive/object-gc.js'
import {decodeDocumentArchiveChunk} from '../session-documents/archive-codec.js'
import {aliasStorage,aliasLimits} from './native-session-alias-fixture.js'
// Exact reviewed pre-v3 native function fixture SHA256: 4d376236279db6bb6dc2dfca23fc5776627dc19e19c499e06fb0c4a44e1eedff
const PRE_V3_AUTHORITY_SQL=String.raw` CREATE OR REPLACE FUNCTION public.native_session_authority(p_id TEXT,p_owner INT,p_daemon TEXT DEFAULT NULL) RETURNS JSONB
 LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
 DECLARE sid TEXT=p_id;seen TEXT[]=ARRAY[]::text[];ids TEXT[];fresh TEXT[];edge RECORD;s RECORD;rev BIGINT;step INT;BEGIN
  IF p_id IS NULL OR length(p_id) NOT BETWEEN 1 AND 128 THEN RETURN jsonb_build_object('state','revoked');END IF;
  -- Bound the complete name graph even when historical owners form separate authority components.
  PERFORM public.native_session_alias_set(ARRAY[p_id]);
  FOR step IN 1..33 LOOP
   IF sid=ANY(seen) OR step>32 THEN RETURN jsonb_build_object('state','revoked');END IF;
   seen=array_append(seen,sid);
   SELECT * INTO edge FROM public.session_aliases WHERE old_session_id=sid;
   IF NOT FOUND THEN EXIT;END IF;
   IF edge.owner_user_id IS DISTINCT FROM p_owner OR(p_owner IS NULL AND edge.original_daemon_id IS DISTINCT FROM p_daemon)
    THEN RETURN jsonb_build_object('state','revoked');END IF;
   IF edge.blocked THEN RETURN jsonb_build_object('state','deleted');END IF;
   sid=edge.next_session_id;
  END LOOP;
  SELECT * INTO s FROM public.sessions WHERE session_id=sid;
  IF NOT FOUND OR s.user_id IS DISTINCT FROM p_owner OR(p_owner IS NULL AND s.daemon_id IS DISTINCT FROM p_daemon)
   THEN RETURN jsonb_build_object('state','revoked');END IF;
  IF s.content_state IN('deleting','deleted') THEN RETURN jsonb_build_object('state','deleted');END IF;
  ids=ARRAY[sid];
  FOR step IN 1..32 LOOP
   SELECT array_agg(id ORDER BY id COLLATE "C") INTO fresh FROM(SELECT unnest(ids) AS id
    UNION SELECT a.old_session_id FROM public.session_aliases a WHERE a.next_session_id=ANY(ids)
     AND a.owner_user_id IS NOT DISTINCT FROM p_owner AND(p_owner IS NOT NULL OR a.original_daemon_id=p_daemon)) q;
   EXIT WHEN fresh=ids;ids=fresh;
  END LOOP;
  -- Only a durable blocked owner boundary permits fresh facts under a new owner.
  IF EXISTS(SELECT 1 FROM public.session_aliases a WHERE a.next_session_id=ANY(ids)
    AND a.owner_user_id IS DISTINCT FROM p_owner AND NOT a.blocked) THEN RETURN jsonb_build_object('state','revoked');END IF;
  IF EXISTS(SELECT 1 FROM public.deleted_sessions WHERE session_id=ANY(ids))
   OR EXISTS(SELECT 1 FROM public.session_aliases WHERE old_session_id=ANY(ids) AND blocked)
   THEN RETURN jsonb_build_object('state','deleted');END IF;
  SELECT COALESCE(max(revision),0) INTO rev FROM public.session_aliases WHERE old_session_id=ANY(ids);
  RETURN jsonb_build_object('state','current','sessionId',sid,'sessionIds',ids,'revision',rev::text,
   'originSessionId',COALESCE((SELECT a.old_session_id FROM public.session_aliases a WHERE a.old_session_id=ANY(ids)
     AND NOT EXISTS(SELECT 1 FROM public.session_aliases parent WHERE parent.next_session_id=a.old_session_id
       AND parent.owner_user_id IS NOT DISTINCT FROM p_owner) LIMIT 1),sid));
 END $$;
`
const url=process.env.NATIVE_SESSION_ALIAS_CUSTODY_TEST_DATABASE_URL
const pool=new pg.Pool({connectionString:url,max:4,statement_timeout:10000,lock_timeout:1000})
const config=sessionLifecycleConfig({SESSION_LIFECYCLE_EFFECTIVE_AT:'2026-01-01T00:00:00Z',SESSION_LIFECYCLE_TRANSITION_DEADLINE:'2026-01-01T00:00:00Z'})
let a:number,b:number

if(!url)test.skip('requires unique owned NATIVE_SESSION_ALIAS_CUSTODY_TEST_DATABASE_URL',()=>{})
else{
 beforeAll(async()=>{const u=new URL(url);assert.ok(['127.0.0.1','localhost','[::1]'].includes(u.hostname));assert.equal(u.pathname,'/shared_native_alias_custody_r1_test');assert.equal(u.username,'shared_native_alias_custody_r1_test');assert.deepEqual((await pool.query("SELECT current_database() AS db,current_user AS role,(SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated")).rows[0],{db:'shared_native_alias_custody_r1_test',role:'shared_native_alias_custody_r1_test',elevated:false})})
 afterAll(async()=>{await pool.end()})
 beforeEach(async()=>{await pool.query('DROP OWNED BY CURRENT_USER CASCADE;CREATE SCHEMA IF NOT EXISTS public');await initDB(pool);await enableSessionColdBodies(pool);const rows=(await pool.query("INSERT INTO users(email,password_hash) VALUES('custody-a@test.invalid','x'),('custody-b@test.invalid','x') RETURNING id,email")).rows;a=rows.find(r=>r.email==='custody-a@test.invalid').id;b=rows.find(r=>r.email==='custody-b@test.invalid').id;await pool.query("INSERT INTO daemons(daemon_id,user_id,status,hostname) VALUES('custody-a',$1,'online','fixture'),('custody-b',$2,'online','fixture'),('custody-anon',NULL,'online','fixture')",[a,b])})
 const session=async(sid:string,owner:number|null,daemon='custody-a')=>pool.query("INSERT INTO sessions(session_id,daemon_id,user_id,agent_type,source,status) VALUES($1,$2,$3,'codex','terminal','idle')",[sid,daemon,owner])
 const event=async(sid:string,owner:number|null,text:string)=>(await pool.query("INSERT INTO events(session_id,user_id,event_type,payload,event_hash,effect_status) VALUES($1,$2,'agent_text',$3,$4,'completed') RETURNING id::text",[sid,owner,{text},randomUUID().replaceAll('-','')])).rows[0].id as string
 const transfer=async(sid:string)=>pool.query("UPDATE sessions SET user_id=$1,daemon_id='custody-b' WHERE session_id=$2",[b,sid])
 const newB=(sid:string)=>new EventMaterializer({pool}).materialize({inboxId:71,userId:b,daemonId:'custody-b',sessionId:sid,eventType:'agent_text',payload:{type:'agent_text',session_id:sid,event_id:randomUUID(),text:'genuine post-cut B fact'},context:{hostname:'fixture'}})
 async function cool(sid:string,owner:number,storage=aliasStorage()){
  const put=storage.put.bind(storage),uploaded:any[]=[],errors:string[]=[]
  storage.put=async(key:string,bytes:Buffer)=>{const r=(await pool.query('SELECT m.*,c.* FROM session_archive_manifests m JOIN session_archive_chunks c USING(manifest_id) WHERE c.object_key=$1',[key])).rows[0];assert.ok(r);const manifest={userId:r.user_id,sessionId:r.session_id,activityEpoch:String(r.activity_epoch),manifestId:r.manifest_id,ordinal:r.ordinal,schemaVersion:r.schema_version,codec:r.codec,firstEventId:String(r.first_event_id),lastEventId:String(r.last_event_id),eventCount:r.event_count,rawBytes:Number(r.raw_bytes),compressedBytes:Number(r.compressed_bytes),rawSha256:r.raw_sha256,compressedSha256:r.compressed_sha256};uploaded.push({key,bytes:Buffer.from(bytes),manifest});await put(key,bytes)}
  await pool.query("UPDATE events SET created_at=NOW()-interval '40 days' WHERE session_id=$1",[sid]);await pool.query("UPDATE sessions SET status='idle',last_activity_at=NOW()-interval '40 days',last_business_activity_at=NOW()-interval '40 days',activity_verified=TRUE,created_at=NOW()-interval '40 days' WHERE session_id=$1",[sid]);await pool.query('UPDATE attention_projection_cursor SET last_event_id=(SELECT COALESCE(max(id),0) FROM events)')
  const e=await inspectLifecycleEligibility(pool,sid,config);assert.deepEqual(e.prediction.blockedReasons,[]);assert.equal(e.prediction.action,'archive')
  const executor=new SessionLifecycleExecutor(pool,config,storage,'custody-diagnostic',e=>errors.push(String(e))),epoch=(await pool.query('SELECT activity_epoch::text AS epoch FROM sessions WHERE session_id=$1',[sid])).rows[0].epoch
  await executor.jobs.enqueue({userId:owner,sessionId:sid,activityEpoch:epoch,action:'archive',policyVersion:config.policyVersion});const lease=await executor.jobs.claim('custody-diagnostic',300000);assert.ok(lease);const result=await executor.execute(lease!);storage.put=put;return {result,uploaded,storage,errors,executor,lease}
 }
 async function document(sid:string,owner:number,name:string){const did=randomUUID(),vid=randomUUID(),bytes=Buffer.from(name+' exact bytes'),hash=createHash('sha256').update(bytes).digest('hex');await pool.query("INSERT INTO session_documents(document_id,user_id,session_id,display_name,document_format,last_source_turn_id,last_source_event_id,state,captured_at) VALUES($1,$2,$3,$4,'markdown','turn','event','available',NOW()-interval '40 days')",[did,owner,sid,name+'.md']);await pool.query("INSERT INTO session_document_versions(version_id,user_id,session_id,document_id,source_turn_id,source_event_id,byte_size,sha256,captured_at,committed_at,content_bytes) VALUES($1,$2,$3,$4,'turn','event',$5,$6,NOW()-interval '40 days',NOW()-interval '40 days',$7)",[vid,owner,sid,did,bytes.length,hash,bytes]);await pool.query('UPDATE session_documents SET latest_version_id=$2 WHERE document_id=$1',[did,vid]);return {did,vid,bytes,hash}}
 test('NULL original adoption and real cooling must not block custodian A account deletion after route transfer',async()=>{
  await session('anon-source',null,'custody-anon');const old=await event('anon-source',null,'original anonymous native fact')
  await pool.query("UPDATE daemons SET user_id=$1 WHERE daemon_id='custody-anon'",[a]);await ensureDaemonSessionIdentity(pool,'anon-source','custody-anon',a)
  assert.equal((await pool.query('SELECT user_id FROM events WHERE id=$1',[old])).rows[0].user_id,null)
  const c=await cool('anon-source',a);assert.equal(c.result,'succeeded');assert.equal(c.uploaded.length,1);const u=c.uploaded[0];assert.equal(u.manifest.userId,a);assert.equal((await decodeArchiveChunk(u.bytes,u.manifest,u.manifest,aliasLimits))[0].id,old)
  await renameOwnedDaemonSession(pool,{oldSessionId:'anon-source',newSessionId:'transferred-route',daemonId:'custody-anon',userId:a});await transfer('transferred-route');const fresh=await newB('transferred-route')
  console.info('NULL custody rows',JSON.stringify((await pool.query('SELECT id::text,user_id,body_owner_user_id,body_storage,body_session_id,session_id,owner_retired FROM events ORDER BY id')).rows))
  try{assert.equal(await deleteUserAccount(pool,a),true)}catch(error){console.info('NULL custody failure',JSON.stringify({code:(error as any).code,constraint:(error as any).constraint}));assert.equal((await pool.query('SELECT user_id FROM events WHERE id=$1',[fresh.eventId])).rows[0].user_id,b);assert.equal((await pool.query("SELECT user_id FROM sessions WHERE session_id='transferred-route'")).rows[0].user_id,b);throw error}
  assert.equal((await pool.query('SELECT user_id FROM events WHERE id=$1',[fresh.eventId])).rows[0].user_id,b)
  await pool.query('UPDATE session_archive_object_deletions SET next_attempt_at=NOW()');assert.equal(await new ArchiveObjectCollector(pool,c.storage).runOnce(20),1);await assert.rejects(()=>c.storage.read(u.key),/missing/)
  await assert.rejects(()=>ensureDaemonSessionIdentity(pool,'anon-source','custody-b',b))
 })
 test('real cooling must exclude retired and known-foreign original events from B archive custody',async()=>{
  await session('event-route',a);const retired=await event('event-route',a,'retired A original');await transfer('event-route');const foreign=await event('event-route',a,'legacy unretired foreign A original'),fresh=await newB('event-route'),c=await cool('event-route',b),decoded:any[]=[]
  for(const u of c.uploaded)decoded.push(...await decodeArchiveChunk(u.bytes,u.manifest,u.manifest,aliasLimits))
  console.info('event custody actual',JSON.stringify({result:c.result,errors:c.errors,encoded:decoded.map(r=>r.id),rows:(await pool.query('SELECT id::text,user_id,owner_retired,body_owner_user_id,body_storage FROM events ORDER BY id')).rows}))
  assert.ok(!decoded.some(r=>r.id===retired||r.id===foreign),'B archive must exclude retired/foreign original bodies');assert.ok(decoded.some(r=>r.id===String(fresh.eventId)));assert.equal(c.result,'succeeded');assert.equal((await pool.query("SELECT content_state FROM sessions WHERE session_id='event-route'")).rows[0].content_state,'mixed');assert.equal(await c.executor.jobs.claim('no-retired-loop',300000),null)
 })
 test('real cooling must never upload retained A document bytes using B archive binding',async()=>{
  await session('document-route',a);const did=randomUUID(),vid=randomUUID(),bytes=Buffer.from('A retained document'),hash=createHash('sha256').update(bytes).digest('hex')
  await pool.query("INSERT INTO session_documents(document_id,user_id,session_id,display_name,document_format,last_source_turn_id,last_source_event_id,state,captured_at) VALUES($1,$2,'document-route','A.md','markdown','A-turn','A-event','available',NOW()-interval '40 days')",[did,a]);await pool.query("INSERT INTO session_document_versions(version_id,user_id,session_id,document_id,source_turn_id,source_event_id,byte_size,sha256,captured_at,committed_at,content_bytes) VALUES($1,$2,'document-route',$3,'A-turn','A-event',$4,$5,NOW()-interval '40 days',NOW()-interval '40 days',$6)",[vid,a,did,bytes.length,hash,bytes]);await pool.query('UPDATE session_documents SET latest_version_id=$2 WHERE document_id=$1',[did,vid]);await transfer('document-route')
  assert.equal((await pool.query('SELECT owner_retired FROM session_documents WHERE document_id=$1',[did])).rows[0].owner_retired,true)
  const bd=await document('document-route',b,'B-current');const c=await cool('document-route',b),leaked=[];let validB=0;for(const u of c.uploaded){try{const body=await decodeDocumentArchiveChunk(u.bytes,u.manifest,u.manifest,{documentId:did,versionId:vid,byteSize:bytes.length,sha256:hash},aliasLimits);leaked.push({user:u.manifest.userId,body:body.toString()})}catch{}}
  for(const u of c.uploaded){try{assert.deepEqual(await decodeDocumentArchiveChunk(u.bytes,u.manifest,u.manifest,{documentId:bd.did,versionId:bd.vid,byteSize:bd.bytes.length,sha256:bd.hash},aliasLimits),bd.bytes);validB++}catch{}}assert.equal(validB,1);assert.equal(c.result,'succeeded');assert.equal(await c.executor.jobs.claim('no-retired-doc-loop',300000),null);console.info('document custody actual',JSON.stringify({result:c.result,errors:c.errors,uploaded:c.uploaded.length,decodedAUnderB:leaked}));assert.equal(leaked.length,0,'retired A document must never upload under B custody')
 })
 for(const custody of ['A','B'])test(`already mixed NONNULL ${custody} custody blocks account A before every destructive business write`,async()=>{
  await session('legacy-mixed',a);const aid=await event('legacy-mixed',a,'A bytes in mixed immutable chunk');await transfer('legacy-mixed');const fresh=await newB('legacy-mixed'),custodian=custody==='A'?a:b,manifestId=randomUUID(),storage=aliasStorage()
  const rows=(await pool.query('SELECT id::text,event_type,payload FROM events ORDER BY id')).rows,binding={userId:custodian,sessionId:'legacy-mixed',activityEpoch:'0',manifestId,ordinal:0},encoded=await encodeArchiveChunk(binding,rows.map(r=>({id:r.id,eventType:r.event_type,payload:r.payload})),aliasLimits),m=encoded.manifest,key=archiveObjectKey(manifestId,0);await storage.put(key,encoded.bytes)
  await pool.query("INSERT INTO session_archive_manifests(manifest_id,user_id,session_id,activity_epoch,schema_version,codec,state,event_high_water,published_at,storage_namespace) VALUES($1,$2,'legacy-mixed',0,1,'gzip','published',$3,NOW(),$4)",[manifestId,custodian,fresh.eventId,storage.namespace]);await pool.query('INSERT INTO session_archive_chunks(manifest_id,ordinal,object_key,first_event_id,last_event_id,event_count,raw_bytes,compressed_bytes,raw_sha256,compressed_sha256) VALUES($1,0,$2,$3,$4,$5,$6,$7,$8,$9)',[manifestId,key,m.firstEventId,m.lastEventId,m.eventCount,m.rawBytes,m.compressedBytes,m.rawSha256,m.compressedSha256]);await pool.query("UPDATE events SET body_storage='cold',payload=NULL,body_manifest_id=$1,body_chunk_ordinal=0,body_owner_user_id=$2,body_session_id='legacy-mixed',body_activity_epoch=0 WHERE id=ANY($3::bigint[])",[manifestId,custodian,[aid,fresh.eventId]])
  const state=async()=>JSON.stringify((await pool.query('SELECT (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM users t) AS users,(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM events t) AS events,(SELECT jsonb_agg(to_jsonb(t)) FROM session_archive_manifests t) AS manifests,(SELECT jsonb_agg(to_jsonb(t)) FROM session_archive_object_deletions t) AS deletion')).rows),before=await state(),writes:string[]=[]
  const watched={connect:async()=>{const client=await pool.connect(),q=client.query.bind(client);return {query:async(sql:string,params?:any[])=>{if(/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))writes.push(sql);return q(sql,params)},release:()=>client.release()}}} as any
  let error:any;try{await deleteUserAccount(watched,a)}catch(e){error=e}
  console.info('mixed custody preflight',JSON.stringify({custody,code:error?.code,writes:writes.length,remainingA:(await pool.query('SELECT count(*)::int n FROM users WHERE id=$1',[a])).rows[0].n}))
  assert.equal(error?.code,'native_archive_custody_repair_required');assert.deepEqual(writes,[]);assert.equal(await state(),before);assert.deepEqual(await decodeArchiveChunk(encoded.bytes,m,binding,aliasLimits),rows.map(r=>({id:r.id,eventType:r.event_type,payload:r.payload})))
 })
 test('known no-alias pre-v3 owner-change history refuses upgrade before DDL or reference regrant',async()=>{
  await session('upgrade-history',a);const id=await event('upgrade-history',a,'old A before historical owner cut');await transfer('upgrade-history');await pool.query("UPDATE sessions SET user_id=$1,daemon_id='custody-a' WHERE session_id='upgrade-history'",[a])
  await pool.query("CREATE SCHEMA shared;CREATE TABLE shared.memory_source_session_barriers(owner_user_id int,session_id text,canonical_session_id text,reason text);INSERT INTO shared.memory_source_session_barriers VALUES(1,'upgrade-history',NULL,'owner_changed')")
  assert.equal(createHash('sha256').update(PRE_V3_AUTHORITY_SQL).digest('hex'),'4d376236279db6bb6dc2dfca23fc5776627dc19e19c499e06fb0c4a44e1eedff');await pool.query(PRE_V3_AUTHORITY_SQL)
  await pool.query('DROP TRIGGER events_owner_retirement ON events;ALTER TABLE events DROP COLUMN owner_retired')
  const before=(await pool.query("SELECT pg_get_functiondef('public.native_session_authority(text,integer,text)'::regprocedure) AS definition")).rows[0].definition;let error:any;try{await initDB(pool)}catch(e){error=e}
  console.info('historical upgrade guard',JSON.stringify({code:error?.code,markerPresent:(await pool.query("SELECT 1 FROM pg_attribute WHERE attrelid='events'::regclass AND attname='owner_retired' AND NOT attisdropped")).rowCount,authority:error?undefined:(await pool.query('SELECT public.native_event_authority($1,$2) AS a',[id,a])).rows[0].a}))
  assert.equal(error?.code,'native_retirement_upgrade_repair_required');assert.equal((await pool.query("SELECT pg_get_functiondef('public.native_session_authority(text,integer,text)'::regprocedure) AS definition")).rows[0].definition,before);assert.equal((await pool.query("SELECT 1 FROM pg_attribute WHERE attrelid='events'::regclass AND attname='owner_retired' AND NOT attisdropped")).rowCount,0);assert.equal((await pool.query('SELECT count(*)::int n FROM session_aliases')).rows[0].n,0);assert.equal((await pool.query("SELECT reason FROM shared.memory_source_session_barriers")).rows[0].reason,'owner_changed')
 })
 for(const table of ['events','session_documents'])test(`valid v3 ${table} missing retirement field is drift and cannot be DEFAULT FALSE repaired`,async()=>{
  if(table==='events')await pool.query('DROP TRIGGER events_owner_retirement ON events');await pool.query('ALTER TABLE '+table+' DROP COLUMN owner_retired')
  await assert.rejects(()=>initDB(pool),{code:'native_retirement_contract_drift'});assert.equal((await pool.query('SELECT 1 FROM pg_attribute WHERE attrelid=$1::regclass AND attname=$2 AND NOT attisdropped',[table,'owner_retired'])).rowCount,0)
 })
 test('safe fresh native0 and valid v3 repetition keep exact flags and native authority working',async()=>{await initDB(pool);await initDB(pool);await session('fresh-repeat',a);const id=await event('fresh-repeat',a,'new valid fact');assert.equal((await pool.query('SELECT public.native_event_authority($1,$2) AS a',[id,a])).rows[0].a.state,'current')})

 test('B cold event/document hydration ignores retained A cold refs before and after A account erasure',async()=>{
  const sid='hydration-route',storage=aliasStorage();await session(sid,a);const oldId=await event(sid,a,'A cold retained'),oldDoc=await document(sid,a,'A-retained'),first=await cool(sid,a,storage);assert.equal(first.result,'succeeded');const aKeys=first.uploaded.map(u=>u.key)
  await transfer(sid);const fresh=await newB(sid),bd=await document(sid,b,'B-current'),second=await cool(sid,b,storage);assert.equal(second.result,'succeeded');assert.equal(second.uploaded.length,2)
  const read=storage.read.bind(storage),reads:string[]=[];storage.read=async key=>{reads.push(key);assert.ok(!aKeys.includes(key),'B hydration must never read original A object');return read(key)}
  installPostgresHistoryBodyReader(pool,storage,aliasLimits);installDocumentBodyReader(pool,storage,aliasLimits);const repo=new SessionDocumentRepository(pool,{uploadTimeoutMs:60000})
  const history=()=>withSessionHistoryScope({userId:b},()=>getSessionAllEvents(pool,sid))
  assert.deepEqual((await history()).map((r:any)=>String(r.id)),[String(fresh.eventId)]);assert.deepEqual((await repo.readCommittedContent(b,sid,bd.did,bd.vid)).bytes,bd.bytes);await assert.rejects(()=>repo.readCommittedContent(b,sid,oldDoc.did,oldDoc.vid),/not found/);assert.ok(reads.length>0);assert.equal((await pool.query('SELECT user_id FROM events WHERE id=$1',[oldId])).rows[0].user_id,a)
  storage.read=read;assert.equal(await deleteUserAccount(pool,a),true);await pool.query('UPDATE session_archive_object_deletions SET next_attempt_at=NOW()');assert.equal(await new ArchiveObjectCollector(pool,storage).runOnce(20),2)
  assert.deepEqual((await history()).map((r:any)=>String(r.id)),[String(fresh.eventId)]);assert.deepEqual((await repo.readCommittedContent(b,sid,bd.did,bd.vid)).bytes,bd.bytes)
 })
 test('legacy0 with recorded owner-change input refuses before native installation',async()=>{
  await pool.query("CREATE SCHEMA shared;CREATE TABLE shared.memory_source_session_barriers(owner_user_id int,session_id text,canonical_session_id text,reason text);INSERT INTO shared.memory_source_session_barriers VALUES(1,'pre-native-cut',NULL,'owner_changed')")
  await pool.query('DROP FUNCTION public.native_session_authority(text,integer,text) CASCADE;DROP TABLE public.session_aliases CASCADE')
  await assert.rejects(()=>initDB(pool),{code:'native_retirement_upgrade_repair_required'});assert.equal((await pool.query("SELECT to_regclass('public.session_aliases') AS relation")).rows[0].relation,null);assert.equal((await pool.query('SELECT reason FROM shared.memory_source_session_barriers')).rows[0].reason,'owner_changed')
 })

}
