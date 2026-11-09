import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {canonicalPayloadHash} from '@pocketctl/session-source'
import {directLaunchFixture} from './direct-launch-fixture.js'
import {createMemoryPool} from '../../db.js'
import {createSharedSourceScheduler} from '../../sources/shared-scheduler.js'
import {createNativeInstallationDiscovery} from '../../installations/native-discovery.js'
import {createJobRepository} from '../../jobs/repository.js'
import {createJobWorker} from '../../jobs/worker.js'
import {createCanonicalProjectionHandler} from '../../sources/canonical-projection-worker.js'
import {prepareSourceReferences} from '../../sources/prepared-sources.js'
import {retainNecessaryOriginalPersonalReferencePage,type NecessaryOriginalCustodyInput} from '../../migrations/shared-forward/necessary-original-custody.js'
import {hash} from '../../migrations/shared-forward/source-maintenance-common.js'
import {readSourceProcessingCustodyDependency} from '../../migrations/shared-forward/source-processing-custody.js'
const url=process.env.NECESSARY_ORIGINAL_TEST_DATABASE_URL,sourceUrl=process.env.NECESSARY_ORIGINAL_SOURCE_TEST_DATABASE_URL,suite=url&&sourceUrl?describe:describe.skip
suite('finite source-processing necessity preserves original unknown custody',()=>{
 let source:pg.Client,target:pg.Client,input:NecessaryOriginalCustodyInput,jobId:string,runtimeUrl:string,nativeId:string
 const payload={text:'retained unknown original, deliberately distinct from the native event'},rowId=randomUUID()
 const call=(value=input,options:Parameters<typeof retainNecessaryOriginalPersonalReferencePage>[3]={})=>retainNecessaryOriginalPersonalReferencePage(source,target,value,options)
 async function runtimeWork(expectMappingFailure:boolean){
  await target.query('ALTER ROLE necessary_original_memory LOGIN')
  const runtime=createMemoryPool({databaseUrl:runtimeUrl,databaseNamespace:'memory',dbPoolMax:2}),errors:unknown[]=[],q=createJobWorker({pool:runtime,jobs:createJobRepository(runtime),workerId:'source-custody-fixture',signal:new AbortController().signal,claimLimit:1,onError:e=>errors.push(e)})
  q.register('project_shared_source',createCanonicalProjectionHandler(runtime,{pageSize:64,stabilizationMs:0}),{branch:'canonical'})
  try{
   for(let n=0;n<120;n++){
    await q.tick()
    if(expectMappingFailure&&errors.length){expect((errors[0] as Error).message).toBe('canonical_reference_mapping_required');return}
    if(!expectMappingFailure){if(errors.length)throw errors[0];const refs=(await runtime.query("SELECT source_event_id::text FROM source_events WHERE installation_id=$1 AND origin='canonical' AND canonical_key=$2",[input.scope.installationId,nativeId])).rows
     if(refs.length){const prepared=await prepareSourceReferences(runtime,input.scope.installationId,refs.map(r=>r.source_event_id));expect(prepared.events[0].payload.text).toBe('bounded direct launch synthetic body');return}}
    await new Promise(r=>setTimeout(r,25))
   }
   throw Error('source_custody_actual_worker_not_observed')
  }finally{await q.stop();await runtime.end();await target.query('ALTER ROLE necessary_original_memory NOLOGIN')}
 }
 beforeAll(async()=>{
  if(!url||!sourceUrl||new URL(url).pathname!=='/shared_necessary_original_test'||new URL(sourceUrl).pathname!=='/shared_necessary_original_source_test')throw Error('dedicated_original_binding_fixture_required')
  const admin=new URL(url);admin.username='postgres';admin.password='synthetic-only'
  const saved=process.env.DIRECT_LAUNCH_FIXTURE_ADMIN_DATABASE_URL;process.env.DIRECT_LAUNCH_FIXTURE_ADMIN_DATABASE_URL=admin.href
  let f:Awaited<ReturnType<typeof directLaunchFixture>>
  try{f=await directLaunchFixture(url,{necessaryOriginal:true})}finally{if(saved===undefined)delete process.env.DIRECT_LAUNCH_FIXTURE_ADMIN_DATABASE_URL;else process.env.DIRECT_LAUNCH_FIXTURE_ADMIN_DATABASE_URL=saved}
  try{
   await(await import(pathToFileURL(resolve('../relay/dist/shared-source/control-capture.js')).href)).applyRelayControlCapture(f.pool)
   const{provisionSharedDatabase}=await import('../../migrations/shared-db/namespace.js')
   await provisionSharedDatabase(f.pool,{memoryRole:'necessary_original_memory',relayRole:'necessary_original_relay',migratorRole:'necessary_original_definer'})
   const s=await f.source(),inst=(await f.install(s,'retained_history')).inst.installation_id
   nativeId=await f.event(s)
   await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
   await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[inst])
   await f.pool.query("INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash,source_provenance,classification) VALUES($1,$2,'feed','700000',$3,'agent_text',date_trunc('milliseconds',NOW()),$4,$5,'{}','{}')",[rowId,inst,s.session,payload,canonicalPayloadHash(payload)])
   const signal=new AbortController().signal,d=createNativeInstallationDiscovery({pool:f.runtime,signal});await d.discoverOnce()
   const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'source-custody-distribution',signal,pageSize:128,refreshInstallations:()=>d.discoverOnce()})
   let job:any
   try{for(let n=0;n<80;n++){await scheduler.runOnce();job=(await f.pool.query("SELECT job_id::text,payload FROM memory.memory_jobs WHERE job_type='project_shared_source' AND installation_id=$1 ORDER BY created_at DESC LIMIT 1",[inst])).rows[0];if(job)break}}finally{await scheduler.stop();await d.stop()}
   if(!job)throw Error('trusted_source_processing_dependency_required');jobId=job.job_id
   source=new pg.Client({connectionString:sourceUrl});await source.connect();let columns:string[]=[]
   for(const table of ['source_events','work_episodes','memory_candidates','source_artifacts','memory_feed_inbox']){
    const cols=(await f.pool.query("SELECT attname,format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum",['memory.'+table])).rows
    await source.query('CREATE TABLE public.'+table+'('+cols.map(c=>'"'+c.attname+'" '+c.type).join(',')+')')
    for(const row of(await f.pool.query('SELECT row_to_json(s)::text AS json FROM memory.'+table+' s WHERE installation_id=$1',[inst])).rows)await source.query('INSERT INTO public.'+table+' SELECT * FROM json_populate_record(NULL::public.'+table+',$1::json)',[row.json])
    if(table==='source_events')columns=cols.map(c=>c.attname)
   }
   const identity=async(db:Pick<pg.Client,'query'>)=>hash((await db.query('SELECT current_database() AS database,current_user AS role,inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort",d.oid::text AS oid FROM pg_database d WHERE datname=current_database()')).rows[0])
   input={scope:job.payload.scope,root:job.payload.root,sourceEventIds:[rowId],necessity:'source-processing',sourceProcessingWitness:{jobId,scanId:job.payload.distribution_scan,targetCursor:job.payload.target_cursor},copy:{schemaVersion:1,kind:'memory-forward-verification',verified:true,manifestHash:'c'.repeat(64),migrationId:randomUUID(),sourceIdentity:await identity(source),targetIdentity:await identity(f.pool),sourceEvents:{sourceColumns:columns,rows:'1',hash:'d'.repeat(64)}}} as never
   await f.pool.query('CREATE TABLE shared.memory_forward_runs(migration_id uuid PRIMARY KEY,manifest_hash text);CREATE TABLE shared.memory_forward_tables(migration_id uuid,table_name text,row_count text,row_hash text)')
   await f.pool.query('INSERT INTO shared.memory_forward_runs VALUES($1,$2)',[input.copy.migrationId,input.copy.manifestHash]);await f.pool.query("INSERT INTO shared.memory_forward_tables VALUES($1,'source_events','1',$2)",[input.copy.migrationId,input.copy.sourceEvents.hash])
   const ru=new URL(url);ru.username='necessary_original_memory';ru.password='synthetic-only';runtimeUrl=ru.href
   await f.pool.query('ALTER ROLE necessary_original_memory NOLOGIN;ALTER ROLE necessary_original_relay NOLOGIN;ALTER ROLE shared_necessary_original_test NOLOGIN')
   await source.query('REVOKE CONNECT ON DATABASE shared_necessary_original_source_test FROM PUBLIC')
  }finally{await f.close()}
  target=new pg.Client({connectionString:admin.href});await target.connect()
 },60000)
 afterAll(async()=>{await source?.end();await target?.end()})
 test('the actual original canonical worker still refuses an unproven Session before custody',async()=>{await runtimeWork(true)})
 test('source necessity requires a real matching native task and sealed context',async()=>{
  const current=input as any
  await expect(call({...input,sourceProcessingWitness:{...current.sourceProcessingWitness,jobId:randomUUID()}} as never)).rejects.toThrow('necessary_original_dependency_unproven')
  await expect(call({...input,sourceProcessingWitness:{...current.sourceProcessingWitness,scanId:randomUUID()}} as never)).rejects.toThrow('necessary_original_dependency_unproven')
  await expect(call({...input,sourceProcessingWitness:{...current.sourceProcessingWitness,targetCursor:'untrusted'}} as never)).rejects.toThrow('necessary_original_dependency_unproven')
 })
 test('necessity rejects a different owner and current control or mode generation changes',async()=>{
  const dependency=(scope=input.scope)=>readSourceProcessingCustodyDependency(target,{scope,root:input.root,sessionId:input.root.key.slice(input.scope.principalUserId.length+1),sourceEventId:rowId,witness:input.sourceProcessingWitness!})
  expect(await dependency()).toHaveLength(1)
  expect(await dependency({...input.scope,principalUserId:String(Number(input.scope.principalUserId)+1)})).toEqual([])
  for(const sql of ['UPDATE shared.memory_source_control_clock SET revision=revision+1','UPDATE shared.memory_source_modes SET generation=generation+1']){
   await target.query('BEGIN')
   try{await target.query(sql);expect(await dependency()).toEqual([])}finally{await target.query('ROLLBACK')}
  }
  expect(await dependency()).toHaveLength(1)
 })
 test('source necessity retains the original copy and no-transport requirements',async()=>{
  await target.query("UPDATE memory.source_events SET payload='{}' WHERE source_event_id=$1",[rowId])
  try{await expect(call()).rejects.toThrow('necessary_original_copy_changed')}finally{await target.query('UPDATE memory.source_events SET payload=$2 WHERE source_event_id=$1',[rowId,payload])}
  await source.query('INSERT INTO public.memory_feed_inbox(installation_id,feed_id) VALUES($1,700000)',[input.scope.installationId])
  try{await expect(call()).rejects.toThrow('necessary_original_transport_still_present')}finally{await source.query('DELETE FROM public.memory_feed_inbox WHERE installation_id=$1 AND feed_id=700000',[input.scope.installationId])}
  expect((await target.query('SELECT mapping_state FROM memory.source_events WHERE source_event_id=$1',[rowId])).rows[0].mapping_state).toBe('unproven')
 })
 test('preparation rechecks its native task inside the original commit fence',async()=>{
  const old=(await target.query('SELECT payload FROM memory.memory_jobs WHERE job_id=$1',[jobId])).rows[0].payload
  await expect(call(input,{beforeCommit:async()=>{await target.query("UPDATE memory.memory_jobs SET payload=jsonb_set(payload,'{target_cursor}','\"changed\"') WHERE job_id=$1",[jobId])}})).rejects.toThrow('necessary_original_dependency_changed')
  await target.query('UPDATE memory.memory_jobs SET payload=$2 WHERE job_id=$1',[jobId,old])
  expect((await target.query('SELECT mapping_state FROM memory.source_events WHERE source_event_id=$1',[rowId])).rows[0].mapping_state).toBe('unproven')
 })
 test('custody preserves the exact original cell and unknown provenance without a human-accepted candidate',async()=>{
  expect((await target.query('SELECT count(*)::int AS n FROM memory.memory_candidates')).rows[0].n).toBe(0)
  const result=await call();expect(result).toMatchObject({changed:1,necessity:'source-processing',canonicalIdentityResolved:false,canonicalAbsenceProven:false,sourceBodiesChanged:false,originalIdsPreserved:true,provenanceRewritten:false,deletionAuthorized:false})
  expect((await target.query('SELECT source_event_id::text,payload,source_provenance,classification,source_sequence::text,source_kind FROM memory.source_events WHERE source_event_id=$1',[rowId])).rows[0]).toEqual({source_event_id:rowId,payload,source_provenance:{},classification:{},source_sequence:null,source_kind:'legacy_archive'})
  expect(await call()).toMatchObject({changed:0,alreadyBound:1})
 })
 test('the unchanged canonical worker can then publish native references while the original UUID stays intact',async()=>{
  await runtimeWork(false)
  expect((await target.query('SELECT payload,source_provenance FROM memory.source_events WHERE source_event_id=$1',[rowId])).rows[0]).toEqual({payload,source_provenance:{}})
 })
})
