import pg from 'pg'
import Fastify from 'fastify'
import {registerManageRoutes} from '../api/manage-routes.js'
import {createCorsHostPolicy} from '../auth/cors-host-policy.js'
import type {GrantGuard} from '../auth/grant-guard.js'
import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {createCandidateExtractor} from '../extraction/extractor.js'
import {loadBusinessHealth,evaluateBusinessHealth} from '../reporting/business-health.js'
import {createExtractionRepository} from '../extraction/repository.js'
import {listExtractionIssues,scheduleExtractionRetry} from '../extraction/recovery.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('personal extraction recovery',()=>{
 let pool:pg.Pool
 const id=randomUUID(),ep=randomUUID(),run=randomUUID()
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:4});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},30000)
 afterAll(async()=>{if(pool){await pool.query('DELETE FROM memory_installations WHERE installation_id=$1',[id]);await pool.end()}})
 beforeEach(async()=>{
  await pool.query('DELETE FROM memory_installations WHERE installation_id=$1',[id])
  await pool.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version,last_ack_at) VALUES($1,'pocketctl-memory','active','ready',1,NOW())`,[id])
  await pool.query(`INSERT INTO memory_feature_settings(installation_id,extraction_mode,extraction_consent_fingerprint) VALUES($1,'enabled','model-consent')`,[id])
  await pool.query(`INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'session-1',NOW(),NOW())`,[id])
  await pool.query(`INSERT INTO source_turns(installation_id,turn_id,session_id,state,terminal_at) VALUES($1,'turn-1','session-1','completed',NOW())`,[id])
  await pool.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,source_digest,compiled_at) VALUES($1,$2,'session-1','turn-1','ready','v1','x'::bytea,NOW())`,[id,ep])
  await pool.query(`INSERT INTO memory_extraction_runs(run_id,installation_id,episode_id,episode_source_digest,extractor_version,prompt_version,model_config_hash,input_digest,mode,state,provider,model,error_code,started_at,completed_at) VALUES($1,$2,$3,'x'::bytea,'v1','v1','x'::bytea,'x'::bytea,'enabled','quarantined','test','test','invalid_output:candidates.0.claim_type:invalid_value',NOW()-interval '11 minutes',NOW()-interval '10 minutes')`,[run,id,ep])
 })
 const options=()=>({installationId:id,runId:run,consentFingerprint:'model-consent'})
 async function schedule(){const c=await pool.connect();try{await c.query('BEGIN');const out=await scheduleExtractionRetry(c,options());await c.query('COMMIT');return out}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}
 test('lists safe reason and schedules once under concurrency',async()=>{
  expect((await listExtractionIssues(pool,id,'model-consent')).issues).toEqual([expect.objectContaining({run_id:run,reason:'invalid_claim_type',can_retry:true,status:'unresolved'})])
  const [a,b]=await Promise.all([schedule(),schedule()]);expect(a.job_id).toBe(b.job_id)
  expect((await pool.query('SELECT count(*)::int n FROM memory_jobs WHERE installation_id=$1',[id])).rows[0].n).toBe(1)
  expect((await listExtractionIssues(pool,id,'model-consent')).issues[0]).toMatchObject({status:'pending',can_retry:false})
 })
 test('retry preserves quarantine, bypasses original one-run cap and dedupes redelivery',async()=>{
  const job=await schedule(),repo=createExtractionRepository(pool)
  const args={installationId:id,episodeId:ep,sourceDigest:Buffer.from('x'),extractorVersion:'v1',promptVersion:'v1',modelConfigHash:Buffer.from('x'),mode:'enabled' as const,provider:'test',model:'test',staleAfterMs:60000,maxRunsPerEpisode:1,expectedConsentFingerprint:'model-consent',userRetry:{runId:run,jobId:job.job_id}}
  await expect(repo.reserveRun(args)).rejects.toThrow('retry_not_authorized')
  await pool.query(`UPDATE memory_jobs SET state='running' WHERE job_id=$1`,[job.job_id])
  const a=await repo.reserveRun(args);expect(a.owner).toBe(true)
  expect((await repo.reserveRun(args)).owner).toBe(false)
  expect((await pool.query('SELECT state FROM memory_extraction_runs WHERE run_id=$1',[run])).rows[0].state).toBe('quarantined')
  await pool.query(`UPDATE memory_extraction_runs SET state='succeeded',completed_at=NOW() WHERE run_id=$1`,[a.runId])
  expect((await listExtractionIssues(pool,id,'model-consent')).issues).toEqual([])
 })

 test('real extractor keeps a repeated invalid result and clears only after a later successful retry',async()=>{
  let valid=false,calls=0
  const extractor=createCandidateExtractor({store:createExtractionRepository(pool),provider:'test',model:'test',timeoutMs:1000,
    expectedConsentFingerprint:'model-consent',maxRunsPerEpisode:1,textGenerator:{generateJson:async<T>()=>{
      calls++;return {ok:true,value:{candidates:valid?[]:[{claim_type:'unsupported'}]} as T,usage:{model:'test',inputTokens:10,outputTokens:5}}
    }}})
  const first=await schedule()
  await pool.query(`UPDATE memory_jobs SET state='running' WHERE job_id=$1`,[first.job_id])
  const failure=await extractor.extract({installationId:id,turnId:'turn-1',signal:new AbortController().signal,userRetry:{runId:run,jobId:first.job_id}})
  expect(failure.kind).toBe('quarantined');expect(calls).toBe(2)
  await pool.query(`UPDATE memory_jobs SET state='completed' WHERE job_id=$1`,[first.job_id])
  let issue=(await listExtractionIssues(pool,id,'model-consent')).issues[0]
  expect(issue.run_id).not.toBe(run);expect(issue.can_retry).toBe(true)
  expect(evaluateBusinessHealth((await loadBusinessHealth(pool)).find(r=>r.installation_id===id)!).reasons).toContain('extraction_failed')
  const c=await pool.connect();let second
  try{await c.query('BEGIN');second=await scheduleExtractionRetry(c,{...options(),runId:issue.run_id});await c.query('COMMIT')}finally{c.release()}
  valid=true;await pool.query(`UPDATE memory_jobs SET state='running' WHERE job_id=$1`,[second.job_id])
  expect((await extractor.extract({installationId:id,turnId:'turn-1',signal:new AbortController().signal,userRetry:{runId:issue.run_id,jobId:second.job_id}})).kind).toBe('succeeded')
  expect(calls).toBe(3);expect((await listExtractionIssues(pool,id,'model-consent')).issues).toEqual([])
  expect(evaluateBusinessHealth((await loadBusinessHealth(pool)).find(r=>r.installation_id===id)!).reasons).not.toContain('extraction_failed')
  expect((await pool.query('SELECT count(*)::int n FROM memory_extraction_runs WHERE installation_id=$1',[id])).rows[0].n).toBe(3)
 })
 test.each(['deleted','changed','reclaimed','disabled','consent','unknown'])('rejects %s without scheduling',async kind=>{
  if(kind==='deleted')await pool.query(`UPDATE source_sessions SET deleted_at=NOW() WHERE installation_id=$1`,[id])
  if(kind==='changed')await pool.query(`UPDATE work_episodes SET source_digest='y'::bytea WHERE installation_id=$1`,[id])
  if(kind==='reclaimed')await pool.query(`UPDATE work_episodes SET body_reclaimed_at=NOW() WHERE installation_id=$1`,[id])
  if(kind==='disabled')await pool.query(`UPDATE memory_feature_settings SET extraction_mode='off' WHERE installation_id=$1`,[id])
  if(kind==='consent')await pool.query(`UPDATE memory_feature_settings SET extraction_consent_fingerprint='old' WHERE installation_id=$1`,[id])
  if(kind==='unknown')await pool.query(`UPDATE memory_extraction_runs SET state='failed',error_code='provider_result_unknown' WHERE run_id=$1`,[run])
  await expect(schedule()).rejects.toThrow()
  expect((await pool.query('SELECT count(*)::int n FROM memory_jobs WHERE installation_id=$1',[id])).rows[0].n).toBe(0)
 })
 test('cross-installation target cannot be retried',async()=>{
  const c=await pool.connect();try{await expect(scheduleExtractionRetry(c,{...options(),installationId:randomUUID()})).rejects.toThrow()}finally{c.release()}
 })
 test('retry limit survives queue retention and a newer failed attempt keeps issue actionable',async()=>{
  for(let n=0;n<3;n++)await pool.query(`INSERT INTO memory_extraction_runs(run_id,installation_id,episode_id,episode_source_digest,extractor_version,prompt_version,model_config_hash,input_digest,mode,state,provider,model,error_code,retry_key,started_at,completed_at)
    VALUES(gen_random_uuid(),$1,$2,'x'::bytea,'v1','v1','x'::bytea,'x'::bytea,'enabled','quarantined','test','test','invalid_output',gen_random_uuid(),NOW()+($3*interval '1 second'),NOW())`,[id,ep,n])
  const issue=(await listExtractionIssues(pool,id,'model-consent')).issues[0]
  expect(issue).toMatchObject({retry_count:3,can_retry:false,blocked_reason:'retry_limit'})
  const c=await pool.connect();try{await expect(scheduleExtractionRetry(c,{...options(),runId:issue.run_id})).rejects.toThrow()}finally{c.release()}
 })
 test('routes enforce grant, receipt key, safe body and exact target',async()=>{
  const app=Fastify()
  registerManageRoutes(app,{pool,guard:{guard:async({authorization,requiredService})=>{
   expect(requiredService).toBe('memory.manage');if(authorization!=='Bearer test')throw Error('denied')
   return {installationId:id,configVersion:'1',expiresAt:Date.now()/1000+60}
  }} as GrantGuard,policy:createCorsHostPolicy({allowedHosts:['localhost'],allowedOrigins:[],isProduction:false}),textConfigured:true,embeddingConfigured:false,extractionAdapter:{provider:'test',origin:'https://test.invalid',model:'test',fingerprint:'model-consent',pricing_configured:true},tombstoneHmacKeys:[]})
  const path=`/api/v1/memory/extraction-issues/${run}/retry`
  expect((await app.inject({method:'GET',url:'/api/v1/memory/extraction-issues'})).statusCode).not.toBe(200)
  const headers={authorization:'Bearer test','idempotency-key':'retry-test'}
  expect((await app.inject({method:'POST',url:path,headers:{authorization:headers.authorization},payload:{}})).statusCode).toBe(400)
  const a=await app.inject({method:'POST',url:path,headers,payload:{}});expect(a.statusCode).toBe(200)
  const b=await app.inject({method:'POST',url:path,headers,payload:{}});expect(b.json()).toEqual(a.json())
  expect((await app.inject({method:'POST',url:path,headers,payload:{force:true}})).statusCode).toBe(400)
  expect((await app.inject({method:'POST',url:`/api/v1/memory/extraction-issues/${randomUUID()}/retry`,headers:{...headers,'idempotency-key':'other'},payload:{}})).statusCode).toBe(404)
  await pool.query(`UPDATE memory_installations SET config_version=2 WHERE installation_id=$1`,[id])
  expect((await app.inject({method:'POST',url:path,headers,payload:{}})).statusCode).toBe(403)
  await app.close()
 })

})
