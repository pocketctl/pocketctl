import {randomUUID} from 'node:crypto'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {createNativeInstallationDiscovery} from '../../installations/native-discovery.js'
import {createInstallationRegistry} from '../../installations/repository.js'
import {loadBusinessHealth,evaluateBusinessHealth} from '../../reporting/business-health.js'
import {createFeedConsumer} from '../../inbox/feed-worker.js'
import {updateFeedLagGauge} from '../../metrics.js'
const url=process.env.DIRECT_LAUNCH_MEMORY_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('native scope control publication and health without HTTP acknowledgements',()=>{
 let f:DirectLaunchFixture,personal:string,organization:string,scope:string
 const discover=async()=>{const d=createNativeInstallationDiscovery({pool:f.runtime,signal:new AbortController().signal});try{return await d.discoverOnce()}finally{await d.stop()}}
 const health=async()=>(await loadBusinessHealth(f.runtime)).find(r=>r.installation_id===organization)!
 const observation=async()=>(await f.runtime.query('SELECT control_revision::text,observed_at FROM memory_native_control_observations WHERE installation_id=$1',[organization])).rows[0]
 beforeAll(async()=>{
  f=await directLaunchFixture(url!)
  const controls=await import(pathToFileURL(resolve('../relay/dist/shared-source/control-capture.js')).href)
  await controls.applyRelayControlCapture(f.pool)
  const{provisionSharedDatabase}=await import('../../migrations/shared-db/namespace.js')
  await provisionSharedDatabase(f.pool,{memoryRole:'direct_launch_memory',relayRole:'direct_launch_relay',migratorRole:'direct_launch_definer'})
  personal=(await f.install(await f.source(),'retained_history')).inst.installation_id
  await f.pool.query("UPDATE shared.memory_source_modes SET mode='shared-active',generation=generation+1 WHERE installation_id=$1",[personal])
  organization=randomUUID();scope=randomUUID()
  await f.pool.query("INSERT INTO public.extension_organizations(organization_id,name) VALUES($1,'native control fixture')",[scope])
  await f.pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory','organization',$2,'active','{}',ARRAY['scope.lifecycle.v2'],'{}','from_now')",[organization,scope])
 },60000)
 afterAll(async()=>{await f?.close()})
 test('complete current native metadata makes the shared scope ready without fabricating HTTP progress',async()=>{
  expect(await discover()).toBe(2)
  const row=(await f.runtime.query('SELECT local_status,last_ack_at,last_pull_at,last_feed_id::text FROM memory_installations WHERE installation_id=$1',[organization])).rows[0]
  expect(row).toEqual({local_status:'ready',last_ack_at:null,last_pull_at:null,last_feed_id:'0'})
  expect((await observation()).control_revision).toBe((await f.runtime.query('SELECT shared.memory_source_control_snapshot() AS revision')).rows[0].revision)
 })
 test('health and feed metric use current native control while retaining real content-feed monitoring',async()=>{
  await f.runtime.query("UPDATE memory_installations SET last_ack_at=NOW()-interval '2 hours',last_pull_at=NOW()-interval '2 hours',created_at=NOW()-interval '3 hours' WHERE installation_id=$1",[organization])
  expect(evaluateBusinessHealth(await health())).toMatchObject({state:'ready',reasons:[]})
  let lag=-1;await updateFeedLagGauge(f.runtime,{set:value=>{lag=value as number}})
  expect(lag).toBe(0)
  await f.pool.query('UPDATE public.extension_installations SET config_version=config_version+1 WHERE installation_id=$1',[organization])
  expect(evaluateBusinessHealth(await health()).reasons).toContain('control_stale')
  await discover()
  expect(evaluateBusinessHealth(await health())).toMatchObject({state:'ready',reasons:[]})
  expect((await f.runtime.query('SELECT last_ack_at<NOW()-interval \'1 hour\' AS unchanged FROM memory_installations WHERE installation_id=$1',[organization])).rows[0].unchanged).toBe(true)
 })
 test('shared feed loop never polls v2 controls or ownerless v1 feeds',async()=>{
  let contentPulls=0,controlPulls=0,acks=0
  const feed=createFeedConsumer({pool:f.runtime,workerId:'native-control-fixture',signal:new AbortController().signal,
   pullFeed:async()=>{contentPulls++;throw Error('unexpected legacy pull')},ackFeed:async()=>{acks++;return 0},
   pullScopeControlFeed:async()=>{controlPulls++;throw Error('unexpected HTTP control pull')},ackScopeControlFeed:async()=>{acks++;return 0}})
  await expect(feed.runOnce()).resolves.toEqual({installations:0})
  expect({contentPulls,controlPulls,acks}).toEqual({contentPulls:0,controlPulls:0,acks:0})
 })
 test('concurrent native authority changes roll back observation and readiness with the whole generation',async()=>{
  const registry=createInstallationRegistry(f.runtime),old=await observation(),generation=await registry.currentGeneration()+1
  const page=(await f.runtime.query('SELECT shared.memory_installation_inventory_page(NULL,128,NULL) AS page')).rows[0].page
  const blocker=await f.runtime.connect();let pending:ReturnType<typeof registry.applyDiscovery>|undefined
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT 1 FROM memory_installations WHERE installation_id=$1 FOR UPDATE',[personal])
   pending=registry.applyDiscovery({generation,items:page.installations,sourceControlRevision:page.control_revision})
   let blocked=false;for(let n=0;n<100;n++){if((await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%INSERT INTO memory_installations%' LIMIT 1")).rowCount){blocked=true;break}await new Promise(r=>setTimeout(r,10))}
   expect(blocked).toBe(true)
   await f.pool.query('UPDATE public.extension_installations SET config_version=config_version+1 WHERE installation_id=$1',[organization])
   await blocker.query('COMMIT');await expect(pending).rejects.toThrow('native_inventory_changed')
   expect(await observation()).toEqual(old);expect(await registry.currentGeneration()).toBe(generation-1)
  }finally{await blocker.query('ROLLBACK');blocker.release();await pending?.catch(()=>undefined)}
  await discover()
 })
 test('native control refresh preserves integrity failures and snapshot requirements',async()=>{
  await f.runtime.query("UPDATE memory_installations SET local_status='integrity_error',last_error_code='hash_mismatch' WHERE installation_id=$1",[organization])
  await discover()
  expect(evaluateBusinessHealth(await health())).toMatchObject({state:'error',primaryError:'hash_mismatch'})
 })
})
