import pg from 'pg'
import Fastify from 'fastify'
import {randomUUID} from 'node:crypto'
import {beforeAll,beforeEach,afterEach,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {registerManageRoutes} from '../api/manage-routes.js'
import {createCorsHostPolicy} from '../auth/cors-host-policy.js'
import type {GrantGuard} from '../auth/grant-guard.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('lifecycle management',()=>{
 let pool:pg.Pool,f:Awaited<ReturnType<typeof governanceFixture>>,caller:string,installation:string
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:5});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{f=await governanceFixture(pool);caller='web';installation=f.personal})
 afterEach(async()=>{await pool.query('DELETE FROM knowledge_claims WHERE installation_id=ANY($1::uuid[])',[[f.personal,f.team]]);await pool.query('DELETE FROM memory_installations WHERE installation_id=ANY($1::uuid[])',[[f.personal,f.team]])})
 afterAll(async()=>{await pool?.end()})
 function app(mode:'off'|'shadow'|'enabled'='enabled'){
  const a=Fastify();registerManageRoutes(a,{pool,lifecycleMode:mode,guard:{guard:async({authorization})=>{if(authorization!=='Bearer fixture')throw Error('denied');return{installationId:installation,callerType:caller,configVersion:'1',expiresAt:Date.now()/1000+120}}} as GrantGuard,
    policy:createCorsHostPolicy({allowedHosts:['localhost'],allowedOrigins:[],isProduction:false}),textConfigured:false,embeddingConfigured:false,tombstoneHmacKeys:[{version:'lifecycle-test',key:'lifecycle-management-test-key'.repeat(3)}]});return a
 }
 const headers=(key='protect')=>({authorization:'Bearer fixture','idempotency-key':key})
 test('AC-41 enabled_legacy_and_team_modes',async()=>{
  await pool.query("INSERT INTO memory_curation_policies(installation_id,mode) VALUES($1,'enabled')",[f.personal])
  const a=app();let r=await a.inject({url:'/api/v1/memory/lifecycle/status',headers:headers()});expect(r.statusCode,r.body).toBe(200);expect(r.json()).toMatchObject({personal:true,mode:'enabled',consume_mode:'off'})
  installation=f.team;r=await a.inject({url:'/api/v1/memory/lifecycle/status',headers:headers()});expect(r.json()).toMatchObject({personal:false,mode:'off'});await a.close()
  installation=f.personal;const off=app('off');expect((await off.inject({url:'/api/v1/memory/lifecycle/status',headers:headers()})).json().mode).toBe('off');await off.close()
 })
 test('AC-42 authority_metadata_and_tenant_isolation',async()=>{
  await pool.query("INSERT INTO memory_claim_lifecycle(installation_id,claim_id,kind,assertion_mode) VALUES($1,$2,'constraint','verified')",[f.personal,f.claim])
  const a=app();const r=await a.inject({url:`/api/v1/memory/claims/${f.claim}/lifecycle`,headers:headers()});expect(r.statusCode,r.body).toBe(200);expect(r.json()).toMatchObject({managed:true,authority:'user_accepted',body_state:'present',storage_tier:'hot',observation_state:'unknown',source_status:'unknown'});expect(r.body).not.toContain('Transactional fixture')
  await pool.query("UPDATE memory_claim_lifecycle SET storage_tier='cold',cold_since=clock_timestamp() WHERE installation_id=$1",[f.personal])
  const cold=await a.inject({url:'/api/v1/memory/lifecycle/claims?view=cold',headers:headers()});expect(cold.statusCode,cold.body).toBe(200);expect(cold.json()).toMatchObject({total_count:1,claims:[{claim_id:f.claim,storage_tier:'cold',body_state:'present'}]})
  await pool.query("UPDATE knowledge_claims SET state='expired' WHERE installation_id=$1",[f.personal])
  expect((await a.inject({url:'/api/v1/memory/lifecycle/claims?view=history',headers:headers()})).json()).toMatchObject({total_count:1,claims:[{state:'expired'}]})
  installation=f.team;expect((await a.inject({url:`/api/v1/memory/claims/${f.claim}/lifecycle`,headers:headers()})).statusCode).toBe(404)
  expect((await a.inject({url:'/api/v1/memory/lifecycle/claims?view=cold',headers:headers()})).json()).toMatchObject({total_count:0,claims:[]});await a.close()
 })
 test('AC-43 protection_cas_idempotency_revocation_and_stronger_protection',async()=>{
  await pool.query("INSERT INTO memory_claim_lifecycle(installation_id,claim_id,kind,assertion_mode) VALUES($1,$2,'constraint','verified')",[f.personal,f.claim])
  const a=app(),path=`/api/v1/memory/claims/${f.claim}/protection`,payload={expected_revision:1,protection:'pinned'}
  const submit=(key:string,body=payload)=>a.inject({method:'POST',url:path,headers:headers(key),payload:body})
  const first=await submit('first');expect(first.statusCode,first.body).toBe(200);expect((await submit('first')).json()).toEqual(first.json());expect((await submit('stale')).statusCode).toBe(409)
  expect((await submit('first',{expected_revision:2,protection:'none'})).statusCode).toBe(409)
  expect((await submit('unpin',{expected_revision:2,protection:'none'})).statusCode).toBe(200)
  await pool.query("UPDATE memory_claim_lifecycle SET protection='user_corrected' WHERE installation_id=$1",[f.personal]);expect((await submit('protected',{expected_revision:3,protection:'none'})).statusCode).toBe(409)
  caller='daemon';expect((await submit('first')).statusCode).toBe(403);expect((await submit('daemon',{expected_revision:3,protection:'none'})).statusCode).toBe(403);caller='web'
  await pool.query('UPDATE memory_installations SET config_version=2 WHERE installation_id=$1',[f.personal]);expect((await submit('first')).statusCode).toBe(403);expect((await a.inject({url:'/api/v1/memory/lifecycle/status',headers:headers()})).statusCode).toBe(403);await a.close()
 })
 test('AC-46 failures_and_zero_conclusion_remain_distinct AC-47 metadata_only',async()=>{
  const bundle=randomUUID(),run=randomUUID();await pool.query(`INSERT INTO memory_task_bundles(installation_id,bundle_id,task_key,session_id,source_digest,watermark,state,reason_code) VALUES($1,$2,'secret-task-path','secret-session',decode(repeat('ab',32),'hex'),1,'failed','credential-canary')`,[f.personal,bundle])
  await pool.query(`INSERT INTO memory_curation_runs(installation_id,run_id,bundle_id,bundle_revision,source_digest,policy_revision,policy_hash,model_config_hash,mode,state,error_code,input_tokens,output_tokens) VALUES($1,$2,$3,1,decode(repeat('ab',32),'hex'),1,repeat('a',64),repeat('b',64),'enabled','provider_result_unknown','provider-credential-canary',100,20)`,[f.personal,run,bundle])
  await pool.query('UPDATE memory_curation_runs SET result=$2::jsonb WHERE run_id=$1',[run,JSON.stringify([{rejections:['value_unsupported','private-rejection-canary'],statement:'secret-model-body'}])])
  await pool.query(`INSERT INTO memory_source_processing_receipts(installation_id,session_id,turn_id,source_digest,policy_version,disposition,allowed_count,excluded_count,complete) VALUES($1,'secret-session','secret-turn',decode(repeat('ab',32),'hex'),'v1','no_durable_conclusion',1,0,true)`,[f.personal])
  const a=app(),r=await a.inject({url:'/api/v1/memory/lifecycle/status',headers:headers()});expect(r.statusCode,r.body).toBe(200);expect(r.json()).toMatchObject({bundles:{failed:1,completed:0},runs:{provider_result_unknown:1},receipts:{no_durable_conclusion:1},usage:{input_tokens:100,output_tokens:20}})
  expect(r.json().validation_rejections).toEqual({value_unsupported:1,unknown:1})
  for(const secret of ['credential-canary','secret-session','secret-task-path','secret-turn','private-rejection-canary','secret-model-body'])expect(r.body).not.toContain(secret)
  installation=f.team;expect((await a.inject({url:'/api/v1/memory/lifecycle/status',headers:headers()})).json()).toMatchObject({records:[],bundles:{failed:0}});await a.close()
 })
})
