import {randomUUID} from 'node:crypto'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import type {ProviderInstallationItemV2} from '../../relay/contracts.js'

const url=process.env.DIRECT_LAUNCH_MEMORY_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('native first-party installation inventory under current control clock',()=>{
 let f:DirectLaunchFixture,personal:string,organization:string,scope:string
 const page=async(after:string|null=null,limit=128,revision:string|null=null):Promise<{installations:ProviderInstallationItemV2[];control_revision:string;has_more:boolean;next_cursor:string|null}>=>(await f.runtime.query('SELECT shared.memory_installation_inventory_page($1::uuid,$2,$3::bigint) AS page',[after,limit,revision])).rows[0].page
 beforeAll(async()=>{
  f=await directLaunchFixture(url!)
  const controls=await import(pathToFileURL(resolve('../relay/dist/shared-source/control-capture.js')).href)
  await controls.applyRelayControlCapture(f.pool)
  const {provisionSharedDatabase}=await import('../../migrations/shared-db/namespace.js')
  await provisionSharedDatabase(f.pool,{memoryRole:'direct_launch_memory',relayRole:'direct_launch_relay',migratorRole:'direct_launch_definer'})
  personal=(await f.install(await f.source(),'retained_history')).inst.installation_id
  organization=randomUUID();scope=randomUUID()
  await f.pool.query("INSERT INTO public.extension_organizations(organization_id,name) VALUES($1,'inventory synthetic organization')",[scope])
  await f.pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory','organization',$2,'active','{}',ARRAY['scope.lifecycle.v2'],'{}','from_now')",[organization,scope])
 },60000)
 afterAll(async()=>{await f?.close()})
 test('least-privilege native pages preserve both personal and complete organization authority',async()=>{
  const first=await page(null,1),second=await page(first.next_cursor,1,first.control_revision)
  expect(first.has_more).toBe(true);expect(second.control_revision).toBe(first.control_revision)
  const items=[...first.installations,...second.installations]
  expect(new Set(items.map(i=>i.installation_id))).toEqual(new Set([personal,organization]))
  expect(items.find(i=>i.installation_id===organization)).toMatchObject({owner_scope_kind:'organization',owner_scope_id:scope,authorization_epoch:'1',scope_snapshot:{state:'active',memberships:[]},subscriptions:['scope.lifecycle.v2']})
  await expect(f.runtime.query('SELECT * FROM public.extension_installations')).rejects.toMatchObject({code:'42501'})
 })
 test('a changed control clock rejects continuation instead of publishing a mixed generation',async()=>{
  const first=await page(null,1)
  await f.pool.query('UPDATE public.extension_installations SET config_version=config_version+1 WHERE installation_id=$1',[personal])
  await expect(page(first.next_cursor,1,first.control_revision)).rejects.toThrow('native_inventory_changed')
  const fresh=await page();expect(fresh.installations.find(i=>i.installation_id===personal)?.config_version).toBe('2')
 })
 test('registry publication refuses a changed native generation and keeps the prior cache',async()=>{
  const {createInstallationRegistry}=await import('../../installations/repository.js'),registry=createInstallationRegistry(f.runtime)
  const observed=await page(),generation=await registry.currentGeneration()+1
  await f.pool.query('UPDATE public.extension_installations SET config_version=config_version+1 WHERE installation_id=$1',[personal])
  await expect(registry.applyDiscovery({generation,items:observed.installations,sourceControlRevision:observed.control_revision} as never)).rejects.toThrow('native_inventory_changed')
  expect(await registry.currentGeneration()).toBe(generation-1)
  const current=await page()
  await registry.applyDiscovery({generation,items:current.installations,sourceControlRevision:current.control_revision} as never)
  expect((await f.runtime.query('SELECT config_version::text FROM memory_installations WHERE installation_id=$1',[personal])).rows[0].config_version).toBe('3')
 })
 test('native discovery updates the existing cache and complete organization facts without an HTTP client',async()=>{
  const {createNativeInstallationDiscovery}=await import('../../installations/native-discovery.js')
  const discovery=createNativeInstallationDiscovery({pool:f.runtime,signal:new AbortController().signal,installationAllowlist:new Set([personal,organization])})
  try{
   expect(await discovery.discoverOnce()).toBe(2)
   await f.pool.query("UPDATE public.extension_organizations SET state='suspended',authorization_epoch=authorization_epoch+1 WHERE organization_id=$1",[scope])
   expect(await discovery.discoverOnce()).toBe(2)
   expect((await f.runtime.query('SELECT state,authorization_epoch::text FROM memory_owner_scopes WHERE installation_id=$1',[organization])).rows[0]).toEqual({state:'suspended',authorization_epoch:'2'})
  }finally{await discovery.stop()}
 })
 test('a native update while registry writes are blocked defeats the final commit fence',async()=>{
  const {createInstallationRegistry}=await import('../../installations/repository.js'),registry=createInstallationRegistry(f.runtime)
  const observed=await page(),generation=await registry.currentGeneration()+1,blocker=await f.runtime.connect()
  let pending:ReturnType<typeof registry.applyDiscovery>|undefined
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT 1 FROM memory_installations WHERE installation_id=$1 FOR UPDATE',[personal])
   pending=registry.applyDiscovery({generation,items:observed.installations,sourceControlRevision:observed.control_revision})
   let blocked=false
   for(let n=0;n<100;n++){
    if((await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%INSERT INTO memory_installations%' LIMIT 1")).rowCount){blocked=true;break}
    await new Promise(resolve=>setTimeout(resolve,10))
   }
   expect(blocked).toBe(true)
   await f.pool.query('UPDATE public.extension_installations SET config_version=config_version+1 WHERE installation_id=$1',[personal])
   await blocker.query('COMMIT')
   await expect(pending).rejects.toThrow('native_inventory_changed')
   expect(await registry.currentGeneration()).toBe(generation-1)
   expect((await f.runtime.query('SELECT config_version::text FROM memory_installations WHERE installation_id=$1',[personal])).rows[0].config_version).toBe('3')
  }finally{await blocker.query('ROLLBACK');blocker.release();await pending?.catch(()=>undefined)}
 })
 test('durable control scheduling refreshes the finite native inventory before source work',async()=>{
  const {createNativeInstallationDiscovery}=await import('../../installations/native-discovery.js'),{createSharedSourceScheduler}=await import('../../sources/shared-scheduler.js')
  const extra=(await f.install(await f.source(),'from_now')).inst.installation_id
  await f.pool.query("UPDATE shared.memory_source_contract SET activation_ready=TRUE,target_profile='personal-relay-only',target_installations=$1::uuid[]",[[personal,organization]])
  expect((await page()).installations.map(i=>i.installation_id)).not.toContain(extra)
  const signal=new AbortController().signal,discovery=createNativeInstallationDiscovery({pool:f.runtime,signal}),errors:unknown[]=[]
  let refreshed=0
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'native-inventory-test',signal,onError:error=>errors.push(error),refreshInstallations:async()=>{refreshed++;await discovery.discoverOnce()}})
  try{
   await scheduler.runOnce();expect(errors).toEqual([]);expect(refreshed).toBeGreaterThan(0)
   expect((await f.runtime.query('SELECT config_version::text FROM memory_installations WHERE installation_id=$1',[personal])).rows[0].config_version).toBe('4')
   expect((await f.runtime.query('SELECT local_status FROM memory_installations WHERE installation_id=$1',[extra])).rows[0].local_status).toBe('degraded')
  }finally{await scheduler.stop();await discovery.stop()}
 })
 test('invalid page bounds fail and a disabled provider cannot supply active inventory',async()=>{
  await expect(page(null,129)).rejects.toThrow('invalid_native_inventory_page')
  await f.pool.query("UPDATE public.extension_providers SET status='disabled' WHERE provider_id='pocketctl-memory'")
  expect((await page()).installations).toEqual([])
 })
})
