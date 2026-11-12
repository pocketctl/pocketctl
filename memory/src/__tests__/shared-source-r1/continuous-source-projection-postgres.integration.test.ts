import {setTimeout as delay} from 'node:timers/promises'
import {randomUUID} from 'node:crypto'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {encodeArchiveChunk,archiveObjectKey,canonicalPayloadHash,createPostgresSharedSourceReader,createPostgresPersonalMetadataReader} from '@pocketctl/session-source'
import {afterAll,beforeAll,describe,expect,test,vi} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {createSharedSourceScheduler} from '../../sources/shared-scheduler.js'
import {createJobRepository} from '../../jobs/repository.js'
import {createJobWorker} from '../../jobs/worker.js'
import {createCanonicalProjectionHandler} from '../../sources/canonical-projection-worker.js'
import {preparePersonalMetadataReferencePage,persistPersonalMetadataReferencePage} from '../../sources/canonical-references.js'
import {loadSourceContextSet,checkSourceContextSet} from '../../sources/source-context-set.js'
import {createEpisodeRepository} from '../../episodes/repository.js'
import {provisionSharedDatabase} from '../../migrations/shared-db/namespace.js'
import {createObservedPersonalMetadataReader} from '../../sources/observed-reader.js'
import {prepareMetadataScope,personalMetadataEnvelope} from '../../sources/source-projection-admission.js'
import {bindSourcePool,sourcePoolContext} from '../../sources/pool-context.js'
import {createSourceArchiveReader} from '../../sources/archive-reader.js'
import {assertSourceProviderExecution,guardSourceExecutionCommit,protectMetadataSourceBodies} from '../../sources/source-execution.js'
import {boundedSourceQuery} from '../../sources/bounded-source-query.js'
import {prepareEpisodeProjectionSources} from '../../sources/prepared-sources.js'
import {JobDeferredError} from '../../jobs/types.js'
import {SourceProcessingPins,runSelectedSourceTransaction} from '../../sources/processing-pins.js'
import {observeProjectionCommits} from './helpers/projection-commit-observer.js'
const url=process.env.CONTINUOUS_SOURCE_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('continuous personal canonical content uses current scope seal',()=>{
 let f:DirectLaunchFixture,inst:string,s:Awaited<ReturnType<DirectLaunchFixture['source']>>
 let restorePin:string|undefined,restoreFence:string|undefined
 const restoredFrozen:string[]=[]
 beforeAll(async()=>{
  f=await directLaunchFixture(url!)
  if(process.env.TASK16_FROZEN_BODY){
   const frozen=JSON.parse(await readFile('/task-evidence/frozen-selected-v6.json','utf8'))
   for(const key of process.env.TASK16_FROZEN_BODY==='both'?['personal','reader']:['personal']){
    const signature=key==='personal'?'shared.lock_memory_personal_source_commit(jsonb,text,text,jsonb,boolean)':'shared.read_memory_relay_sources(jsonb,text,bigint,integer,bigint[])'
    restoredFrozen.push((await f.pool.query('SELECT pg_get_functiondef($1::regprocedure) AS definition',[signature])).rows[0].definition)
    await f.pool.query(frozen[key])
   }
  }
  if(process.env.TASK16_DIAGNOSTIC_PIN==='1'){
   restorePin=(await f.pool.query("SELECT pg_get_functiondef('shared.acquire_memory_source_processing_pin(uuid,jsonb,text,jsonb,boolean)'::regprocedure) AS definition")).rows[0].definition
   let refusal=0
   const mapping:{id:number;context:string}[]=[]
   const debug=restorePin!.replaceAll('RETURN FALSE',(match:string,offset:number)=>{
    const id=++refusal;mapping.push({id,context:restorePin!.slice(Math.max(0,offset-170),offset)})
    return `RAISE EXCEPTION 'task16_pin_diagnostic_refusal_${id}'`
   })
   console.info('DIAGNOSTIC ONLY pin refusal map',JSON.stringify(mapping))
   await f.pool.query(debug)
  }
  if(process.env.TASK16_DIAGNOSTIC_FENCE==='1'){
   restoreFence=(await f.pool.query("SELECT pg_get_functiondef('shared.lock_memory_personal_source_commit(jsonb,text,text,jsonb,boolean)'::regprocedure) AS definition")).rows[0].definition
   let refusal=0;const mapping:{id:number;context:string}[]=[]
   const debug=restoreFence!.replace(/RAISE lock_not_available|RETURN FALSE/g,(match:string,offset:number)=>{
    const id=++refusal;mapping.push({id,context:restoreFence!.slice(Math.max(0,offset-400),offset)})
    return `RAISE EXCEPTION 'task16_fence_diagnostic_refusal_${id}'`
   })
   console.info('DIAGNOSTIC ONLY fence refusal map',JSON.stringify(mapping));await f.pool.query(debug)
  }
  s=await f.source();inst=(await f.install(s,'retained_history')).inst.installation_id
  await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[inst])
 },60000)
 afterAll(async()=>{if(restorePin)await f.pool.query(restorePin);if(restoreFence)await f.pool.query(restoreFence);for(const definition of restoredFrozen)await f.pool.query(definition);await f?.close()})
 test('selected row locks need only the six real definer key grants and never elevate a runtime',async()=>{
  const columns=[['events','id'],['native_installation_starts','installation_id'],['native_source_publications','source_key'],['extension_source_outbox','source_seq'],['session_archive_manifests','manifest_id'],['session_archive_chunks','manifest_id']]
  for(const [table,key]of columns){
   const c=await f.pool.connect()
   try{await c.query('BEGIN');await c.query('SET LOCAL ROLE direct_launch_definer');await c.query(`SELECT ${key} FROM public.${table} WHERE FALSE FOR SHARE NOWAIT`);await c.query('ROLLBACK')}
   finally{await c.query('ROLLBACK');c.release()}
   await f.pool.query(`REVOKE UPDATE(${key}) ON public.${table} FROM direct_launch_definer`)
   const denied=await f.pool.connect()
   try{await denied.query('BEGIN');await denied.query('SET LOCAL ROLE direct_launch_definer');await expect(denied.query(`SELECT ${key} FROM public.${table} WHERE FALSE FOR SHARE NOWAIT`)).rejects.toMatchObject({code:'42501'})}
   finally{await denied.query('ROLLBACK');denied.release();await f.pool.query(`GRANT UPDATE(${key}) ON public.${table} TO direct_launch_definer`)}
   await expect(f.runtime.query(`UPDATE public.${table} SET ${key}=${key} WHERE FALSE`)).rejects.toMatchObject({code:'42501'})
  }
  const isolation=(await f.pool.query(`SELECT r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
   pg_has_role('direct_launch_memory',r.oid,'MEMBER') OR pg_has_role('direct_launch_memory',r.oid,'USAGE') OR pg_has_role('direct_launch_relay',r.oid,'MEMBER') OR pg_has_role('direct_launch_relay',r.oid,'USAGE') AS inherited,
   has_column_privilege(r.oid,'public.events','payload','UPDATE') AS body_update,has_column_privilege(r.oid,'public.events','user_id','UPDATE') AS owner_update,
   has_table_privilege(r.oid,'public.events','INSERT,DELETE,TRUNCATE') AS event_dml FROM pg_roles r WHERE rolname='direct_launch_definer'`)).rows[0]
  expect(Object.values(isolation).every(v=>v===false)).toBe(true)
  await expect(f.runtime.query('SET ROLE direct_launch_definer')).rejects.toMatchObject({code:'42501'})
  for(const sql of ["UPDATE public.events SET payload='{}' WHERE FALSE",'INSERT INTO public.events(session_id) VALUES(\'denied\')','DELETE FROM public.events WHERE FALSE','TRUNCATE public.events'])await expect(f.runtime.query(sql)).rejects.toMatchObject({code:'42501'})
  for(const attribute of ['LOGIN','SUPERUSER','CREATEDB','CREATEROLE','REPLICATION','BYPASSRLS']){
   await f.pool.query('ALTER ROLE direct_launch_definer '+attribute)
   try{await expect(provisionSharedDatabase(f.pool,{memoryRole:'direct_launch_memory',relayRole:'direct_launch_relay',migratorRole:'direct_launch_definer'})).rejects.toThrow(/unsafe_.*definer_role/)}
   finally{await f.pool.query('ALTER ROLE direct_launch_definer NO'+attribute)}
  }
  for(const role of ['direct_launch_memory','direct_launch_relay']){
   await f.pool.query('GRANT direct_launch_definer TO '+role)
   try{await expect(provisionSharedDatabase(f.pool,{memoryRole:'direct_launch_memory',relayRole:'direct_launch_relay',migratorRole:'direct_launch_definer'})).rejects.toThrow('runtime_role_escalation')}
   finally{await f.pool.query('REVOKE direct_launch_definer FROM '+role)}
  }
 })
 test('numeric finite waves survive claims beyond 128 rows and rescan a late smaller ID',async()=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation])
  const ids:string[]=[]
  for(const id of [2,9,10,64,100]){await f.pool.query("SELECT setval(pg_get_serial_sequence('public.events','id'),$1,FALSE)",[id]);ids.push(await f.event(source))}
  for(let n=0;n<129;n++)ids.push(await f.event(source))
  const upper=ids.at(-1)!,signal=new AbortController().signal,errors:unknown[]=[],waves:any[]=[]
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'wave-scheduler',signal,onError:e=>errors.push(e)})
  const queue=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'wave-worker',signal,onError:e=>errors.push(e)})
  const project=createCanonicalProjectionHandler(f.runtime,{stabilizationMs:0});let late=false
  queue.register('compile_episode',createEpisodeRepository(f.runtime,{stabilizationMs:0}).handleCompileEpisode)
  const closeObserver=observeProjectionCommits(f.runtime,async event=>{
   if(event.installationId!==installation||event.rootKey!==f.root(source))return
   const p=event.after;waves.push(structuredClone(p))
   if(!late){
    expect(p.state).toBe('scanning');expect(p.source_version.metadataWave.through).toBe(upper)
    expect(BigInt(p.source_version.metadataWave.after)).toBeGreaterThan(100n)
    await f.pool.query("SELECT setval(pg_get_serial_sequence('public.events','id'),3,FALSE)");ids.push(await f.event(source))
    await f.pool.query("SELECT setval(pg_get_serial_sequence('public.events','id'),$1,TRUE)",[upper]);ids.push(await f.event(source));late=true
   }
  },errors)
  queue.register('project_shared_source',project,{branch:'canonical'})
  try{
   for(let n=0;n<250;n++){
    await scheduler.runOnce();await queue.tick();if(errors.length)throw errors[0]
    const progress=(await f.runtime.query('SELECT state FROM memory_canonical_projection_progress WHERE installation_id=$1 AND root_key=$2',[installation,f.root(source)])).rows[0]
    const count=(await f.runtime.query('SELECT count(*)::int AS count FROM source_events WHERE installation_id=$1',[installation])).rows[0].count
    if(progress?.state==='ready'&&count===136)break
    if(n===249)throw Error('wave_drain_timeout');await delay(100)
   }
   expect(late).toBe(true)
   const first=waves.filter(p=>p.source_version.metadataWave?.through===upper).map(p=>p.source_version.metadataWave)
   expect(first.length).toBeGreaterThanOrEqual(3)
   expect(first.some(w=>w.phase==='scanning'&&BigInt(w.after)>200n)).toBe(true)
   const refs=(await f.runtime.query('SELECT canonical_key,payload FROM source_events WHERE installation_id=$1 ORDER BY canonical_key::bigint',[installation])).rows
   expect(refs.map(r=>r.canonical_key)).toEqual(ids.sort((a,b)=>BigInt(a)<BigInt(b)?-1:1));expect(refs.every(r=>r.payload===null)).toBe(true)
   expect(refs.slice(0,6).map(r=>r.canonical_key)).toEqual(['2','3','9','10','64','100']);expect(errors).toEqual([])
  }finally{await closeObserver();await scheduler.stop();await queue.stop()}
 },40000)
 test('a native r+1 after dispatch leaves content pending but permits current-source metadata projection',async()=>{
  const errors:unknown[]=[],signal=new AbortController().signal
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'continuous-scheduler',signal,onError:e=>errors.push(e)})
  const queue=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'continuous-worker',signal,claimLimit:1,onError:e=>errors.push(e)})
  queue.register('project_shared_source',createCanonicalProjectionHandler(f.runtime,{stabilizationMs:0}),{branch:'canonical'})
  queue.register('compile_episode',createEpisodeRepository(f.runtime,{stabilizationMs:0}).handleCompileEpisode)
  try{
   const first=await f.event(s),root={kind:'relay_event' as const,key:f.root(s)}
   for(let n=0;n<64;n++){
    await scheduler.runOnce();if(errors.length)throw errors[0]
    if((await f.pool.query("SELECT 1 FROM shared.memory_source_distributions WHERE root_key=$1 AND dispatch_complete",[root.key])).rowCount)break
    if(n===63)throw Error('fixture_dispatch_missing')
   }
   const sealed=(await f.runtime.query('SELECT shared.current_memory_source_distribution($1,$2,$3) AS seal',[root.kind,root.key,inst])).rows[0].seal
   expect(sealed).not.toBeNull()
   // Actual publication after a dispatched scan, with the causal 200ms claim
   // delay. No control/mode/window mutation and no handcrafted source vector.
   await delay(200);const second=await f.event(s,true)
   const work=(await f.pool.query('SELECT revision::text,processed_revision::text FROM shared.memory_source_work WHERE source_kind=$1 AND root_key=$2',[root.kind,root.key])).rows[0]
   expect(BigInt(work.revision)).toBeGreaterThan(BigInt(sealed.workRevision))
   expect(work.processed_revision).toBe(sealed.workRevision)
   expect((await f.runtime.query('SELECT shared.current_memory_source_distribution($1,$2,$3) AS seal',[root.kind,root.key,inst])).rows[0].seal).toMatchObject({scanId:sealed.scanId,workRevision:sealed.workRevision,contentPending:true})
   // Positive consumers must still reject the incomplete latest-content set.
   await expect(loadSourceContextSet(f.runtime,inst,root)).rejects.toMatchObject({reason:'source_not_ready'})
   await queue.tick()
   const refs=(await f.runtime.query('SELECT canonical_key,payload FROM source_events WHERE installation_id=$1 AND session_id=$2 ORDER BY canonical_key::bigint',[inst,s.session])).rows
   expect(refs.map(r=>r.canonical_key)).toEqual([first,second])
   expect(refs.every(r=>r.payload===null)).toBe(true)
   // Metadata projection never acknowledges an unseen r+1/root distribution.
   const after=(await f.pool.query('SELECT revision::text,processed_revision::text FROM shared.memory_source_work WHERE source_kind=$1 AND root_key=$2',[root.kind,root.key])).rows[0]
   expect(after).toEqual(work)
   expect(errors).toEqual([])
  }finally{await scheduler.stop();await queue.stop()}
 })
 test('pending personal scope metadata rejects current deletion, grant, owner, mode, control and scan replacement',async()=>{
  const source={...s,session:'negative-'+randomUUID()},signal=new AbortController().signal,errors:unknown[]=[],other=await f.source()
  const root={kind:'relay_event' as const,key:f.root(source)}
  await f.publisher.query("INSERT INTO public.sessions(session_id,daemon_id,user_id,agent_type,source,status) VALUES($1,$2,$3,'codex','terminal','running')",[source.session,source.daemon,source.owner])
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'negative-scheduler',signal,onError:e=>errors.push(e)})
  try{
   await f.event(source)
   for(let n=0;n<128;n++){
    await scheduler.runOnce();if(errors.length)throw errors[0]
    if((await f.pool.query('SELECT 1 FROM shared.memory_source_distributions WHERE root_key=$1 AND dispatch_complete',[root.key])).rowCount)break
    if(n===127)throw Error('negative_fixture_dispatch_missing')
   }
   const set=await loadSourceContextSet(f.runtime,inst,root,undefined,'personal-projection')
   await f.event(source,true)
   await expect(checkSourceContextSet(f.runtime,root,set,'personal-projection')).resolves.toHaveLength(1)
   // Observe each uncommitted negative state on that same physical connection;
   // rollback preserves the fixture's original authority for the next case.
   for(const mutation of [
    {sql:'INSERT INTO public.deleted_sessions(session_id) VALUES($1)',args:[source.session]},
    {sql:"UPDATE public.extension_installations SET status='revoked' WHERE installation_id=$1",args:[inst]},
    {sql:'UPDATE public.sessions SET user_id=$2 WHERE session_id=$1',args:[source.session,other.owner]},
    {sql:"UPDATE shared.memory_source_modes SET mode='paused',generation=generation+1 WHERE installation_id=$1",args:[inst]},
   ]){
    const c=await f.pool.connect()
    try{
     await c.query('BEGIN');await c.query(mutation.sql,mutation.args)
     await expect(checkSourceContextSet(c as unknown as typeof f.runtime,root,set,'personal-projection')).rejects.toMatchObject({reason:'source_not_ready'})
    }finally{await c.query('ROLLBACK');c.release()}
   }
   const c=await f.pool.connect()
   try{
    await c.query('BEGIN');await c.query('UPDATE shared.memory_source_control_clock SET revision=revision+1')
    await expect(loadSourceContextSet(c,inst,root,set.scanId,'personal-projection')).rejects.toMatchObject({reason:'source_not_ready'})
   }finally{await c.query('ROLLBACK');c.release()}
   await scheduler.runOnce();await scheduler.runOnce()
   expect((await f.pool.query('SELECT scan_id::text FROM shared.memory_source_distributions WHERE root_key=$1',[root.key])).rows[0].scan_id).toBe(set.scanId)
   // Synthetic negative-only job: no projection/readiness receipt is created.
   await f.pool.query("UPDATE memory.memory_jobs SET state='completed',completed_at=clock_timestamp() WHERE job_type='project_shared_source' AND payload->>'distribution_scan'=$1",[set.scanId])
   for(let n=0;n<64;n++){
    await scheduler.runOnce();if(errors.length)throw errors[0]
    const scan=(await f.pool.query('SELECT scan_id::text,state FROM shared.memory_source_distributions WHERE root_key=$1',[root.key])).rows[0]
    if(scan.scan_id!==set.scanId&&scan.state==='sealed')break
    if(n===63)throw Error('replacement_fixture_scan_missing')
   }
   await expect(loadSourceContextSet(f.runtime,inst,root,set.scanId,'personal-projection')).rejects.toMatchObject({errorCode:'source_context_set_changed'})
  }finally{await scheduler.stop()}
 })
 test('selected original references preserve unknown order and deny known header conflicts',async()=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation])
  const turn='legacy-unknown-'+source.session,payload={text:'original reference with unknown provenance',turn_id:turn}
  const id=(await f.publisher.query(`INSERT INTO public.events(session_id,event_type,payload,event_hash,effect_status,user_id,created_at)
   VALUES($1,'agent_text',$2,$3,'completed',$4,'2026-11-01T01:02:03.123456Z') RETURNING id::text`,[source.session,payload,randomUUID().replaceAll('-',''),source.owner])).rows[0].id
  const {createPostgresExtensionJournalSink}=await import(new URL('../../../../relay/dist/extensions/journal.js',import.meta.url).href)
  await createPostgresExtensionJournalSink({sharedHeaders:true}).appendCanonicalEvent(f.publisher,{sourceEventId:id,ownerUserId:source.owner,sessionId:source.session,eventType:'agent_text',occurredAt:null,payload})
  const originalId=randomUUID()
  await f.pool.query(`INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,canonical_event_key,session_id,turn_id,event_type,occurred_at,payload,payload_hash,
   classification,source_provenance,source_kind,canonical_key,canonical_session_key,source_version,source_sequence,content_hash,hash_version,mapping_state,adapter_version)
   SELECT $1,$2,'feed','legacy-feed:62','legacy-original-event',logical_source_session_id,$4,event_type,date_trunc('milliseconds',created_at),NULL,decode(repeat('a',64),'hex'),
    source_classification,'{}'::jsonb,'relay_event',id::text,logical_source_session_id,'{"content":"1","authorization":"1","storage":"0"}',NULL,decode(canonical_payload_hash,'hex'),'canonical-json-sha256-v1','verified','original-ref-v1'
   FROM public.events WHERE id=$3`,[originalId,installation,id,turn])
  const native=(await f.pool.query('SELECT source_sequence::text,source_classification,canonical_payload_hash FROM public.events WHERE id=$1',[id])).rows[0]
  expect(native.source_sequence).toMatch(/^[1-9][0-9]*$/);expect(native.source_classification).toEqual({})
  const root={kind:'relay_event' as const,key:f.root(source)},signal=new AbortController().signal,errors:unknown[]=[];let checked=false
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'unknown-order-scheduler',signal,onError:e=>errors.push(e)})
  const queue=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'unknown-order-worker',signal,claimLimit:1,onError:e=>errors.push(e)})
  queue.register('compile_episode',createEpisodeRepository(f.runtime,{stabilizationMs:0}).handleCompileEpisode)
  queue.register('project_shared_source',async job=>{
   if(job.installation_id!==installation)return
   const scope=job.payload.scope as any,seal=await prepareMetadataScope(f.runtime,scope,root)
   const selected=createObservedPersonalMetadataReader(f.runtime),ordinary=createPostgresSharedSourceReader(f.runtime)
   expect((await f.runtime.query('SELECT current_user AS role')).rows[0].role).toBe('direct_launch_memory')
   await expect(f.runtime.query('SELECT payload FROM public.events WHERE id=$1',[id])).rejects.toMatchObject({code:'42501'})
   // Known disagreements remain denials in both paths. Restore each synthetic
   // fault before exercising the actual legacy NULL-order case.
   for(const mutation of [
    {sql:'source_sequence=$2::bigint',value:String(BigInt(native.source_sequence)+1n)},
    {sql:"content_hash=decode($2,'hex')",value:'0'.repeat(64)},
    {sql:'classification=$2::jsonb',value:JSON.stringify({actor_scope:'user'})},
   ]){
    try{
     await f.pool.query(`UPDATE memory.source_events SET ${mutation.sql} WHERE source_event_id=$1`,[originalId,mutation.value])
     await expect(selected.selectPage(scope,root)).rejects.toMatchObject({code:'source_metadata_conflict'})
     await expect(ordinary.getHeads(scope,root,[id])).rejects.toMatchObject({code:'source_metadata_conflict'})
    }finally{await f.pool.query("UPDATE memory.source_events SET source_sequence=NULL,content_hash=decode($2,'hex'),classification=$3::jsonb WHERE source_event_id=$1",[originalId,native.canonical_payload_hash,JSON.stringify(native.source_classification)])}
   }
   const before=(await f.runtime.query('SELECT to_jsonb(s) AS original FROM source_events s WHERE source_event_id=$1',[originalId])).rows[0].original
   expect(before).toMatchObject({origin:'feed',adapter_version:'original-ref-v1',source_sequence:null,source_provenance:{},classification:{},payload:null})
   // This is the installed SDK default first64 API that failed on the real
   // row, with a genuine native header and an independently unknown old order.
   const view=await selected.selectPage(scope,root),old=await ordinary.getHeads(scope,root,[id])
   expect(view.heads).toHaveLength(1);expect(old.heads).toHaveLength(1)
   for(const head of [view.heads[0],old.heads[0]]){
    expect(head).toMatchObject({canonicalKey:id,sessionKey:source.session,eventType:'agent_text',sourceSequence:native.source_sequence,classification:{},provenance:{state:'unknown'}})
    expect(head.classification).not.toHaveProperty('memory_source')
   }
   expect((await selected.resolve(view))[0].payload).toEqual(payload)
   expect((await ordinary.resolveBodies(scope,root,old.heads,old.version))[0].payload).toEqual(payload)
   const page=await preparePersonalMetadataReferencePage(f.runtime,scope,root,seal,undefined)
   const persisted=await persistPersonalMetadataReferencePage(f.runtime,page,0)
   expect(persisted.references).toEqual([{sourceEventId:originalId,canonicalKey:id,sessionId:source.session,created:false}])
   expect(persisted.contextReady).toBe(true)
   expect((await f.runtime.query('SELECT to_jsonb(s) AS original FROM source_events s WHERE source_event_id=$1',[originalId])).rows[0].original).toEqual(before)
   expect((await f.runtime.query('SELECT count(*)::int AS n FROM source_events WHERE installation_id=$1',[installation])).rows[0].n).toBe(1)
   checked=true
  },{branch:'canonical'})
  try{for(let n=0;n<128&&!checked;n++){await scheduler.runOnce();await queue.tick();if(errors.length)throw errors[0]};expect(checked).toBe(true);expect(errors).toEqual([])}
  finally{await scheduler.stop();await queue.stop()}
 },30000)
 test('selected SQL keeps actual claim, privacy, original rows and transaction locks distinct from busy',async()=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation])
  const id=await f.event(source),root={kind:'relay_event' as const,key:f.root(source)},signal=new AbortController().signal,errors:unknown[]=[]
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'proof-scheduler',signal,onError:e=>errors.push(e)})
  const queue=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'proof-worker',signal,onError:e=>errors.push(e)})
  let checked=false
  queue.register('compile_episode',createEpisodeRepository(f.runtime,{stabilizationMs:0}).handleCompileEpisode)
  queue.register('project_shared_source',async job=>{
   if(job.installation_id!==installation)return
   const scope=(job.payload as any).scope,seal=await prepareMetadataScope(f.runtime,scope,root),reader=createObservedPersonalMetadataReader(f.runtime)
   for(const ids of [[-2],[-3],[-1,-2],[-1,0],[-2,id,id],[-2,id,'1'],[-1,null]]){
    await expect(f.runtime.query('SELECT * FROM shared.read_memory_relay_sources($1::jsonb,$2,NULL,1,$3::bigint[])',[JSON.stringify(scope),root.key,ids])).rejects.toThrow('invalid_source_metadata_request')
   }
   await expect(f.runtime.query('SELECT * FROM shared.read_memory_relay_sources($1::jsonb,$2,NULL,NULL,ARRAY[-1]::bigint[])',[JSON.stringify(scope),root.key])).rejects.toThrow('invalid_source_metadata_request')
   await expect(f.runtime.query('SELECT * FROM shared.read_memory_relay_sources($1::jsonb,$2,-1,1,ARRAY[-1]::bigint[])',[JSON.stringify(scope),root.key])).rejects.toThrow('invalid_source_metadata_request')
   const sqlBody=(await f.pool.query("SELECT prosrc FROM pg_proc WHERE oid='shared.read_memory_relay_sources(jsonb,text,bigint,integer,bigint[])'::regprocedure")).rows[0].prosrc
   const metadataBranch=sqlBody.split('IF metadata_only THEN')[1].split('RETURN;')[0]
   expect(metadataBranch).not.toMatch(/\be\.payload\b|octet_length|to_jsonb\(e\)/i)
   expect(metadataBranch).toContain('source_body_change_revision')
   const view=await reader.selectKeys(scope,root,[id]);await reader.resolve(view)
   const envelope=personalMetadataEnvelope(f.runtime,scope,root,reader.proof(view),seal,'reference') as any
   const lock=async(c:any,proof=envelope,selectedScope=scope)=>(await c.query('SELECT shared.lock_memory_personal_source_commit($1::jsonb,$2,$3,$4::jsonb,FALSE) AS valid',[JSON.stringify(selectedScope),root.kind,root.key,JSON.stringify(proof)])).rows[0].valid
   const c=await f.pool.connect(),writer=await f.pool.connect()
   try{
    // Forged locators and original-row facts are denials, never typed busy.
    for(const proof of [
     {...envelope,executionId:randomUUID()}, {...envelope,scanId:randomUUID()}, {...envelope,targetCursor:'forged'},
     {...envelope,purpose:'episode'}, {...envelope,inputFingerprint:'0'.repeat(64)},
     {...envelope,rows:[{...envelope.rows[0],contentHash:'0'.repeat(64)}]},
     {...envelope,rows:[{...envelope.rows[0],rowVersion:'0'}]},
     {...envelope,rows:[{...envelope.rows[0],bodyChangeRevision:'999999'}]},
     {...envelope,rows:[{...envelope.rows[0],ref:{id:randomUUID(),rowVersion:'1',fingerprint:'0'.repeat(64)}}]},
    ])expect(await lock(c,proof)).toBe(false)
    expect(await lock(c,envelope,{...scope,principalUserId:String(source.owner+10000)})).toBe(false)
    for(const mutation of [
     {sql:"UPDATE public.extension_installations SET status='revoked' WHERE installation_id=$1",args:[installation]},
     {sql:'INSERT INTO public.deleted_sessions(session_id) VALUES($1)',args:[source.session]},
     {sql:'UPDATE public.sessions SET user_id=NULL WHERE session_id=$1',args:[source.session]},
     {sql:'UPDATE memory.memory_jobs SET claim_epoch=claim_epoch+1 WHERE job_id=$1',args:[job.job_id]},
     {sql:"UPDATE memory.memory_jobs SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",args:[job.job_id]},
    ]){
     await c.query('BEGIN');await c.query(mutation.sql,mutation.args);expect(await lock(c)).toBe(false);await c.query('ROLLBACK')
    }
    // A selected envelope cannot confer ordinary completion or pin authority.
    expect((await c.query('SELECT shared.complete_memory_source_projection($1,$2::jsonb,$3,$4,$5::jsonb) AS ready',[envelope.executionId,JSON.stringify(scope),root.kind,root.key,JSON.stringify(envelope)])).rows[0].ready).toBe(false)
    expect((await c.query('SELECT shared.acquire_memory_source_processing_pin($1,$2::jsonb,$3,$4::jsonb,FALSE) AS valid',[envelope.executionId,JSON.stringify(scope),root.key,JSON.stringify(envelope)])).rows[0].valid).toBe(false)
    for(const [table,key,value]of [['extension_installations','installation_id',installation],['users','id',source.owner],['extension_providers','provider_id','pocketctl-memory']]){
     await writer.query('BEGIN');await writer.query(`SELECT 1 FROM public.${table} WHERE ${key}=$1 FOR UPDATE`,[value])
     await expect(lock(c)).rejects.toMatchObject({code:'55P03',message:'source_metadata_lock_busy'});await writer.query('ROLLBACK')
    }
    // Real writer-respected Session advisory contention is typed; its absence
    // cannot convert any of the policy failures above into a retryable result.
    await writer.query('BEGIN');await writer.query('SELECT pg_advisory_xact_lock(1885566061,hashtext($1))',[source.session])
    await expect(lock(c)).rejects.toMatchObject({code:'55P03',message:'source_metadata_lock_busy'});await writer.query('ROLLBACK')
    // The actual Relay-respected Session mutex can clear between short,
    // fully rolled-back selected attempts; no one-second job defer is needed.
    await writer.query('BEGIN');await writer.query('SELECT pg_advisory_xact_lock(1885566061,hashtext($1))',[source.session])
    let attempts=0,releasing:Promise<unknown>|undefined
    try{
     const valid=await runSelectedSourceTransaction(f.runtime,installation,signal,async tx=>{
      attempts++
      try{return await lock(tx)}catch(error){
       if(!releasing)releasing=delay(1).then(()=>writer.query('COMMIT'))
       throw error
      }
     })
     expect(valid).toBe(true);expect(attempts).toBeGreaterThan(1);expect(attempts).toBeLessThanOrEqual(4)
    }finally{if(releasing)await releasing;else await writer.query('ROLLBACK')}
    // Persistent contention never becomes a positive or a fifth attempt.
    await writer.query('BEGIN');await writer.query('SELECT pg_advisory_xact_lock(1885566061,hashtext($1))',[source.session])
    attempts=0
    try{
     await expect(runSelectedSourceTransaction(f.runtime,installation,signal,async tx=>{attempts++;return lock(tx)})).rejects.toMatchObject({code:'55P03',message:'source_metadata_lock_busy'})
     expect(attempts).toBe(4)
    }finally{await writer.query('ROLLBACK')}
    await writer.query('BEGIN');await writer.query('SELECT id FROM public.events WHERE id=$1 FOR UPDATE',[id])
    await expect(lock(c)).rejects.toMatchObject({code:'55P03',message:'source_metadata_lock_busy'});await writer.query('ROLLBACK')
    // Positive fences retain real tuple locks through physical COMMIT.
    await c.query('BEGIN');expect(await lock(c)).toBe(true)
    await writer.query('BEGIN');await expect(writer.query('SELECT id FROM public.events WHERE id=$1 FOR UPDATE NOWAIT',[id])).rejects.toMatchObject({code:'55P03'});await writer.query('ROLLBACK')
    await c.query('COMMIT')
    // The selected fence does not weaken the original physical expiry guard.
    await c.query('BEGIN');await guardSourceExecutionCommit(c,installation);expect(await lock(c)).toBe(true)
    await c.query("UPDATE shared.memory_source_processing_pins SET lease_until=clock_timestamp()+interval '150 milliseconds' WHERE execution_id=$1",[envelope.executionId])
    await delay(200);await expect(c.query('COMMIT')).rejects.toMatchObject({code:'55000'});await c.query('ROLLBACK')
    // Same XID does not imply lock continuity across SAVEPOINT rollback.
    await c.query('BEGIN');const xid=(await c.query('SELECT txid_current()::text AS xid')).rows[0].xid
    await c.query('SAVEPOINT selection');expect(await lock(c)).toBe(true);await c.query('ROLLBACK TO SAVEPOINT selection')
    await writer.query('UPDATE public.events SET source_body_change_revision=source_body_change_revision+1 WHERE id=$1',[id])
    expect((await c.query('SELECT txid_current()::text AS xid')).rows[0].xid).toBe(xid);expect(await lock(c)).toBe(false);await c.query('ROLLBACK')
    await expect(reader.assertSelection(view)).rejects.toThrow()
    checked=true
   }finally{await c.query('ROLLBACK');await writer.query('ROLLBACK');c.release();writer.release()}
  },{branch:'canonical'})
  try{
   for(let n=0;n<128&&!checked;n++){await scheduler.runOnce();await queue.tick();if(errors.length)throw errors[0]}
   expect(checked).toBe(true);expect(errors).toEqual([])
  }finally{await scheduler.stop();await queue.stop()}
 },30000)
 test.each(['before-ack','after-ack'] as const)('running-turn compile skips body/pin/provider work and terminal projection survives %s',async ordering=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id,turn='direct-turn-'+source.session
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation]);await f.event(source)
  const signal=new AbortController().signal,errors:unknown[]=[],jobs=createJobRepository(f.runtime),episodes=createEpisodeRepository(f.runtime,{stabilizationMs:0})
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'terminal-scheduler',signal,onError:e=>errors.push(e)})
  const initial=createJobWorker({pool:f.runtime,jobs,workerId:'terminal-early',signal,claimLimit:1,onError:e=>errors.push(e)})
  const later=createJobWorker({pool:f.runtime,jobs,workerId:'terminal-later',signal,onError:e=>errors.push(e)})
  let notifyEarly!:()=>void,releaseEarly!:()=>void
  const earlyReady=new Promise<void>(r=>{notifyEarly=r}),earlyRelease=new Promise<void>(r=>{releaseEarly=r})
  const project=createCanonicalProjectionHandler(f.runtime,{stabilizationMs:0});let early=false,jobId:string|undefined
  initial.register('project_shared_source',project,{branch:'canonical'});later.register('project_shared_source',project,{branch:'canonical'})
  later.register('compile_episode',episodes.handleCompileEpisode)
  const projectTerminal=async()=>{
   await f.event(source,true)
   for(let n=0;n<128;n++){
    await scheduler.runOnce();await later.tick();if(errors.length)throw errors[0]
    if((await f.runtime.query("SELECT 1 FROM source_turns WHERE installation_id=$1 AND turn_id=$2 AND state='completed'",[installation,turn])).rowCount)return
   }
   throw Error('terminal_projection_missing')
  }
  initial.register('compile_episode',async(job,abort,ctx)=>{
   if(job.installation_id!==installation){await episodes.handleCompileEpisode(job,abort,ctx);return}
   jobId=job.job_id
   const generic=vi.spyOn(SourceProcessingPins.prototype,'protect'),current=vi.spyOn(SourceProcessingPins.prototype,'protectCurrent')
   try{await episodes.handleCompileEpisode(job,abort,ctx);expect(generic).not.toHaveBeenCalled();expect(current).not.toHaveBeenCalled()}
   finally{generic.mockRestore();current.mockRestore()}
   expect((await f.pool.query('SELECT count(*)::int AS n FROM shared.memory_source_processing_pins p JOIN shared.memory_source_executions e USING(execution_id) WHERE e.job_id=$1',[jobId])).rows[0].n).toBe(0)
   expect((await f.pool.query('SELECT count(*)::int AS n FROM shared.memory_source_provider_attempts p JOIN shared.memory_source_executions e USING(execution_id) WHERE e.job_id=$1',[jobId])).rows[0].n).toBe(0)
   early=true;notifyEarly()
   if(ordering==='before-ack'){
    await earlyRelease
    expect((await f.runtime.query('SELECT state,last_error_code FROM memory_jobs WHERE job_id=$1',[jobId])).rows[0]).toEqual({state:'running',last_error_code:'rerun_required'})
   }
  })
  try{
   for(let n=0;n<128&&!early;n++){
    await scheduler.runOnce();const tick=initial.tick()
    if(ordering==='before-ack'){
     await Promise.race([tick,earlyReady]);if(early){try{await projectTerminal()}finally{releaseEarly()}}
    }
    await tick;if(errors.length)throw errors[0];await delay(10)
   }
   expect(early).toBe(true)
   if(ordering==='after-ack'){
    expect((await f.runtime.query('SELECT state FROM memory_jobs WHERE job_id=$1',[jobId])).rows[0].state).toBe('completed')
    await projectTerminal()
   }
   for(let n=0;n<128;n++){
    await scheduler.runOnce();await later.tick();if(errors.length)throw errors[0]
    if((await f.runtime.query("SELECT 1 FROM work_episodes WHERE installation_id=$1 AND turn_id=$2 AND state='ready'",[installation,turn])).rowCount)break
    if(n===127)throw Error('terminal_episode_missing');await delay(25)
   }
   expect((await f.runtime.query("SELECT job_id::text,state FROM memory_jobs WHERE installation_id=$1 AND job_type='compile_episode' AND idempotency_key=$2",[installation,'compile_episode:'+turn])).rows).toEqual([{job_id:jobId,state:'completed'}]);expect(errors).toEqual([])
  }finally{releaseEarly();await scheduler.stop();await initial.stop();await later.stop()}
 },30000)
 test('known selected local NOWAIT sites defer without consuming earlier attempts or partial output',async()=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id,turn='direct-turn-'+source.session
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation])
  const {persistOwnedClientEvent}=await import(new URL('../../../../relay/dist/db.js',import.meta.url).href),{createPostgresExtensionJournalSink}=await import(new URL('../../../../relay/dist/extensions/journal.js',import.meta.url).href)
  const payload={text:'selected local row contention',turn_id:turn,repository_id:'github.com/task16/selected-row-locks',commit_sha:'1'.repeat(40),branch:'main',actor_scope:'assistant',memory_source:{version:1,producer:'codex',session_id:source.session,turn_id:turn,event_id:randomUUID(),sequence:'1',invocation_id:'row-locks',source_role:'assistant',skill_state:'non_skill',lineage_complete:true,derived_from_event_ids:[]}}
  await persistOwnedClientEvent(f.publisher,source.owner,source.session,'user_goal',payload,createPostgresExtensionJournalSink({sharedHeaders:true}));await f.event(source,true)
  const signal=new AbortController().signal,errors:unknown[]=[],jobs=createJobRepository(f.runtime),episodes=createEpisodeRepository(f.runtime,{stabilizationMs:0}),project=createCanonicalProjectionHandler(f.runtime,{stabilizationMs:0})
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'local-lock-scheduler',signal,onError:e=>errors.push(e)})
  const queue=createJobWorker({pool:f.runtime,jobs,workerId:'local-lock-worker',signal,claimLimit:1,onError:(e,j)=>{if(j?.installation_id===installation)errors.push(e)}})
  let lockSite:'turn'|'repository'|'snapshot'|'checkpoint'|'ref'|undefined
  const locked=async(job:any,work:()=>Promise<void>)=>{
   if(job.installation_id!==installation||!lockSite)return work()
   const writer=await f.pool.connect()
   try{
    await writer.query('BEGIN')
    if(lockSite==='turn')await writer.query('SELECT 1 FROM memory.source_turns WHERE installation_id=$1 AND turn_id=$2 FOR UPDATE',[installation,turn])
    else if(lockSite==='repository')await writer.query('SELECT 1 FROM memory.repositories WHERE installation_id=$1 FOR UPDATE',[installation])
    else if(lockSite==='snapshot')await writer.query('SELECT 1 FROM memory.repo_snapshots WHERE installation_id=$1 FOR UPDATE',[installation])
    else if(lockSite==='checkpoint')await writer.query('SELECT 1 FROM memory.memory_canonical_projection_progress WHERE installation_id=$1 AND root_key=$2 FOR SHARE',[installation,f.root(source)])
    else await writer.query('SELECT 1 FROM memory.source_events WHERE installation_id=$1 ORDER BY source_event_id FOR SHARE',[installation])
    await work()
   }finally{await writer.query('ROLLBACK');writer.release()}
  }
  queue.register('project_shared_source',async(...args)=>locked(args[0],()=>project(...args)),{branch:'canonical'})
  queue.register('compile_episode',async(...args)=>locked(args[0],()=>episodes.handleCompileEpisode(...args)))
  const jobFor=async(type:string)=>(await f.runtime.query("SELECT job_id::text,state,attempts,last_error_code FROM memory_jobs WHERE installation_id=$1 AND job_type=$2 AND state IN('pending','running') ORDER BY created_at DESC LIMIT 1",[installation,type])).rows[0]
  const tickUntil=async(work:()=>Promise<boolean>)=>{for(let n=0;n<160;n++){await scheduler.runOnce();if(await work())return;await queue.tick();if(errors.length)throw errors[0];await delay(10)}throw Error('local_lock_fixture_missing')}
  try{
   await tickUntil(async()=>!!await jobFor('compile_episode'))
   expect((await f.runtime.query('SELECT 1 FROM repositories WHERE installation_id=$1',[installation])).rowCount).toBe(1)
   expect((await f.runtime.query('SELECT 1 FROM repo_snapshots WHERE installation_id=$1',[installation])).rowCount).toBe(1)
   const episodeJob=(await jobFor('compile_episode')).job_id
   for(const site of ['turn','repository','snapshot'] as const){
    lockSite=site;await f.runtime.query('UPDATE memory_jobs SET attempts=7,available_at=clock_timestamp() WHERE job_id=$1',[episodeJob]);await queue.tick()
    expect((await f.runtime.query('SELECT state,attempts,last_error_code FROM memory_jobs WHERE job_id=$1',[episodeJob])).rows[0]).toEqual({state:'pending',attempts:7,last_error_code:'source_not_ready'})
    expect((await f.runtime.query('SELECT 1 FROM work_episodes WHERE installation_id=$1',[installation])).rowCount).toBe(0)
   }
   lockSite=undefined;await f.runtime.query('UPDATE memory_jobs SET available_at=clock_timestamp() WHERE job_id=$1',[episodeJob]);await queue.tick()
   expect((await f.runtime.query("SELECT 1 FROM work_episodes WHERE installation_id=$1 AND state='ready'",[installation])).rowCount).toBe(1)
   await f.event(source)
   await tickUntil(async()=>!!await jobFor('project_shared_source'))
   const projectJob=(await jobFor('project_shared_source')).job_id
   for(const site of ['checkpoint','ref'] as const){
    lockSite=site;await f.runtime.query('UPDATE memory_jobs SET attempts=7,available_at=clock_timestamp() WHERE job_id=$1',[projectJob]);await queue.tick()
    expect((await f.runtime.query('SELECT state,attempts,last_error_code FROM memory_jobs WHERE job_id=$1',[projectJob])).rows[0]).toEqual({state:'pending',attempts:7,last_error_code:'source_not_ready'})
    expect((await f.runtime.query('SELECT count(*)::int AS n FROM source_events WHERE installation_id=$1',[installation])).rows[0].n).toBe(2)
   }
   lockSite=undefined;await f.runtime.query('UPDATE memory_jobs SET available_at=clock_timestamp() WHERE job_id=$1',[projectJob]);await queue.tick()
   expect((await f.runtime.query('SELECT count(*)::int AS n FROM source_events WHERE installation_id=$1',[installation])).rows[0].n).toBe(3);expect(errors).toEqual([])
  }finally{await scheduler.stop();await queue.stop()}
 },30000)
 test('episode membership fences block new children and turn mutations through physical COMMIT',async()=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation]);await f.event(source);await f.event(source,true)
  const signal=new AbortController().signal,errors:unknown[]=[];let checked=false
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'membership-scheduler',signal,onError:e=>errors.push(e)})
  const queue=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'membership-worker',signal,claimLimit:1,onError:e=>errors.push(e)})
  queue.register('project_shared_source',createCanonicalProjectionHandler(f.runtime,{stabilizationMs:0}),{branch:'canonical'})
  const episodes=createEpisodeRepository(f.runtime,{stabilizationMs:0})
  queue.register('compile_episode',async(job,abort,ctx)=>{
   if(job.installation_id!==installation){await episodes.handleCompileEpisode(job,abort,ctx);return}
   const turn=job.idempotency_key.slice('compile_episode:'.length),prepared=await prepareEpisodeProjectionSources(f.runtime,installation,turn)
   expect(prepared).not.toBeNull();const c=await f.runtime.connect(),writer=await f.pool.connect()
   const insert=`INSERT INTO memory.source_events SELECT (jsonb_populate_record(NULL::memory.source_events,to_jsonb(s)||jsonb_build_object('source_event_id',$2::text,'origin_position',$2::text,'canonical_key',$2::text))).* FROM memory.source_events s WHERE installation_id=$1 LIMIT 1`
   try{
    await c.query('BEGIN');await prepared!.fenceMembership(c)
    await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='100ms'")
    await expect(writer.query(insert,[installation,randomUUID()])).rejects.toMatchObject({code:'55P03'});await writer.query('ROLLBACK')
    await writer.query('BEGIN');await expect(writer.query('SELECT 1 FROM memory.source_turns WHERE installation_id=$1 AND turn_id=$2 FOR UPDATE NOWAIT',[installation,turn])).rejects.toMatchObject({code:'55P03'});await writer.query('ROLLBACK')
    await prepared!.assertCurrent(c,{forCommit:true});await c.query('COMMIT')
    // Reverse ordering: an already inserted child holds the FK parent lock;
    // selected compilation must defer and cannot miss that membership phantom.
    await writer.query('BEGIN');await writer.query(insert,[installation,randomUUID()]);await c.query('BEGIN')
    await expect(prepared!.fenceMembership(c)).rejects.toMatchObject({reason:'source_not_ready'});await c.query('ROLLBACK');await writer.query('ROLLBACK')
    checked=true
   }finally{await c.query('ROLLBACK');await writer.query('ROLLBACK');c.release();writer.release()}
   await episodes.handleCompileEpisode(job,abort,ctx)
  })
  try{for(let n=0;n<160&&!checked;n++){await scheduler.runOnce();await queue.tick();if(errors.length)throw errors[0];await delay(25)}expect(checked).toBe(true);expect(errors).toEqual([])}
  finally{await scheduler.stop();await queue.stop()}
 },30000)
 test('refs and ready episodes advance while the native 16/s writer continues, then drain exactly',async()=>{
  // Separate installation keeps intentionally stale negative-test jobs out of
  // this writer's liveness/error/queue accounting without deleting their rows.
  const source=await f.source(),inst=(await f.install(source,'retained_history')).inst.installation_id
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[inst])
  const signal=new AbortController().signal,errors:unknown[]=[],ids:string[]=[],samples:{written:number;refs:number;episodes:number;jobs:number}[]=[]
  const genericPin=vi.spyOn(SourceProcessingPins.prototype,'protect')
  const {createPostgresExtensionJournalSink}=await import(new URL('../../../../relay/dist/extensions/journal.js',import.meta.url).href)
  const {persistOwnedClientEvent}=await import(new URL('../../../../relay/dist/db.js',import.meta.url).href)
  const sink=createPostgresExtensionJournalSink({sharedHeaders:true})
  async function publish(n:number){
   const terminal=n%2===1,turn='continuous-turn-'+Math.floor(n/2),eventType=terminal?'turn_status':'agent_text'
   const payload={...(terminal?{turn_status:'completed'}:{text:'continuous native synthetic body'}),turn_id:turn,actor_scope:'assistant',memory_source:{version:1,producer:'codex',session_id:source.session,turn_id:turn,event_id:randomUUID(),sequence:terminal?'2':'1',invocation_id:'continuous-native',source_role:'assistant',skill_state:'non_skill',lineage_complete:true,derived_from_event_ids:[]}}
   const result=await persistOwnedClientEvent(f.publisher,source.owner,source.session,eventType,payload,sink)
   expect(result.inserted).toBe(true);ids.push(String(result.eventId))
  }
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'live-scheduler',signal,onError:e=>errors.push(e)})
  const queue=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'live-worker',signal,onError:(e,j)=>{if(j&&j.installation_id===inst)errors.push({error:String(e),stack:e instanceof Error?e.stack:undefined,type:j.job_type})}})
  const project=createCanonicalProjectionHandler(f.runtime,{stabilizationMs:0})
  queue.register('project_shared_source',async(...args)=>{await delay(200);await project(...args)},{branch:'canonical'})
  queue.register('compile_episode',createEpisodeRepository(f.runtime,{stabilizationMs:0}).handleCompileEpisode)
  async function sample(){
   const r=(await f.pool.query("SELECT(SELECT count(*)::int FROM memory.source_events WHERE installation_id=$1 AND session_id=$2) AS refs,(SELECT count(*)::int FROM memory.work_episodes WHERE installation_id=$1 AND session_id=$2 AND state='ready') AS episodes,(SELECT count(*)::int FROM memory.memory_jobs WHERE installation_id=$1 AND state IN('pending','running') AND job_type IN('project_shared_source','compile_episode')) AS jobs",[inst,source.session])).rows[0]
   return {written:ids.length,...r} as {written:number;refs:number;episodes:number;jobs:number}
  }
  try{
   let writing=true
   const writer=(async()=>{const started=performance.now();try{
    for(let n=0;n<64;n++){await delay(Math.max(0,started+n*62.5-performance.now()));await publish(n)}
   }finally{writing=false}})()
   // Keep the scan/dispatch/claim barrier explicit: do not replace the one-row
   // scope seal during its deliberately delayed consumer. The native writer
   // continues at 16/s through every metadata/body/compile operation.
   while(writing){
    for(let n=0;n<64;n++){
     await scheduler.runOnce()
     if((await f.pool.query('SELECT 1 FROM shared.memory_source_distributions WHERE root_key=$1 AND dispatch_complete',[f.root(source)])).rowCount)break
     if(n===63)throw Error('live_fixture_dispatch_missing')
    }
    await queue.tick();if(writing)samples.push(await sample())
    // Waiting source work deliberately yields; the functional driver must
    // not replace the production scheduler's wait with a tight probe loop.
    await delay(100)
   }
   await writer
   const live=samples.at(-1)!;console.info('continuous while-writer samples',JSON.stringify({samples,errors}))
   expect(live.refs).toBeGreaterThan(0);expect(live.episodes).toBeGreaterThan(0)
   for(let n=0;n<300;n++){
    await scheduler.runOnce();await queue.tick()
    const r=await sample()
    if(r.refs===64&&r.episodes===32&&r.jobs===0)break
    if(n===299)throw Error('continuous_drain_timeout_'+JSON.stringify(r))
    await delay(100)
   }
   const refs=(await f.runtime.query('SELECT canonical_key,payload,turn_id FROM source_events WHERE installation_id=$1 AND session_id=$2 ORDER BY canonical_key::bigint',[inst,source.session])).rows
   expect(refs.map(r=>r.canonical_key)).toEqual(ids);expect(refs.every(r=>r.payload===null)).toBe(true)
   expect(refs.map(r=>r.turn_id)).toEqual(ids.map((_,n)=>'continuous-turn-'+Math.floor(n/2)))
   expect(genericPin).not.toHaveBeenCalled();expect(errors).toEqual([])
  }finally{await scheduler.stop();await queue.stop();genericPin.mockRestore()}
 },45000)
 test('a fixed cold selection survives native appends and current pin renewal without refreshing its proof',async()=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation])
  const id=await f.event(source),root={kind:'relay_event' as const,key:f.root(source)},manifest=randomUUID(),key=archiveObjectKey(manifest,0)
  const directory=await mkdtemp(join(tmpdir(),'task16-selected-cold-')),limits={maxRawBytes:1048576,maxCompressedBytes:1048576,maxRecords:100}
  const payload=(await f.pool.query('SELECT payload FROM public.events WHERE id=$1',[id])).rows[0].payload
  const epoch=(await f.pool.query('SELECT activity_epoch::text AS epoch FROM public.sessions WHERE session_id=$1',[source.session])).rows[0].epoch
  const encoded=await encodeArchiveChunk({userId:source.owner,sessionId:source.session,activityEpoch:epoch,manifestId:manifest,ordinal:0},[{id,eventType:'agent_text',payload}],limits),m=encoded.manifest
  await mkdir(join(directory,'session-archive/v1',manifest),{recursive:true});await writeFile(join(directory,key),encoded.bytes)
  await f.pool.query("INSERT INTO public.session_archive_manifests(manifest_id,user_id,session_id,activity_epoch,schema_version,codec,state,event_high_water,published_at,storage_namespace) VALUES($1,$2,$3,$4,1,'gzip','published',$5,NOW(),'task16-cold')",[manifest,source.owner,source.session,epoch,id])
  await f.pool.query('INSERT INTO public.session_archive_chunks(manifest_id,ordinal,object_key,first_event_id,last_event_id,event_count,raw_bytes,compressed_bytes,raw_sha256,compressed_sha256) VALUES($1,0,$2,$3,$3,1,$4,$5,$6,$7)',[manifest,key,id,m.rawBytes,m.compressedBytes,m.rawSha256,m.compressedSha256])
  await f.pool.query('ALTER TABLE public.events ALTER COLUMN payload DROP NOT NULL')
  await f.pool.query("UPDATE public.events SET body_storage='cold',payload=NULL,body_session_id=$1,body_manifest_id=$2,body_chunk_ordinal=0,body_owner_user_id=$3,body_activity_epoch=$4 WHERE id=$5",[source.session,manifest,source.owner,epoch,id])
  const previous=sourcePoolContext(f.runtime),storage=createSourceArchiveReader(directory,'task16-cold'),read=storage.read.bind(storage)
  let reads=0,checked=false;const appended:string[]=[],signal=new AbortController().signal,errors:unknown[]=[]
  storage.read=async objectKey=>{
   reads++;expect(f.runtime.waitingCount).toBe(0)
   for(let n=0;n<8;n++){await delay(100);appended.push(await f.event(source))}
   // Cross the ordinary renewal timer while IO retains the original selected
   // proof. Both automatic and explicit protection observe current metadata.
   await delay(10200);await assertSourceProviderExecution(true)
   return read(objectKey)
  }
  bindSourcePool(f.runtime,{...previous,archive:{storage,limits}})
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'cold-scheduler',signal,onError:e=>errors.push(e)})
  const queue=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'cold-worker',signal,claimLimit:1,onError:e=>errors.push(e)})
  queue.register('compile_episode',createEpisodeRepository(f.runtime,{stabilizationMs:0}).handleCompileEpisode)
  queue.register('project_shared_source',async job=>{
   if(job.installation_id!==installation)return
   const scope=job.payload.scope as any,seal=await prepareMetadataScope(f.runtime,scope,root),reader=createObservedPersonalMetadataReader(f.runtime)
   const view=await reader.selectKeys(scope,root,[id]),original=JSON.stringify(reader.proof(view)),bodies=await reader.resolve(view)
   expect(bodies[0].payload).toEqual(payload);expect(appended).toHaveLength(8);expect(reads).toBe(1)
   const proof=reader.proof(view) as any;expect(JSON.stringify({...proof,cold:[]})).toBe(original)
   const envelope=personalMetadataEnvelope(f.runtime,scope,root,proof,seal,'reference'),c=await f.runtime.connect()
   try{await c.query('BEGIN');expect((await c.query('SELECT shared.lock_memory_personal_source_commit($1::jsonb,$2,$3,$4::jsonb,FALSE) AS valid',[JSON.stringify(scope),root.kind,root.key,JSON.stringify(envelope)])).rows[0].valid).toBe(true);await c.query('COMMIT')}
   finally{await c.query('ROLLBACK');c.release()}
   // Archive replacement invalidates the same proof, including a cached read.
   await f.pool.query("UPDATE public.session_archive_chunks SET compressed_sha256=repeat('0',64) WHERE manifest_id=$1",[manifest])
   await expect(reader.assertSelection(view)).rejects.toThrow()
   await f.pool.query('UPDATE public.session_archive_chunks SET compressed_sha256=$2 WHERE manifest_id=$1',[manifest,m.compressedSha256]);checked=true
  },{branch:'canonical'})
  try{
   for(let n=0;n<128&&!checked;n++){await scheduler.runOnce();await queue.tick();if(errors.length)throw errors[0]}
   expect(checked).toBe(true);expect(errors).toEqual([])
  }finally{await scheduler.stop();await queue.stop();bindSourcePool(f.runtime,previous);await rm(directory,{recursive:true,force:true})}
 },30000)

 test('waiting retains only a fully dispatched current exact-job seal without ACK or claim rewrites',async()=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id,root=f.root(source)
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation]);await f.event(source)
  const errors:unknown[]=[],scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'waiting-initial',signal:new AbortController().signal,onError:e=>errors.push(e)})
  try{
   for(let n=0;n<160;n++){await scheduler.runOnce();if(errors.length)throw errors[0];if((await f.pool.query('SELECT 1 FROM shared.memory_source_distributions WHERE root_key=$1 AND dispatch_complete',[root])).rowCount)break;if(n===159)throw Error('waiting_dispatch_missing')}
  }finally{await scheduler.stop()}
  const old=(await f.pool.query('SELECT to_jsonb(d) AS snapshot,d.xmin::text AS xmin FROM shared.memory_source_distributions d WHERE root_key=$1',[root])).rows[0]
  const job=(await f.runtime.query("SELECT job_id::text FROM memory_jobs WHERE installation_id=$1 AND job_type='project_shared_source' AND payload->>'distribution_scan'=$2",[installation,old.snapshot.scan_id])).rows[0].job_id
  await f.event(source,true)
  // This final fault-only fixture claims actual outstanding work through the
  // unchanged runtime function, rather than minting/rewriting an old claim.
  const claim=(await f.runtime.query("SELECT * FROM shared.claim_memory_source_work('waiting-current',30,256)")).rows.find(r=>r.source_kind==='relay_event'&&r.root_key===root)!
  expect(claim).toBeDefined();expect(BigInt(claim.claimed_revision)).toBeGreaterThan(BigInt(old.snapshot.work_revision))
  const args=['relay_event',root,claim.lease_token,'waiting-current',claim.claimed_revision,null,'',64]
  expect((await f.runtime.query('SELECT shared.resume_memory_source_distribution($1,$2,$3,$4,$5) AS value',args.slice(0,5))).rows[0].value).toBeNull()
  const c=await f.pool.connect()
  const step=async()=>(await c.query('SELECT shared.step_memory_source_distribution($1,$2,$3,$4,$5,$6,$7,$8) AS value',args)).rows[0].value
  try{
   await c.query('BEGIN');expect(await step()).toMatchObject({waiting:true,scanId:old.snapshot.scan_id,workRevision:String(old.snapshot.work_revision)});await c.query('COMMIT')
   expect((await f.pool.query('SELECT to_jsonb(d) AS snapshot,d.xmin::text AS xmin FROM shared.memory_source_distributions d WHERE root_key=$1',[root])).rows[0]).toEqual(old)
   const work=(await f.pool.query('SELECT revision::text,processed_revision::text,claimed_revision::text,lease_token::text,lease_owner FROM shared.memory_source_work WHERE root_key=$1',[root])).rows[0]
   expect(work.claimed_revision).toBe(String(claim.claimed_revision));expect(work.lease_token).toBe(claim.lease_token);expect(work.lease_owner).toBe('waiting-current');expect(BigInt(work.processed_revision)).toBeLessThan(BigInt(work.revision))
   // Transaction-local fault states test each no-freeze condition. No pending
   // job is silently dropped, and rollback restores the exact original seal.
   for(const mutation of [
    {sql:"UPDATE memory.memory_jobs SET state='completed' WHERE job_id=$1",args:[job]},
    {sql:"UPDATE memory.memory_jobs SET state='dead' WHERE job_id=$1",args:[job]},
    {sql:'DELETE FROM memory.memory_jobs WHERE job_id=$1',args:[job]},
    {sql:"UPDATE memory.memory_jobs SET payload=jsonb_set(payload,'{target_cursor}','\"wrong\"') WHERE job_id=$1",args:[job]},
    {sql:"UPDATE shared.memory_source_distribution_targets SET target_mode='shared-shadow' WHERE scan_id=$1",args:[old.snapshot.scan_id]},
    {sql:'UPDATE shared.memory_source_distributions SET dispatch_complete=FALSE WHERE scan_id=$1',args:[old.snapshot.scan_id]},
    {sql:'UPDATE shared.memory_source_control_clock SET revision=revision+1',args:[]},
    {sql:"UPDATE shared.memory_source_modes SET mode='paused',generation=generation+1 WHERE installation_id=$1",args:[installation]},
   ]){
    await c.query('BEGIN');await c.query(mutation.sql,mutation.args);const page=await step();expect(page.waiting).not.toBe(true);expect(page.scanId).not.toBe(old.snapshot.scan_id);await c.query('ROLLBACK')
   }
   // Negative-only fixture terminalization is not a readiness receipt. A real
   // replacement writes the current claim and passes its deferred COMMIT gate.
   await f.runtime.query("UPDATE memory_jobs SET state='completed' WHERE job_id=$1",[job])
   await c.query('BEGIN');expect((await step()).scanId).not.toBe(old.snapshot.scan_id);await c.query('COMMIT')
   const after=(await f.pool.query('SELECT processed_revision::text,claimed_revision::text FROM shared.memory_source_work WHERE root_key=$1',[root])).rows[0]
   expect(after.processed_revision).toBe(work.processed_revision);expect(after.claimed_revision).toBe(work.claimed_revision)
  }finally{await c.query('ROLLBACK');c.release()}
 },30000)
 test('selected retained from_now entitlement is body-free, and hot headerless proof fails explicitly',async()=>{
  const source=await f.source(),payload={text:Array.from({length:12000},()=>randomUUID()).join(''),turn_id:'retained-turn',actor_scope:'assistant',memory_source:{version:1,producer:'codex',session_id:source.session,turn_id:'retained-turn',event_id:randomUUID(),sequence:'1',invocation_id:'retained-native',source_role:'assistant',skill_state:'non_skill',lineage_complete:true,derived_from_event_ids:[]}}
  const {persistOwnedClientEvent}=await import(new URL('../../../../relay/dist/db.js',import.meta.url).href)
  const {createPostgresExtensionJournalSink}=await import(new URL('../../../../relay/dist/extensions/journal.js',import.meta.url).href)
  const id=String((await persistOwnedClientEvent(f.publisher,source.owner,source.session,'agent_text',payload,createPostgresExtensionJournalSink({sharedHeaders:true}))).eventId)
  const excluded=await f.event(source)
  // A fixture-only pre-native historical event. Its first observed UPDATE
  // freezes UNKNOWN through the actual native trigger, never a guessed XID.
  let unknown:string,unknownMissing:string
  await f.pool.query('ALTER TABLE public.events DISABLE TRIGGER native_input_event')
  try{unknown=await f.event(source);unknownMissing=await f.event(source)}finally{await f.pool.query('ALTER TABLE public.events ENABLE TRIGGER native_input_event')}
  await f.pool.query('UPDATE public.events SET effect_status=effect_status WHERE id=ANY($1::bigint[])',[[unknown!,unknownMissing!]])
  const installation=(await f.install(source,'from_now')).inst.installation_id,root={kind:'relay_event' as const,key:f.root(source)}
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation])
  for(const key of [id,unknown!])await f.pool.query(`INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,
   classification,source_provenance,source_kind,canonical_key,canonical_session_key,source_version,source_sequence,content_hash,hash_version,mapping_state,adapter_version)
   SELECT $1,$2,'feed',$1::uuid::text,logical_source_session_id,source_classification->'memory_source'->>'turn_id',event_type,created_at,payload,decode(canonical_payload_hash,'hex'),
    source_classification,jsonb_build_object('memory',source_classification->'memory_source'),'relay_event',id::text,logical_source_session_id,'{"content":"1","authorization":"1","storage":"0"}',source_sequence,decode(canonical_payload_hash,'hex'),'canonical-json-sha256-v1','verified','v1'
   FROM public.events WHERE id=$3`,[randomUUID(),installation,key])
  expect(Number((await f.pool.query('SELECT pg_column_size(payload) AS bytes FROM public.events WHERE id=$1',[id])).rows[0].bytes)).toBeGreaterThan(200000)
  const state=async(key:string)=>(await f.pool.query("SELECT shared.memory_input_start_admission($1,'relay_event',$2,$3,$4) AS state",[installation,key,String(source.owner),source.session])).rows[0].state
  expect(await state(id)).toBe('before');expect(await state(unknown!)).toBe('unproven');expect(await state(unknownMissing!)).toBe('unproven');expect(await state(excluded)).toBe('before')
  expect((await f.pool.query("SELECT shared.memory_input_start_admission($1,'relay_event',$2,'wrong-owner',$3) AS state",[installation,id,source.session])).rows[0].state).toBe('denied')
  const directory=await mkdtemp(join(tmpdir(),'task16-retained-cold-')),previous=sourcePoolContext(f.runtime),limits={maxRawBytes:1048576,maxCompressedBytes:1048576,maxRecords:10}
  const signal=new AbortController().signal,errors:unknown[]=[];let checked=false
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'retained-scheduler',signal,onError:e=>errors.push(e)})
  const queue=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'retained-worker',signal,claimLimit:1,onError:e=>errors.push(e)})
  queue.register('compile_episode',createEpisodeRepository(f.runtime,{stabilizationMs:0}).handleCompileEpisode)
  queue.register('project_shared_source',async job=>{
   if(job.installation_id!==installation)return
   const scope=job.payload.scope as any,seal=await prepareMetadataScope(f.runtime,scope,root),reader=createObservedPersonalMetadataReader(f.runtime)
   const view=await reader.selectKeys(scope,root,[id]);expect((await reader.resolve(view))[0].payload).toEqual(payload)
   const unknownView=await reader.selectKeys(scope,root,[unknown!]);expect((await reader.resolve(unknownView))[0].head.canonicalKey).toBe(unknown)
   const metadata=async(c:any,key=id)=>(await c.query('SELECT value FROM shared.read_memory_relay_sources($1::jsonb,$2,NULL,1,ARRAY[-2,$3]::bigint[]) AS value',[JSON.stringify(scope),root.key,key])).rows[0].value
   expect((await metadata(f.runtime)).rows).toHaveLength(1);expect((await metadata(f.runtime,excluded)).rows).toEqual([])
   await expect(metadata(f.runtime,unknownMissing!)).rejects.toThrow('source_input_start_unproven')
   const bodies=(await f.pool.query("SELECT proname,prosrc FROM pg_proc WHERE oid=ANY(ARRAY['shared.read_memory_relay_sources(jsonb,text,bigint,integer,bigint[])'::regprocedure,'shared.lock_memory_personal_source_commit(jsonb,text,text,jsonb,boolean)'::regprocedure,'shared.memory_input_start_admission(uuid,text,text,text,text)'::regprocedure,'public.native_event_authority(bigint,integer)'::regprocedure]::oid[])")).rows
   const branch=bodies.find(r=>r.proname==='read_memory_relay_sources').prosrc.split('IF metadata_only THEN')[1].split("RETURN NEXT observation-'admissions'")[0]
   expect(branch).not.toMatch(/memory_relay_input_admitted|\be\.payload\b|to_jsonb\(e\)/)
   expect(branch.match(/memory_input_start_admission\(/g)).toHaveLength(1)
   const commitBody=bodies.find(r=>r.proname==='lock_memory_personal_source_commit').prosrc
   expect(commitBody).not.toMatch(/memory_relay_input_admitted|\be\.payload\b|to_jsonb\(e\)/)
   expect(commitBody.match(/memory_input_start_admission\(/g)).toHaveLength(1)
   // The physical selected fence observes native authority once per requested ID.
   expect(commitBody.match(/public\.native_event_authority\(/g)).toHaveLength(1)
   for(const name of ['memory_input_start_admission','native_event_authority'])expect(bodies.find(r=>r.proname===name).prosrc).not.toMatch(/payload|to_jsonb\(e\)/)
   const envelope=personalMetadataEnvelope(f.runtime,scope,root,reader.proof(view),seal,'reference')
   const lock=async(c:any,proof:unknown=envelope)=>(await c.query('SELECT shared.lock_memory_personal_source_commit($1::jsonb,$2,$3,$4::jsonb,FALSE) AS valid',[JSON.stringify(scope),root.kind,root.key,JSON.stringify(proof)])).rows[0].valid
   const c=await f.pool.connect()
   try{
    await c.query('BEGIN');expect(await lock(c)).toBe(true);await c.query('COMMIT')
    const pair=await reader.selectKeys(scope,root,[id,unknown!])
    const pairEnvelope=personalMetadataEnvelope(f.runtime,scope,root,reader.proof(pair),seal,'reference') as any
    expect(pairEnvelope.rows.map((row:{id:string})=>row.id)).toEqual([id,unknown])
    await c.query('BEGIN');expect(await lock(c,pairEnvelope)).toBe(true);await c.query('COMMIT')
    await c.query('BEGIN')
    await c.query('UPDATE public.events SET source_header_version=NULL,source_sequence=NULL,canonical_payload_hash=NULL,source_classification=NULL WHERE id=$1',[unknown])
    const invalidFirst={...pairEnvelope,rows:[{...pairEnvelope.rows[0],contentHash:'0'.repeat(64)},pairEnvelope.rows[1]]}
    expect(await lock(c,invalidFirst)).toBe(false)
    await expect(lock(c,pairEnvelope)).rejects.toThrow('source_metadata_proof_unavailable')
    await c.query('ROLLBACK')
    for(const mutation of ["source_provenance='{}'::jsonb","content_hash=decode(repeat('0',64),'hex')","classification='{}'::jsonb"]){
     await c.query('BEGIN');await c.query(`UPDATE memory.source_events SET ${mutation} WHERE installation_id=$1 AND canonical_key=$2`,[installation,id])
     expect((await metadata(c)).rows).toEqual([]);expect(await lock(c)).toBe(false);await c.query('ROLLBACK')
    }
    // No headerless hot retained entitlement can enter the selected final
    // path via payload comparison; ordinary explicit behavior stays intact.
    await f.pool.query('UPDATE public.events SET source_header_version=NULL,source_sequence=NULL,canonical_payload_hash=NULL,source_classification=NULL WHERE id=$1',[id])
    await expect(reader.selectKeys(scope,root,[id])).rejects.toMatchObject({code:'source_metadata_proof_unavailable'})
    await expect(metadata(f.runtime)).rejects.toThrow('source_metadata_proof_unavailable')
    await expect(lock(c)).rejects.toThrow('source_metadata_proof_unavailable')
    const ordinary=createPostgresSharedSourceReader(f.runtime),old=await ordinary.getHeads(scope,root,[id])
    expect((await ordinary.resolveBodies(scope,root,old.heads,old.version))[0].payload).toEqual(payload)
    // The cold retained tuple has an authoritative metadata binding; actual
    // decoder bytes must still match the old UUID's expected hash.
    const manifest=randomUUID(),objectKey=archiveObjectKey(manifest,0),epoch=(await f.pool.query('SELECT activity_epoch::text AS epoch FROM public.sessions WHERE session_id=$1',[source.session])).rows[0].epoch
    const encoded=await encodeArchiveChunk({userId:source.owner,sessionId:source.session,activityEpoch:epoch,manifestId:manifest,ordinal:0},[{id,eventType:'agent_text',payload}],limits),m=encoded.manifest
    await mkdir(join(directory,'session-archive/v1',manifest),{recursive:true});await writeFile(join(directory,objectKey),encoded.bytes)
    await f.pool.query("INSERT INTO public.session_archive_manifests(manifest_id,user_id,session_id,activity_epoch,schema_version,codec,state,event_high_water,published_at,storage_namespace) VALUES($1,$2,$3,$4,1,'gzip','published',$5,NOW(),'task16-retained')",[manifest,source.owner,source.session,epoch,id])
    await f.pool.query('INSERT INTO public.session_archive_chunks(manifest_id,ordinal,object_key,first_event_id,last_event_id,event_count,raw_bytes,compressed_bytes,raw_sha256,compressed_sha256) VALUES($1,0,$2,$3,$3,1,$4,$5,$6,$7)',[manifest,objectKey,id,m.rawBytes,m.compressedBytes,m.rawSha256,m.compressedSha256])
    await f.pool.query('ALTER TABLE public.events ALTER COLUMN payload DROP NOT NULL')
    await f.pool.query("UPDATE public.events SET body_storage='cold',payload=NULL,body_session_id=$1,body_manifest_id=$2,body_chunk_ordinal=0,body_owner_user_id=$3,body_activity_epoch=$4 WHERE id=$5",[source.session,manifest,source.owner,epoch,id])
    bindSourcePool(f.runtime,{...previous,archive:{storage:createSourceArchiveReader(directory,'task16-retained'),limits}})
    const coldReader=createObservedPersonalMetadataReader(f.runtime),cold=await coldReader.selectKeys(scope,root,[id])
    expect((await coldReader.resolve(cold))[0].payload).toEqual(payload);expect((await metadata(f.runtime)).rows).toHaveLength(1)
    const coldEnvelope=personalMetadataEnvelope(f.runtime,scope,root,coldReader.proof(cold),seal,'reference')
    await c.query('BEGIN');expect(await lock(c,coldEnvelope)).toBe(true);await c.query('COMMIT')
    expect(await lock(c,{...coldEnvelope,cold:[{manifestId:manifest,ordinal:0,fingerprint:'0'.repeat(64)}]})).toBe(false)
    await f.runtime.query("UPDATE source_events SET content_hash=decode(repeat('0',64),'hex') WHERE installation_id=$1 AND canonical_key=$2",[installation,id])
    try{const corruptReader=createObservedPersonalMetadataReader(f.runtime),corrupt=await corruptReader.selectKeys(scope,root,[id]);await expect(corruptReader.resolve(corrupt)).rejects.toThrow()}
    finally{await f.runtime.query('UPDATE source_events SET content_hash=$3 WHERE installation_id=$1 AND canonical_key=$2',[installation,id,canonicalPayloadHash(payload)])}
    checked=true
   }finally{await c.query('ROLLBACK');c.release()}
  },{branch:'canonical'})
  try{for(let n=0;n<160&&!checked;n++){await scheduler.runOnce();await queue.tick();if(errors.length)throw errors[0];await delay(10)}expect(checked).toBe(true);expect(errors).toEqual([])}
  finally{await scheduler.stop();await queue.stop();bindSourcePool(f.runtime,previous);await rm(directory,{recursive:true,force:true})}
},30000)

 test('a previously ready checkpoint records an unstable fresh wave after a real native append',async()=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation])
  const first=await f.event(source),root={kind:'relay_event' as const,key:f.root(source)},signal=new AbortController().signal,errors:unknown[]=[]
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'ready-wave-scheduler',signal,onError:e=>errors.push(e)})
  const queue=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'ready-wave-worker',signal,claimLimit:1,onError:e=>errors.push(e)})
  const normal=createCanonicalProjectionHandler(f.runtime,{stabilizationMs:0});let checked=false
  queue.register('compile_episode',createEpisodeRepository(f.runtime,{stabilizationMs:0}).handleCompileEpisode)
  queue.register('project_shared_source',async(job,abort,context)=>{
   if(job.installation_id!==installation||checked)return normal(job,abort,context)
   const scope=job.payload.scope as any,seal=await prepareMetadataScope(f.runtime,scope,root)
   const progress=async()=>(await f.runtime.query('SELECT source_version,next_cursor,state FROM memory_canonical_projection_progress WHERE installation_id=$1 AND root_key=$2',[installation,root.key])).rows[0]
   const initial=await preparePersonalMetadataReferencePage(f.runtime,scope,root,seal,await progress())
   expect((await persistPersonalMetadataReferencePage(f.runtime,initial,0)).contextReady).toBe(true)
   const prior=await progress();expect(prior.state).toBe('ready')
   const original=(await f.runtime.query('SELECT source_event_id::text,payload FROM source_events WHERE installation_id=$1 AND canonical_key=$2',[installation,first])).rows[0]
   const selected=await preparePersonalMetadataReferencePage(f.runtime,scope,root,seal,prior)
   const late=await f.event(source)
   const result=await persistPersonalMetadataReferencePage(f.runtime,selected,0)
   expect(result.contextReady).toBe(false)
   const durable=await progress();expect(durable.state).toBe('scanning')
   expect(durable.source_version.metadataWave).toMatchObject({phase:'restart',after:first,through:first,startVersion:prior.source_version})
   expect(durable.next_cursor).not.toBeNull()
   expect((await f.runtime.query('SELECT source_event_id::text,payload FROM source_events WHERE installation_id=$1 AND canonical_key=$2',[installation,first])).rows[0]).toEqual(original)
   expect(original.payload).toBeNull();expect((await f.runtime.query('SELECT count(*)::int AS n FROM source_events WHERE installation_id=$1 AND canonical_key=$2',[installation,late])).rows[0].n).toBe(0)
   checked=true
  },{branch:'canonical'})
  try{for(let n=0;n<128&&!checked;n++){await scheduler.runOnce();await queue.tick();if(errors.length)throw errors[0]};expect(checked).toBe(true);expect(errors).toEqual([])}
  finally{await scheduler.stop();await queue.stop()}
 },30000)

 test('the concrete metadata reader fetches one private hot body and keeps both real native proof checks',async()=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation])
  const id=await f.event(source),root={kind:'relay_event' as const,key:f.root(source)},signal=new AbortController().signal,errors:unknown[]=[]
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'single-body-scheduler',signal,onError:e=>errors.push(e)})
  const queue=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'single-body-worker',signal,claimLimit:1,onError:e=>errors.push(e)})
  const normal=createCanonicalProjectionHandler(f.runtime,{stabilizationMs:0});let checked=false
  queue.register('compile_episode',createEpisodeRepository(f.runtime,{stabilizationMs:0}).handleCompileEpisode)
  queue.register('project_shared_source',async(job,abort,context)=>{
   if(job.installation_id!==installation||checked)return normal(job,abort,context)
   const scope=job.payload.scope as any,calls:string[]=[]
   const reader=createPostgresPersonalMetadataReader({async connect(){throw Error('metadata_reader_must_not_hold_a_client')},async query(sql,args){
    if(sql.includes('shared.read_memory_relay_sources('))calls.push(args?.[4]?.[0]==='-2'?'metadata':'body')
    return boundedSourceQuery(f.runtime,sql,args)
   }})
   await protectMetadataSourceBodies(f.runtime,scope,root)
   const view=await reader.selectKeys(scope,root,[id]),original=JSON.stringify(reader.proof(view))
   await protectMetadataSourceBodies(f.runtime,scope,root)
   const bodies=await reader.resolve(view)
   expect(bodies[0].head.canonicalKey).toBe(id);expect(canonicalPayloadHash(bodies[0].payload).toString('hex')).toBe(view.heads[0].contentHash)
   expect(calls).toEqual(['body','metadata','metadata']);expect(JSON.stringify(reader.proof(view))).toBe(original)
   await f.publisher.query("UPDATE public.events SET payload=jsonb_set(payload,'{text}','\"changed native body\"'::jsonb) WHERE id=$1",[id])
   await expect(reader.resolve(view)).rejects.toMatchObject({code:'changed'});expect(JSON.stringify(reader.proof(view))).toBe(original)
   checked=true
  },{branch:'canonical'})
  try{for(let n=0;n<128&&!checked;n++){await scheduler.runOnce();await queue.tick();if(errors.length)throw errors[0]};expect(checked).toBe(true);expect(errors).toEqual([])}
  finally{await scheduler.stop();await queue.stop()}
 },30000)

 test('real personal episode body invalidation yields before output and does not consume a failure attempt',async()=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation])
  const id=await f.event(source);await f.event(source,true)
  const signal=new AbortController().signal,errors:unknown[]=[],outcomes:string[]=[];let checked=false,mutated=false,target=''
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'episode-change-source',signal,onError:e=>errors.push(e)})
  const queue=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'episode-change-job',signal,claimLimit:1,onError:e=>errors.push(e),onExecution:(j,result)=>{if(j.job_id===target)outcomes.push(result)}})
  queue.register('project_shared_source',createCanonicalProjectionHandler(f.runtime,{stabilizationMs:0}),{branch:'canonical'})
  const compile=createEpisodeRepository(f.runtime,{stabilizationMs:0}).handleCompileEpisode
  queue.register('compile_episode',async(job,abort,context)=>{
   if(job.installation_id!==installation||checked)return compile(job,abort,context)
   target=job.job_id;const originals=new Map<any,any>()
   const instrument=(client:any)=>{if(originals.has(client))return;const original=client.query;originals.set(client,original)
    client.query=function(...args:any[]){const sql=typeof args[0]==='string'?args[0]:args[0]?.text??'',values=Array.isArray(args[1])?args[1]:args[0]?.values??[],result=original.apply(client,args)
     if(!result?.then)return result
     return result.then(async(r:any)=>{if(!mutated&&sql.includes('shared.read_memory_relay_sources(')&&values[4]?.[0]==='-1'){
      mutated=true;await f.publisher.query("UPDATE public.events SET payload=jsonb_set(payload,'{text}','\"body changed after selected read\"'::jsonb) WHERE id=$1",[id])
     }return r})
    }
   }
   f.runtime.on('acquire',instrument)
   try{await compile(job,abort,context);throw Error('episode_invalidation_was_not_observed')}
   catch(error){expect(mutated).toBe(true);expect(error).toBeInstanceOf(JobDeferredError);expect(error).toMatchObject({reason:'source_not_ready'});checked=true;throw error}
   finally{f.runtime.off('acquire',instrument);for(const[client,query]of originals)client.query=query}
  },{branch:'canonical'})
  try{
   for(let n=0;n<128&&!checked;n++){await scheduler.runOnce();await queue.tick();if(errors.length)throw errors[0]}
   expect(checked).toBe(true);expect(outcomes).toEqual(['deferred']);expect(errors).toEqual([])
   expect((await f.pool.query('SELECT state,attempts,last_error_code FROM memory.memory_jobs WHERE job_id=$1',[target])).rows[0]).toMatchObject({state:'pending',attempts:0,last_error_code:'source_not_ready'})
   expect((await f.pool.query("SELECT (SELECT count(*)::int FROM memory.work_episodes WHERE installation_id=$1) AS episodes,(SELECT count(*)::int FROM memory.memory_jobs WHERE installation_id=$1 AND job_type='extract_candidates') AS extraction",[installation])).rows[0]).toEqual({episodes:0,extraction:0})
  }finally{await scheduler.stop();await queue.stop()}
 },30000)
 test.each([false,true])('retiring delivery journal rows uses durable native publication and preserves UNKNOWN fallback (legacy=%s)',async legacy=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation])
  const id=await f.event(source,false,{unknownPublication:legacy}),root={kind:'relay_event' as const,key:f.root(source)},signal=new AbortController().signal,errors:unknown[]=[]
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'journal-retirement-source',signal,onError:e=>errors.push(e)})
  const queue=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'journal-retirement-job',signal,claimLimit:1,onError:e=>errors.push(e)});let checked=false
  queue.register('project_shared_source',async job=>{
   if(job.installation_id!==installation||checked)return
   const scope=job.payload.scope as any,reader=createObservedPersonalMetadataReader(f.runtime),seal=await prepareMetadataScope(f.runtime,scope,root)
   await protectMetadataSourceBodies(f.runtime,scope,root)
   const view=await reader.selectKeys(scope,root,[id]),proof=JSON.stringify(reader.proof(view)),envelope=personalMetadataEnvelope(f.runtime,scope,root,reader.proof(view),seal,'reference')
   const facts=async()=>({event:(await f.pool.query('SELECT id::text,xmin::text,source_body_change_revision::text,canonical_payload_hash FROM public.events WHERE id=$1',[id])).rows[0],publication:(await f.pool.query("SELECT owner_key,source_session_id,publication_xid::text,publication_order::text,retired FROM public.native_source_publications WHERE source_kind='relay_event' AND source_key=$1",[id])).rows[0],authority:(await f.pool.query('SELECT public.native_event_authority($1,$2) AS authority',[id,source.owner])).rows[0].authority})
   const before=await facts();expect(before.publication.retired).toBe(false)
   if(legacy){expect(before.publication.publication_xid).toBeNull();expect(before.publication.publication_order).toBeNull()}
   else{expect(before.publication.publication_xid).toMatch(/^[1-9][0-9]*$/);expect(before.publication.publication_order).toMatch(/^[1-9][0-9]*$/)}
   const sequences=(await f.pool.query("SELECT source_seq::text FROM public.extension_source_outbox WHERE source_kind='canonical_event' AND source_id=$1",['event:'+id])).rows.map(r=>r.source_seq)
   expect(sequences.length).toBeGreaterThan(0)
   const {deleteSourceRows}=await import(new URL('../../../../relay/dist/extensions/feed-repository.js',import.meta.url).href)
   await deleteSourceRows(f.pool,sequences)
   expect((await f.pool.query('SELECT count(*)::int AS n FROM public.extension_source_outbox WHERE source_seq=ANY($1::bigint[])',[sequences])).rows[0].n).toBe(0);expect(await facts()).toEqual(before)
   if(legacy){await expect(reader.resolve(view)).rejects.toMatchObject({code:'changed'});expect(JSON.stringify(reader.proof(view))).toBe(proof);checked=true;return}
   const bodies=await reader.resolve(view);expect(bodies).toHaveLength(1);expect(canonicalPayloadHash(bodies[0].payload).toString('hex')).toBe(view.heads[0].contentHash);expect(JSON.stringify(reader.proof(view))).toBe(proof)
   const client=await f.runtime.connect()
   try{await client.query('BEGIN');await guardSourceExecutionCommit(client,installation);expect((await client.query('SELECT shared.lock_memory_personal_source_commit($1::jsonb,$2,$3,$4::jsonb,FALSE) AS locked',[JSON.stringify(scope),root.kind,root.key,JSON.stringify(envelope)])).rows[0].locked).toBe(true)}finally{await client.query('ROLLBACK');client.release()}
   // The permanent native fact is still part of the original proof. Its real
   // irreversible retirement must invalidate that proof even after delivery GC.
   await f.pool.query("UPDATE public.native_source_publications SET retired=TRUE,owner_key=NULL,source_session_id=NULL,publication_xid=NULL,publication_order=NULL WHERE source_kind='relay_event' AND source_key=$1",[id])
   await expect(reader.resolve(view)).rejects.toThrow();expect(JSON.stringify(reader.proof(view))).toBe(proof);checked=true
  },{branch:'canonical'})
  try{for(let n=0;n<128&&!checked;n++){await scheduler.runOnce();await queue.tick();if(errors.length)throw errors[0]};expect(checked).toBe(true);expect(errors).toEqual([])}finally{await scheduler.stop();await queue.stop()}
 },30000)
})
