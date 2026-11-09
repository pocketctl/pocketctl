import {randomUUID} from 'node:crypto'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {createSharedSourceScheduler} from '../../sources/shared-scheduler.js'
import {createJobRepository} from '../../jobs/repository.js'
import {createJobWorker} from '../../jobs/worker.js'
import {createCanonicalProjectionHandler} from '../../sources/canonical-projection-worker.js'
import {createNativeInstallationDiscovery} from '../../installations/native-discovery.js'
import {prepareSourceReferences} from '../../sources/prepared-sources.js'
import {retainedSourceRead,type SourceReadGrant} from '../../sources/retained-read.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {provisionSharedDatabase,assertSharedRuntimeContract} from '../../migrations/shared-db/namespace.js'
const url=process.env.DIRECT_LAUNCH_MEMORY_TEST_DATABASE_URL,suite=url?describe:describe.skip
const topics=['session.event.v1','session.lifecycle.v1','turn.lifecycle.v1','session.deleted.v1','session.access.revoked.v1']
suite('durable bounded personal Session transport retirement with native business continuing',()=>{
 let f:DirectLaunchFixture,personal:string,organization:string,external:string,source:Awaited<ReturnType<DirectLaunchFixture['source']>>,scheduler:ReturnType<typeof createSharedSourceScheduler>,queue:ReturnType<typeof createJobWorker>,discovery:ReturnType<typeof createNativeInstallationDiscovery>,oldGrant:SourceReadGrant
 const row=async(id=personal)=>(await f.pool.query('SELECT config_version::text,subscriptions,granted_scopes,enabled_services,event_filter FROM public.extension_installations WHERE installation_id=$1',[id])).rows[0]
 const retire=(db=f.pool,id=personal,config='1',generation='3')=>db.query('SELECT shared.retire_memory_session_transport($1::uuid,$2::bigint,$3::bigint,$4::bigint) AS result',[id,String(source.owner),config,generation])
 async function publishAndRead(){
  const ids=[await f.event(source),await f.event(source,true)]
  for(let n=0;n<512;n++){
   await scheduler.runOnce();await queue.tick()
   const refs=(await f.runtime.query("SELECT source_event_id::text,canonical_key FROM source_events WHERE installation_id=$1 AND origin='canonical' AND canonical_key=ANY($2::text[])",[personal,ids])).rows
   if(refs.length===2){const read=await prepareSourceReferences(f.runtime,personal,refs.map(r=>r.source_event_id));expect(read.events).toHaveLength(2);expect(read.events.some(e=>e.payload.text==='bounded direct launch synthetic body')).toBe(true);return ids}
  }
  throw Error('retired_transport_native_projection_not_ready')
 }
 beforeAll(async()=>{
  f=await directLaunchFixture(url!)
  const controls=await import(pathToFileURL(resolve('../relay/dist/shared-source/control-capture.js')).href);await controls.applyRelayControlCapture(f.pool)
  const{provisionSharedDatabase}=await import('../../migrations/shared-db/namespace.js');await provisionSharedDatabase(f.pool,{memoryRole:'direct_launch_memory',relayRole:'direct_launch_relay',migratorRole:'direct_launch_definer'})
  source=await f.source();personal=(await f.install(source,'retained_history')).inst.installation_id
  await f.pool.query('UPDATE public.extension_installations SET subscriptions=$2::text[] WHERE installation_id=$1',[personal,topics])
  const scope=randomUUID();organization=randomUUID();external=randomUUID()
  await f.pool.query("INSERT INTO public.extension_organizations(organization_id,name) VALUES($1,'preserved organization')",[scope])
  await f.pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory','organization',$2,'active','{}',ARRAY['scope.lifecycle.v2'],'{}','from_now')",[organization,scope])
  await f.pool.query("INSERT INTO public.extension_providers(provider_id,manifest_version,manifest,status) VALUES('synthetic-external',1,'{}','enabled')")
  await f.pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_user_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'synthetic-external',$2,'active',ARRAY['session:events:read'],ARRAY['session.event.v1'],'{}','from_now')",[external,source.owner])
  await f.pool.query("UPDATE shared.memory_source_modes SET mode='legacy-feed' WHERE installation_id=$1",[personal])
  await f.pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode) VALUES($1,'legacy-feed')",[organization])
  await applySharedSourceContract(f.pool,{targetProfile:'personal-relay-only',preservedInstallations:[personal,organization]})
  await provisionSharedDatabase(f.pool,{memoryRole:'direct_launch_memory',relayRole:'direct_launch_relay',migratorRole:'direct_launch_definer'})
  await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[personal])
  const signal=new AbortController().signal;discovery=createNativeInstallationDiscovery({pool:f.runtime,signal});await discovery.discoverOnce()
  oldGrant={installationId:personal,configVersion:'1',userId:source.owner}
  scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'transport-retirement-scheduler',signal,pageSize:128,refreshInstallations:()=>discovery.discoverOnce()})
  queue=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'transport-retirement-worker',signal,claimLimit:8})
  queue.register('project_shared_source',createCanonicalProjectionHandler(f.runtime,{sourceProfile:'personal-relay-only',installationAllowlist:[personal,organization],pageSize:64,stabilizationMs:0}),{branch:'canonical'})
  await publishAndRead()
 },60000)
 afterAll(async()=>{await scheduler?.stop();await queue?.stop();await discovery?.stop();await f?.close()})
 test('active mode alone does not silently change unreviewed subscriptions',async()=>{expect((await row()).subscriptions).toEqual(topics)})
 test('reviewed CAS retirement creates one durable config epoch without removing read rights',async()=>{
  const before=await row(),result=(await retire()).rows[0].result,after=await row()
  expect(result).toMatchObject({alreadyRetired:false,retiredConfigVersion:'2',currentConfigVersion:'2',modeGeneration:'3',removedTopics:topics})
  expect(after).toEqual({...before,config_version:'2',subscriptions:[]})
  expect((await f.runtime.query('SELECT last_ack_at,last_feed_id::text FROM memory_installations WHERE installation_id=$1',[personal])).rows[0]).toEqual({last_ack_at:null,last_feed_id:'0'})
 })
 test('old personal grants fail before mirror refresh and the current config is usable afterwards',async()=>{
  const check=(grant:SourceReadGrant)=>retainedSourceRead(f.runtime,{installationId:personal,authorityGrant:grant},async()=> 'authorized')
  expect(await check(oldGrant)).toBeUndefined()
  await discovery.discoverOnce();expect(await check({...oldGrant,configVersion:'2'})).toBe('authorized')
 })
 test('later ordinary config updates cannot reintroduce retired Session or Turn topics',async()=>{
  await f.publisher.query('UPDATE public.extension_installations SET config_version=config_version+1,subscriptions=$2::text[] WHERE installation_id=$1',[personal,topics])
  expect(await row()).toMatchObject({config_version:'3',subscriptions:[]})
  const repeated=(await retire()).rows[0].result
  expect(repeated).toMatchObject({alreadyRetired:true,retiredConfigVersion:'2',currentConfigVersion:'3',modeGeneration:'3'})
 })
 test('the maintenance action is not a runtime privilege and cannot retire other scopes/providers',async()=>{
  await expect(retire(f.runtime)).rejects.toMatchObject({code:'42501'})
  await expect(retire(f.publisher)).rejects.toMatchObject({code:'42501'})
  await expect(retire(f.pool,organization)).rejects.toThrow('session_transport_retirement_scope_mismatch')
  await expect(retire(f.pool,external)).rejects.toThrow('session_transport_retirement_scope_mismatch')
  expect((await row(organization)).subscriptions).toEqual(['scope.lifecycle.v2']);expect((await row(external)).subscriptions).toEqual(['session.event.v1'])
 })
 test('mode/config mismatch cannot rewrite the durable retirement receipt',async()=>{
  const before=(await f.pool.query('SELECT * FROM shared.memory_session_transport_retirements WHERE installation_id=$1',[personal])).rows[0]
  await expect(retire(f.pool,personal,'1','4')).rejects.toThrow('session_transport_retirement_epoch_mismatch')
  await expect(retire(f.pool,personal,'2')).rejects.toThrow('session_transport_retirement_epoch_mismatch')
  expect((await f.pool.query('SELECT * FROM shared.memory_session_transport_retirements WHERE installation_id=$1',[personal])).rows[0]).toEqual(before)
 })
 test('post-retirement native publish still becomes readable refs without legacy Memory inbox input',async()=>{
  const before=(await f.runtime.query('SELECT count(*)::text AS n FROM memory_feed_inbox WHERE installation_id=$1',[personal])).rows[0].n
  await publishAndRead()
  expect((await f.runtime.query('SELECT count(*)::text AS n FROM memory_feed_inbox WHERE installation_id=$1',[personal])).rows[0].n).toBe(before)
  expect((await row()).subscriptions).toEqual([])
 })
 test('runtime startup refuses a disabled persistent subscription fence',async()=>{
  await f.pool.query('ALTER TABLE public.extension_installations DISABLE TRIGGER memory_session_transport_retired')
  try{await expect(assertSharedRuntimeContract(f.runtime,{sharedSourceProfile:'personal-relay-only',installationAllowlist:[personal,organization]})).rejects.toThrow('shared_session_transport_retirement_fence_missing')}
  finally{await f.pool.query('ALTER TABLE public.extension_installations ENABLE TRIGGER memory_session_transport_retired')}
 })
 test('the retirement receipt is immutable and survives explicit contract reinstallation',async()=>{
  const receipt=(await f.pool.query('SELECT * FROM shared.memory_session_transport_retirements WHERE installation_id=$1',[personal])).rows[0]
  await expect(f.pool.query('DELETE FROM shared.memory_session_transport_retirements WHERE installation_id=$1',[personal])).rejects.toThrow('session_transport_retirement_is_durable')
  await expect(f.pool.query('UPDATE shared.memory_session_transport_retirements SET retired_config_version=3 WHERE installation_id=$1',[personal])).rejects.toThrow('session_transport_retirement_is_durable')
  await applySharedSourceContract(f.pool)
  await provisionSharedDatabase(f.pool,{memoryRole:'direct_launch_memory',relayRole:'direct_launch_relay',migratorRole:'direct_launch_definer'})
  expect((await f.pool.query('SELECT * FROM shared.memory_session_transport_retirements WHERE installation_id=$1',[personal])).rows[0]).toEqual(receipt)
  await f.publisher.query('UPDATE public.extension_installations SET config_version=config_version+1,subscriptions=$2::text[] WHERE installation_id=$1',[personal,topics])
  expect((await row()).subscriptions).toEqual([])
 })
})
