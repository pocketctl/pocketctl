import pg from 'pg'
import Fastify from 'fastify'
import {randomUUID} from 'node:crypto'
import {beforeAll,beforeEach,afterEach,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {lifecyclePipelineFixture} from '../testing/lifecycle-pipeline-fixture.js'
import {registerReadRoutes} from '../api/read-routes.js'
import {registerMcpRoute} from '../mcp/server.js'
import {createCorsHostPolicy} from '../auth/cors-host-policy.js'
import {resolveLifecycleFrame,resolveLifecycleReadFrame} from '../context/lifecycle-frame.js'
import {consumptionGeneration} from '../context/consumption.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('public lifecycle reads (actual routes and automatic writer; synthetic provider)',()=>{
 let pool:pg.Pool,h:ReturnType<typeof lifecyclePipelineFixture>,f:Awaited<ReturnType<ReturnType<typeof lifecyclePipelineFixture>['fixture']>>,claim:string
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:5});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool);h=lifecyclePipelineFixture(pool)},60000)
 beforeEach(async()=>{f=await h.fixture();claim=(await h.ingest(f,'trains')).claimId!})
 afterEach(async()=>{await pool.query('DELETE FROM knowledge_claims WHERE installation_id=ANY($1::uuid[])',[[f.personal,f.team]]);await pool.query('DELETE FROM memory_installations WHERE installation_id=ANY($1::uuid[])',[[f.personal,f.team]])})
 afterAll(async()=>{await pool?.end()})
 function app(mode:'off'|'shadow'|'enabled'='enabled',mcp=false){
  const grant={version:'v2',installationId:f.personal,primaryInstallationId:f.personal,configVersion:'1',callerType:'web',scopeBindings:[{installation_id:f.personal,owner_scope_kind:'personal',owner_scope_id:f.personal,membership_id:null,membership_revision:'0',authorization_epoch:'1',permissions:['read']}]}
  const a=Fastify(),deps={pool,lifecycleMode:mode,guard:{guard:async()=>grant,guardV2:async()=>grant,guardMcp:async()=>grant} as never,policy:createCorsHostPolicy({allowedHosts:['localhost'],allowedOrigins:[],isProduction:false}),recallEmbeddingTimeoutMs:100,cursorSigningKey:'read-test',sharedScopesEnabled:true}
  if(mcp)registerMcpRoute(a,{...deps,providerVersion:'test'});else registerReadRoutes(a,deps)
  return a
 }
 test.each([['search',false],['search',true],['recall',false],['recall',true]] as const)('AC-25 public %s scoped=%s resolves scene and excludes wrong/off/foreign scopes',async(route,federated)=>{
  const a=app(),payload={query:'personal travel',scene_id:f.space,destination:'personal',...(federated?{scope_installation_ids:[f.personal]}:{})}
  const request=(body:Record<string,unknown>,server=a)=>server.inject({method:'POST',url:`/api/v1/memory/${route}`,headers:{authorization:'Bearer fixture'},payload:body})
  const ids=(response:any)=>{expect(response.statusCode,response.body).toBe(200);return(response.json()[route==='search'?'hits':'claims']??[]).map((item:any)=>item.claimId)}
  expect(ids(await request(payload))).toContain(claim)
  expect(ids(await request({...payload,scene_id:f.other}))).not.toContain(claim)
  expect(ids(await request({...payload,destination:'work'}))).not.toContain(claim)
  expect(ids(await request({...payload,scene_id:randomUUID()}))).not.toContain(claim)
  expect((await request({...payload,scope_installation_ids:[f.team]})).statusCode).toBe(400)
  await pool.query("UPDATE memory_curation_policies SET consume_mode='off',revision=revision+1 WHERE installation_id=$1",[f.personal])
  expect(ids(await request(payload))).not.toContain(claim)
  await pool.query("UPDATE memory_curation_policies SET consume_mode='enabled',mode='off',revision=revision+1 WHERE installation_id=$1",[f.personal])
  expect(ids(await request(payload))).toContain(claim)
  for(const mode of ['off','shadow'] as const){const disabled=app(mode);expect(ids(await request(payload,disabled))).not.toContain(claim);await disabled.close()}
  expect(ids(await request({...payload,scene_id:undefined}))).not.toContain(claim)
  await a.close()
 })
 test('AC-29 stateless reads leave active session bindings/generation untouched and honor recorded repository binding',async()=>{
  const frame=await resolveLifecycleFrame(pool,{installationId:f.personal,sessionId:f.session,repositoryId:null,spaceId:f.other,destination:'personal',mode:'enabled'}),generation=await consumptionGeneration(pool,f.personal)
  const a=app();const response=await a.inject({method:'POST',url:'/api/v1/memory/search',headers:{authorization:'Bearer fixture'},payload:{query:'personal travel',scene_id:f.space,destination:'personal'}})
  expect(response.statusCode,response.body).toBe(200)
  expect((await pool.query('SELECT binding FROM memory_session_scene_frames WHERE installation_id=$1 AND session_id=$2',[f.personal,f.session])).rows[0].binding).toBe(frame?.binding)
  expect(await consumptionGeneration(pool,f.personal)).toBe(generation)
  const repository=randomUUID();await pool.query("INSERT INTO repositories(repository_id,installation_id,repository_key,first_observed_at,last_observed_at) VALUES($1,$2,'fixture',NOW(),NOW())",[repository,f.personal])
  await pool.query('INSERT INTO memory_space_bindings(installation_id,space_id,repository_id) VALUES($1,$2,$3)',[f.personal,f.space,repository])
  expect(await resolveLifecycleReadFrame(pool,{installationId:f.personal,repositoryId:repository,destination:'personal',mode:'enabled'})).toMatchObject({spaceId:f.space,consume:true})
  expect(await resolveLifecycleReadFrame(pool,{installationId:f.team,repositoryId:repository,destination:'personal',mode:'enabled'})).toBeUndefined()
  await a.close()
 })
 test('AC-25 scene catalog is bounded, current, metadata-only and tenant authorized',async()=>{
  const a=app(),headers={authorization:'Bearer fixture'}
  const first=await a.inject({url:'/api/v1/memory/scenes',headers});expect(first.statusCode,first.body).toBe(200)
  expect(first.json()).toMatchObject({has_more:false,scenes:expect.arrayContaining([{id:f.space,name:'Personal travel',domain:'life',destinations:['personal']}])})
  expect(first.body).not.toContain('I prefer');expect((await a.inject({url:`/api/v1/memory/scenes?installation_id=${f.team}`,headers})).statusCode).toBe(400)
  await pool.query("UPDATE memory_spaces SET state='archived' WHERE installation_id=$1 AND space_id=$2",[f.personal,f.space])
  expect((await a.inject({url:'/api/v1/memory/scenes',headers})).json().scenes.some((s:any)=>s.id===f.space)).toBe(false)
  await pool.query("INSERT INTO memory_spaces(installation_id,name,domain,destinations) SELECT $1,'bounded-'||n,'life',ARRAY['personal'] FROM generate_series(1,101) n",[f.personal])
  const bounded=(await a.inject({url:'/api/v1/memory/scenes',headers})).json();expect(bounded.scenes).toHaveLength(100);expect(bounded.has_more).toBe(true);await a.close()
 })
 test.each([['memory_search',false],['memory_search',true],['memory_recall',false],['memory_recall',true]] as const)('AC-25 MCP %s scoped=%s shares authorized scene filtering',async(name,federated)=>{
  const a=app('enabled',true)
  const call=async(tool:string,args:unknown,server=a)=>{
   const response=await server.inject({method:'POST',url:'/mcp',headers:{authorization:'Bearer fixture','content-type':'application/json'},payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool,arguments:args}}})
   expect(response.statusCode,response.body).toBe(200)
   const body=response.body.startsWith('event:')||response.body.startsWith('data:')?response.body.split('\n').find(line=>line.startsWith('data:'))!.slice(5).trim():response.body
   const rpc=JSON.parse(body);expect(rpc.result?.isError,body).not.toBe(true);return JSON.parse(rpc.result.content[0].text)
  }
  const args={query:'personal travel',scene_id:f.space,destination:'personal',...(federated?{scope_installation_ids:[f.personal]}:{})},key=name==='memory_search'?'hits':'claims'
  expect((await call(name,args))[key].map((h:any)=>h.claimId)).toContain(claim)
  expect((await call(name,{...args,scene_id:f.other}))[key].map((h:any)=>h.claimId)).not.toContain(claim)
  expect((await call('memory_list_scenes',{})).scenes.map((s:any)=>s.id)).toContain(f.space)
  const off=app('off',true);expect((await call(name,args,off))[key].map((h:any)=>h.claimId)).not.toContain(claim)
  await off.close();await a.close()
 })
})
