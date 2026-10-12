import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,test,vi} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {createExtractionRepository} from '../extraction/repository.js'
import {createCandidateExtractor,type ExtractionOutcome} from '../extraction/extractor.js'
import {createProviderBudgetStore,withTextProviderBudget} from '../model/provider-budget.js'
import {createJobRepository} from '../jobs/repository.js'
import {createJobWorker} from '../jobs/worker.js'
import type {TextGenerator} from '../ports/text-generator.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('budget waiting and positively proven recovery',()=>{
 let pool:pg.Pool,installation:string
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:8});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{
  await pool.query('TRUNCATE memory_installations CASCADE');await pool.query('TRUNCATE memory_provider_budget_reservations')
  installation=randomUUID()
  await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[installation])
  await pool.query("INSERT INTO memory_feature_settings(installation_id,extraction_mode,extraction_consent_fingerprint) VALUES($1,'enabled','current-consent')",[installation])
 })
 afterAll(async()=>{await pool?.end()})
 async function episode(){
  const id=randomUUID(),session=randomUUID(),turn=randomUUID(),digest=Buffer.alloc(32,7)
  await pool.query('INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,$2,NOW(),NOW())',[installation,session])
  await pool.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,source_digest,
    document,evidence_manifest,document_compiler_version,compiled_at,terminal_at,outcome)
    VALUES($1,$2,$3,$4,'ready','fixture',$5,'{}','{}','fixture',NOW(),NOW(),'completed')`,[installation,id,session,turn,digest])
  return {id,turn,digest}
 }
 const generator=()=>vi.fn(async()=>({ok:true as const,value:{candidates:[]},usage:{inputTokens:1,outputTokens:1,model:'fixture'}}))
 const extractor=(store:ReturnType<typeof createExtractionRepository>,generateJson:ReturnType<typeof generator>)=>createCandidateExtractor({store,textGenerator:{generateJson} as TextGenerator,provider:'fixture',model:'fixture',timeoutMs:1000})
 async function budgetProof(e:Awaited<ReturnType<typeof episode>>,errorCode='budget_exceeded'){
  const store=createExtractionRepository(pool),r=await store.reserveRun({installationId:installation,episodeId:e.id,sourceDigest:e.digest,
   extractorVersion:'proof',promptVersion:'proof',modelConfigHash:Buffer.alloc(32,1),mode:'enabled',provider:'fixture',model:'fixture',staleAfterMs:60000})
  await store.markRun({runId:r.runId,state:'failed',errorCode})
  return r.runId
 }
 async function bridge(outcome:ExtractionOutcome){
  const module=await import('../extraction/extractor.js') as unknown as {deferBudgetOutcome:(outcome:ExtractionOutcome)=>void}
  module.deferBudgetOutcome(outcome)
 }
 test('real worker keeps a rejected extraction pending and resumes exactly once when the daily budget opens',async()=>{
  const e=await episode(),jobs=createJobRepository(pool),budget=createProviderBudgetStore(pool),generateJson=generator()
  const limits={key:'resume',window:'daily-asia-shanghai' as const,maxRequests:1,maxInputTokens:100000,maxOutputTokens:100000,maxOutputTokensPerRequest:10}
  await budget.reserve({key:limits.key,kind:'text',window:limits.window,inputTokens:1,outputTokens:1,maxRequests:1,maxInputTokens:100000,maxOutputTokens:100000})
  const extract=createCandidateExtractor({store:createExtractionRepository(pool),textGenerator:withTextProviderBudget({generateJson} as TextGenerator,budget,limits),provider:'fixture',model:'fixture',timeoutMs:1000})
  const worker=createJobWorker({pool,jobs,workerId:'budget-owner',signal:new AbortController().signal})
  worker.register('extract_candidates',async(job,signal,ctx)=>{await bridge(await extract.extract({installationId:installation,turnId:String(job.payload.turn_id),signal,fence:ctx?.fence}))})
  await jobs.enqueueJob({installationId:installation,jobType:'extract_candidates',idempotencyKey:'resume',payload:{turn_id:e.turn}})
  await worker.tick()
  let row=(await pool.query("SELECT state,attempts,last_error_code,payload,available_at>clock_timestamp() AS delayed FROM memory_jobs WHERE idempotency_key='resume'")).rows[0]
  expect(row).toMatchObject({state:'pending',attempts:0,last_error_code:'budget_exceeded',delayed:true,payload:{budget_wait_count:1}})
  expect(generateJson).not.toHaveBeenCalled();await worker.tick();expect(generateJson).not.toHaveBeenCalled()
  await pool.query("UPDATE memory_provider_budget_reservations SET created_at=clock_timestamp()-interval '2 days' WHERE budget_key='resume'")
  await pool.query("UPDATE memory_jobs SET available_at=clock_timestamp() WHERE idempotency_key='resume'")
  await worker.tick();await worker.tick()
  row=(await pool.query("SELECT state,attempts FROM memory_jobs WHERE idempotency_key='resume'")).rows[0]
  expect(row).toEqual({state:'completed',attempts:1});expect(generateJson).toHaveBeenCalledTimes(1)
  expect((await pool.query("SELECT count(*)::int n FROM memory_extraction_runs WHERE state='succeeded'")).rows[0].n).toBe(1)
  expect((await pool.query('SELECT count(*)::int n FROM memory_usage_outbox')).rows[0].n).toBe(1)
  await worker.stop()
 })
 test('bounded recovery requires retained budget proof and remains idempotent after finished-job retention',async()=>{
  const e=await episode(),run=await budgetProof(e),store=createExtractionRepository(pool)
  expect(await store.recoverBudgetWaits({consentFingerprint:'current-consent',limit:1})).toBe(1)
  expect(await store.recoverBudgetWaits({consentFingerprint:'current-consent',limit:1})).toBe(0)
  const j=(await pool.query('SELECT idempotency_key,payload FROM memory_jobs')).rows[0]
  expect(j).toMatchObject({idempotency_key:`budget-recovery:${run}`,payload:{turn_id:e.turn,expected_source_digest:e.digest.toString('hex')}})
  await pool.query('DELETE FROM memory_jobs')
  expect(await store.recoverBudgetWaits({consentFingerprint:'current-consent',limit:1})).toBe(0)
 })
 test('recovery processes only its bounded batch and can advance through the remaining proofs',async()=>{
  for(let n=0;n<3;n++)await budgetProof(await episode())
  const store=createExtractionRepository(pool)
  expect(await store.recoverBudgetWaits({consentFingerprint:'current-consent',limit:2})).toBe(2)
  expect(await store.recoverBudgetWaits({consentFingerprint:'current-consent',limit:2})).toBe(1)
  expect(await store.recoverBudgetWaits({consentFingerprint:'current-consent',limit:2})).toBe(0)
  expect((await pool.query('SELECT count(*)::int n FROM memory_jobs')).rows[0].n).toBe(3)
 })
 test.each(['no_proof','different_digest','mode_off','wrong_consent','already_succeeded'])('recovery cannot invent work for %s',async condition=>{
  const e=await episode(),store=createExtractionRepository(pool)
  if(condition!=='no_proof'){
   const run=await budgetProof(e)
   if(condition==='different_digest')await pool.query('UPDATE work_episodes SET source_digest=$2 WHERE episode_id=$1',[e.id,Buffer.alloc(32,9)])
   if(condition==='mode_off')await pool.query("UPDATE memory_feature_settings SET extraction_mode='off' WHERE installation_id=$1",[installation])
   if(condition==='already_succeeded')await pool.query("UPDATE memory_extraction_runs SET state='succeeded' WHERE run_id=$1",[run])
  }
  expect(await store.recoverBudgetWaits({consentFingerprint:condition==='wrong_consent'?'obsolete':'current-consent'})).toBe(0)
  expect((await pool.query('SELECT count(*)::int n FROM memory_jobs')).rows[0].n).toBe(0)
 })
 test('a queued recovery rechecks its exact digest before any provider call',async()=>{
  const e=await episode(),store=createExtractionRepository(pool),generateJson=generator()
  await pool.query('UPDATE work_episodes SET source_digest=$2 WHERE episode_id=$1',[e.id,Buffer.alloc(32,9)])
  expect((await extractor(store,generateJson).extract({installationId:installation,turnId:e.turn,expectedSourceDigest:e.digest.toString('hex'),signal:new AbortController().signal})).kind).toBe('episode_missing')
  expect(generateJson).not.toHaveBeenCalled()
 })
 test.each(['syncing','paused'])('a temporarily %s installation retains work without dispatch until it becomes ready',async state=>{
  const e=await episode(),store=createExtractionRepository(pool),generateJson=generator(),extract=extractor(store,generateJson)
  if(state==='syncing')await pool.query("UPDATE memory_installations SET local_status='syncing' WHERE installation_id=$1",[installation])
  else await pool.query("UPDATE memory_installations SET relay_status='paused' WHERE installation_id=$1",[installation])
  const outcome=await extract.extract({installationId:installation,turnId:e.turn,signal:new AbortController().signal})
  expect(outcome.kind).toBe('deferred_source');expect(generateJson).not.toHaveBeenCalled()
  await expect(bridge(outcome)).rejects.toMatchObject({reason:'source_not_ready'})
  await pool.query("UPDATE memory_installations SET local_status='ready',relay_status='active' WHERE installation_id=$1",[installation])
  expect((await extract.extract({installationId:installation,turnId:e.turn,signal:new AbortController().signal})).kind).toBe('succeeded')
  expect(generateJson).toHaveBeenCalledTimes(1)
 })
 test.each(['different_digest','mode_off','consent_changed'])('run reservation rechecks %s after the initial source read',async change=>{
  const e=await episode(),store=createExtractionRepository(pool),generateJson=generator()
  const wrapped={...store,loadEpisodeForExtraction:async(...args:Parameters<typeof store.loadEpisodeForExtraction>)=>{
   const loaded=await store.loadEpisodeForExtraction(...args)
   if(change==='different_digest')await pool.query('UPDATE work_episodes SET source_digest=$2 WHERE episode_id=$1',[e.id,Buffer.alloc(32,9)])
   else if(change==='mode_off')await pool.query("UPDATE memory_feature_settings SET extraction_mode='off' WHERE installation_id=$1",[installation])
   else await pool.query("UPDATE memory_feature_settings SET extraction_consent_fingerprint='revoked' WHERE installation_id=$1",[installation])
   return loaded
  }}
  const extract=createCandidateExtractor({store:wrapped,textGenerator:{generateJson} as TextGenerator,provider:'fixture',model:'fixture',timeoutMs:1000,expectedConsentFingerprint:'current-consent'})
  expect((await extract.extract({installationId:installation,turnId:e.turn,signal:new AbortController().signal})).kind).toBe(change==='consent_changed'?'deferred_source':'episode_missing')
  expect(generateJson).not.toHaveBeenCalled()
 })
})
