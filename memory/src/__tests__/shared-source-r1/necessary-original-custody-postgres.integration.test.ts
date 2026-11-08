import pg from 'pg'
import {randomUUID,createHash} from 'node:crypto'
import {mkdtemp,mkdir,writeFile,readFile,stat,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createSourceArchiveReader} from '../../sources/archive-reader.js'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {canonicalPayloadHash,createPostgresSharedSourceReader,encodeArchiveChunk,type SourceScope} from '@pocketctl/session-source'
import {directLaunchFixture} from './direct-launch-fixture.js'
import {retainNecessaryOriginalPersonalReferencePage,type NecessaryOriginalCustodyInput} from '../../migrations/shared-forward/necessary-original-custody.js'
import {hash} from '../../migrations/shared-forward/source-maintenance-common.js'
const url=process.env.NECESSARY_ORIGINAL_TEST_DATABASE_URL,sourceUrl=process.env.NECESSARY_ORIGINAL_SOURCE_TEST_DATABASE_URL,suite=url&&sourceUrl?describe:describe.skip
suite('necessary original Memory custody without a claimed canonical relation',()=>{
 let discovery:string,canonicalDiscovery:string,archiveDirectory:string,discoverySession:string
 let source:pg.Client,target:pg.Client,input:NecessaryOriginalCustodyInput,scope:SourceScope,unnecessary:string,episode:string,candidate:string,originalsHash:string,fromNowInput:Pick<NecessaryOriginalCustodyInput,'scope'|'root'>
 const payload={text:'original necessary private bytes'},digest=(v:unknown)=>canonicalPayloadHash(v).toString('hex')
 const call=(ids=input.sourceEventIds,options:Parameters<typeof retainNecessaryOriginalPersonalReferencePage>[3]={})=>retainNecessaryOriginalPersonalReferencePage(source,target,{...input,sourceEventIds:ids},options)
 beforeAll(async()=>{
  if(!url||!sourceUrl||new URL(url).pathname!=='/shared_necessary_original_test'||new URL(sourceUrl).pathname!=='/shared_necessary_original_source_test')throw Error('dedicated_original_binding_fixture_required')
  const admin=new URL(url);admin.username='postgres';admin.password='synthetic-only'
  const saved=process.env.DIRECT_LAUNCH_FIXTURE_ADMIN_DATABASE_URL;process.env.DIRECT_LAUNCH_FIXTURE_ADMIN_DATABASE_URL=admin.href
  let f:Awaited<ReturnType<typeof directLaunchFixture>>
  try{f=await directLaunchFixture(url,{necessaryOriginal:true})}finally{if(saved===undefined)delete process.env.DIRECT_LAUNCH_FIXTURE_ADMIN_DATABASE_URL;else process.env.DIRECT_LAUNCH_FIXTURE_ADMIN_DATABASE_URL=saved}
  try{
   const s=await f.source(),inst=(await f.install(s,'retained_history')).inst.installation_id
   await f.event(s) // Current Session authority exists, with no asserted event relation.
   scope={installationId:inst,principalUserId:String(s.owner),ownerScopeKind:'personal',ownerScopeId:inst,authorizationRevision:'1',configVersion:'1',modeGeneration:'2'}
   const fromNowSource=await f.source(),fromNowInstallation=(await f.install(fromNowSource,'from_now')).inst.installation_id
   await f.event(fromNowSource)
   fromNowInput={scope:{...scope,installationId:fromNowInstallation,ownerScopeId:fromNowInstallation,principalUserId:String(fromNowSource.owner)},root:{kind:'relay_event',key:f.root(fromNowSource)}}
   const necessary=randomUUID();unnecessary=randomUUID();episode=randomUUID();candidate=randomUUID();const run=randomUUID(),d=Buffer.alloc(32,8)
   for(const [id,pos]of[[necessary,'70'],[unnecessary,'71']])await f.pool.query("INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash,source_provenance,classification) VALUES($1,$2,'feed',$3,$4,'agent_text',date_trunc('milliseconds',NOW()),$5,$6,'{}','{}')",[id,inst,pos,s.session,payload,canonicalPayloadHash(payload)])
   discovery=randomUUID();discoverySession=s.session
   const first={event_id:'original-discovery-key',actor_scope:'assistant',state:'first'},later={...first,state:'later'}
   const ingress=createHash('md5').update(`${s.session}:session_discovered:event:original-discovery-key`).digest('hex').slice(0,16)
   canonicalDiscovery=(await f.publisher.query("INSERT INTO public.events(session_id,event_type,payload,event_hash,effect_status,user_id,created_at) VALUES($1,'session_discovered',$2,$3,'completed',$4,date_trunc('milliseconds',NOW())-interval '2 minutes') RETURNING id::text",[s.session,first,ingress,s.owner])).rows[0].id
   await f.pool.query("INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,canonical_event_key,session_id,event_type,occurred_at,payload,payload_hash,source_provenance,classification) VALUES($1,$2,'feed','72','event_id:original-discovery-key',$3,'session_discovered',date_trunc('milliseconds',NOW())-interval '1 minute',$4,$5,'{}','{\"actor_scope\":\"assistant\"}')",[discovery,inst,s.session,later,canonicalPayloadHash(later)])
   await f.pool.query("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,source_digest,evidence_manifest) VALUES($1,$2,$3,'accepted-turn','ready','fixture',$4,$5)",[inst,episode,s.session,d,{h:{kind:'event',source_event_id:necessary}}])
   await f.pool.query("INSERT INTO memory.memory_extraction_runs(run_id,installation_id,episode_id,episode_source_digest,extractor_version,prompt_version,model_config_hash,input_digest,mode,state,provider,model) VALUES($1,$2,$3,$4,'fixture','fixture',$4,$4,'enabled','succeeded','fixture','fixture')",[run,inst,episode,d])
   await f.pool.query("INSERT INTO memory.memory_candidates(candidate_id,installation_id,run_id,episode_id,ordinal,claim_type,statement,normalized_key,scope_kind,scope_key,confidence,freshness_at,evidence_handles,status) VALUES($1,$2,$3,$4,0,'work_method','accepted synthetic',$5,'installation','global',1,NOW(),'[\"h\"]','accepted')",[candidate,inst,run,episode,randomUUID()])
   source=new pg.Client({connectionString:sourceUrl});await source.connect()
   if(!(await source.query("SELECT to_regclass('public.source_events') IS NULL AS fresh")).rows[0].fresh)throw Error('fresh_original_source_required')
   let sourceColumns:string[]=[]
   for(const table of ['source_events','work_episodes','memory_candidates','source_artifacts','memory_feed_inbox']){
    const cols=(await f.pool.query("SELECT attname,format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum",['memory.'+table])).rows
    await source.query('CREATE TABLE public.'+table+'('+cols.map(c=>'"'+c.attname+'" '+c.type).join(',')+')')
    const rows=(await f.pool.query('SELECT row_to_json(s)::text AS json FROM memory.'+table+' s WHERE installation_id=$1',[inst])).rows
    for(const r of rows)await source.query('INSERT INTO public.'+table+' SELECT * FROM json_populate_record(NULL::public.'+table+',$1::json)',[r.json])
    if(table==='source_events')sourceColumns=cols.map(c=>c.attname)
   }
   const identity=async(db:Pick<pg.Client,'query'>)=>hash((await db.query(`SELECT current_database() AS database,current_user AS role,inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort",d.oid::text AS oid FROM pg_database d WHERE datname=current_database()`)).rows[0])
   input={scope,root:{kind:'relay_event',key:f.root(s)},sourceEventIds:[necessary],copy:{schemaVersion:1,kind:'memory-forward-verification',verified:true,manifestHash:'a'.repeat(64),migrationId:randomUUID(),sourceIdentity:await identity(source),targetIdentity:await identity(f.pool),sourceEvents:{sourceColumns,rows:'3',hash:'b'.repeat(64)}}}
   await f.pool.query('CREATE TABLE shared.memory_forward_runs(migration_id uuid PRIMARY KEY,manifest_hash text);CREATE TABLE shared.memory_forward_tables(migration_id uuid,table_name text,row_count text,row_hash text)')
   await f.pool.query('INSERT INTO shared.memory_forward_runs VALUES($1,$2)',[input.copy.migrationId,input.copy.manifestHash]);await f.pool.query("INSERT INTO shared.memory_forward_tables VALUES($1,'source_events','3',$2)",[input.copy.migrationId,input.copy.sourceEvents.hash])
   await f.pool.query('ALTER ROLE necessary_original_memory NOLOGIN;ALTER ROLE necessary_original_relay NOLOGIN;ALTER ROLE shared_necessary_original_test NOLOGIN')
   await source.query('REVOKE CONNECT ON DATABASE shared_necessary_original_source_test FROM PUBLIC')
   originalsHash=(await source.query("SELECT encode(sha256(convert_to(jsonb_agg(to_jsonb(s) ORDER BY source_event_id)::text,'UTF8')),'hex') AS hash FROM public.source_events s")).rows[0].hash
  }finally{await f.close()}
  target=new pg.Client({connectionString:admin.href});await target.connect()
 },60000)
 afterAll(async()=>{await source?.end();await target?.end();if(archiveDirectory)await rm(archiveDirectory,{recursive:true,force:true})})
 test('requires a current literal accepted dependency rather than body equality or UUID-looking prose',async()=>{
  await expect(call([unnecessary])).rejects.toThrow('necessary_original_dependency_unproven')
  await expect(call([...input.sourceEventIds,unnecessary])).rejects.toThrow('necessary_original_dependency_unproven')
  for(const manifest of [{prose:'source_event_id '+input.sourceEventIds[0]},{wrapper:{nested:{source_event_id:input.sourceEventIds[0]}}}]){
   for(const [db,schema]of[[source,'public'],[target,'memory']]as const)await db.query('UPDATE '+schema+'.work_episodes SET evidence_manifest=$2 WHERE episode_id=$1',[episode,manifest])
   await expect(call()).rejects.toThrow('necessary_original_dependency_unproven')
  }
  for(const [db,schema]of[[source,'public'],[target,'memory']]as const)await db.query('UPDATE '+schema+'.work_episodes SET evidence_manifest=$2 WHERE episode_id=$1',[episode,{h:{kind:'event',source_event_id:input.sourceEventIds[0]}}])
  await expect(call(input.sourceEventIds,{beforeCommit:async()=>{throw Error('prepared_necessary_original')}})).rejects.toThrow('prepared_necessary_original')
 })
 test('does not turn existing transport, invalid copy or cancellation into an original custody grant',async()=>{
  await source.query('INSERT INTO public.memory_feed_inbox(installation_id,feed_id) VALUES($1,70)',[scope.installationId])
  try{await expect(call()).rejects.toThrow('necessary_original_transport_still_present')}finally{await source.query('DELETE FROM public.memory_feed_inbox')}
  await expect(retainNecessaryOriginalPersonalReferencePage(source,target,{...input,copy:{...input.copy,verified:false}})).rejects.toThrow('original_binding_input_invalid')
  const controller=new AbortController();controller.abort();await expect(call(input.sourceEventIds,{signal:controller.signal})).rejects.toThrow('necessary_original_aborted')
 })
 test('rejects changed copied bytes and changed accepted metadata before any custody mutation',async()=>{
  await target.query("UPDATE memory.source_events SET payload='{}' WHERE source_event_id=$1",input.sourceEventIds)
  try{await expect(call()).rejects.toThrow('necessary_original_copy_changed')}finally{await target.query('UPDATE memory.source_events SET payload=$2 WHERE source_event_id=$1',[input.sourceEventIds[0],payload])}
  await target.query("UPDATE memory.work_episodes SET evidence_manifest='{}' WHERE episode_id=$1",[episode])
  try{await expect(call()).rejects.toThrow('necessary_original_dependency_unproven')}finally{await target.query('UPDATE memory.work_episodes SET evidence_manifest=$2 WHERE episode_id=$1',[episode,{h:{kind:'event',source_event_id:input.sourceEventIds[0]}}])}
 })
 test('current revocation and row CAS protect the full page after preparation',async()=>{
  await expect(call(input.sourceEventIds,{beforeCommit:async()=>{await target.query("UPDATE public.extension_installations SET status='revoked' WHERE installation_id=$1",[scope.installationId])}})).rejects.toThrow('necessary_original_authority_changed')
  await target.query("UPDATE public.extension_installations SET status='active' WHERE installation_id=$1",[scope.installationId])
  await expect(call(input.sourceEventIds,{beforeCommit:async()=>{await target.query('UPDATE memory.source_events SET created_at=created_at WHERE source_event_id=$1',input.sourceEventIds)}})).rejects.toThrow('necessary_original_row_changed')
  expect((await target.query("SELECT count(*)::int AS n FROM memory.source_events WHERE mapping_state='verified'")).rows[0].n).toBe(0)
 })
 test('rechecks the current accepted dependency after preparation inside the commit fence',async()=>{
  await expect(call(input.sourceEventIds,{beforeCommit:async()=>{await target.query("UPDATE memory.memory_candidates SET status='rejected' WHERE candidate_id=$1",[candidate])}})).rejects.toThrow('necessary_original_dependency_changed')
  await target.query("UPDATE memory.memory_candidates SET status='accepted' WHERE candidate_id=$1",[candidate])
  expect((await target.query("SELECT count(*)::int AS n FROM memory.source_events WHERE mapping_state='verified'")).rows[0].n).toBe(0)
 })
 test('retains the original necessary UUID/body under explicit legacy custody without claiming Relay equivalence',async()=>{
  const result=await call();expect(result).toMatchObject({changed:1,alreadyBound:0,canonicalIdentityResolved:false,canonicalAbsenceProven:false,sourceBodiesChanged:false,deletionAuthorized:false})
  const row=(await target.query('SELECT source_event_id::text,canonical_key,source_kind,source_provenance,source_sequence,payload FROM memory.source_events WHERE source_event_id=$1',input.sourceEventIds)).rows[0]
  expect(row).toMatchObject({source_event_id:input.sourceEventIds[0],canonical_key:input.sourceEventIds[0],source_kind:'legacy_archive',source_provenance:{},source_sequence:null,payload})
  const reader=createPostgresSharedSourceReader({query:(sql,args)=>target.query(sql,args),async connect(){throw Error('no_external_io')}}),root={kind:'legacy_archive' as const,key:input.root.key}
  const heads=await reader.getHeads(scope,root,input.sourceEventIds),bodies=await reader.resolveBodies(scope,root,heads.heads,heads.version)
  expect(bodies[0].payload).toEqual(payload);expect(bodies[0].head.provenance.state).toBe('unknown')
  expect(await call()).toMatchObject({changed:0,alreadyBound:1})
  expect(JSON.stringify(result)).not.toContain(payload.text)
  expect((await source.query("SELECT encode(sha256(convert_to(jsonb_agg(to_jsonb(s) ORDER BY source_event_id)::text,'UTF8')),'hex') AS hash FROM public.source_events s")).rows[0].hash).toBe(originalsHash)
  expect(digest(row.payload)).toBe(digest(payload))
 })
 test('accepted Session closure still refuses transport, stable keys and from-now admission',async()=>{
  const sessionInput={...input,necessity:'accepted-session' as const,sourceEventIds:[unnecessary]}
  await source.query('INSERT INTO public.memory_feed_inbox(installation_id,feed_id) VALUES($1,71)',[scope.installationId])
  try{await expect(retainNecessaryOriginalPersonalReferencePage(source,target,sessionInput)).rejects.toThrow('necessary_original_transport_still_present')}finally{await source.query('DELETE FROM public.memory_feed_inbox')}
  for(const[db,schema]of[[source,'public'],[target,'memory']]as const)await db.query("UPDATE "+schema+".source_events SET canonical_event_key='event_id:original-key' WHERE source_event_id=$1",[unnecessary])
  try{await expect(retainNecessaryOriginalPersonalReferencePage(source,target,sessionInput)).rejects.toThrow('necessary_original_copy_changed')}finally{for(const[db,schema]of[[source,'public'],[target,'memory']]as const)await db.query('UPDATE '+schema+'.source_events SET canonical_event_key=NULL WHERE source_event_id=$1',[unnecessary])}
  await expect(retainNecessaryOriginalPersonalReferencePage(source,target,{...sessionInput,...fromNowInput})).rejects.toThrow('necessary_original_session_policy_unproven')
 })
 test('explicit accepted Session closure retains an unreferenced original cell without inventing a canonical identity',async()=>{
  const sessionInput={...input,necessity:'accepted-session' as const,sourceEventIds:[unnecessary]}
  await expect(retainNecessaryOriginalPersonalReferencePage(source,target,{...sessionInput,necessity:'guessed' as never})).rejects.toThrow('necessary_original_input_invalid')
  await expect(retainNecessaryOriginalPersonalReferencePage(source,target,sessionInput,{beforeCommit:async()=>{throw Error('prepared_session_custody')}})).rejects.toThrow('prepared_session_custody')
  await expect(retainNecessaryOriginalPersonalReferencePage(source,target,sessionInput,{beforeCommit:async()=>{await target.query("UPDATE memory.memory_candidates SET status='rejected' WHERE candidate_id=$1",[candidate])}})).rejects.toThrow('necessary_original_dependency_changed')
  await target.query("UPDATE memory.memory_candidates SET status='accepted' WHERE candidate_id=$1",[candidate])
  const result=await retainNecessaryOriginalPersonalReferencePage(source,target,sessionInput)
  expect(result).toMatchObject({changed:1,alreadyBound:0,necessity:'accepted-session',canonicalIdentityResolved:false,canonicalAbsenceProven:false,sourceBodiesChanged:false,deletionAuthorized:false})
  expect(result.manifests[0]).toMatchObject({necessity:'accepted-session',provenanceState:'unknown',sourceSequence:null})
  expect(await retainNecessaryOriginalPersonalReferencePage(source,target,sessionInput)).toMatchObject({changed:0,alreadyBound:1,necessity:'accepted-session'})
  expect((await target.query('SELECT payload,source_provenance,source_sequence,canonical_key FROM memory.source_events WHERE source_event_id=$1',[unnecessary])).rows[0]).toEqual({payload,source_provenance:{},source_sequence:null,canonical_key:unnecessary})
  await target.query("UPDATE memory.memory_candidates SET status='rejected' WHERE candidate_id=$1",[candidate])
  try{await expect(retainNecessaryOriginalPersonalReferencePage(source,target,sessionInput)).rejects.toThrow('necessary_original_dependency_unproven')}finally{await target.query("UPDATE memory.memory_candidates SET status='accepted' WHERE candidate_id=$1",[candidate])}
 })
 test('requires a separately witnessed later discovery observation and rejects current witness drift',async()=>{
  const ordinary={...input,necessity:'accepted-session' as const,sourceEventIds:[discovery]},observed={...ordinary,discoveryWitness:{canonicalKey:canonicalDiscovery}}
  await expect(retainNecessaryOriginalPersonalReferencePage(source,target,ordinary)).rejects.toThrow('necessary_original_copy_changed')
  await expect(retainNecessaryOriginalPersonalReferencePage(source,target,{...observed,necessity:'literal-reference'})).rejects.toThrow('necessary_original_input_invalid')
  await expect(retainNecessaryOriginalPersonalReferencePage(source,target,{...observed,discoveryWitness:{canonicalKey:'9223372036854775808'}})).rejects.toThrow('necessary_original_input_invalid')
  await expect(retainNecessaryOriginalPersonalReferencePage(source,target,observed,{beforeCommit:async()=>{throw Error('prepared_discovery_observation')}})).rejects.toThrow('prepared_discovery_observation')
  const e=(await target.query('SELECT payload,created_at,event_hash FROM public.events WHERE id=$1',[canonicalDiscovery])).rows[0]
  await target.query("UPDATE public.events SET created_at=NOW() WHERE id=$1",[canonicalDiscovery])
  try{await expect(retainNecessaryOriginalPersonalReferencePage(source,target,observed)).rejects.toThrow('necessary_original_discovery_unproven')}finally{await target.query('UPDATE public.events SET created_at=$2 WHERE id=$1',[canonicalDiscovery,e.created_at])}
  await target.query("UPDATE public.events SET payload=jsonb_set(payload,'{state}','\"later\"') WHERE id=$1",[canonicalDiscovery])
  try{await expect(retainNecessaryOriginalPersonalReferencePage(source,target,observed)).rejects.toThrow('necessary_original_discovery_unproven')}finally{await target.query('UPDATE public.events SET payload=$2 WHERE id=$1',[canonicalDiscovery,e.payload])}
  await expect(retainNecessaryOriginalPersonalReferencePage(source,target,observed,{beforeCommit:async()=>{await target.query("UPDATE public.events SET event_hash='changed' WHERE id=$1",[canonicalDiscovery])}})).rejects.toThrow('necessary_original_discovery_changed')
  await target.query('UPDATE public.events SET event_hash=$2 WHERE id=$1',[canonicalDiscovery,e.event_hash])
  expect((await target.query('SELECT mapping_state FROM memory.source_events WHERE source_event_id=$1',[discovery])).rows[0].mapping_state).toBe('unproven')
 })
 test('checks each surviving discovery transport and fences changes after preparation',async()=>{
  const observed={...input,necessity:'accepted-session' as const,sourceEventIds:[discovery],discoveryWitness:{canonicalKey:canonicalDiscovery}}
  const original=(await source.query('SELECT payload,classification,occurred_at FROM public.source_events WHERE source_event_id=$1',[discovery])).rows[0]
  const envelope={envelope_version:1,feed_id:'72',topic:'session.lifecycle.v1',source:{kind:'canonical_event',id:'event:'+canonicalDiscovery,recorded_at:new Date(original.occurred_at).toISOString()},subject:{session_id:discoverySession,event_type:'session_discovered'},classification:original.classification,data:original.payload}
  await source.query("INSERT INTO public.memory_feed_inbox(installation_id,feed_id,envelope_version,topic,source_kind,source_id,session_id,turn_id,event_type,recorded_at,payload_hash,body_reclaimed_at,classification,data) VALUES($1,72,1,$2,'canonical_event',$3,$4,NULL,'session_discovered',$5,$6,NULL,$7,$8)",[scope.installationId,envelope.topic,envelope.source.id,discoverySession,envelope.source.recorded_at,canonicalPayloadHash(envelope),original.classification,original.payload])
  const {feed_id,...stored}=envelope
  await target.query("INSERT INTO public.extension_feed(feed_id,owner_user_id,topic,source_kind,source_id,session_id,turn_id,envelope_version,payload) VALUES(72,$1,$2,'canonical_event',$3,$4,NULL,1,$5)",[scope.principalUserId,envelope.topic,envelope.source.id,discoverySession,stored])
  try{
   await expect(retainNecessaryOriginalPersonalReferencePage(source,target,observed,{beforeCommit:async()=>{throw Error('prepared_surviving_transport')}})).rejects.toThrow('prepared_surviving_transport')
   await source.query("UPDATE public.memory_feed_inbox SET payload_hash=decode(repeat('f',64),'hex') WHERE feed_id=72")
   await expect(retainNecessaryOriginalPersonalReferencePage(source,target,observed)).rejects.toThrow('necessary_original_discovery_unproven')
   await source.query('UPDATE public.memory_feed_inbox SET payload_hash=$1 WHERE feed_id=72',[canonicalPayloadHash(envelope)])
   await target.query("UPDATE public.extension_feed SET payload=jsonb_set(payload,'{data}','{}') WHERE feed_id=72")
   await expect(retainNecessaryOriginalPersonalReferencePage(source,target,observed)).rejects.toThrow('necessary_original_discovery_unproven')
   await target.query('UPDATE public.extension_feed SET payload=$1 WHERE feed_id=72',[stored])
   await expect(retainNecessaryOriginalPersonalReferencePage(source,target,observed,{beforeCommit:async()=>{await target.query('UPDATE public.extension_feed SET payload=payload WHERE feed_id=72')}})).rejects.toThrow('necessary_original_discovery_changed')
  }finally{await source.query('DELETE FROM public.memory_feed_inbox WHERE feed_id=72');await target.query('DELETE FROM public.extension_feed WHERE feed_id=72')}
 })
 test('validates the actual cold discovery witness, refuses corrupt bytes, and preserves the distinct original UUID',async()=>{
  const observed={...input,necessity:'accepted-session' as const,sourceEventIds:[discovery],discoveryWitness:{canonicalKey:canonicalDiscovery}}
  const original=(await source.query('SELECT payload FROM public.source_events WHERE source_event_id=$1',[discovery])).rows[0].payload
  const first=(await target.query('SELECT payload FROM public.events WHERE id=$1',[canonicalDiscovery])).rows[0].payload
  const manifestId=randomUUID(),binding={userId:Number(scope.principalUserId),sessionId:discoverySession,activityEpoch:'0',manifestId,ordinal:0}
  const {bytes,manifest:z}=await encodeArchiveChunk(binding,[{id:canonicalDiscovery,eventType:'session_discovered',payload:first}],{maxRawBytes:1048576,maxCompressedBytes:1048576,maxRecords:100})
  archiveDirectory=await mkdtemp(join(tmpdir(),'necessary-original-cold-'))
  const objectKey=`session-archive/v1/${manifestId}/0.gz`,file=join(archiveDirectory,objectKey)
  await mkdir(join(archiveDirectory,'session-archive/v1',manifestId),{recursive:true});await writeFile(file,bytes)
  const archive={storage:createSourceArchiveReader(archiveDirectory,'necessary-original-test'),limits:{maxRawBytes:1048576,maxCompressedBytes:1048576,maxRecords:100}}
  await target.query("INSERT INTO public.session_archive_manifests(manifest_id,user_id,session_id,activity_epoch,schema_version,codec,state,event_high_water,published_at,storage_namespace) VALUES($1,$2,$3,0,1,'gzip','published',$4,NOW(),'necessary-original-test')",[manifestId,scope.principalUserId,discoverySession,canonicalDiscovery])
  await target.query('INSERT INTO public.session_archive_chunks(manifest_id,ordinal,object_key,first_event_id,last_event_id,event_count,raw_bytes,compressed_bytes,raw_sha256,compressed_sha256) VALUES($1,0,$2,$3,$3,1,$4,$5,$6,$7)',[manifestId,objectKey,canonicalDiscovery,z.rawBytes,z.compressedBytes,z.rawSha256,z.compressedSha256])
  const {enableSessionColdBodies}=await import(pathToFileURL(resolve('../relay/dist/session-lifecycle/cold-schema.js')).href)
  await enableSessionColdBodies(target)
  await target.query("UPDATE public.events SET payload=NULL,body_storage='cold',body_manifest_id=$2,body_chunk_ordinal=0,body_owner_user_id=$3,body_session_id=session_id,body_activity_epoch=0 WHERE id=$1",[canonicalDiscovery,manifestId,scope.principalUserId])
  await expect(retainNecessaryOriginalPersonalReferencePage(source,target,observed)).rejects.toThrow('archive_unconfigured')
  await writeFile(file,Buffer.from('corrupt'))
  await expect(retainNecessaryOriginalPersonalReferencePage(source,target,observed,{archive})).rejects.toThrow('archive_unavailable');await writeFile(file,bytes)
  const result=await retainNecessaryOriginalPersonalReferencePage(source,target,observed,{archive})
  expect(result).toMatchObject({changed:1,canonicalIdentityResolved:false,canonicalAbsenceProven:false,sourceBodiesChanged:false})
  expect(result.manifests[0]).toMatchObject({discoveryObservation:{kind:'original-session-discovery-observation',canonicalKey:canonicalDiscovery,canonicalStorage:'cold',canonicalWitnessIsReplacement:false}})
  expect((await target.query('SELECT source_event_id::text,canonical_key,payload,source_provenance,source_sequence FROM memory.source_events WHERE source_event_id=$1',[discovery])).rows[0]).toEqual({source_event_id:discovery,canonical_key:discovery,payload:original,source_provenance:{},source_sequence:null})
  expect(await retainNecessaryOriginalPersonalReferencePage(source,target,observed,{archive})).toMatchObject({changed:0,alreadyBound:1})
  expect(JSON.stringify(result)).not.toContain('"state":"later"')
  expect((await source.query("SELECT encode(sha256(convert_to(jsonb_agg(to_jsonb(s) ORDER BY source_event_id)::text,'UTF8')),'hex') AS hash FROM public.source_events s")).rows[0].hash).toBe(originalsHash)
 })
 test('the explicit CLI resumes only into a new private metadata receipt',async()=>{
  const identity=async(db:pg.Client)=>(await db.query(`SELECT current_database() AS database,current_user AS role,d.oid::text AS "databaseOid",inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort" FROM pg_database d WHERE datname=current_database()`)).rows[0]
  const config={...input,source:await identity(source),target:await identity(target)},dir=await mkdtemp(join(tmpdir(),'necessary-original-cli-')),path=join(dir,'input.json'),output=join(dir,'receipt')
  const before={source:process.env.SHARED_FORWARD_SOURCE_URL,target:process.env.SHARED_FORWARD_TARGET_URL},admin=new URL(url!);admin.username='postgres';admin.password='synthetic-only'
  await source.end();await target.end();process.env.SHARED_FORWARD_SOURCE_URL=sourceUrl;process.env.SHARED_FORWARD_TARGET_URL=admin.href
  try{
   await writeFile(path,JSON.stringify(config),{mode:0o600})
   const {main}=await import('../../migrations/shared-forward/necessary-original-custody-cli.js')
   expect(await main(['--input',path,'--output',output])).toBe(0)
   expect(JSON.parse(await readFile(join(output,'necessary-original-custody.json'),'utf8'))).toMatchObject({changed:0,alreadyBound:1,canonicalIdentityResolved:false})
   expect((await stat(output)).mode&0o777).toBe(0o700);expect((await stat(join(output,'necessary-original-custody.json'))).mode&0o777).toBe(0o600)
   expect(await main(['--input',path,'--output',output])).toBe(2)
  }finally{
   for(const [key,value]of Object.entries({SHARED_FORWARD_SOURCE_URL:before.source,SHARED_FORWARD_TARGET_URL:before.target}))if(value===undefined)delete process.env[key];else process.env[key]=value
   await rm(dir,{recursive:true,force:true})
  }
 })
})
