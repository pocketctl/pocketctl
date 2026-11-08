import {randomUUID} from 'node:crypto'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {prepareMemoryStartup} from '../../startup-schema.js'
import {createCanonicalProjectionHandler} from '../../sources/canonical-projection-worker.js'
import {createSourceProjector} from '../../projection/source-projector.js'
const url=process.env.DIRECT_LAUNCH_MEMORY_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('bounded personal Session direct launch with preserved organization',()=>{
 let f:DirectLaunchFixture,personal:string,organization:string,source:Awaited<ReturnType<DirectLaunchFixture['source']>>
 const profile='personal-relay-only' as const
 const options=()=>({databaseNamespace:'memory' as const,sharedSourceProfile:profile,installationAllowlist:[personal,organization]})
 beforeAll(async()=>{
  f=await directLaunchFixture(url!);source=await f.source()
  personal=(await f.install(source,'retained_history')).inst.installation_id
  const scope=randomUUID();organization=randomUUID()
  await f.pool.query("INSERT INTO public.extension_organizations(organization_id,name) VALUES($1,'preserved synthetic organization')",[scope])
  await f.pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory','organization',$2,'active',ARRAY[]::text[],ARRAY['scope.lifecycle.v2','scope.membership.v2','scope.installation.v2'],ARRAY['memory.search','memory.manage'],'from_now')",[organization,scope])
  await f.runtime.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[organization])
  await f.pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode) VALUES($1,'legacy-feed')",[organization])
  await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
 },60000)
 afterAll(async()=>{await f?.close()})
 test('ordinary startup remains closed and profile opt-in refuses the unbounded target enumerator',async()=>{
  await expect(prepareMemoryStartup(f.runtime,{databaseNamespace:'memory'})).rejects.toThrow('shared_source_consumers_not_ready')
  await expect(prepareMemoryStartup(f.runtime,options())).rejects.toThrow('shared_source_target_profile_mismatch')
 })
 test('trusted migrator installs the finite target policy and actual runtime can start both preserved scopes',async()=>{
  // Reprofiling is an offline operation, before activation.
  await f.pool.query("UPDATE shared.memory_source_modes SET mode='legacy-feed' WHERE installation_id=$1",[personal])
  await applySharedSourceContract(f.pool,{targetProfile:profile,preservedInstallations:[personal,organization]})
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[personal])
  await expect(prepareMemoryStartup(f.runtime,options())).resolves.toBeUndefined()
  await expect(createSourceProjector(f.runtime).projectOnce(organization)).resolves.toEqual({projected:0})
  await expect(createSourceProjector(f.runtime).projectOnce(personal)).rejects.toThrow('legacy_source_input_disabled')
  const id=await f.event(source)
  const targets=(await f.runtime.query("SELECT source_scope FROM shared.enumerate_memory_source_targets('relay_event',$1,'',64)",[f.root(source)])).rows
  expect(targets.map(r=>r.source_scope.installationId)).toEqual([personal])
  expect(await f.runtime.query("SELECT * FROM shared.enumerate_memory_source_targets('team_collaboration','unactivated-team','',64)")).toHaveProperty('rowCount',0)
  expect(await f.runtime.query("SELECT * FROM shared.enumerate_memory_source_targets('team_delivery','unactivated-delivery','',64)")).toHaveProperty('rowCount',0)
  expect(id).toMatch(/^\d+$/)
 })
 test('missing preserved organization, extra active installation and organization direct mode fail closed',async()=>{
  await expect(prepareMemoryStartup(f.runtime,{...options(),installationAllowlist:[personal]})).rejects.toThrow('shared_source_launch_scope_mismatch')
  const extra=randomUUID()
  await f.runtime.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[extra])
  try{await expect(prepareMemoryStartup(f.runtime,options())).rejects.toThrow('shared_source_launch_scope_mismatch')}
  finally{await f.runtime.query('DELETE FROM memory_installations WHERE installation_id=$1',[extra])}
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,1,'shared-active')",[organization])
  try{await expect(prepareMemoryStartup(f.runtime,options())).rejects.toThrow('shared_source_launch_scope_mismatch')}
  finally{await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'legacy-feed')",[organization])}
  await expect(prepareMemoryStartup(f.runtime,options())).resolves.toBeUndefined()
 })
 test('target definition drift is rejected even when the stored profile still claims personal-only',async()=>{
  const original=(await f.pool.query("SELECT pg_get_functiondef('shared.enumerate_memory_source_targets(text,text,text,integer)'::regprocedure) AS definition")).rows[0].definition
  await f.pool.query(original.replace("IF p_kind='relay_event' THEN","IF FALSE THEN"))
  try{
   await expect(prepareMemoryStartup(f.runtime,options())).rejects.toThrow('shared_source_target_profile_mismatch')
   await expect(applySharedSourceContract(f.pool)).rejects.toThrow('shared_source_target_profile_mismatch')
  }finally{await f.pool.query(original)}
  await applySharedSourceContract(f.pool)
  await expect(prepareMemoryStartup(f.runtime,options())).resolves.toBeUndefined()
 })
 test('a queued Team injection is terminal before context, reader, semantic publication or billing',async()=>{
  const handler=createCanonicalProjectionHandler(f.runtime,{sourceProfile:profile,installationAllowlist:[personal,organization]})
  for(const kind of ['team_collaboration','team_delivery']){
   await expect(handler({job_type:'project_shared_source',installation_id:personal,payload:{scope:{installationId:personal},root:{kind,key:'unactivated-team'}}} as never,new AbortController().signal)).rejects.toMatchObject({errorCode:'canonical_source_kind_disabled'})
  }
  expect((await f.runtime.query('SELECT count(*)::int AS n FROM memory_team_semantic_publications')).rows[0].n).toBe(0)
  expect((await f.runtime.query('SELECT count(*)::int AS n FROM memory_provider_budget_reservations')).rows[0].n).toBe(0)
 })
 test('native publish, durable scheduler and actual job worker produce readable body-free refs alongside organization legacy input',async()=>{
  const {createSharedSourceScheduler}=await import('../../sources/shared-scheduler.js')
  const {createJobRepository}=await import('../../jobs/repository.js'),{createJobWorker}=await import('../../jobs/worker.js')
  const {createEpisodeRepository}=await import('../../episodes/repository.js')
  const {prepareSourceReferences}=await import('../../sources/prepared-sources.js')
  const s={...source,session:'direct-queue-'+randomUUID()},errors:unknown[]=[]
  await f.publisher.query("INSERT INTO public.sessions(session_id,daemon_id,user_id,agent_type,source,status) VALUES($1,$2,$3,'codex','terminal','running')",[s.session,s.daemon,s.owner])
  const ids=[await f.event(s),await f.event(s,true)],signal=new AbortController().signal
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'direct-launch-scheduler',signal,pageSize:128,onError:e=>errors.push(e)})
  const queue=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'direct-launch-worker',signal,claimLimit:1,onError:e=>errors.push(e)})
  queue.register('project_shared_source',createCanonicalProjectionHandler(f.runtime,{sourceProfile:profile,installationAllowlist:[personal,organization],pageSize:64,stabilizationMs:0}),{branch:'canonical'})
  queue.register('compile_episode',createEpisodeRepository(f.runtime,{stabilizationMs:0}).handleCompileEpisode)
  try{
   for(let n=0;n<256;n++){
    await scheduler.runOnce();await queue.tick()
    if(errors.length)throw errors[0]
    const ready=(await f.runtime.query("SELECT state FROM memory_canonical_projection_progress WHERE installation_id=$1 AND source_kind='relay_event' AND root_key=$2",[personal,f.root(s)])).rows
    if(ready.length&&ready.every(r=>r.state==='ready'))break
    if(n===255)throw Error('direct_launch_projection_not_ready')
   }
   const refs=(await f.runtime.query('SELECT source_event_id::text,canonical_key,payload FROM source_events WHERE installation_id=$1 AND session_id=$2 ORDER BY canonical_key',[personal,s.session])).rows
   expect(refs.map(r=>r.canonical_key)).toEqual(ids)
   expect(refs.every(r=>r.payload===null)).toBe(true)
   const prepared=await prepareSourceReferences(f.runtime,personal,refs.map(r=>r.source_event_id))
   expect(prepared.events.map(r=>r.payload.turn_id)).toEqual(['direct-turn-'+s.session,'direct-turn-'+s.session])
   expect(prepared.events.some(r=>r.payload.text==='bounded direct launch synthetic body')).toBe(true)
   await expect(createSourceProjector(f.runtime).projectOnce(organization)).resolves.toEqual({projected:0})
   expect((await f.runtime.query("SELECT count(*)::int AS n FROM memory_jobs WHERE job_type='project_shared_source' AND payload->'root'->>'kind' IN('team_collaboration','team_delivery')")).rows[0].n).toBe(0)
  }finally{await scheduler.stop();await queue.stop()}
 })
 test('organization legacy Team transport still projects, prepares and compiles without canonical Team activation',async()=>{
  const {createJobWorker}=await import('../../jobs/worker.js'),{createJobRepository}=await import('../../jobs/repository.js')
  const {createEpisodeRepository}=await import('../../episodes/repository.js'),{prepareTurnSources}=await import('../../sources/prepared-sources.js')
  const session='team_legacy_'+randomUUID(),turn='team-call:legacy-'+randomUUID(),errors:unknown[]=[]
  const owner=(await f.pool.query('SELECT owner_scope_id::text FROM public.extension_installations WHERE installation_id=$1',[organization])).rows[0].owner_scope_id
  await f.runtime.query("INSERT INTO memory_feature_settings(installation_id,extraction_mode,embedding_mode) VALUES($1,'off','off')",[organization])
  for(const [index,role]of ['goal','outcome'].entries()){
   const at=new Date(Date.now()-5000+index*1000).toISOString(),data={team_source_version:1,team_id:'legacy-team',team_session_id:'legacy-session',team_call_id:turn,source_role:role,context_version:1,turn_id:turn,team_event_ids:['legacy-event-'+index],team_event_seqs:[index+1],occurred_at:at,
    ...(role==='goal'?{text:'Preserve the organization legacy consumer',author_user_id:source.owner}:{status:'completed',turn_status:'completed'}),
    read_scope:{kind:'team_session',team_id:'legacy-team',team_session_id:'legacy-session',team_memory_binding_id:'legacy-binding',team_memory_binding_revision:1,target_installation_id:organization,target_owner_scope_kind:'organization',target_owner_scope_id:owner,participant_user_id:source.owner,participant_revision:1}}
   await f.runtime.query(`INSERT INTO memory_feed_inbox(installation_id,feed_id,envelope_version,topic,source_kind,source_id,session_id,turn_id,event_type,recorded_at,classification,data,payload_hash)
    VALUES($1,$2,1,'session.event.v1','team_collaboration_event',$3,$4,$5,'team_source',$6,'{}',$7::jsonb,sha256(convert_to($7::text,'utf8')))`,[organization,String(900001+index),'legacy:'+turn+':'+role,session,turn,at,JSON.stringify(data)])
  }
  await expect(createSourceProjector(f.runtime,{stabilizationMs:0}).projectOnce(organization)).resolves.toEqual({projected:2})
  const original=(await f.runtime.query('SELECT source_event_id::text,origin,source_provenance FROM source_events WHERE installation_id=$1 AND turn_id=$2 ORDER BY occurred_at',[organization,turn])).rows
  expect(original).toHaveLength(2);expect(original.every(r=>r.origin==='team')).toBe(true)
  const prepared=await prepareTurnSources(f.runtime,organization,turn)
  expect(prepared.events.map(e=>e.source_event_id)).toEqual(original.map(r=>r.source_event_id))
  expect(prepared.events[0].payload.text).toBe('Preserve the organization legacy consumer')
  const queue=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'organization-legacy-compile',signal:new AbortController().signal,claimLimit:1,onError:e=>errors.push(e)})
  queue.register('compile_episode',createEpisodeRepository(f.runtime,{stabilizationMs:0}).handleCompileEpisode)
  try{
   for(let n=0;n<64;n++){
    await queue.tick();if(errors.length)throw errors[0]
    if((await f.runtime.query("SELECT 1 FROM work_episodes WHERE installation_id=$1 AND turn_id=$2 AND state='ready'",[organization,turn])).rowCount)break
    if(n===63)throw Error('organization_legacy_compile_not_ready')
   }
  }finally{await queue.stop()}
  expect((await f.runtime.query('SELECT mode FROM shared.memory_source_modes WHERE installation_id=$1',[organization])).rows[0].mode).toBe('legacy-feed')
  expect((await f.runtime.query('SELECT source_event_id::text,origin,source_provenance FROM source_events WHERE installation_id=$1 AND turn_id=$2 ORDER BY occurred_at',[organization,turn])).rows).toEqual(original)
  expect((await f.runtime.query('SELECT count(*)::int n FROM memory_team_semantic_publications')).rows[0].n).toBe(0)
  expect((await f.runtime.query('SELECT count(*)::int n FROM memory_provider_budget_reservations')).rows[0].n).toBe(0)
 })
 test('a later unrelated personal activation cannot escape the frozen launch scope',async()=>{
  const other=await f.source(),extra=(await f.install(other,'retained_history')).inst.installation_id
  await f.event(other)
  expect((await f.runtime.query("SELECT * FROM shared.enumerate_memory_source_targets('relay_event',$1,'',64)",[f.root(other)])).rowCount).toBe(0)
  const handler=createCanonicalProjectionHandler(f.runtime,{sourceProfile:profile,installationAllowlist:[personal,organization]})
  await expect(handler({job_type:'project_shared_source',installation_id:extra,payload:{scope:{installationId:extra},root:{kind:'relay_event',key:f.root(other)}}} as never,new AbortController().signal)).rejects.toMatchObject({errorCode:'canonical_source_installation_disabled'})
 })
})
