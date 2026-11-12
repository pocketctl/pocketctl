import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {contextDeliveryClient,originContextFixture} from '../helpers/origin-context-fixture.js'
import {createLifecycleObservationService} from '../../claims/lifecycle-observation.js'

const url=process.env.DIRECT_LAUNCH_MEMORY_TEST_DATABASE_URL
const suite=url?describe:describe.skip
suite('native Context receipt coverage',()=>{
 let fixture:DirectLaunchFixture,installationId:string,sessionId:string,configVersion='1'
 let client:Awaited<ReturnType<typeof contextDeliveryClient>>
 const claimId=randomUUID(),versionId=randomUUID(),evidenceId=randomUUID()
 const repositoryId=randomUUID(),snapshotId=randomUUID(),spaceId=randomUUID(),commitSha='c'.repeat(40)
 const statement='An accepted Context receipt records a delivery only once.'
 beforeAll(async()=>{
  fixture=await directLaunchFixture(url!,{captureRelayControls:true})
  const owner=await fixture.source()
  installationId=(await fixture.install(owner,'retained_history')).inst.installation_id
  await fixture.pool.query("UPDATE public.extension_installations SET enabled_services=ARRAY['memory.manage','memory.context'] WHERE installation_id=$1",[installationId])
  await fixture.runtime.query("INSERT INTO memory_curation_policies(installation_id,mode,consume_mode) VALUES($1,'enabled','enabled')",[installationId])
  await fixture.runtime.query(`INSERT INTO repositories(repository_id,installation_id,repository_key,first_observed_at,last_observed_at)
   VALUES($1,$2,'context-receipt-fixture',now(),now())`,[repositoryId,installationId])
  await fixture.runtime.query(`INSERT INTO repo_snapshots(installation_id,repository_id,repo_snapshot_id,commit_sha,branch,observed_at)
   VALUES($1,$2,$3,$4,'main',now())`,[installationId,repositoryId,snapshotId,commitSha])
  await fixture.runtime.query(`INSERT INTO memory_spaces(installation_id,space_id,domain,name,destinations)
   VALUES($1,$2,'work','Context receipts',ARRAY['personal'])`,[installationId,spaceId])
  await fixture.runtime.query(`INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state)
   VALUES($1,$2,'test_invariant','repository',$3,'context-receipt-once','active')`,[claimId,installationId,repositoryId])
  await fixture.runtime.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence,repository_id,repo_snapshot_id,branch)
   VALUES($1,$2,$3,1,$4,'user_accepted',1,$5,$6,'main')`,[versionId,installationId,claimId,statement,repositoryId,snapshotId])
  await fixture.runtime.query('UPDATE knowledge_claims SET current_version_id=$1 WHERE claim_id=$2',[versionId,claimId])
  await fixture.runtime.query(`INSERT INTO memory_claim_lifecycle(installation_id,claim_id,kind,assertion_mode)
   VALUES($1,$2,'fact','verified')`,[installationId,claimId])
  await fixture.runtime.query(`WITH capsule AS (
   INSERT INTO knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash)
   VALUES(gen_random_uuid(),$1,$2,'user_accepted',sha256(convert_to($3,'UTF8'))) RETURNING capsule_id)
   INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,capsule_id,ordinal,evidence_kind,excerpt,excerpt_hash,occurred_at)
   SELECT $4,$1,$2,capsule_id,1,'accepted_excerpt',$3,sha256(convert_to($3,'UTF8')),clock_timestamp() FROM capsule`,[installationId,versionId,statement,evidenceId])
  const context=await originContextFixture(fixture.runtime,installationId,{sceneId:spaceId,repositoryId,commitSha,query:statement})
  sessionId=context.sessionId
  await fixture.publisher.query(`INSERT INTO public.sessions(session_id,daemon_id,user_id,agent_type,source,status)
   VALUES($1,$2,$3,'codex','terminal','running')`,[sessionId,owner.daemon,owner.owner])
  client=await contextDeliveryClient(fixture.runtime,context,installationId)
 },60000)
 afterAll(async()=>{await client?.close();await fixture?.close()})
 async function contextRequest(grant:string,path:string,body?:object,expectedStatus=200,signal?:AbortSignal){
  const headers:Record<string,string>={authorization:'Bearer '+grant}
  if(body)headers['content-type']='application/json'
  const response=await fetch(client.url+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,signal})
  const data=await response.json()
  expect(response.status,path.split('?')[0]+' '+JSON.stringify(data)).toBe(expectedStatus)
  return data
 }
 async function admitted(grant:string,signal?:AbortSignal){
  const turn={session_id:sessionId,client_request_id:randomUUID(),agent:'codex'}
  const compiled=await contextRequest(grant,'/compile',{
   ...turn,schema_version:1,adapter_capability:'native_hidden_v1',query:statement,
   repository_hint:{repository_id:repositoryId,commit_sha:commitSha},evidence_read_capability:'on_demand_v1',
  },200,signal)
  expect(compiled).toMatchObject({outcome:'ready',pack:{item_count:1}})
  const pack=compiled.pack.pack_id
  const path='/packs/'+pack
  const ticket=await contextRequest(grant,path+'/admit',{...turn,adapter:'codex-app-server'},200,signal)
  const injection=ticket.injection_id
  const query=new URLSearchParams({session_id:sessionId,injection_id:injection,nonce:ticket.nonce})
  return {injection,pack,textPath:path+'/text?'+query}
 }
 async function prepared(grant=client.issueGrant(configVersion),signal?:AbortSignal){
  const {injection,pack,textPath}=await admitted(grant,signal)
  const text=await contextRequest(grant,textPath,undefined,200,signal)
  expect(text.pack_id).toBe(pack)
  expect(text.stable_text+text.dynamic_text).toContain(statement)
  expect((await fixture.runtime.query(`SELECT state,native_delivery_authority_sha256 FROM memory_context_injections
   WHERE injection_id=$1`,[injection])).rows[0]).toMatchObject({state:'prepared',native_delivery_authority_sha256:expect.stringMatching(/^[0-9a-f]{64}$/)})
  return injection
 }
 const post=(injection:string,config=configVersion,delivered=true)=>fetch(client.url+'/injections/'+injection+'/receipt',{
  method:'POST',
  headers:{authorization:'Bearer '+client.issueGrant(config),'content-type':'application/json'},
  body:JSON.stringify({session_id:sessionId,delivered}),
 })
 const observation=async()=>(await fixture.runtime.query(`SELECT state,settings_hash,capability_since_at::text,last_native_delivery_at::text
  FROM memory_lifecycle_observation_windows WHERE installation_id=$1`,[installationId])).rows[0]
 const usage=async()=>(await fixture.runtime.query(`SELECT l.last_delivered_at::text,
  (SELECT count(*)::int FROM memory_claim_usage u WHERE u.installation_id=l.installation_id AND u.claim_id=l.claim_id AND u.signal='delivered') AS receipts
  FROM memory_claim_lifecycle l WHERE l.installation_id=$1 AND l.claim_id=$2`,[installationId,claimId])).rows[0]
 test('a duplicate signed receipt does not move the lifecycle coverage clock',async()=>{
  const injection=await prepared()
  const firstReplies=await Promise.all([post(injection),post(injection)])
  for(const response of firstReplies){
   expect(response.status).toBe(200)
   expect(await response.json()).toEqual({state:'delivered'})
  }
  const first=await observation(),firstUsage=await usage()
  expect(firstUsage).toMatchObject({last_delivered_at:first.last_native_delivery_at,receipts:1})
  expect(first.last_native_delivery_at).not.toBeNull()
  const replies=await Promise.all([post(injection),post(injection)])
  for(const duplicate of replies){
   expect(duplicate.status).toBe(200)
   expect(await duplicate.json()).toEqual({state:'delivered'})
  }
  const delivered=(await fixture.runtime.query('SELECT delivered_at::text FROM memory_context_injections WHERE injection_id=$1',[injection])).rows[0].delivered_at
  expect(first.last_native_delivery_at).toBe(delivered)
  expect(await observation()).toEqual(first)
  expect(await usage()).toEqual(firstUsage)
 })
 test('a signed personal v2 grant binds the actual text handoff',async()=>{
  const injection=await prepared(client.issuePersonalV2Grant(configVersion,'1'))
  const response=await post(injection)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({state:'delivered'})
 })
 test('an authority row locked by another transaction leaves the receipt retryable',async()=>{
  const injection=await prepared(),before=await observation(),native=await fixture.pool.connect()
  try{
   await native.query('BEGIN')
   await native.query("SELECT 1 FROM public.extension_providers WHERE provider_id='pocketctl-memory' FOR UPDATE")
   const blocked=await post(injection)
   expect(blocked.status).toBe(500)
   expect((await fixture.runtime.query('SELECT state FROM memory_context_injections WHERE injection_id=$1',[injection])).rows[0].state).toBe('prepared')
   expect(await observation()).toEqual(before)
  }finally{await native.query('ROLLBACK');native.release()}
  const retry=await post(injection)
  expect(retry.status).toBe(200)
  expect(await retry.json()).toEqual({state:'delivered'})
 })
 test('a busy Claim lifecycle row leaves receipt and new Context progress independent',async()=>{
  const injection=await prepared(),before=await observation(),beforeUsage=await usage(),other=await fixture.runtime.connect()
  try{
   await other.query('BEGIN')
   await other.query('SELECT 1 FROM memory_claim_lifecycle WHERE installation_id=$1 AND claim_id=$2 FOR UPDATE',[installationId,claimId])
   const started=performance.now()
   expect((await post(injection)).status).toBe(500)
   expect((await fixture.runtime.query('SELECT state FROM memory_context_injections WHERE injection_id=$1',[injection])).rows[0].state).toBe('prepared')
   expect(await observation()).toEqual(before)
   expect(await usage()).toEqual(beforeUsage)
   await prepared(client.issueGrant(configVersion),AbortSignal.timeout(750))
   expect(performance.now()-started).toBeLessThan(750)
  }finally{await other.query('ROLLBACK');other.release()}
  expect((await post(injection)).status).toBe(200)
  expect((await usage()).receipts).toBe(beforeUsage.receipts+1)
 })
 test('an old prepared injection cannot count as a delivery for the new authorization',async()=>{
  const injection=await prepared()
  await fixture.pool.query("UPDATE public.extension_installations SET authorization_epoch=2,config_version=2 WHERE installation_id=$1",[installationId])
  configVersion='2'
  const service=createLifecycleObservationService({pool:fixture.runtime,mode:'enabled'})
  await service.recordObservationHeartbeat({installationId})
  const before=await observation()
  expect(before.capability_since_at).toBeNull()
  const response=await post(injection,'2')
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({state:'delivered'})
  expect(await observation()).toEqual(before)
 })
 test('provider disable and re-enable cannot credit the preceding authority stamp',async()=>{
  const injection=await prepared()
  await fixture.pool.query("UPDATE public.extension_providers SET status='disabled' WHERE provider_id='pocketctl-memory'")
  await fixture.pool.query("UPDATE public.extension_providers SET status='enabled' WHERE provider_id='pocketctl-memory'")
  const service=createLifecycleObservationService({pool:fixture.runtime,mode:'enabled'})
  await service.recordObservationHeartbeat({installationId})
  const before=await observation()
  expect(before.capability_since_at).toBeNull()
  const response=await post(injection)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({state:'delivered'})
  expect(await observation()).toEqual(before)
  const fresh=await post(await prepared())
  expect(fresh.status).toBe(200)
  expect((await observation()).capability_since_at).not.toBeNull()
 })
 test('a late success cannot relabel an earlier terminal delivery failure',async()=>{
  const injection=await prepared()
  const failed=await post(injection,configVersion,false)
  expect(failed.status).toBe(200)
  expect(await failed.json()).toEqual({state:'delivery_failed'})
  const before=await observation()
  const retry=await post(injection)
  expect(retry.status).toBe(200)
  expect(await retry.json()).toEqual({state:'delivery_failed'})
  expect((await fixture.runtime.query('SELECT delivered_at FROM memory_context_injections WHERE injection_id=$1',[injection])).rows[0].delivered_at).toBeNull()
  expect(await observation()).toEqual(before)
 })
 test('v2 text handoff rechecks its epoch after the route guard has run',async()=>{
  await fixture.runtime.query('UPDATE memory_installations SET config_version=$2 WHERE installation_id=$1',[installationId,configVersion])
  const grant=client.issuePersonalV2Grant(configVersion,'2')
  const {injection,textPath}=await admitted(grant)
  client.beforeNextConsume(async()=>{
   await fixture.pool.query('UPDATE public.extension_installations SET authorization_epoch=3 WHERE installation_id=$1',[installationId])
  })
  expect(await contextRequest(grant,textPath,undefined,410)).toEqual({error:{code:'expired'}})
  const result=await fixture.runtime.query(`SELECT state,native_delivery_authority_sha256 FROM memory_context_injections
   WHERE injection_id=$1`,[injection])
  expect(result.rows).toEqual([{state:'expired',native_delivery_authority_sha256:null}])
 })
 test('missing Relay control capture leaves receipt history but cannot credit coverage',async()=>{
  const injection=await prepared(),before=await observation()
  await fixture.pool.query('ALTER TABLE public.extension_providers DISABLE TRIGGER memory_control_providers_update')
  try{
   const stale=await post(injection)
   expect(stale.status).toBe(200)
   expect(await stale.json()).toEqual({state:'delivered'})
   expect(await observation()).toEqual(before)
   const grant=client.issueGrant(configVersion),next=await admitted(grant)
   const text=await contextRequest(grant,next.textPath)
   expect(text.stable_text+text.dynamic_text).toContain(statement)
   const observed=await fixture.runtime.query('SELECT native_delivery_authority_sha256 FROM memory_context_injections WHERE injection_id=$1',[next.injection])
   expect(observed.rows).toEqual([{native_delivery_authority_sha256:null}])
  }finally{await fixture.pool.query('ALTER TABLE public.extension_providers ENABLE TRIGGER memory_control_providers_update')}
 })
 test('a delayed first receipt stays historical even with current signed authority',async()=>{
  const injection=await prepared(),before=await observation(),beforeUsage=await usage()
  await fixture.runtime.query(`UPDATE memory_context_injections SET native_delivery_prepared_at=clock_timestamp()-interval '6 minutes'
   WHERE injection_id=$1`,[injection])
  const response=await post(injection)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({state:'delivered'})
  expect(await observation()).toEqual(before)
  expect(await usage()).toEqual(beforeUsage)
 })
 test('a settings change before the first receipt cannot credit the earlier handoff',async()=>{
  await fixture.runtime.query('DELETE FROM memory_lifecycle_observation_windows WHERE installation_id=$1',[installationId])
  const injection=await prepared()
  for(const mode of ['off','enabled']){
   await fixture.runtime.query(`UPDATE memory_context_settings SET mode=$2,revision=revision+1
    WHERE installation_id=$1 AND scope_kind='installation' AND scope_key='global'`,[installationId,mode])
  }
  expect(await observation()).toBeUndefined()
  const response=await post(injection)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({state:'delivered'})
  expect(await observation()).toBeUndefined()
  const current=await post(await prepared())
  expect(current.status).toBe(200)
  expect((await observation()).last_native_delivery_at).not.toBeNull()
 })
})
