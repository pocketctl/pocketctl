import pg from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,test,vi} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {createDailyMaintenanceWorker} from '../maintenance/worker.js'
import {loadBusinessHealth} from '../reporting/business-health.js'
import * as daily from '../maintenance/daily.js'
import {createProviderBudgetStore,withTextProviderBudget} from '../model/provider-budget.js'
import type {TextGenerator} from '../ports/text-generator.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
const id='91919191-9191-4191-8191-919191919191'
suite('extraction failure history retention PostgreSQL',()=>{
 let pool:pg.Pool,episode:string
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:3});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{vi.restoreAllMocks();await pool?.end()})
 beforeEach(async()=>{
  vi.restoreAllMocks();vi.spyOn(daily,'dailyMaintenanceSlot').mockReturnValue(null)
  await pool.query('TRUNCATE memory_maintenance_runs,memory_installations CASCADE')
  await pool.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)`,[id])
  await pool.query(`INSERT INTO memory_feature_settings(installation_id,extraction_mode) VALUES($1,'enabled')`,[id])
  await pool.query(`INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'history-session',NOW(),NOW())`,[id])
  await pool.query(`INSERT INTO source_turns(installation_id,turn_id,session_id,state,terminal_at) VALUES($1,'history-turn','history-session','completed',NOW())`,[id])
  episode=(await pool.query(`INSERT INTO work_episodes(episode_id,installation_id,session_id,turn_id,state,compiler_version,summary,compiled_at,source_digest) VALUES(gen_random_uuid(),$1,'history-session','history-turn','ready','v1','{}',NOW(),'digest'::bytea) RETURNING episode_id`,[id])).rows[0].episode_id
  await pool.query(`INSERT INTO memory_maintenance_runs(scheduled_at,scope_key,stage) VALUES(date_trunc('second',NOW()),'global',3)`)
 })
 async function run(state:string,code:string|null,age=9){return(await pool.query(`INSERT INTO memory_extraction_runs(run_id,installation_id,episode_id,episode_source_digest,extractor_version,prompt_version,model_config_hash,input_digest,mode,state,provider,model,error_code,started_at,completed_at) VALUES(gen_random_uuid(),$1,$2,'digest'::bytea,gen_random_uuid()::text,'p','hash'::bytea,'hash'::bytea,'enabled',$3,'test','test',$4,NOW()-($5::int*INTERVAL '1 day'),NOW()-($5::int*INTERVAL '1 day')) RETURNING run_id`,[id,episode,state,code,age])).rows[0].run_id as string}
 async function maintenance(){const errors:unknown[]=[];const w=createDailyMaintenanceWorker({pool,signal:new AbortController().signal,inbox:{mode:'off',bodyDays:7,metadataDays:14,batchSize:2,intervalMs:60000},data:{mode:'enabled',bodyDays:14,batchSize:2,intervalMs:86400000},report:async()=>{},onError:e=>errors.push(e)});try{await w.runOnce()}finally{await w.stop()}expect(errors).toEqual([]);expect((await pool.query("SELECT state FROM memory_maintenance_runs WHERE scope_key='global'")).rows[0].state).toBe('completed')}
 async function ids(){return(await pool.query('SELECT run_id FROM memory_extraction_runs ORDER BY run_id')).rows.map(r=>r.run_id)}
 test('unresolved current failures older than seven days retain their health truth',async()=>{
  const failed=await run('failed','provider_result_unknown'),quarantine=await run('quarantined','invalid_output',10)
  expect(Number((await loadBusinessHealth(pool))[0].unresolved_extractions)).toBe(1)
  await maintenance();expect(await ids()).toEqual([failed,quarantine].sort())
  expect(Number((await loadBusinessHealth(pool))[0].unresolved_extractions)).toBe(1)
 })
 test('later source success alone never authorizes deleting prior failure history',async()=>{
  const failed=await run('quarantined','invalid_output'),success=await run('succeeded',null,1)
  await maintenance();expect(await ids()).toEqual([failed,success].sort())
 })
 test('unknown provider cost remains retained even after a later success',async()=>{
  const failed=await run('failed','provider_result_unknown'),success=await run('succeeded',null,1)
  await maintenance();expect(await ids()).toEqual([failed,success].sort())
 })
 test('a real budget-wrapped timeout retains both its uncertain fee and failed run after source recovery',async()=>{
  const failed=await run('failed','http_error')
  const provider={generateJson:async()=>({ok:false,code:'http_error',detail:'timeout',retryable:false})} as TextGenerator
  const generator=withTextProviderBudget(provider,createProviderBudgetStore(pool),{key:`retention-test:${failed}`,maxRequests:10,maxInputTokens:1000000,maxOutputTokens:100000,maxOutputTokensPerRequest:1000})
  const result=await generator.generateJson({operation:'candidate_extract',requestKey:`extraction:${failed}:candidate_extract`,system:'fixture',document:{},schema:{},timeoutMs:100,signal:new AbortController().signal})
  expect(result).toMatchObject({ok:false,code:'http_error',billingUncertain:true})
  const success=await run('succeeded',null,1)
  await maintenance();expect(await ids()).toEqual([failed,success].sort())
  expect((await pool.query('SELECT state FROM memory_provider_budget_reservations WHERE reservation_id=$1',[result.budgetReservationId])).rows[0].state).toBe('reserved')
 })
 test('changing the source digest alone does not resolve or retire a failed provider call',async()=>{
  const failed=await run('failed','network')
  await pool.query("UPDATE work_episodes SET source_digest='new'::bytea WHERE episode_id=$1",[episode])
  await maintenance();expect(await ids()).toEqual([failed])
 })
 test('later failed attempts cannot resolve an older failure',async()=>{
  const first=await run('failed','network'),later=await run('failed','network',1)
  await maintenance();expect(await ids()).toEqual([first,later].sort())
 })
})
