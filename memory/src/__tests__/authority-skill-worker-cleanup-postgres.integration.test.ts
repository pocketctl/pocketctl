import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {createSkillGovernanceFixture} from '../testing/skill-fixture.js'
import {skillPublicationFixtureContext as context} from '../testing/skill-publication-fixture.js'
import {createJobRepository} from '../jobs/repository.js'
import {createSkillWorker} from '../skills/worker.js'
import {createPurgeRepository} from '../purge/repository.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const db=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
db('Skill worker restrictive cleanup joins installation purge',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{
  pool=new pg.Pool({connectionString:url,max:8});await assertMemoryTestDatabase(pool,url!)
  await pool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');await applyMemorySchema(pool)
 },60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool?.end()})
 async function claimed(kind:'personal'|'team'='personal'){
  const f=await createSkillGovernanceFixture(pool,context,kind)
  // Reclaim the real fixture's completed job to exercise the terminal callback
  // against its existing task/run. No provider or source is consumed by cleanup.
  await pool.query("UPDATE memory_jobs SET state='pending',claimed_by=NULL,claim_expires_at=NULL WHERE installation_id=$1 AND job_type='extract_skill_candidate'",[f.installationId])
  const claim=(await createJobRepository(pool).claimJobs({workerId:'cleanup-order-fixture',limit:1,leaseMs:30000}))[0]!
  return {f,claim,fence:{jobId:claim.job_id,claimedBy:'cleanup-order-fixture',claimEpoch:claim.claim_epoch}}
 }
 test('disabled worker cleanup and installation purge finish without a task/job deadlock',async()=>{
  const {f,claim,fence}=await claimed()
  let entered!:()=>void,release!:()=>void
  const reached=new Promise<void>(resolve=>{entered=resolve}),resume=new Promise<void>(resolve=>{release=resolve})
  let paused=false,purgePid:number|undefined,purgeFinished=false
  const cleanupPool={query:pool.query.bind(pool),connect:async()=>{
   const client=await pool.connect()
   return new Proxy(client,{get(target,key){if(key==='query')return async(...args:unknown[])=>{
    if(!paused&&typeof args[0]==='string'&&args[0].includes('FROM memory_jobs')&&args[0].includes('FOR UPDATE')){
     paused=true;entered();await resume
    }
    return Reflect.apply(target.query,target,args)
   };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
  }} as unknown as pg.Pool
  const purgePool={query:pool.query.bind(pool),connect:async()=>{
   const client=await pool.connect();purgePid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number
   return client
  }} as unknown as pg.Pool
  const disabledContext={...context,config:{...context.config,mode:'off' as const}}
  const cleanup=createSkillWorker({pool:cleanupPool,context:disabledContext}).handle(claim,new AbortController().signal,{fence})
   .then(()=>({ok:true}),error=>({ok:false,error}))
  let purge:Promise<{ok:boolean;error?:unknown}>|undefined
  try{
   await reached
   purge=createPurgeRepository(purgePool,{hmacKey:'isolated-worker-cleanup-test'}).purgeInstallation({installationId:f.installationId,requestId:randomUUID(),reason:'fixture privacy deletion'})
    .then(()=>{purgeFinished=true;return {ok:true}},error=>{purgeFinished=true;return {ok:false,error}})
   let observed=false
   for(let attempt=0;attempt<200;attempt++){
    if(purgeFinished||(purgePid&&(await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[purgePid])).rows[0].blocked)){
     observed=true;break
    }
    await new Promise(resolve=>setTimeout(resolve,10))
   }
   expect(observed).toBe(true);release()
   expect(await cleanup).toEqual({ok:true})
   expect(await purge).toEqual({ok:true})
   expect((await pool.query('SELECT local_status FROM memory_installations WHERE installation_id=$1',[f.installationId])).rows).toEqual([{local_status:'purged'}])
   expect((await pool.query('SELECT 1 FROM memory_skill_tasks WHERE installation_id=$1',[f.installationId])).rowCount).toBe(0)
  }finally{release();await cleanup;await purge}
 },15000)
 test('disabled cleanup remains legal when the Claim source has already expired',async()=>{
  const {f,claim,fence}=await claimed('team')
  await pool.query("UPDATE knowledge_versions SET valid_until=clock_timestamp()-interval '1 second' WHERE installation_id=$1",[f.installationId])
  await createSkillWorker({pool,context:{...context,config:{...context.config,mode:'off'}}}).handle(claim,new AbortController().signal,{fence})
  expect((await pool.query('SELECT state,error_code FROM memory_skill_task_runs WHERE installation_id=$1',[f.installationId])).rows).toEqual([{state:'cancelled',error_code:'skill_disabled'}])
  expect((await pool.query('SELECT state,last_error_code FROM memory_jobs WHERE job_id=$1',[claim.job_id])).rows).toEqual([{state:'completed',last_error_code:'skill_disabled'}])
 })
 test('provider-unavailable cleanup still records a failed task and durable dead letter',async()=>{
  const {f,claim,fence}=await claimed()
  await createSkillWorker({pool,context}).handle(claim,new AbortController().signal,{fence})
  expect((await pool.query('SELECT state FROM memory_skill_tasks WHERE installation_id=$1',[f.installationId])).rows).toEqual([{state:'dead'}])
  expect((await pool.query('SELECT state,last_error_code FROM memory_jobs WHERE job_id=$1',[claim.job_id])).rows).toEqual([{state:'dead',last_error_code:'skill_provider_unavailable'}])
  expect((await pool.query('SELECT error_code FROM memory_dead_letters WHERE job_id=$1',[claim.job_id])).rows).toEqual([{error_code:'skill_provider_unavailable'}])
 })
})
