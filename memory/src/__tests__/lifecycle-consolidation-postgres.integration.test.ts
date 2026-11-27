import {createPurgeRepository} from '../purge/repository.js'
import {settleNativeStage} from '../jobs/stage-recovery.js'
import {inspectCurationRecovery,recoverDueCurationCheckpoints} from '../curation/recover-checkpoints.js'
import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {beforeAll,beforeEach,afterAll,describe,test,expect,vi} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {createReviewService} from '../claims/review-service.js'
import {createClaimRepository} from '../claims/repository.js'
import {SourceUnavailableError} from '@pocketctl/session-source'
import * as execution from '../sources/source-execution.js'
import {annotateSourceFailure} from '../sources/diagnostics.js'
import {reconcileExpiredCurationRuns} from '../curation/reconcile-expired.js'
import {lifecycleStatus} from '../curation/status.js'
import {createCurationExecutor} from '../curation/executor.js'
import {createCurationWorker,curationTransaction} from '../curation/worker.js'
import {createWindowCheckpoints} from '../curation/call-checkpoints.js'
import {extractDialogueConclusions} from '../curation/dialogue-extraction.js'
import {createProviderBudgetStore,withTextProviderBudget} from '../model/provider-budget.js'
import {drainTextProvider,ProviderDrain} from '../model/provider-drain.js'
import {createSourceProjector} from '../projection/source-projector.js'
import {stageLifecycleTurn} from '../curation/task-repository.js'
import {canonicalPayloadHash} from '../inbox/canonical-json.js'
import type {TextGenerator} from '../ports/text-generator.js'
import type {JobClaim} from '../jobs/types.js'
import {createExtractionRepository} from '../extraction/repository.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('lifecycle consolidation transaction (synthetic provider, not model acceptance)',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 const success=(tasks:unknown[]=[])=>({ok:true,value:{tasks},usage:{inputTokens:20,outputTokens:5,model:'synthetic'}})
 async function fixture(unknown=false,text='I prefer concise answers.'){
  const f=await governanceFixture(pool),id=randomUUID(),session='consolidation-session',turn='consolidation-turn'
  const payload={text},proof={version:1,producer:'claude',session_id:session,turn_id:turn,event_id:'event-1',sequence:'1',invocation_id:'user-input',source_role:'user',skill_state:'non_skill',lineage_complete:true,derived_from_event_ids:[]}
  await pool.query("INSERT INTO memory_curation_policies(installation_id,mode) VALUES($1,'enabled')",[f.personal])
  await pool.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,source_provenance)
   VALUES($1,$2,'feed','1',$3,$4,'user_text',clock_timestamp(),$5,$6,$7)`,[id,f.personal,session,turn,payload,canonicalPayloadHash(payload),{memory:proof}])
  if(unknown){const data={text:'UNKNOWN_EXCLUDED_CANARY'};await pool.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash) VALUES(gen_random_uuid(),$1,'feed','2',$2,$3,'user_text',clock_timestamp(),$4,$5)`,[f.personal,session,turn,data,canonicalPayloadHash(data)])}
  const client=await pool.connect()
  try{await client.query('BEGIN');const events=(await client.query('SELECT * FROM source_events WHERE installation_id=$1',[f.personal])).rows
   await stageLifecycleTurn(client,{installationId:f.personal,sessionId:session,turnId:turn,events},{mode:'enabled',revision:1,authorizationEpoch:'1',version:'memory-lifecycle-v1'});await client.query('COMMIT')
  }finally{client.release()}
  const job=(await pool.query("SELECT * FROM memory_jobs WHERE installation_id=$1 AND job_type='consolidate_task'",[f.personal])).rows[0] as JobClaim
  return {...f,id,payload,job,bundleId:String(job.payload.bundle_id)}
 }
 test('a bundle revision closes its old pending job atomically with staging the successor',async()=>{
  const f=await fixture()
  const c=await pool.connect()
  try{
   const events=(await c.query('SELECT * FROM source_events WHERE installation_id=$1',[f.personal])).rows
   const newPayload={text:'Updated preference.'}
   events[0]={...events[0],payload:newPayload,payload_hash:canonicalPayloadHash(newPayload)}
   const stage=()=>stageLifecycleTurn(c,{installationId:f.personal,sessionId:'consolidation-session',turnId:'consolidation-turn',events},
    {mode:'enabled',revision:1,authorizationEpoch:'1',version:'memory-lifecycle-v1'})
   const jobs=async()=>(await c.query(`SELECT state,last_error_code,completed_at IS NOT NULL AS finished
    FROM memory_jobs WHERE installation_id=$1 AND job_type='consolidate_task' ORDER BY payload->>'bundle_revision'`,[f.personal])).rows
   await c.query('BEGIN')
   await stage()
   await c.query('ROLLBACK')
   const pending={state:'pending',last_error_code:null,finished:false}
   expect(await jobs()).toEqual([pending])
   await c.query('BEGIN')
   await stage()
   await stage()
   await c.query('COMMIT')
   expect(await jobs()).toEqual([{state:'completed',last_error_code:'bundle_revision_superseded',finished:true},pending])
  }finally{await c.query('ROLLBACK');c.release()}
 })
 const worker=(generator:TextGenerator)=>createCurationWorker({pool,mode:'enabled',textGenerator:generator,modelFingerprint:'synthetic-v1'})
 const signal=()=>new AbortController().signal
 test('fresh canonical feed source reaches shadow once and preserves formal content',async()=>{
  const f=await governanceFixture(pool),session='fresh-shadow-session',turn='fresh-shadow-turn'
  await pool.query("INSERT INTO memory_curation_policies(installation_id,mode) VALUES($1,'shadow')",[f.personal])
  const snapshot=async()=>JSON.stringify((await pool.query(`SELECT to_jsonb(c) AS claim,to_jsonb(v) AS claim_version,to_jsonb(e) AS evidence FROM knowledge_claims c JOIN knowledge_versions v USING(installation_id,claim_id) JOIN knowledge_evidence e USING(installation_id,version_id) WHERE c.installation_id=$1 ORDER BY c.claim_id,v.version_id,e.evidence_id`,[f.personal])).rows)
  const before=await snapshot(),payload={text:'This isolated input contains no durable conclusion.'}
  const proof={version:1,producer:'claude',session_id:session,turn_id:turn,event_id:'input:synthetic-dispatch',sequence:'1',invocation_id:'input:synthetic-dispatch',source_role:'user',skill_state:'non_skill',lineage_complete:true,derived_from_event_ids:[]}
  await pool.query(`INSERT INTO memory_feed_inbox(installation_id,feed_id,envelope_version,topic,source_kind,source_id,session_id,turn_id,event_type,recorded_at,classification,data,payload_hash) VALUES($1,1,1,'session.event.v1','canonical_event','event:synthetic',$2,$3,'user_text',clock_timestamp(),$4,$5,$6)`,[f.personal,session,turn,{memory_source:proof},payload,canonicalPayloadHash(payload)])
  const projector=createSourceProjector(pool)
  expect(await projector.projectOnce(f.personal)).toEqual({projected:1})
  const events=(await pool.query('SELECT * FROM source_events WHERE installation_id=$1',[f.personal])).rows
  expect(events[0].source_provenance.memory).toEqual(proof)
  const client=await pool.connect()
  try{await client.query('BEGIN');await stageLifecycleTurn(client,{installationId:f.personal,sessionId:session,turnId:turn,events},{mode:'shadow',revision:1,authorizationEpoch:'1',version:'memory-lifecycle-v1'});await client.query('COMMIT')}finally{client.release()}
  const job=(await pool.query("SELECT * FROM memory_jobs WHERE installation_id=$1 AND job_type='consolidate_task'",[f.personal])).rows[0]
  const generate=vi.fn(async()=>success()),w=createCurationWorker({pool,mode:'shadow',textGenerator:{generateJson:generate} as TextGenerator,modelFingerprint:'synthetic-shadow-fixture'})
  await w.consolidate(job,signal());await w.consolidate(job,signal())
  expect(generate).toHaveBeenCalledTimes(1)
  expect((await pool.query('SELECT state,mode FROM memory_curation_runs WHERE installation_id=$1',[f.personal])).rows).toEqual([{state:'completed',mode:'shadow'}])
  expect((await pool.query('SELECT disposition,complete,allowed_count FROM memory_source_processing_receipts WHERE installation_id=$1',[f.personal])).rows).toEqual([{disposition:'no_durable_conclusion',complete:false,allowed_count:1}])
  expect((await pool.query('SELECT count(*)::int n FROM memory_candidates WHERE installation_id=$1',[f.personal])).rows[0].n).toBe(0)
  expect((await lifecycleStatus(pool,f.personal,'shadow')).records[0]).toMatchObject({run_result_state:'committed',publication_state:'not_published'})
  expect(await snapshot()).toBe(before)
 })
 test('nonempty shadow conclusion is visible read-only with exact evidence and scope fences',async()=>{
  const f=await fixture(),space=randomUUID()
  await pool.query("UPDATE memory_curation_policies SET mode='shadow' WHERE installation_id=$1",[f.personal])
  await pool.query("INSERT INTO memory_spaces(installation_id,space_id,domain,name,destinations) VALUES($1,$2,'profile','preferences',ARRAY['personal'])",[f.personal,space])
  const conclusion={kind:'preference',confirmed:true,subject:'self',predicate:'user.preference',value:'concise answers',conditions:{},assertion_mode:'user_asserted',fact_at:null,valid_until:null,statement:f.payload.text,evidence:{subject:[f.id],predicate:[f.id],value:[f.id]}}
  const generate=vi.fn(async()=>success([{space_id:space,task_id:null,spans:[{event_id:f.id,quote:f.payload.text}],conclusions:[conclusion]}]))
  const w=createCurationWorker({pool,mode:'shadow',textGenerator:{generateJson:generate} as TextGenerator,modelFingerprint:'synthetic'})
  await w.consolidate(f.job,signal());await w.consolidate(f.job,signal())
  const review=createReviewService(pool,createClaimRepository(pool))
  const page=await review.shadowQueuePage({installationId:f.personal})
  expect(page.total_count).toBe(1);expect(page.candidates[0]).toMatchObject({status:'shadow',statement:f.payload.text,evidence:[{excerpt:f.payload.text}],source_kind:'task_bundle',read_only:true})
  const status=await lifecycleStatus(pool,f.personal,'shadow')
  expect(status.records.map(r=>r.publication_state)).toEqual(['not_published','not_published'])
  expect((await review.reviewQueuePage({installationId:f.personal})).total_count).toBe(0)
  expect((await review.shadowQueuePage({installationId:f.team})).total_count).toBe(0)
  await expect(review.shadowQueuePage({installationId:f.team,cursor:page.candidates[0].candidate_id})).rejects.toThrow('invalid_cursor')
  expect(generate).toHaveBeenCalledTimes(1)
  expect((await pool.query("SELECT count(*)::int n FROM memory_curation_decisions WHERE installation_id=$1",[f.personal])).rows[0].n).toBe(0)
  expect((await pool.query("SELECT count(*)::int n FROM knowledge_claims WHERE installation_id=$1",[f.personal])).rows[0].n).toBe(1)
  await pool.query("UPDATE memory_task_bundles SET revision=revision+1 WHERE installation_id=$1 AND bundle_id=$2",[f.personal,f.bundleId])
  expect((await review.shadowQueuePage({installationId:f.personal})).total_count).toBe(0)
 })
 test('quoted model evidence persists numeric spans for downstream workers',async()=>{
  const f=await fixture(),space=randomUUID()
  await pool.query("INSERT INTO memory_spaces(installation_id,space_id,domain,name,destinations) VALUES($1,$2,'profile','preferences',ARRAY['personal'])",[f.personal,space])
  const generate=vi.fn(async()=>success([{space_id:space,task_id:null,spans:[{event_id:f.id,quote:f.payload.text}],conclusions:[]}]))
  await worker({generateJson:generate} as TextGenerator).consolidate(f.job,signal())
  const rows=(await pool.query("SELECT spans FROM memory_task_bundles WHERE installation_id=$1 AND bundle_kind='task'",[f.personal])).rows
  expect(rows).toEqual([{spans:[{event_id:f.id,start:0,end:f.payload.text.length}]}])
  expect((await pool.query('SELECT count(*)::int n FROM memory_candidates')).rows[0].n).toBe(0)
 })
 test('AC-16 zero conclusion receives complete coverage without a fabricated candidate',async()=>{
  const f=await fixture(),generate=vi.fn(async()=>success())
  await worker({generateJson:generate} as TextGenerator).consolidate(f.job,signal())
  expect((await pool.query('SELECT disposition,complete,allowed_count FROM memory_source_processing_receipts')).rows).toEqual([{disposition:'no_durable_conclusion',complete:true,allowed_count:1}])
  expect((await lifecycleStatus(pool,f.personal,'enabled')).records[0]).toMatchObject({run_result_state:'committed',publication_state:'not_published'})
  expect((await pool.query('SELECT count(*)::int n FROM memory_candidates')).rows[0].n).toBe(0)
  await worker({generateJson:generate} as TextGenerator).consolidate(f.job,signal())
  expect(generate).toHaveBeenCalledTimes(1)
 })
 test('AC-05 unknown source is excluded from provider and never complete coverage',async()=>{
  const f=await fixture(true),generate=vi.fn(async()=>success())
  await worker({generateJson:generate} as TextGenerator).consolidate(f.job,signal())
  expect(JSON.stringify(generate.mock.calls)).not.toContain('UNKNOWN_EXCLUDED_CANARY')
  expect((await pool.query('SELECT disposition,complete FROM memory_source_processing_receipts')).rows).toEqual([{disposition:'provenance_unknown',complete:false}])
 })
 test('AC-15 known budget block retries the same run under current authority',async()=>{
  const f=await fixture(),generate=vi.fn().mockResolvedValueOnce({ok:false,code:'budget_exceeded',retryable:true}).mockResolvedValueOnce(success())
  const w=worker({generateJson:generate} as TextGenerator)
  await expect(w.consolidate(f.job,signal())).rejects.toThrow('source_not_ready')
  const {run_id:runId}=(await pool.query('SELECT run_id FROM memory_curation_runs')).rows[0]
  await pool.query('UPDATE memory_owner_scopes SET authorization_epoch=2 WHERE installation_id=$1',[f.personal])
  await pool.query("UPDATE memory_task_bundles SET next_evaluate_at=clock_timestamp()-interval '1 second'")
  await w.consolidate(f.job,signal())
  expect(generate).toHaveBeenCalledTimes(2)
  expect((await pool.query('SELECT run_id,state,claim_epoch,authorization_epoch FROM memory_curation_runs')).rows).toEqual([{run_id:runId,state:'completed',claim_epoch:'2',authorization_epoch:'2'}])
 })
 test('an existing usage receipt forbids reopening a budget-blocked curation run',async()=>{
  const f=await fixture(),generate=vi.fn().mockResolvedValueOnce({ok:false,code:'budget_exceeded',retryable:true})
  const w=worker({generateJson:generate} as TextGenerator)
  await expect(w.consolidate(f.job,signal())).rejects.toThrow('source_not_ready')
  await pool.query(`INSERT INTO memory_usage_outbox(installation_id,usage_id,operation,model,occurred_at)
   SELECT installation_id,'curation:'||run_id::text,'curation','synthetic',clock_timestamp() FROM memory_curation_runs`)
  await pool.query("UPDATE memory_task_bundles SET next_evaluate_at=clock_timestamp()-interval '1 second'")
  await expect(w.consolidate(f.job,signal())).rejects.toThrow('curation_budget_usage_already_recorded')
  expect(generate).toHaveBeenCalledTimes(1)
  expect((await pool.query('SELECT state,claim_epoch FROM memory_curation_runs')).rows).toEqual([{state:'blocked',claim_epoch:'1'}])
 })
 test('a primary timeout followed by fallback budget refusal is held instead of retried as free budget waiting',async()=>{
  const f=await fixture(),generate=vi.fn(async()=>({ok:false,code:'budget_exceeded',retryable:false,timeoutFallback:{primary:{code:'http_error',detail:'timeout',billingUncertain:true,budgetReservationId:'synthetic-reservation'}}}))
  const w=worker({generateJson:generate} as unknown as TextGenerator)
  await w.consolidate(f.job,signal());await w.consolidate(f.job,signal())
  expect(generate).toHaveBeenCalledTimes(1)
  expect((await pool.query('SELECT state,error_code FROM memory_curation_runs')).rows).toEqual([{state:'provider_result_unknown',error_code:'provider_result_unknown'}])
 })
 test('a primary timeout followed by fallback budget refusal is held instead of retried as free budget waiting',async()=>{
  const f=await fixture(),generate=vi.fn(async()=>({ok:false,code:'budget_exceeded',retryable:false,timeoutFallback:{primary:{code:'http_error',detail:'timeout',billingUncertain:true,budgetReservationId:'synthetic-reservation'}}}))
  const w=worker({generateJson:generate} as unknown as TextGenerator)
  await w.consolidate(f.job,signal());await w.consolidate(f.job,signal())
  expect(generate).toHaveBeenCalledTimes(1)
  expect((await pool.query('SELECT state,error_code FROM memory_curation_runs')).rows).toEqual([{state:'provider_result_unknown',error_code:'provider_result_unknown'}])
 })
 test('long consolidation renews the run while its queue claim is live',async()=>{
  const f=await fixture()
  const fence={jobId:f.job.job_id,claimedBy:'lease-test',claimEpoch:1}
  await pool.query(`UPDATE memory_jobs SET state='running',claimed_by=$2,claim_epoch=1,
   claim_expires_at=clock_timestamp()+interval '30 seconds' WHERE job_id=$1`,[fence.jobId,fence.claimedBy])
  let renewed=false
  const generate=vi.fn(async()=>{
   // Advance the run's age in PostgreSQL and trigger the next timer tick.
   await pool.query(`UPDATE memory_curation_runs SET started_at=clock_timestamp()-interval '5 minutes',
    claim_expires_at=clock_timestamp()+interval '30 seconds'`)
   await vi.advanceTimersByTimeAsync(60000)
   for(let i=0;i<100&&!renewed;i++){
    renewed=(await pool.query("SELECT claim_expires_at>clock_timestamp()+interval '4 minutes' AS live FROM memory_curation_runs")).rows[0].live
    if(!renewed)await new Promise(resolve=>setTimeout(resolve,10))
   }
   return success()
  })
  vi.useFakeTimers({toFake:['setInterval','clearInterval']})
  try{await worker({generateJson:generate} as TextGenerator).consolidate(f.job,signal(),fence)}
  finally{vi.useRealTimers()}
  expect(renewed).toBe(true)
  expect(generate).toHaveBeenCalledTimes(1)
  expect((await pool.query('SELECT state FROM memory_curation_runs')).rows).toEqual([{state:'completed'}])
  expect((await pool.query("SELECT count(*)::int n FROM memory_usage_outbox WHERE operation='curation'")).rows[0].n).toBe(1)
 })
 test('a replaced run claim keeps its deadline and bundle when the old response arrives',async()=>{
  const f=await fixture(),fence={jobId:f.job.job_id,claimedBy:'old-owner',claimEpoch:1}
  await pool.query("UPDATE memory_jobs SET state='running',claimed_by=$2,claim_epoch=1,claim_expires_at=now()+interval '30 seconds' WHERE job_id=$1",[fence.jobId,fence.claimedBy])
  let deadline:string|undefined
  const generate=vi.fn(async()=>{
   deadline=(await pool.query(`UPDATE memory_curation_runs SET claim_epoch=claim_epoch+1,
    claim_expires_at=clock_timestamp()+interval '20 seconds' RETURNING claim_expires_at::text`)).rows[0].claim_expires_at
   await vi.advanceTimersByTimeAsync(60000)
   return success()
  })
  vi.useFakeTimers({toFake:['setInterval','clearInterval']})
  try{await expect(worker({generateJson:generate} as TextGenerator).consolidate(f.job,signal(),fence)).rejects.toThrow('curation_lease_lost')}
  finally{vi.useRealTimers()}
  const run=(await pool.query('SELECT state,error_code,claim_expires_at::text FROM memory_curation_runs')).rows[0]
  expect(run).toEqual({state:'running',error_code:null,claim_expires_at:deadline})
  expect((await pool.query('SELECT state FROM memory_task_bundles WHERE bundle_id=$1',[f.bundleId])).rows[0].state).toBe('running')
 })
 test.each(['expired_run','reclaimed_job'])('heartbeat cannot revive %s',async scenario=>{
  const f=await fixture(),fence={jobId:f.job.job_id,claimedBy:'lease-test',claimEpoch:1}
  await pool.query("UPDATE memory_jobs SET state='running',claimed_by=$2,claim_epoch=1,claim_expires_at=now()+interval '30 seconds' WHERE job_id=$1",[fence.jobId,fence.claimedBy])
  let deadline:string|undefined
  const generate=vi.fn(async()=>{
   if(scenario==='reclaimed_job')await pool.query("UPDATE memory_jobs SET claimed_by='successor',claim_epoch=2 WHERE job_id=$1",[fence.jobId])
   const seconds=scenario==='expired_run'?-1:20
   deadline=(await pool.query(`UPDATE memory_curation_runs SET claim_expires_at=clock_timestamp()+$1*interval '1 second'
    RETURNING claim_expires_at::text`,[seconds])).rows[0].claim_expires_at
   await vi.advanceTimersByTimeAsync(60000)
   return success()
  })
  vi.useFakeTimers({toFake:['setInterval','clearInterval']})
  try{
   const work=worker({generateJson:generate} as TextGenerator).consolidate(f.job,signal(),fence)
   if(scenario==='reclaimed_job')await expect(work).rejects.toThrow('job fence no longer owned')
   else await work
  }finally{vi.useRealTimers()}
  const run=(await pool.query('SELECT state,claim_expires_at::text,result FROM memory_curation_runs')).rows[0]
  expect(run).toEqual({state:'failed',claim_expires_at:deadline,result:null})
  expect(generate).toHaveBeenCalledTimes(1)
 })
 test('AC-15 expired publication lease preserves the returned charge and never repeats the provider call',async()=>{
  const f=await fixture(),generate=vi.fn(async()=>{await pool.query("UPDATE memory_curation_runs SET claim_expires_at=clock_timestamp()-interval '1 second'");return success()})
  const w=worker({generateJson:generate} as TextGenerator)
  await w.consolidate(f.job,signal())
  expect((await pool.query('SELECT state,error_code FROM memory_curation_runs')).rows[0]).toEqual({state:'failed',error_code:'lease_expired'})
  expect((await pool.query('SELECT count(*)::int n FROM memory_source_processing_receipts WHERE complete')).rows[0].n).toBe(0)
  await w.consolidate(f.job,signal())
  expect(generate).toHaveBeenCalledTimes(1)
  expect((await pool.query('SELECT state,error_code FROM memory_curation_runs')).rows[0]).toEqual({state:'completed',error_code:null})
  expect((await pool.query('SELECT count(*)::int n FROM memory_source_processing_receipts WHERE complete')).rows[0].n).toBe(1)
 })
 test('a returned charge survives pin renewal denial, with the original publication diagnosis and no second call',async()=>{
  const f=await fixture(), guard=vi.spyOn(execution,'guardSourceExecutionCommit')
  const generate=vi.fn(async()=>{
   guard.mockRejectedValueOnce(annotateSourceFailure(new SourceUnavailableError('processing_pin_expired_or_unavailable'),'pin_renew','authority_or_version_changed'))
   return {...success(),usage:{inputTokens:2007,outputTokens:273,model:'synthetic'}}
  })
  const w=worker({generateJson:generate} as TextGenerator)
  try{
   await expect(w.consolidate(f.job,signal())).rejects.toThrow('processing_pin_expired_or_unavailable')
   const status=await lifecycleStatus(pool,f.personal,'enabled')
   expect(status.records.find(r=>r.bundle_id===f.bundleId)).toMatchObject({state:'blocked',run_state:'failed',
    run_reason:'processing_pin_expired_or_unavailable',source_stage:'pin_renew',source_reason:'authority_or_version_changed',
    accounting_state:'recorded',publication_state:'not_published',automatic_model_retry:false,input_tokens:2007,output_tokens:273})
   await w.consolidate(f.job,signal())
   // A software/config refresh between claims must not mint a paid retry.
   await createCurationWorker({pool,mode:'enabled',textGenerator:{generateJson:generate} as TextGenerator,modelFingerprint:'updated'}).consolidate(f.job,signal())
   expect(generate).toHaveBeenCalledTimes(1)
   expect((await pool.query("SELECT count(*)::int n FROM memory_usage_outbox WHERE operation='curation'")).rows[0].n).toBe(1)
   expect((await pool.query('SELECT state,result FROM memory_curation_runs')).rows).toEqual([{state:'completed',result:[]}])
   expect((await pool.query('SELECT count(*)::int n FROM memory_source_processing_receipts WHERE complete')).rows[0].n).toBe(1)
  }finally{guard.mockRestore()}
 })
 test('a late known response refines only its own previously expired claim',async()=>{
  const f=await fixture()
  const generate=vi.fn(async()=>{
   await pool.query("UPDATE memory_jobs SET state='dead' WHERE job_id=$1",[f.job.job_id])
   await pool.query("UPDATE memory_curation_runs SET claim_expires_at=now()-interval '1 second'")
   expect(await reconcileExpiredCurationRuns(pool)).toBe(1)
   return success()
  })
  const w=worker({generateJson:generate} as TextGenerator)
  await expect(w.consolidate(f.job,signal())).rejects.toThrow('curation_lease_lost')
  expect((await pool.query('SELECT state,error_code,result FROM memory_curation_runs')).rows).toEqual([{state:'failed',error_code:'curation_lease_lost',result:null}])
  expect((await pool.query('SELECT state,reason_code FROM memory_task_bundles WHERE bundle_id=$1',[f.bundleId])).rows[0]).toEqual({state:'blocked',reason_code:'curation_lease_lost'})
  await w.consolidate(f.job,signal())
  expect(generate).toHaveBeenCalledTimes(1)
 })
 test.each([true,false])('lost publication COMMIT acknowledgment with server commit=%s follows its durable outcome',async(committed)=>{
  const f=await fixture(),generate=vi.fn(async()=>success()),w=worker({generateJson:generate} as TextGenerator)
  const original=pg.Client.prototype.query
  let publication:pg.Client|undefined
  // Drop the acknowledgment only for the actual publication transaction.
  const query=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:unknown[]){
   const sql=args[0]
   if(typeof sql==='string'&&sql.includes("UPDATE memory_curation_runs SET state='completed'"))publication=this
   if(sql==='COMMIT'&&this===publication){
    publication=undefined
    return this.query(committed?'COMMIT':'ROLLBACK').then(()=>{throw Object.assign(Error('connection closed'),{code:'ECONNRESET'})})
   }
   return Reflect.apply(original,this,args)
  } as typeof original)
  try{await expect(w.consolidate(f.job,signal())).rejects.toThrow('curation_commit_outcome_unknown')}
  finally{query.mockRestore()}
  const initial=(await pool.query('SELECT state,error_code FROM memory_curation_runs')).rows[0]
  expect(initial).toEqual(committed?{state:'completed',error_code:null}:{state:'running',error_code:'provider_response_received'})
  expect((await lifecycleStatus(pool,f.personal,'enabled')).records[0]).toMatchObject({
   accounting_state:'recorded',run_result_state:committed?'committed':'pending',publication_state:'not_published',automatic_model_retry:false})

  await pool.query("UPDATE memory_curation_runs SET claim_expires_at=now()-interval '1 second'")
  await w.consolidate(f.job,signal())
  expect(generate).toHaveBeenCalledTimes(1)
  expect((await pool.query('SELECT state,error_code FROM memory_curation_runs')).rows[0]).toEqual({state:'completed',error_code:null})
  expect((await pool.query('SELECT count(*)::int n FROM memory_source_processing_receipts WHERE complete')).rows[0].n).toBe(1)
 })
 test('AC-16 source change during provider call cannot commit old output',async()=>{
  const f=await fixture(),generate=vi.fn(async()=>{const payload={text:'changed body'};await pool.query('UPDATE source_events SET payload=$2,payload_hash=$3 WHERE source_event_id=$1',[f.id,payload,canonicalPayloadHash(payload)]);return success()})
  await expect(worker({generateJson:generate} as TextGenerator).consolidate(f.job,signal())).rejects.toThrow('curation_source_changed')
  expect((await pool.query("SELECT count(*)::int n FROM memory_curation_runs WHERE state='completed'")).rows[0].n).toBe(0)
  expect((await pool.query('SELECT state,error_code,result FROM memory_curation_runs')).rows).toEqual([{state:'failed',error_code:'curation_source_changed',result:null}])
  expect((await pool.query('SELECT input_tokens::text,output_tokens::text FROM memory_curation_runs')).rows).toEqual([{input_tokens:'20',output_tokens:'5'}])
  expect((await pool.query("SELECT input_tokens::text,output_tokens::text FROM memory_usage_outbox WHERE operation='curation'")).rows).toEqual([{input_tokens:'20',output_tokens:'5'}])
  await expect(worker({generateJson:generate} as TextGenerator).consolidate(f.job,signal())).rejects.toThrow('curation_source_changed')
  expect(generate).toHaveBeenCalledTimes(1)
 })
 test('AC-15 semantic deadline closes without another model call or operational-success disguise',async()=>{
  const f=await fixture(),generate=vi.fn(async()=>success([{space_id:null,task_id:null,spans:[{event_id:f.id,start:0,end:f.payload.text.length}],conclusions:[]}]))
  const w=worker({generateJson:generate} as TextGenerator)
  await expect(w.consolidate(f.job,signal())).rejects.toThrow('source_not_ready')
  await pool.query("UPDATE memory_task_bundles SET semantic_deadline=clock_timestamp()-interval '1 second'")
  await w.consolidate(f.job,signal())
  expect(generate).toHaveBeenCalledTimes(1)
  expect((await pool.query('SELECT state FROM memory_task_bundles WHERE bundle_id=$1',[f.bundleId])).rows[0].state).toBe('skipped_unresolved')
 })

 test('a budget denial after a billed window reuses its response and admits exactly the missing call',async()=>{
  const text='a'.repeat(65000),f=await fixture(false,text),run=randomUUID(),requests:string[]=[]
  await pool.query(`INSERT INTO memory_curation_runs(installation_id,run_id,bundle_id,bundle_revision,source_digest,policy_revision,policy_hash,model_config_hash,mode,state,checkpoint_protocol)
    SELECT installation_id,$2,bundle_id,revision,source_digest,1,repeat('a',64),repeat('b',64),'enabled','running',1 FROM memory_task_bundles WHERE bundle_id=$1`,[f.bundleId,run])
  const raw={generateJson:vi.fn(async(p:{requestKey:string})=>{requests.push(p.requestKey);return success()})} as unknown as TextGenerator
  const guarded=async<T>(work:(c:pg.PoolClient)=>Promise<T>)=>{
   const result=await curationTransaction(pool,f.personal,f.bundleId,async c=>({data:await work(c)}))
   if(!result)throw Error('source_changed')
   return result.data
  }
  async function extract(maxRequests:number){
   const generator=drainTextProvider(withTextProviderBudget(raw,createProviderBudgetStore(pool),{
    key:run,maxRequests,maxInputTokens:10_000_000,maxOutputTokens:10_000,maxOutputTokensPerRequest:1000}),new ProviderDrain())!
   const runWindow=createWindowCheckpoints({pool,installation:f.personal,run,runEpoch:1,modelHash:'b'.repeat(64),generator,routeMatches:true,bindings:{tasks:{},spaces:{}},
    owned:guarded,dispatch:guarded,receipt:guarded,witnesses:[]})
   return extractDialogueConclusions(generator,{sources:[{id:f.id,text,role:'user'}],spaces:[],tasks:[],requestKey:run,signal:signal(),now:new Date()},runWindow)
  }
  expect(await extract(1)).toMatchObject({ok:false,code:'budget_exceeded'})
  const calls=async()=>(await pool.query('SELECT window_index,state,call_id,budget_reservation_id FROM memory_curation_calls ORDER BY window_index')).rows
  const before=await calls()
  expect(before.map(c=>c.state)).toEqual(['saved','intended'])
  expect(before[0].call_id).not.toBe(before[1].call_id)
  expect(await extract(2)).toMatchObject({ok:true,usage:{inputTokens:40,outputTokens:10}})
  const after=await calls()
  expect(after.map(c=>c.state)).toEqual(['saved','saved'])
  expect(after.every(c=>c.budget_reservation_id)).toBe(true)
  expect(requests).toEqual(before.map(c=>'curation-call:'+c.call_id))
  expect((await pool.query('SELECT input_tokens::int,output_tokens::int FROM memory_curation_runs')).rows).toEqual([{input_tokens:40,output_tokens:10}])
  expect((await pool.query("SELECT count(*)::int n,sum(input_tokens)::int AS tokens FROM memory_usage_outbox WHERE operation='curation'")).rows[0]).toEqual({n:2,tokens:40})
 })

 test('a crash after budget reservation but before the send marker can reuse only that reserved window',async()=>{
  const f=await fixture(),send=vi.fn(async()=>success())
  const generator=drainTextProvider(withTextProviderBudget({generateJson:send} as TextGenerator,createProviderBudgetStore(pool),
   {key:f.personal,maxRequests:1,maxInputTokens:1_000_000,maxOutputTokens:100,maxOutputTokensPerRequest:100}),new ProviderDrain())!
  const w=worker(generator),original=pg.Client.prototype.query
  let fail=true
  const query=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:unknown[]){
   if(fail&&typeof args[0]==='string'&&args[0].includes("SET state='possible',budget_reservation_id")){
    fail=false
    throw Error('fixture_dispatch_before_http')
   }
   return Reflect.apply(original,this,args)
  } as typeof original)
  try{await expect(w.consolidate(f.job,signal())).rejects.toThrow('source_not_ready')}finally{query.mockRestore()}
  expect(send).not.toHaveBeenCalled()
  const before=(await pool.query('SELECT reservation_id,state FROM memory_provider_budget_reservations WHERE budget_key=$1',[f.personal])).rows
  expect(before).toHaveLength(1);expect(before[0].state).toBe('reserved')
  expect((await pool.query('SELECT state FROM memory_curation_calls')).rows[0].state).toBe('intended')
  await pool.query('UPDATE memory_task_bundles SET next_evaluate_at=now() WHERE bundle_id=$1',[f.bundleId])
  await w.consolidate(f.job,signal())
  expect(send).toHaveBeenCalledTimes(1)
  expect((await pool.query('SELECT budget_reservation_id,state,request_digest IS NOT NULL AS has_digest FROM memory_curation_calls')).rows).toEqual([
   {budget_reservation_id:before[0].reservation_id,state:'saved',has_digest:true}])
  expect((await pool.query('SELECT reservation_id,state FROM memory_provider_budget_reservations WHERE budget_key=$1',[f.personal])).rows).toEqual([
   {reservation_id:before[0].reservation_id,state:'settled'}])
 })
 test('a session purged after dispatch retains only the original billed window usage when its reply arrives',async()=>{
  const f=await fixture(),purge=createPurgeRepository(pool,{hmacKey:'purge-fixture'})
  let entered!:()=>void,resume!:()=>void
  const started=new Promise<void>(resolve=>{entered=resolve}),reply=new Promise<void>(resolve=>{resume=resolve})
  const send=vi.fn(async()=>{entered();await reply;return {...success(),usage:{...success().usage,costMicros:120}}})
  const generator=withTextProviderBudget({generateJson:send} as TextGenerator,createProviderBudgetStore(pool),
   {key:f.personal,maxRequests:1,maxInputTokens:1_000_000,maxOutputTokens:100,maxOutputTokensPerRequest:100})
  const work=worker(generator).consolidate(f.job,signal()).catch(error=>error as Error)
  await started
  const issued=(await pool.query("SELECT run_id,budget_reservation_id FROM memory_curation_calls WHERE state='possible'")).rows[0]
  try{
   await purge.purgeSession({installationId:f.personal,sessionId:'consolidation-session',reason:'user_deleted',sourceFeedId:null})
  }finally{resume()}
  expect(await work).toMatchObject({message:'curation_source_unavailable'})
  expect(send).toHaveBeenCalledTimes(1)
  for(const table of ['memory_task_bundles','memory_curation_runs','memory_curation_calls','memory_curation_items']){
   expect((await pool.query('SELECT count(*)::int n FROM '+table+' WHERE installation_id=$1',[f.personal])).rows[0].n).toBe(0)
  }
  expect((await pool.query("SELECT usage_id,input_tokens::int,output_tokens::int,cost_micros::int FROM memory_usage_outbox WHERE installation_id=$1 AND operation='curation'",[f.personal])).rows)
   .toEqual([{usage_id:'curation:'+issued.run_id,input_tokens:20,output_tokens:5,cost_micros:120}])
  expect((await pool.query('SELECT reservation_id,state FROM memory_provider_budget_reservations WHERE budget_key=$1',[f.personal])).rows)
   .toEqual([{reservation_id:issued.budget_reservation_id,state:'settled'}])
 })
 test('policy withdrawal erases checkpoint content, preserves its charge and prohibits local republication',async()=>{
  const f=await fixture(),generate=vi.fn(async()=>success())
  await worker({generateJson:generate} as TextGenerator).consolidate(f.job,signal())
  const before=(await pool.query('SELECT run_id,state,response,usage FROM memory_curation_calls')).rows[0]
  expect(before.state).toBe('saved')
  await pool.query("UPDATE memory_curation_policies SET revision=revision+1,mode='off' WHERE installation_id=$1",[f.personal])
  expect((await pool.query('SELECT state,response,usage,response_digest IS NOT NULL AS digest FROM memory_curation_calls')).rows[0]).toEqual({
   state:'withdrawn',response:null,usage:before.usage,digest:true})
  expect((await inspectCurationRecovery(pool,{installationId:f.personal,runIds:[before.run_id],apply:true}))[0].disposition).toBe('source_changed')
  expect(generate).toHaveBeenCalledTimes(1)
 })
 test('recovery of an expired isolated reservation with a lost COMMIT acknowledgement keeps its exact job and run epochs',async()=>{
  const f=await fixture(),send=vi.fn(async()=>success()),w=worker({generateJson:send} as TextGenerator)
  const job=(await pool.query(`UPDATE memory_jobs SET state='running',claimed_by='fixture',claim_epoch=7,
   claim_expires_at=clock_timestamp()+interval '1 hour' WHERE job_id=$1 RETURNING *`,[f.job.job_id])).rows[0]
  const original=pg.Client.prototype.query
  let committing:pg.Client|undefined
  const query=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:unknown[]){
   if(typeof args[0]==='string'&&args[0].includes('INSERT INTO memory_curation_runs'))committing=this
   if(this===committing&&args[0]==='COMMIT'){
    committing=undefined
    return this.query('COMMIT').then(()=>{throw Object.assign(Error('connection closed'),{code:'ECONNRESET'})})
   }
   return Reflect.apply(original,this,args)
  } as typeof original)
  try{await expect(w.consolidate(job,signal())).rejects.toThrow('curation_commit_outcome_unknown')}finally{query.mockRestore()}
  const run=(await pool.query('SELECT run_id,claim_epoch FROM memory_curation_runs')).rows[0]
  expect(send).not.toHaveBeenCalled()
  expect((await pool.query('SELECT 1 FROM memory_curation_calls')).rows).toHaveLength(0)
  const c=await pool.connect()
  try{await c.query('BEGIN');expect(await settleNativeStage(c,job,'curation_commit_outcome_unknown')).toBe(true);await c.query('COMMIT')}
  finally{await c.query('ROLLBACK');c.release()}
  await pool.query("UPDATE memory_curation_runs SET recovery_at=now(),claim_expires_at=now()-interval '1 second'")
  await pool.query('UPDATE memory_jobs SET claim_epoch=8 WHERE job_id=$1',[job.job_id])
  expect((await inspectCurationRecovery(pool,{installationId:f.personal,runIds:[run.run_id],apply:true}))[0].disposition).toBe('unverified')
  await pool.query('UPDATE memory_jobs SET claim_epoch=7 WHERE job_id=$1',[job.job_id])
  expect(await recoverDueCurationCheckpoints(pool)).toBe(1)
  expect((await pool.query('SELECT job_id,state FROM memory_jobs WHERE job_id=$1',[job.job_id])).rows[0]).toEqual({job_id:job.job_id,state:'pending'})
  await w.consolidate(job,signal())
  expect(send).toHaveBeenCalledTimes(1)
  expect((await pool.query('SELECT run_id,state,claim_epoch::int FROM memory_curation_runs')).rows)
   .toEqual([{run_id:run.run_id,state:'completed',claim_epoch:Number(run.claim_epoch)+1}])
 })
 test('a busy recovery bundle reports lock_wait while its next independent run is queued',async()=>{
  const f=await fixture(),bundles:string[]=[],runs:string[]=[]
  for(const delay of [2,1]){
   const bundle=randomUUID(),run=randomUUID(),job=randomUUID()
   await pool.query(`INSERT INTO memory_task_bundles(installation_id,bundle_id,session_id,task_key,source_digest,watermark,state)
    VALUES($1,$2,'s',$3,sha256('source'),1,'blocked')`,[f.personal,bundle,'source:'+bundle])
   await pool.query(`INSERT INTO memory_curation_runs(installation_id,bundle_id,run_id,bundle_revision,source_digest,
     policy_revision,authorization_epoch,policy_hash,model_config_hash,mode,state,checkpoint_protocol,claimed_by,recovery_at)
     VALUES($1,$2,$3,1,sha256('source'),1,1,repeat('a',64),repeat('b',64),'enabled','failed',1,$4,now()-$5*interval '1 second')`,
     [f.personal,bundle,run,job,delay])
   bundles.push(bundle);runs.push(run)
  }
  const c=await pool.connect()
  try{
   await c.query('BEGIN');await c.query('SELECT 1 FROM memory_task_bundles WHERE bundle_id=$1 FOR UPDATE',[bundles[0]])
   const scope={installationId:f.personal,runIds:runs}
   expect((await inspectCurationRecovery(pool,scope)).map(row=>row.disposition)).toEqual(['lock_wait','local_recovery'])
   expect(await recoverDueCurationCheckpoints(pool)).toBe(1)
   expect((await inspectCurationRecovery(pool,{...scope,apply:true})).map(row=>row.disposition)).toEqual(['lock_wait','queued'])
  }finally{await c.query('ROLLBACK');c.release()}
  await pool.query("UPDATE memory_jobs SET state='completed' WHERE payload->>'bundle_id'=$1",[bundles[1]])
  await pool.query("UPDATE memory_curation_runs SET recovery_at=now() WHERE run_id=ANY($1::uuid[])",[runs])
  const original=pg.Client.prototype.query
  const query=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:unknown[]){
   if(typeof args[0]==='string'&&args[0].includes('AS bundle_state,j.state AS job_state')&&Array.isArray(args[1])&&args[1][1]===runs[0])
    throw Error('fixture_single_run_failure')
   return Reflect.apply(original,this,args)
  } as typeof original)
  try{await expect(recoverDueCurationCheckpoints(pool)).rejects.toMatchObject({errors:[expect.objectContaining({message:'fixture_single_run_failure'})]})}
  finally{query.mockRestore()}
  expect((await pool.query("SELECT state FROM memory_jobs WHERE payload->>'bundle_id'=$1",[bundles[1]])).rows).toEqual([{state:'pending'}])
 })
 test('four charged historical runs without model bodies close only their exact original obligations',async()=>{
  const f=await fixture(),ids:string[]=[]
  for(const [n,code] of ['task_binding_changed','task_binding_changed','provider_result_unknown','source_processing_pin_unavailable'].entries()){
   const bundle=randomUUID(),run=randomUUID()
   await pool.query("INSERT INTO memory_task_bundles(installation_id,bundle_id,session_id,task_key,source_digest,watermark,state,reason_code) VALUES($1,$2,'s',$3,sha256('source'),1,'blocked',$4)",[f.personal,bundle,'source:cohort'+n,code])
   await pool.query(`INSERT INTO memory_curation_runs(installation_id,bundle_id,run_id,bundle_revision,source_digest,policy_revision,authorization_epoch,policy_hash,model_config_hash,mode,state,error_code,input_tokens,completed_at)
     VALUES($1,$2,$3,1,sha256('source'),1,1,repeat('a',64),repeat('b',64),'enabled',$4,$5,28,now())`,[f.personal,bundle,run,code==='provider_result_unknown'?code:'failed',code])
   ids.push(run)
  }
  const args={installationId:f.personal,runIds:ids}
  expect((await inspectCurationRecovery(pool,args)).map(r=>r.disposition)).toEqual(ids.map(()=>'external_result_unconfirmed'))
  expect((await pool.query("SELECT count(*)::int n FROM memory_task_bundles WHERE state='blocked'")).rows[0].n).toBe(4)
  await inspectCurationRecovery(pool,{...args,apply:true});await inspectCurationRecovery(pool,{...args,apply:true})
  expect((await pool.query("SELECT count(*)::int n FROM memory_task_bundles WHERE state='failed' AND reason_code='external_result_unconfirmed'")).rows[0].n).toBe(4)
  expect((await pool.query("SELECT sum(input_tokens)::int total FROM memory_curation_runs")).rows[0].total).toBe(112)
  expect((await pool.query("SELECT count(*)::int n FROM memory_source_processing_receipts WHERE complete")).rows[0].n).toBe(0)
  expect((await pool.query('SELECT count(*)::int n FROM memory_curation_calls')).rows[0].n).toBe(0)
  expect((await inspectCurationRecovery(pool,{...args,installationId:f.team,apply:true})).map(r=>r.disposition)).toEqual(ids.map(()=>'unavailable'))
 })
 test('AC-08 off and shadow preserve legacy extraction while enabled owns the source',async()=>{
  const f=await fixture()
  await pool.query("INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'transaction-fixture',NOW(),NOW())",[f.personal])
  await pool.query("UPDATE work_episodes SET compiled_at=NOW(),source_digest=sha256('fixture'),document='{}',evidence_manifest='{}' WHERE installation_id=$1",[f.personal])
  for(const mode of ['off','shadow'] as const)expect(await createExtractionRepository(pool,undefined,{lifecycleMode:mode}).loadEpisodeForExtraction(f.personal,'transaction-turn')).not.toBeNull()
  expect(await createExtractionRepository(pool,undefined,{lifecycleMode:'enabled'}).loadEpisodeForExtraction(f.personal,'transaction-turn')).toBeNull()
 })
 test('AC-24 overlapping consolidation owns one provider call',async()=>{
  const f=await fixture()
  let release!:()=>void,started!:()=>void
  const entered=new Promise<void>(r=>{started=r}),gate=new Promise<void>(r=>{release=r})
  const generate=vi.fn(async()=>{started();await gate;return success()})
  const w=worker({generateJson:generate} as TextGenerator),first=w.consolidate(f.job,signal())
  await entered
  try{await expect(w.consolidate(f.job,signal())).rejects.toThrow('source_not_ready')}
  finally{release()}
  await first;expect(generate).toHaveBeenCalledTimes(1)
 })
 test('AC-09 valid bounded conclusion stages a task candidate and keeps coverage incomplete until decision',async()=>{
  const f=await fixture(),space=randomUUID()
  await pool.query("INSERT INTO memory_spaces(installation_id,space_id,domain,name,destinations) VALUES($1,$2,'profile','preferences',ARRAY['personal'])",[f.personal,space])
  const generate=vi.fn(async()=>success([{space_id:space,task_id:null,spans:[{event_id:f.id,quote:f.payload.text}],conclusions:[{
   kind:'preference',assertion_mode:'user_asserted',subject:'self',predicate:'user.preference',value:'concise',conditions:{},fact_at:null,valid_until:null,statement:f.payload.text,confirmed:true,
   evidence:{subject:[f.id],predicate:[f.id],value:[f.id]},
  }]}]))
  await worker({generateJson:generate} as TextGenerator).consolidate(f.job,signal())
  expect((await pool.query("SELECT source_kind,status,statement FROM memory_candidates WHERE source_kind='task_bundle'")).rows).toEqual([{source_kind:'task_bundle',status:'validated',statement:f.payload.text}])
  expect((await pool.query('SELECT disposition,complete FROM memory_source_processing_receipts')).rows).toEqual([{disposition:'concluded',complete:false}])
  const publication=async()=>(await lifecycleStatus(pool,f.personal,'enabled')).records.map(r=>r.publication_state)
  expect(await publication()).toEqual(['not_published','not_published'])
  const jobs=(await pool.query("SELECT * FROM memory_jobs WHERE installation_id=$1 AND job_type='curate_conclusions'",[f.personal])).rows
  expect(jobs).toHaveLength(1)
  expect(await createCurationExecutor({pool,mode:'enabled',tombstoneKeys:[]}).curate(jobs[0],signal())).toMatchObject({action:'create'})
  expect(await publication()).toEqual(['published','published'])
 })
 test.each([false,true])('AC-15 rejected conclusions defer coverage with valid subset %s and close only at semantic deadline',async(validSubset)=>{
  const f=await fixture(),space=randomUUID()
  await pool.query("INSERT INTO memory_spaces(installation_id,space_id,domain,name,destinations) VALUES($1,$2,'profile','preferences',ARRAY['personal'])",[f.personal,space])
  const valid={kind:'preference',assertion_mode:'user_asserted',subject:'self',predicate:'user.preference',value:'concise',conditions:{},fact_at:null,valid_until:null,statement:f.payload.text,confirmed:true,evidence:{subject:[f.id],predicate:[f.id],value:[f.id]}}
  const generate=vi.fn(async()=>success([{space_id:space,task_id:null,spans:[{event_id:f.id,start:0,end:f.payload.text.length}],conclusions:[{...valid,value:'invented unsupported'},...(validSubset?[valid]:[])]}]))
  const w=worker({generateJson:generate} as TextGenerator)
  await expect(w.consolidate(f.job,signal())).rejects.toThrow('source_not_ready')
  expect((await pool.query('SELECT state,reason_code FROM memory_task_bundles WHERE bundle_id=$1',[f.bundleId])).rows[0]).toMatchObject({state:'deferred_semantic',reason_code:'conclusion_invalid'})
  expect((await pool.query('SELECT complete FROM memory_source_processing_receipts')).rows[0].complete).toBe(false)
  expect((await pool.query("SELECT count(*)::int n FROM memory_candidates WHERE source_kind='task_bundle'")).rows[0].n).toBe(validSubset?1:0)
  await pool.query("UPDATE memory_task_bundles SET semantic_deadline=clock_timestamp()-interval '1 second' WHERE bundle_id=$1",[f.bundleId])
  await w.consolidate(f.job,signal())
  expect(generate).toHaveBeenCalledTimes(1)
  expect((await pool.query('SELECT state FROM memory_task_bundles WHERE bundle_id=$1',[f.bundleId])).rows[0].state).toBe('skipped_unresolved')
  expect((await pool.query('SELECT complete FROM memory_source_processing_receipts')).rows[0].complete).toBe(false)
 })
})
