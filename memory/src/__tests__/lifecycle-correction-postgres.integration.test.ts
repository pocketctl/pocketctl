import pg from 'pg'
import {randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {registerManageRoutes} from '../api/manage-routes.js'
import {createCorsHostPolicy} from '../auth/cors-host-policy.js'
import type {GrantGuard} from '../auth/grant-guard.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('normal claim correction lifecycle protection',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool?.end()})
 async function fixture(managed=true){
  const f=await governanceFixture(pool)
  await pool.query("INSERT INTO memory_curation_policies(installation_id,mode) VALUES($1,'enabled')",[f.personal])
  const bundle=randomUUID(),run=randomUUID()
  await pool.query("INSERT INTO memory_task_bundles(installation_id,bundle_id,session_id,task_key,source_digest,watermark,state) VALUES($1,$2,'correction','correction',decode(repeat('ab',32),'hex'),1,'completed')",[f.personal,bundle])
  await pool.query("INSERT INTO memory_curation_runs(installation_id,run_id,bundle_id,bundle_revision,source_digest,policy_revision,policy_hash,model_config_hash,mode,state) VALUES($1,$2,$3,1,decode(repeat('ab',32),'hex'),1,repeat('a',64),repeat('b',64),'enabled','completed')",[f.personal,run,bundle])
  await pool.query("INSERT INTO memory_curation_decisions(installation_id,run_id,action,idempotency_key,claim_id,version_id,reason_code,state) VALUES($1,$2,'create','correction-fixture',$3,$4,'fixture','committed')",[f.personal,run,f.claim,f.version])
  await pool.query("UPDATE knowledge_versions SET authority='machine_concluded' WHERE version_id=$1",[f.version])
  if(managed)await pool.query("UPDATE knowledge_versions SET structured_content=$2::jsonb WHERE version_id=$1",[f.version,JSON.stringify({value:30,predicate:'timeout',conditions:{unit:'seconds'},lifecycle:{logical_key:'a'.repeat(64),space_id:randomUUID(),source_kind:'task_bundle',bundle_id:bundle}})])
  if(managed)await pool.query("INSERT INTO memory_claim_lifecycle(installation_id,claim_id,kind,assertion_mode,storage_tier,cold_since) VALUES($1,$2,'constraint','verified','cold',clock_timestamp()-interval '1 day')",[f.personal,f.claim])
  const app=Fastify();registerManageRoutes(app,{pool,lifecycleMode:'enabled',guard:{guard:async()=>({installationId:f.personal,callerType:'web',configVersion:'1',expiresAt:Date.now()/1000+120})} as unknown as GrantGuard,
   policy:createCorsHostPolicy({allowedHosts:['localhost'],allowedOrigins:[],isProduction:false}),textConfigured:false,embeddingConfigured:false,tombstoneHmacKeys:[]})
  const episode=(await pool.query('SELECT episode_id FROM work_episodes WHERE installation_id=$1',[f.personal])).rows[0].episode_id
  const payload={expected_revision:1,statement:'Human corrected transactional invariant.',evidence:[{evidence_kind:'episode',episode_id:episode,locator:{},excerpt:'Human reviewed corrected invariant',occurred_at:new Date().toISOString()}]}
  const submit=(revision=1,key='correction')=>app.inject({method:'POST',url:`/api/v1/memory/claims/${f.claim}/correct`,headers:{authorization:'Bearer fixture','idempotency-key':key},payload:{...payload,expected_revision:revision}})
  return{...f,app,submit}
 }
 test('AC-21 normal API protects an automatic cold claim and exposes the new correction as hot',async()=>{
  const f=await fixture()
  try{
   const response=await f.submit();expect(response.statusCode,response.body).toBe(200)
   const row=(await pool.query(`SELECT l.kind,l.assertion_mode,l.protection,l.storage_tier,l.cold_since,l.body_state,v.authority,v.statement,v.structured_content,v.body_state AS version_body_state
    FROM memory_claim_lifecycle l JOIN knowledge_claims c USING(installation_id,claim_id) JOIN knowledge_versions v ON v.version_id=c.current_version_id WHERE c.claim_id=$1`,[f.claim])).rows[0]
   expect(row).toMatchObject({kind:'constraint',assertion_mode:'user_asserted',protection:'user_corrected',storage_tier:'hot',cold_since:null,body_state:'present',version_body_state:'present',authority:'user_corrected',statement:'Human corrected transactional invariant.'})
   expect(row.structured_content.value).toBeUndefined()
   expect(row.structured_content.conditions).toBeUndefined()
   expect(row.structured_content.lifecycle.logical_key).toBe('a'.repeat(64))
   expect(row.structured_content.manual_correction).toEqual({previous_version_id:f.version,semantic_fields:'unparsed'})
   expect((await pool.query('SELECT structured_content FROM knowledge_versions WHERE version_id=$1',[f.version])).rows[0].structured_content.value).toBe(30)
   expect((await f.submit()).json()).toEqual(response.json())
   expect((await f.submit(1,'stale')).statusCode).toBe(409)
   expect((await pool.query('SELECT count(*)::int n FROM knowledge_versions WHERE claim_id=$1',[f.claim])).rows[0].n).toBe(2)
  }finally{await f.app.close()}
 })
 test('AC-21 legacy correction keeps human authority without inventing lifecycle kind',async()=>{
  const f=await fixture(false)
  try{
   const response=await f.submit();expect(response.statusCode,response.body).toBe(200)
   expect((await pool.query('SELECT count(*)::int n FROM memory_claim_lifecycle WHERE claim_id=$1',[f.claim])).rows[0].n).toBe(0)
   expect((await pool.query('SELECT authority FROM knowledge_versions WHERE version_id=$1',[response.json().version_id])).rows[0].authority).toBe('user_corrected')
  }finally{await f.app.close()}
 })
})
