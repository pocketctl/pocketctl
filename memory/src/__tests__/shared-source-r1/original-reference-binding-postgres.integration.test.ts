import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {mkdtemp,mkdir,writeFile,readFile,stat,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {canonicalPayloadHash,canonicalSourceClassification,encodeArchiveChunk,type SourceScope} from '@pocketctl/session-source'
import {createSourceArchiveReader} from '../../sources/archive-reader.js'
import {directLaunchFixture} from './direct-launch-fixture.js'
import {bindOriginalPersonalReferencePage,type OriginalBindingCopyReceipt} from '../../migrations/shared-forward/original-reference-binding.js'
import {hash} from '../../migrations/shared-forward/source-maintenance-common.js'
import type {MappingResult} from '../../migrations/shared-source/mapping.js'
import {prepareOriginalPayloadRetirement,applyOriginalPayloadRetirement} from '../../migrations/shared-forward/original-payload-retirement.js'
const url=process.env.ORIGINAL_BINDING_TEST_DATABASE_URL,sourceUrl=process.env.ORIGINAL_BINDING_SOURCE_TEST_DATABASE_URL,suite=url&&sourceUrl?describe:describe.skip
suite('finite original UUID binding with actual controlled reader and commit fence',()=>{
 let source:pg.Client,target:pg.Client,scope:SourceScope,root:{kind:'relay_event';key:string},copy:OriginalBindingCopyReceipt,mappings:MappingResult[],originalHash:string,fixtureClosed=false
 let fixture:Awaited<ReturnType<typeof directLaunchFixture>>
 let archiveDirectory:string|undefined,archive:NonNullable<Parameters<typeof bindOriginalPersonalReferencePage>[3]>['archive']
 const digest=(v:unknown)=>canonicalPayloadHash(v).toString('hex')
 const call=(ms=mappings,options:Parameters<typeof bindOriginalPersonalReferencePage>[3]={})=>bindOriginalPersonalReferencePage(source,target,{copy,scope,root,mappings:ms},{archive,...options})
 beforeAll(async()=>{
  if(!url||!sourceUrl||new URL(url).pathname!=='/shared_original_binding_test'||new URL(sourceUrl).pathname!=='/shared_original_binding_source_test'||new URL(sourceUrl).username!=='postgres')throw Error('dedicated_original_binding_fixture_required')
  // Distinct fresh databases. The synthetic copy receipt below represents
  // the operator input; actual transfer/checkpoint verification has its own
  // full-engine integration suite. Row comparison and runtime fences are real.
  const saved=process.env.DIRECT_LAUNCH_FIXTURE_ADMIN_DATABASE_URL,admin=new URL(url);admin.username='postgres';admin.password='synthetic-only'
  process.env.DIRECT_LAUNCH_FIXTURE_ADMIN_DATABASE_URL=admin.href
  try{fixture=await directLaunchFixture(url,{originalBinding:true})}finally{if(saved===undefined)delete process.env.DIRECT_LAUNCH_FIXTURE_ADMIN_DATABASE_URL;else process.env.DIRECT_LAUNCH_FIXTURE_ADMIN_DATABASE_URL=saved}
  const s=await fixture.source(),inst=(await fixture.install(s,'retained_history')).inst.installation_id,knownId=await fixture.event(s)
  root={kind:'relay_event',key:fixture.root(s)};scope={installationId:inst,principalUserId:String(s.owner),ownerScopeKind:'personal',ownerScopeId:inst,authorizationRevision:'1',configVersion:'1',modeGeneration:'2'}
  const unknownId=(await fixture.publisher.query("INSERT INTO public.events(session_id,event_type,payload,event_hash,effect_status,user_id) VALUES($1::text,'agent_text','{\"text\":\"literal unknown producer\",\"event_id\":\"original-business-key\"}',substr(md5($1::text||':agent_text:event:original-business-key'),1,16),'completed',$2) RETURNING id::text",[s.session,s.owner])).rows[0].id
  mappings=[]
  for(const id of [knownId,unknownId]){
   const e=(await fixture.pool.query('SELECT id::text,created_at,payload,source_sequence::text,source_classification FROM public.events WHERE id=$1',[id])).rows[0],uuid=randomUUID()
   const classification=e.source_classification??canonicalSourceClassification({source_kind:'canonical_event',session_id:s.session,source_seq:'',payload:e.payload}),provenance=id===knownId?{memory:classification.memory_source}:{}
   await fixture.pool.query(`INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,classification,payload,payload_hash,source_provenance)
    VALUES($1,$2,'feed',$3,$4,$5,'agent_text',date_trunc('milliseconds',$6::timestamptz),$7,$8,decode($9,'hex'),$10)`,[uuid,inst,id===unknownId?'42':'synthetic-feed:'+id,s.session,e.payload.turn_id??null,e.created_at,classification,e.payload,digest(e.payload),provenance])
   mappings.push({sourceEventId:uuid,installationId:inst,state:'unique-hot',reasons:[],replacementProven:true,deletionEligible:false,originalSourceHash:digest(e.payload),originalHashVersion:'canonical-json-sha256-v1',contentHash:digest(e.payload),classificationHash:digest(classification),hashVersion:'canonical-json-sha256-v1',sourceKind:'relay_event',canonicalId:id,
    provenanceState:id===knownId?'known':'unknown',identityRelations:[{kind:'relay_event',id,via:'feed'}],...(e.source_sequence?{sourceSequence:e.source_sequence,sourceVersion:e.source_sequence}:{})})
  }
  await fixture.pool.query("UPDATE memory.source_events SET canonical_event_key='event_id:original-business-key' WHERE source_event_id=$1",[mappings[1].sourceEventId])
  source=new pg.Client({connectionString:sourceUrl});await source.connect()
  if(!(await source.query("SELECT to_regclass('public.source_events') IS NULL AS fresh")).rows[0].fresh)throw Error('fresh_original_source_required')
  // Copy the immutable original columns as opaque SQL JSON, preserving exact
  // timestamp/numeric representation, rather than a JS object round-trip.
  const cols=(await fixture.pool.query("SELECT attname,format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid='memory.source_events'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum")).rows
  await source.query('CREATE TABLE public.source_events('+cols.map(c=>'"'+c.attname+'" '+c.type).join(',')+')')
  const rows=(await fixture.pool.query('SELECT row_to_json(s)::text AS json FROM memory.source_events s WHERE installation_id=$1 ORDER BY source_event_id',[inst])).rows
  for(const row of rows)await source.query('INSERT INTO public.source_events SELECT * FROM json_populate_record(NULL::public.source_events,$1::json)',[row.json])
  const u=mappings[1],r=(await source.query('SELECT xmin::text AS version,* FROM public.source_events WHERE source_event_id=$1',[u.sourceEventId])).rows[0]
  u.originalIdentityManifest={kind:'retained-feed-v1-original-identity',sourceEventId:u.sourceEventId,installationId:inst,canonicalKey:unknownId,sourceRowVersion:r.version,originalOrigin:r.origin,originalOriginPosition:r.origin_position,ownerUserId:String(s.owner),ownerScopeId:inst,sessionId:s.session,turnId:null,eventType:'agent_text',occurredAt:r.occurred_at.toISOString(),provenanceHash:digest({}),classificationHash:u.classificationHash,contentHash:u.contentHash,originalSourceHash:u.originalSourceHash,sourceSequence:null,journalOrderProven:false,provenanceState:'unknown'}
  u.originalIdentityManifestHash=digest(u.originalIdentityManifest)
  const wire={envelope_version:1,feed_id:'42',topic:'session.event.v1',source:{kind:'canonical_event',id:'event:'+unknownId,recorded_at:r.occurred_at.toISOString()},subject:{session_id:s.session,event_type:'agent_text'},classification:r.classification,data:r.payload}
  await source.query('CREATE TABLE public.memory_feed_inbox(installation_id uuid,feed_id bigint,envelope_version integer,topic text,source_kind text,source_id text,session_id text,turn_id text,event_type text,recorded_at timestamptz,payload_hash bytea,body_reclaimed_at timestamptz,data jsonb,classification jsonb)')
  await source.query("INSERT INTO public.memory_feed_inbox VALUES($1,42,1,'session.event.v1','canonical_event',$2,$3,NULL,'agent_text',$4,$5,NOW(),'{}','{}')",[inst,'event:'+unknownId,s.session,r.occurred_at,canonicalPayloadHash(wire)])
  const identity=async(db:Pick<pg.Client,'query'>)=>hash((await db.query(`SELECT current_database() AS database,current_user AS role,inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort",d.oid::text AS oid FROM pg_database d WHERE datname=current_database()`)).rows[0])
  copy={schemaVersion:1,kind:'memory-forward-verification',verified:true,manifestHash:'a'.repeat(64),migrationId:randomUUID(),sourceIdentity:await identity(source),targetIdentity:await identity(fixture.pool),sourceEvents:{sourceColumns:cols.map(c=>c.attname),rows:'2',hash:'b'.repeat(64)}}
  await fixture.pool.query('CREATE TABLE shared.memory_forward_runs(migration_id uuid PRIMARY KEY,manifest_hash text);CREATE TABLE shared.memory_forward_tables(migration_id uuid,table_name text,row_count text,row_hash text)')
  await fixture.pool.query('INSERT INTO shared.memory_forward_runs VALUES($1,$2)',[copy.migrationId,copy.manifestHash]);await fixture.pool.query("INSERT INTO shared.memory_forward_tables VALUES($1,'source_events','2',$2)",[copy.migrationId,copy.sourceEvents.hash])
  await fixture.pool.query('ALTER ROLE original_binding_memory NOLOGIN;ALTER ROLE original_binding_relay NOLOGIN;ALTER ROLE shared_original_binding_test NOLOGIN')
  await source.query('REVOKE CONNECT ON DATABASE shared_original_binding_source_test FROM PUBLIC')
  await fixture.close();fixtureClosed=true
  target=new pg.Client({connectionString:admin.href});await target.connect()
  originalHash=(await source.query("SELECT encode(sha256(convert_to(jsonb_agg(to_jsonb(s) ORDER BY source_event_id)::text,'UTF8')),'hex') AS hash FROM public.source_events s")).rows[0].hash
 },60000)
 afterAll(async()=>{await source?.end();await target?.end();if(fixture&&!fixtureClosed)await fixture.close();if(archiveDirectory)await rm(archiveDirectory,{recursive:true,force:true})})
 test('refuses unverified copy, unknown proof invention, wrong database and pre-existing writer before binding',async()=>{
  await expect(bindOriginalPersonalReferencePage(source,target,{copy:{...copy,verified:false},scope,root,mappings})).rejects.toThrow('original_binding_input_invalid')
  await expect(bindOriginalPersonalReferencePage(source,target,{copy:{...copy,targetIdentity:'f'.repeat(64)},scope,root,mappings})).rejects.toThrow('original_binding_database_mismatch')
  await expect(call([{...mappings[1],sourceSequence:'123'}])).rejects.toThrow('original_binding_mapping_unproven')
  await target.query('ALTER ROLE original_binding_memory LOGIN')
  try{await expect(call()).rejects.toThrow('target_writers_not_fenced')}finally{await target.query('ALTER ROLE original_binding_memory NOLOGIN')}
  expect((await target.query("SELECT count(*)::int AS n FROM memory.source_events WHERE mapping_state='verified'")).rows[0].n).toBe(0)
 })
 test('refuses changed original target bytes and commits no partial bindings',async()=>{
  await target.query("UPDATE memory.source_events SET payload='{}' WHERE source_event_id=$1",[mappings[0].sourceEventId])
  try{await expect(call()).rejects.toThrow('original_binding_original_changed')}finally{
   const json=(await source.query('SELECT payload::text AS json FROM public.source_events WHERE source_event_id=$1',[mappings[0].sourceEventId])).rows[0].json
   await target.query('UPDATE memory.source_events SET payload=$2::jsonb WHERE source_event_id=$1',[mappings[0].sourceEventId,json])
  }
 })
 test('a stale target xmin after body preparation rolls back the whole page',async()=>{
  await expect(call(mappings,{beforeCommit:async()=>{await target.query('UPDATE memory.source_events SET created_at=created_at WHERE source_event_id=$1',[mappings[1].sourceEventId])}})).rejects.toThrow('original_binding_row_changed')
  expect((await target.query("SELECT count(*)::int AS n FROM memory.source_events WHERE mapping_state='verified'")).rows[0].n).toBe(0)
 })
 test('wrong canonical identity, changed copy checkpoint and cancellation confer no binding',async()=>{
  const swapped=mappings.map((m,i)=>({...m,canonicalId:mappings[1-i].canonicalId,identityRelations:mappings[1-i].identityRelations}))
  // Retain only the known row so the independent unknown manifest cannot
  // mask the actual controlled body/identity mismatch being exercised.
  await expect(call([swapped[0]])).rejects.toThrow('original_binding_current_source_conflict')
  await target.query("UPDATE shared.memory_forward_tables SET row_hash=repeat('c',64)")
  try{await expect(call()).rejects.toThrow('original_binding_copy_unverified')}finally{await target.query('UPDATE shared.memory_forward_tables SET row_hash=$1',[copy.sourceEvents.hash])}
  const controller=new AbortController();controller.abort()
  await expect(call(mappings,{signal:controller.signal})).rejects.toThrow('original_binding_aborted')
 })
 test('detects authority change between body preparation and COMMIT, and retains original unknown',async()=>{
  await expect(call(mappings,{beforeCommit:async()=>{await target.query("UPDATE public.extension_installations SET status='revoked' WHERE installation_id=$1",[scope.installationId])}})).rejects.toThrow('original_binding_authority_changed')
  await target.query("UPDATE public.extension_installations SET status='active' WHERE installation_id=$1",[scope.installationId])
  expect((await target.query("SELECT count(*)::int AS n FROM memory.source_events WHERE mapping_state='verified'")).rows[0].n).toBe(0)
 })
 test('revalidates the retained Inbox wire hash and xmin before accepting a pruned transport manifest',async()=>{
  const m=mappings[1],inbox=(await source.query("SELECT xmin::text AS version,encode(payload_hash,'hex') AS hash FROM public.memory_feed_inbox WHERE feed_id=42")).rows[0]
  m.originalIdentityManifest={...m.originalIdentityManifest,kind:'retained-inbox-v1-original-identity',feedRowVersion:null,inboxRowVersion:inbox.version,transportEnvelopeHash:inbox.hash,inboxBodyReclaimed:true}
  m.originalIdentityManifestHash=digest(m.originalIdentityManifest)
  const bad=structuredClone(m);bad.originalIdentityManifest!.transportEnvelopeHash='f'.repeat(64);bad.originalIdentityManifestHash=digest(bad.originalIdentityManifest)
  await expect(call([bad])).rejects.toThrow('original_binding_transport_changed')
  const before=async()=>{throw Error('original_binding_test_before_commit')}
  await expect(call([m],{beforeCommit:before})).rejects.toThrow('original_binding_test_before_commit')
  const changed=structuredClone(m);changed.originalIdentityManifest!.inboxRowVersion='1';changed.originalIdentityManifestHash=digest(changed.originalIdentityManifest)
  await expect(call([changed])).rejects.toThrow('original_binding_transport_changed')
  expect((await target.query("SELECT count(*)::int AS n FROM memory.source_events WHERE mapping_state='verified'")).rows[0].n).toBe(0)
 })
 test('keeps original unknown order when the current canonical Journal independently proves an order',async()=>{
  const m=mappings[1],event=(await target.query('SELECT payload,created_at FROM public.events WHERE id=$1',[m.canonicalId])).rows[0]
  const sequence=(await target.query(`INSERT INTO public.extension_source_outbox(source_kind,source_id,owner_user_id,session_id,event_type,occurred_at,payload)
   VALUES('canonical_event',$1,$2,$3,'agent_text',$4,$5) RETURNING source_seq::text`,['event:'+m.canonicalId,scope.principalUserId,root.key.slice(scope.principalUserId.length+1),event.created_at,event.payload])).rows[0].source_seq
  try{
   expect(sequence).toMatch(/^[1-9][0-9]*$/);expect(m.sourceSequence).toBeUndefined()
   expect(await call([m])).toMatchObject({changed:1,alreadyBound:0,sourceBodiesChanged:false,provenanceRewritten:false})
   const row=(await target.query('SELECT source_sequence,source_provenance,payload IS NOT NULL AS body_present FROM memory.source_events WHERE source_event_id=$1',[m.sourceEventId])).rows[0]
   expect(row).toEqual({source_sequence:null,source_provenance:{},body_present:true})
  }finally{
   await target.query('DELETE FROM public.extension_source_outbox WHERE source_seq=$1',[sequence])
   await target.query("UPDATE memory.source_events SET source_kind=NULL,canonical_key=NULL,canonical_session_key=NULL,source_version=NULL,source_sequence=NULL,content_hash=NULL,hash_version=NULL,mapping_state='unproven',adapter_version=NULL WHERE source_event_id=$1",[m.sourceEventId])
  }
 })
 test('preserves proven original order after current Journal and header order are unavailable',async()=>{
  const m=mappings[0],event=(await target.query('SELECT source_header_version,source_sequence::text,canonical_payload_hash,source_classification FROM public.events WHERE id=$1',[m.canonicalId])).rows[0]
  const journal=(await target.query("DELETE FROM public.extension_source_outbox WHERE source_kind='canonical_event' AND source_id=$1 RETURNING row_to_json(extension_source_outbox)::text AS json",['event:'+m.canonicalId])).rows
  await target.query('UPDATE public.events SET source_header_version=NULL,source_sequence=NULL,canonical_payload_hash=NULL,source_classification=NULL WHERE id=$1',[m.canonicalId])
  try{
   expect(await call([m])).toMatchObject({changed:1,alreadyBound:0,provenanceRewritten:false})
   const row=(await target.query('SELECT source_sequence::text,source_provenance,payload IS NOT NULL AS body_present FROM memory.source_events WHERE source_event_id=$1',[m.sourceEventId])).rows[0]
   expect(row.source_sequence).toBe(m.sourceSequence);expect(row.source_provenance.memory.sequence).toBe(m.sourceSequence);expect(row.body_present).toBe(true)
  }finally{
   await target.query('UPDATE public.events SET source_header_version=$2,source_sequence=$3::bigint,canonical_payload_hash=$4,source_classification=$5 WHERE id=$1',[m.canonicalId,event.source_header_version,event.source_sequence,event.canonical_payload_hash,event.source_classification])
   for(const row of journal)await target.query('INSERT INTO public.extension_source_outbox SELECT * FROM json_populate_record(NULL::public.extension_source_outbox,$1::json)',[row.json])
   await target.query("UPDATE memory.source_events SET source_kind=NULL,canonical_key=NULL,canonical_session_key=NULL,source_version=NULL,source_sequence=NULL,content_hash=NULL,hash_version=NULL,mapping_state='unproven',adapter_version=NULL WHERE source_event_id=$1",[m.sourceEventId])
  }
 })
 test('refuses a changed canonical order when the original order is positively mapped',async()=>{
  const m=mappings[0],event=(await target.query('SELECT payload,source_sequence::text,source_classification FROM public.events WHERE id=$1',[m.canonicalId])).rows[0]
  const changed=String(BigInt(event.source_sequence)+1000n),classification=canonicalSourceClassification({source_kind:'canonical_event',session_id:root.key.slice(scope.principalUserId.length+1),source_seq:changed,payload:event.payload})
  await target.query('UPDATE public.extension_source_outbox SET source_seq=$2::bigint WHERE source_kind=\'canonical_event\' AND source_id=$1',['event:'+m.canonicalId,changed])
  await target.query('UPDATE public.events SET source_sequence=$2::bigint,source_classification=$3 WHERE id=$1',[m.canonicalId,changed,classification])
  try{
   await expect(call([m])).rejects.toThrow('original_binding_current_source_conflict')
   expect((await target.query('SELECT mapping_state FROM memory.source_events WHERE source_event_id=$1',[m.sourceEventId])).rows[0].mapping_state).toBe('unproven')
  }finally{
   await target.query('UPDATE public.events SET source_sequence=$2::bigint,source_classification=$3 WHERE id=$1',[m.canonicalId,event.source_sequence,event.source_classification])
   await target.query('UPDATE public.extension_source_outbox SET source_seq=$2::bigint WHERE source_kind=\'canonical_event\' AND source_id=$1',['event:'+m.canonicalId,event.source_sequence])
  }
 })
 test('revalidates original ingress identity, index and current canonical key, including commit-time drift',async()=>{
  const m=mappings[1],index=(await target.query("SELECT pg_get_indexdef('public.idx_events_dedup'::regclass) AS definition")).rows[0].definition
  const eventHash=(await target.query('SELECT event_hash FROM public.events WHERE id=$1',[m.canonicalId])).rows[0].event_hash
  m.identityRelations=[{kind:'relay_event',id:m.canonicalId!,via:'ingress'}]
  m.originalIdentityManifest={...m.originalIdentityManifest,kind:'retained-ingress-key-v1-original-identity',feedRowVersion:null,inboxRowVersion:null,ingressIndexHash:digest(index),ingressEventHash:eventHash,sourceIngressKeyHash:digest('event_id:original-business-key'),archiveVerified:false}
  m.originalIdentityManifestHash=digest(m.originalIdentityManifest)
  for(const key of ['ingressIndexHash','ingressEventHash','sourceIngressKeyHash']){
   const bad=structuredClone(m);bad.originalIdentityManifest![key]='f'.repeat(64);bad.originalIdentityManifestHash=digest(bad.originalIdentityManifest)
   await expect(call([bad])).rejects.toThrow('original_binding_ingress_changed')
  }
  await expect(call([m],{beforeCommit:async()=>{throw Error('prepared_ingress')}})).rejects.toThrow('prepared_ingress')
  await expect(call([m],{beforeCommit:async()=>{await target.query("UPDATE public.events SET event_hash='changed' WHERE id=$1",[m.canonicalId])}})).rejects.toThrow('original_binding_ingress_changed')
  await target.query('UPDATE public.events SET event_hash=$2 WHERE id=$1',[m.canonicalId,eventHash])
  expect((await target.query("SELECT count(*)::int AS n FROM memory.source_events WHERE mapping_state='verified'")).rows[0].n).toBe(0)
 })
 test('prepares actual cold ingress bytes through the controlled archive reader and rejects corruption',async()=>{
  const m=mappings[1],row=(await source.query('SELECT session_id,payload FROM public.source_events WHERE source_event_id=$1',[m.sourceEventId])).rows[0]
  const manifestId=randomUUID(),binding={userId:Number(scope.principalUserId),sessionId:row.session_id,activityEpoch:'0',manifestId,ordinal:0}
  const {bytes,manifest:z}=await encodeArchiveChunk(binding,[{id:m.canonicalId!,eventType:'agent_text',payload:row.payload}],{maxRawBytes:1024*1024,maxCompressedBytes:1024*1024,maxRecords:100})
  archiveDirectory=await mkdtemp(join(tmpdir(),'original-binding-cold-'))
  const objectKey=`session-archive/v1/${manifestId}/0.gz`,file=join(archiveDirectory,objectKey)
  await mkdir(join(archiveDirectory,'session-archive/v1',manifestId),{recursive:true});await writeFile(file,bytes)
  archive={storage:createSourceArchiveReader(archiveDirectory,'original-binding-test'),limits:{maxRawBytes:1024*1024,maxCompressedBytes:1024*1024,maxRecords:100}}
  await target.query("INSERT INTO public.session_archive_manifests(manifest_id,user_id,session_id,activity_epoch,schema_version,codec,state,event_high_water,published_at,storage_namespace) VALUES($1,$2,$3,0,1,'gzip','published',$4,NOW(),'original-binding-test')",[manifestId,scope.principalUserId,row.session_id,m.canonicalId])
  await target.query('INSERT INTO public.session_archive_chunks(manifest_id,ordinal,object_key,first_event_id,last_event_id,event_count,raw_bytes,compressed_bytes,raw_sha256,compressed_sha256) VALUES($1,0,$2,$3,$3,1,$4,$5,$6,$7)',[manifestId,objectKey,m.canonicalId,z.rawBytes,z.compressedBytes,z.rawSha256,z.compressedSha256])
  const {enableSessionColdBodies}=await import(pathToFileURL(resolve('../relay/dist/session-lifecycle/cold-schema.js')).href)
  await enableSessionColdBodies(target)
  await target.query("UPDATE public.events SET payload=NULL,body_storage='cold',body_manifest_id=$2,body_chunk_ordinal=0,body_owner_user_id=$3,body_session_id=session_id,body_activity_epoch=0 WHERE id=$1",[m.canonicalId,manifestId,scope.principalUserId])
  m.state='unique-cold';m.originalIdentityManifest!.archiveVerified=true;m.originalIdentityManifestHash=digest(m.originalIdentityManifest)
  await expect(call([m],{beforeCommit:async()=>{throw Error('prepared_cold_ingress')}})).rejects.toThrow('prepared_cold_ingress')
  await writeFile(file,Buffer.from('corrupt'))
  await expect(call([m])).rejects.toThrow('archive_unavailable');await writeFile(file,bytes)
  await expect(call([m],{archive:undefined})).rejects.toThrow('archive_unconfigured')
 })
 test('binds existing UUIDs, keeps bodies/hash/provenance exact, uses actual version tuple and resumes idempotently',async()=>{
  const receipt=await call();expect(receipt).toMatchObject({changed:2,alreadyBound:0,sourceBodiesChanged:false,originalIdsPreserved:true,provenanceRewritten:false})
  const rows=(await target.query('SELECT source_event_id::text,origin,payload_hash,payload,source_provenance,source_version,source_sequence::text,canonical_key FROM memory.source_events ORDER BY source_event_id')).rows
  expect(rows.map(r=>r.source_event_id).sort()).toEqual(mappings.map(m=>m.sourceEventId).sort())
  for(const row of rows){expect(row.origin).toBe('feed');expect(row.payload).not.toBeNull();expect(row.source_version).toEqual(receipt.sourceVersion);expect(Object.values(row.source_version).every(v=>typeof v==='string')).toBe(true)}
  const unknown=rows.find(r=>r.source_event_id===mappings[1].sourceEventId)!
  expect(unknown.source_sequence).toBeNull();expect(unknown.source_provenance).toEqual({})
  expect(await call()).toMatchObject({changed:0,alreadyBound:2})
  expect((await source.query("SELECT encode(sha256(convert_to(jsonb_agg(to_jsonb(s) ORDER BY source_event_id)::text,'UTF8')),'hex') AS hash FROM public.source_events s")).rows[0].hash).toBe(originalHash)
 })
 test('the explicit CLI revalidates identity and resumes into an exclusive private metadata receipt',async()=>{
  const identity=async(db:pg.Client)=>(await db.query(`SELECT current_database() AS database,current_user AS role,d.oid::text AS "databaseOid",inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort" FROM pg_database d WHERE datname=current_database()`)).rows[0]
  const input={source:await identity(source),target:await identity(target),copy,scope,root,mappings},dir=await mkdtemp(join(tmpdir(),'pocketctl-original-binding-')),path=join(dir,'input.json'),output=join(dir,'receipt')
  const before={source:process.env.SHARED_FORWARD_SOURCE_URL,target:process.env.SHARED_FORWARD_TARGET_URL,directory:process.env.MEMORY_SHARED_ARCHIVE_DIRECTORY,namespace:process.env.MEMORY_SHARED_ARCHIVE_NAMESPACE},admin=new URL(url!);admin.username='postgres';admin.password='synthetic-only'
  await source.end();await target.end()
  process.env.SHARED_FORWARD_SOURCE_URL=sourceUrl;process.env.SHARED_FORWARD_TARGET_URL=admin.href
  process.env.MEMORY_SHARED_ARCHIVE_DIRECTORY=archiveDirectory;process.env.MEMORY_SHARED_ARCHIVE_NAMESPACE='original-binding-test'
  try{
   await writeFile(path,JSON.stringify(input),{mode:0o600})
   const {main}=await import('../../migrations/shared-forward/original-reference-binding-cli.js')
   expect(await main(['--input',path,'--output',output])).toBe(0)
   expect(JSON.parse(await readFile(join(output,'original-reference-binding.json'),'utf8'))).toMatchObject({changed:0,alreadyBound:2,provenanceRewritten:false})
   expect((await stat(output)).mode&0o777).toBe(0o700);expect((await stat(join(output,'original-reference-binding.json'))).mode&0o777).toBe(0o600)
   expect(await main(['--input',path,'--output',output])).toBe(2)
  }finally{
   for(const [key,value]of Object.entries({SHARED_FORWARD_SOURCE_URL:before.source,SHARED_FORWARD_TARGET_URL:before.target,MEMORY_SHARED_ARCHIVE_DIRECTORY:before.directory,MEMORY_SHARED_ARCHIVE_NAMESPACE:before.namespace}))if(value===undefined)delete process.env[key];else process.env[key]=value
   await rm(dir,{recursive:true,force:true})
  }
 })
 test('retirement refuses changed bytes and stale rows without removing any original body',async()=>{
  source=new pg.Client({connectionString:sourceUrl});await source.connect()
  const admin=new URL(url!);admin.username='postgres';admin.password='synthetic-only'
  target=new pg.Client({connectionString:admin.href});await target.connect()
  await target.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE WHERE singleton')
  const input={copy,scope,root,sourceEventIds:mappings.map(m=>m.sourceEventId)}
  await expect(prepareOriginalPayloadRetirement(source,target,{...input,sourceEventIds:[input.sourceEventIds[0],input.sourceEventIds[0]]},{archive})).rejects.toThrow('original_retirement_input_invalid')
  await target.query("UPDATE memory.source_events SET payload='{}' WHERE source_event_id=$1",[mappings[0].sourceEventId])
  try{await expect(prepareOriginalPayloadRetirement(source,target,input,{archive})).rejects.toThrow('original_retirement_body_not_equivalent')}finally{
   const body=(await source.query('SELECT payload::text AS body FROM public.source_events WHERE source_event_id=$1',[mappings[0].sourceEventId])).rows[0].body
   await target.query('UPDATE memory.source_events SET payload=$2::jsonb WHERE source_event_id=$1',[mappings[0].sourceEventId,body])
  }
  const page=await prepareOriginalPayloadRetirement(source,target,input,{archive})
  await expect(applyOriginalPayloadRetirement(source,target,page,{beforeCommit:async()=>{await target.query('UPDATE memory.source_events SET created_at=created_at WHERE source_event_id=$1',[mappings[1].sourceEventId])}})).rejects.toThrow('original_retirement_row_changed')
  expect((await target.query('SELECT count(*)::int AS n FROM memory.source_events WHERE payload IS NULL')).rows[0].n).toBe(0)
 })
 test('retirement requires current authority and verified cold bytes before deleting a page',async()=>{
  const input={copy,scope,root,sourceEventIds:mappings.map(m=>m.sourceEventId)},page=await prepareOriginalPayloadRetirement(source,target,input,{archive})
  await expect(applyOriginalPayloadRetirement(source,target,page,{beforeCommit:async()=>{await target.query("UPDATE public.extension_installations SET status='revoked' WHERE installation_id=$1",[scope.installationId])}})).rejects.toThrow('original_retirement_authority_changed')
  await target.query("UPDATE public.extension_installations SET status='active' WHERE installation_id=$1",[scope.installationId])
  const key=(await target.query('SELECT object_key FROM public.session_archive_chunks LIMIT 1')).rows[0].object_key,file=join(archiveDirectory!,key),bytes=await readFile(file)
  await writeFile(file,Buffer.from('corrupt'))
  try{await expect(prepareOriginalPayloadRetirement(source,target,input,{archive})).rejects.toThrow('archive_unavailable')}finally{await writeFile(file,bytes)}
  expect((await target.query('SELECT count(*)::int AS n FROM memory.source_events WHERE payload IS NULL')).rows[0].n).toBe(0)
 })
 test('retirement rejects an unproved Session, a live writer and a changed source mode generation',async()=>{
  const input=()=>({copy,scope,root,sourceEventIds:mappings.map(m=>m.sourceEventId)})
  await target.query("UPDATE memory.source_events SET mapping_state='unproven' WHERE source_event_id=$1",[mappings[0].sourceEventId])
  try{await expect(prepareOriginalPayloadRetirement(source,target,input(),{archive})).rejects.toThrow('original_retirement_session_unresolved')}finally{await target.query("UPDATE memory.source_events SET mapping_state='verified' WHERE source_event_id=$1",[mappings[0].sourceEventId])}
  await target.query('ALTER ROLE original_binding_memory LOGIN')
  try{await expect(prepareOriginalPayloadRetirement(source,target,input(),{archive})).rejects.toThrow('target_writers_not_fenced')}finally{await target.query('ALTER ROLE original_binding_memory NOLOGIN')}
  const page=await prepareOriginalPayloadRetirement(source,target,input(),{archive})
  const paused=(await target.query("SELECT shared.transition_memory_source_mode($1,$2::bigint,'paused')::text AS generation",[scope.installationId,scope.modeGeneration])).rows[0].generation
  await expect(applyOriginalPayloadRetirement(source,target,page)).rejects.toThrow('original_retirement_authority_changed')
  scope.modeGeneration=(await target.query("SELECT shared.transition_memory_source_mode($1,$2::bigint,'shared-shadow')::text AS generation",[scope.installationId,paused])).rows[0].generation
  expect((await target.query('SELECT count(*)::int AS n FROM memory.source_events WHERE payload IS NULL')).rows[0].n).toBe(0)
 })
 test('retires only proved duplicate payloads, keeps metadata and UUIDs, and resolves through the actual Memory reader',async()=>{
  const input={copy,scope,root,sourceEventIds:mappings.map(m=>m.sourceEventId)}
  const metadata=async()=>(await target.query("SELECT encode(sha256(convert_to(jsonb_agg(to_jsonb(s)-'payload' ORDER BY source_event_id)::text,'UTF8')),'hex') AS hash FROM memory.source_events s")).rows[0].hash
  const before=await metadata(),page=await prepareOriginalPayloadRetirement(source,target,input,{archive})
  expect(await applyOriginalPayloadRetirement(source,target,page)).toMatchObject({changed:2,alreadyRetired:0,originalIdsPreserved:true,provenanceRewritten:false,bodyReclaimedAtChanged:false})
  expect(await metadata()).toBe(before)
  expect((await target.query('SELECT count(*)::int AS n FROM memory.source_events WHERE payload IS NULL AND body_reclaimed_at IS NULL')).rows[0].n).toBe(2)
  const {bindSourcePool}=await import('../../sources/pool-context.js'),{prepareSourceReferences}=await import('../../sources/prepared-sources.js')
  bindSourcePool(target,{namespace:'memory',archive});await target.query('SET search_path=pg_catalog,memory,shared')
  const actual=await prepareSourceReferences(target as unknown as pg.Pool,scope.installationId,input.sourceEventIds)
  expect(actual.events.map(e=>e.source_event_id).sort()).toEqual(input.sourceEventIds.sort())
  for(const e of actual.events)expect(canonicalPayloadHash(e.payload).equals(e.payload_hash)).toBe(true)
  await target.query('BEGIN');try{await actual.assertCurrent(target,{forCommit:true});await target.query('COMMIT')}catch(e){await target.query('ROLLBACK');throw e}
  expect(await applyOriginalPayloadRetirement(source,target,await prepareOriginalPayloadRetirement(source,target,input,{archive}))).toMatchObject({changed:0,alreadyRetired:2})
  expect((await source.query("SELECT encode(sha256(convert_to(jsonb_agg(to_jsonb(s) ORDER BY source_event_id)::text,'UTF8')),'hex') AS hash FROM public.source_events s")).rows[0].hash).toBe(originalHash)
 })
})
