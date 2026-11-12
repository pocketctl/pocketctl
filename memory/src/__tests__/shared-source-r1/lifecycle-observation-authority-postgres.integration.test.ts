import {createHash,randomUUID} from 'node:crypto'
import type pg from 'pg'
import {createAdmissionService} from '../../context/admission-service.js'
import {personalLifecycleAuthorityStampSql,personalLifecycleDeliveryStampSql} from '../../sources/current-grant.js'
import {canonicalPayloadHash} from '@pocketctl/session-source'
import {afterAll,beforeAll,beforeEach,describe,expect,test,vi} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {createLifecycleObservationService} from '../../claims/lifecycle-observation.js'
import {createLifecycleAssessmentService} from '../../claims/lifecycle-assessment.js'
import type {TextGenerator} from '../../ports/text-generator.js'
import {createLifecycleService} from '../../claims/lifecycle-service.js'
import {createClaimRepository} from '../../claims/repository.js'
import {reclaimClaimHistory,reclaimColdClaimBody} from '../../retention/claim-history.js'
import {createLifecycleJobHandler} from '../../claims/lifecycle-job.js'
import {createJobRepository} from '../../jobs/repository.js'
import {createJobWorker} from '../../jobs/worker.js'
import {createProviderBudgetStore,withTextProviderBudget} from '../../model/provider-budget.js'

const url=process.env.DIRECT_LAUNCH_MEMORY_TEST_DATABASE_URL
const suite=url?describe:describe.skip
const consentFingerprint='a'.repeat(64)

suite('personal lifecycle uses current Relay authority',()=>{
 let fixture:DirectLaunchFixture, installationId:string, source:Awaited<ReturnType<DirectLaunchFixture['source']>>
 const scheduler=()=>createLifecycleObservationService({pool:fixture.runtime,mode:'enabled'})
 beforeAll(async()=>{
  fixture=await directLaunchFixture(url!,{captureRelayControls:true})
  source=await fixture.source()
  installationId=(await fixture.install(source,'retained_history')).inst.installation_id
  await fixture.runtime.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id,state,authorization_epoch) VALUES($1,'personal',$1,'active',1) ON CONFLICT (installation_id) DO UPDATE SET state='active',authorization_epoch=1",[installationId])
  await fixture.runtime.query("INSERT INTO memory_curation_policies(installation_id,mode,consume_mode,cold_mode,reclaim_mode) VALUES($1,'enabled','enabled','enabled','enabled')",[installationId])
  await fixture.runtime.query("INSERT INTO memory_context_settings(setting_id,installation_id,scope_kind,scope_key,agent,mode,revision) VALUES(gen_random_uuid(),$1,'installation','global',NULL,'enabled',1)",[installationId])
 },60000)
 afterAll(async()=>{await fixture?.close()})
 beforeEach(async()=>{
  await fixture.pool.query("UPDATE public.extension_installations SET status='active' WHERE installation_id=$1",[installationId])
  await fixture.runtime.query("UPDATE memory_installations SET relay_status='active' WHERE installation_id=$1",[installationId])
  await fixture.runtime.query(`INSERT INTO memory_feature_settings(installation_id,extraction_mode,extraction_consent_fingerprint)
   VALUES($1,'enabled',$2) ON CONFLICT (installation_id) DO UPDATE SET extraction_mode='enabled',extraction_consent_fingerprint=$2`,[installationId,consentFingerprint])
  await fixture.runtime.query("UPDATE memory_curation_policies SET cold_mode='enabled' WHERE installation_id=$1",[installationId])
 })
 test('omits a native-revoked personal installation while the local mirror remains active',async()=>{
  expect(await scheduler().listActivePersonalOwners()).toEqual([installationId])
  await fixture.pool.query("UPDATE public.extension_installations SET status='revoked',authorization_epoch=authorization_epoch+1 WHERE installation_id=$1",[installationId])
  expect(await scheduler().listActivePersonalOwners()).toEqual([])
 })
 async function nativeDelivery(bound=true){
  const pack=randomUUID(),request=randomUUID(),digest=createHash('sha256').update(request).digest(),injectionId=randomUUID()
  await fixture.runtime.query(`INSERT INTO memory_context_packs(pack_id,installation_id,session_id,client_request_id,agent,mode,effective_policy_hash,input_digest,state)
   VALUES($1,$2,$3,$3,'codex','enabled',$4,$4,'ready')`,[pack,installationId,request,digest])
  await fixture.runtime.query(`INSERT INTO memory_context_injections(injection_id,installation_id,pack_id,session_id,client_request_id,agent,adapter,admission_nonce_hmac,state,native_delivery_authority_sha256,native_delivery_prepared_at)
   SELECT $1,$2,$3,$4,$4,'codex','codex-app-server',$5,'prepared',CASE WHEN $6 THEN ${personalLifecycleDeliveryStampSql('$2',personalLifecycleAuthorityStampSql('current.state'))} END,CASE WHEN $6 THEN clock_timestamp() END
   FROM shared.memory_current_grant_states(ARRAY[$2::uuid],ARRAY[]::uuid[]) current`,[injectionId,installationId,pack,request,digest,bound])
  expect(await createAdmissionService({pool:fixture.runtime,nonceHmacKey:Buffer.alloc(32)}).receipt({
   injectionId,installationId,sessionId:request,delivered:true,
  })).toEqual({ok:true,state:'delivered'})
 }
 async function observedWindow(){
  // Advance only the clock-derived fixture fields to model a mature interval.
  await fixture.runtime.query('DELETE FROM memory_lifecycle_observation_windows WHERE installation_id=$1',[installationId])
  expect(await scheduler().recordObservationHeartbeat({installationId})).toBe('unknown')
  await nativeDelivery()
  expect(await scheduler().recordObservationHeartbeat({installationId})).toBe('unknown')
  await fixture.runtime.query(`UPDATE memory_lifecycle_observation_windows SET state='observed',
    started_at=clock_timestamp()-interval '91 days',capability_since_at=clock_timestamp()-interval '92 days',
    last_limitation_at=NULL WHERE installation_id=$1`,[installationId])
 }
 test('an old unbound delivery cannot start coverage under a new authority',async()=>{
  await fixture.runtime.query('DELETE FROM memory_lifecycle_observation_windows WHERE installation_id=$1',[installationId])
  await nativeDelivery(false)
  await fixture.pool.query("UPDATE public.extension_installations SET authorization_epoch=authorization_epoch+1 WHERE installation_id=$1",[installationId])
  expect(await scheduler().recordObservationHeartbeat({installationId})).toBe('unknown')
  const observation=async()=>(await fixture.runtime.query('SELECT capability_since_at,started_at FROM memory_lifecycle_observation_windows WHERE installation_id=$1',[installationId])).rows[0]
  expect(await observation()).toEqual({capability_since_at:null,started_at:null})
  await nativeDelivery()
  expect(await scheduler().recordObservationHeartbeat({installationId})).toBe('unknown')
  expect(await observation()).toEqual({capability_since_at:expect.any(Date),started_at:expect.any(Date)})
 })
 test('a queued heartbeat cannot preserve observation after native revocation',async()=>{
  await observedWindow()
  expect(await scheduler().recordObservationHeartbeat({installationId})).toBe('observed')
  await fixture.pool.query("UPDATE public.extension_installations SET status='revoked',authorization_epoch=authorization_epoch+1 WHERE installation_id=$1",[installationId])
  expect(await scheduler().recordObservationHeartbeat({installationId})).toBe('unknown')
 })

 async function assessmentClaim(){
  await observedWindow()
  await fixture.runtime.query('DELETE FROM memory_curation_decisions WHERE installation_id=$1',[installationId])
  await fixture.runtime.query('DELETE FROM knowledge_claims WHERE installation_id=$1',[installationId])
  const claim=randomUUID(),version=randomUUID(),capsule=randomUUID(),sourceEventId=randomUUID()
  const eventId=await fixture.event(source)
  const payload=(await fixture.pool.query('SELECT payload FROM public.events WHERE id=$1',[eventId])).rows[0].payload
  const statement=payload.text as string
  const digest=canonicalPayloadHash(payload)
  const at=new Date()
  await fixture.runtime.query(`INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at)
   VALUES($1,$2,$3,$3) ON CONFLICT (installation_id,session_id) DO NOTHING`,[installationId,source.session,at])
  await fixture.runtime.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,classification,
   source_kind,canonical_key,canonical_session_key,source_version,content_hash,hash_version,mapping_state,adapter_version)
   VALUES($1,$2,'feed',$3,$4,$5,'agent_text',$6,NULL,$7,'{}','relay_event',$3,$4,'{"content":"1","authorization":"1","storage":"0"}',$7,'canonical-json-sha256-v1','verified','v1')`,
   [sourceEventId,installationId,eventId,source.session,payload.turn_id,at,digest])
  await fixture.runtime.query(`INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state,created_at)
   VALUES($1,$2,'work_method','installation',$2::uuid::text,'synthetic-observation','active',clock_timestamp()-interval '91 days')`,[claim,installationId])
  await fixture.runtime.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence)
   VALUES($1,$2,$3,1,$4,'user_accepted',1)`,[version,installationId,claim,statement])
  const bundle=randomUUID(),run=randomUUID()
  await fixture.runtime.query(`INSERT INTO memory_task_bundles(installation_id,bundle_id,session_id,task_key,source_digest,watermark,state,bundle_kind)
   VALUES($1,$2,$3,$4,$5,1,'completed','task')`,[installationId,bundle,source.session,'observation:'+bundle,digest])
  await fixture.runtime.query(`INSERT INTO memory_task_bundle_sources(installation_id,bundle_id,source_event_id,source_digest,source_sequence)
   VALUES($1,$2,$3,$4,1)`,[installationId,bundle,sourceEventId,digest])
  await fixture.runtime.query(`INSERT INTO memory_curation_runs(installation_id,run_id,bundle_id,bundle_revision,source_digest,policy_revision,policy_hash,model_config_hash,mode,state,authorization_epoch)
   SELECT $1,$2,$3,1,$4,1,repeat('a',64),repeat('b',64),'enabled','completed',(state->>'authorization_epoch')::bigint
   FROM shared.memory_current_grant_states(ARRAY[$1::uuid],ARRAY[]::uuid[])`,[installationId,run,bundle,digest])
  await fixture.runtime.query(`INSERT INTO memory_curation_decisions(installation_id,run_id,action,idempotency_key,claim_id,version_id,reason_code,state,evidence_refs)
   VALUES($1,$2,'create',$3,$4,$5,'new_logical_identity','committed',$6)`,
   [installationId,run,run,claim,version,JSON.stringify([{source_event_id:sourceEventId,digest:digest.toString('hex')}])])
  await fixture.runtime.query("UPDATE knowledge_versions SET authority='machine_concluded' WHERE version_id=$1",[version])
  await fixture.runtime.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,version])
  await fixture.runtime.query(`INSERT INTO memory_claim_lifecycle(installation_id,claim_id,kind,assertion_mode,observation_state,observation_started_at,next_evaluate_at)
   VALUES($1,$2,'method','verified','observed',clock_timestamp()-interval '91 days',clock_timestamp())`,[installationId,claim])
  await fixture.runtime.query(`INSERT INTO knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash)
   VALUES($1,$2,$3,'automation_conclusion',sha256(convert_to($4::text,'UTF8')))`,[capsule,installationId,version,statement])
  await fixture.runtime.query(`INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,capsule_id,evidence_kind,locator,excerpt,excerpt_hash,occurred_at,ordinal)
   VALUES(gen_random_uuid(),$1,$2,$3,'accepted_excerpt',$5,$4,sha256(convert_to($4::text,'UTF8')),clock_timestamp()-interval '91 days',0)`,
   [installationId,version,capsule,statement,JSON.stringify({source_kind:'task_bundle',source_event_id:sourceEventId,bundle_id:bundle,source_digest:digest.toString('hex')})])
  return {claim,version,statement,eventId,sourceEventId}
 }
 const assess=(generateJson:TextGenerator['generateJson'])=>createLifecycleAssessmentService({
  pool:fixture.runtime,mode:'enabled',modelFingerprint:'synthetic-only',consentFingerprint,textGeneratorForInstallation:()=>({generateJson} as TextGenerator),
 }).assessDueClaims({installationId,limit:1})
 const revoke=async()=>{await fixture.pool.query("UPDATE public.extension_installations SET status='revoked',authorization_epoch=authorization_epoch+1 WHERE installation_id=$1",[installationId])}
 test('does not send assessment input after native revocation',async()=>{
  const {statement}=await assessmentClaim()
  const generate=vi.fn(async()=>({ok:true as const,value:{assessment:'low',reason:'transient_procedure',support:statement},usage:{inputTokens:20,outputTokens:5,model:'synthetic'}}))
  await revoke()
  await assess(generate as TextGenerator['generateJson'])
  expect(generate).not.toHaveBeenCalled()
 })
 test('rejects an assessment result if Relay revokes the source during inference',async()=>{
  const {statement}=await assessmentClaim()
  const generate=vi.fn(async()=>{
   await revoke()
   return {ok:true as const,value:{assessment:'low',reason:'transient_procedure',support:statement},usage:{inputTokens:20,outputTokens:5,model:'synthetic'}}
  })
  const result=await assess(generate as TextGenerator['generateJson'])
  expect(generate).toHaveBeenCalledOnce()
  expect(result).toMatchObject({evaluated:0,low:0,blocked:1})
  expect((await fixture.runtime.query('SELECT state,input_tokens::int,output_tokens::int FROM memory_lifecycle_assessment_runs')).rows).toEqual([
   {state:'stale',input_tokens:20,output_tokens:5},
  ])
 })

 test('current personal authority works with a stale local Relay status',async()=>{
  const {statement}=await assessmentClaim()
  await fixture.runtime.query("UPDATE memory_installations SET relay_status='paused' WHERE installation_id=$1",[installationId])
  expect(await scheduler().listActivePersonalOwners()).toEqual([installationId])
  const generate=vi.fn(async()=>({ok:true as const,value:{assessment:'low',reason:'transient_procedure',support:statement},usage:{inputTokens:20,outputTokens:5,model:'synthetic'}}))
  expect(await assess(generate as TextGenerator['generateJson'])).toMatchObject({evaluated:1,low:1})
  expect(generate).toHaveBeenCalledOnce()
 })
 test('revocation followed by a new epoch cannot reuse earlier observation or assessment',async()=>{
  const {statement}=await assessmentClaim()
  const generate=vi.fn(async()=>{
   await revoke()
   await fixture.pool.query("UPDATE public.extension_installations SET status='active',authorization_epoch=authorization_epoch+1 WHERE installation_id=$1",[installationId])
   return {ok:true as const,value:{assessment:'low',reason:'transient_procedure',support:statement},usage:{inputTokens:20,outputTokens:5,model:'synthetic'}}
  })
  expect(await assess(generate as TextGenerator['generateJson'])).toMatchObject({evaluated:0,low:0,blocked:1})
  expect(generate).toHaveBeenCalledOnce()
  await assess(generate as TextGenerator['generateJson'])
  expect(generate).toHaveBeenCalledOnce()
  expect(await scheduler().recordObservationHeartbeat({installationId})).toBe('unknown')
  const observation=async()=>(await fixture.runtime.query('SELECT capability_since_at,started_at FROM memory_lifecycle_observation_windows WHERE installation_id=$1',[installationId])).rows[0]
  expect(await observation()).toEqual({capability_since_at:null,started_at:null})
  await nativeDelivery()
  expect(await scheduler().recordObservationHeartbeat({installationId})).toBe('unknown')
  expect(await observation()).toEqual({capability_since_at:expect.any(Date),started_at:expect.any(Date)})
 })
 test('a concurrent native revocation prevents a heartbeat or new assessment from crossing the lock',async()=>{
  await assessmentClaim()
  const native=await fixture.pool.connect()
  const generate=vi.fn()
  try{
   await native.query('BEGIN')
   await native.query("UPDATE public.extension_installations SET status='revoked',authorization_epoch=authorization_epoch+1 WHERE installation_id=$1",[installationId])
   expect(await scheduler().recordObservationHeartbeat({installationId})).toBe('unknown')
   expect(await assess(generate as TextGenerator['generateJson'])).toMatchObject({evaluated:0})
   expect(generate).not.toHaveBeenCalled()
   const result=await fixture.runtime.query('SELECT state FROM memory_lifecycle_observation_windows WHERE installation_id=$1',[installationId])
   expect(result.rows[0].state).toBe('observed')
  }finally{await native.query('ROLLBACK');native.release()}
  expect(await scheduler().recordObservationHeartbeat({installationId})).toBe('observed')
 })
 test('native revocation fences cooling and destructive reclamation',async()=>{
  const {claim,version}=await assessmentClaim()
  const lifecycle=createLifecycleService(fixture.runtime,createClaimRepository(fixture.runtime),{lifecycleMode:'enabled'})
  const retention={lifecycleMode:'enabled' as const,readerCompatible:true}
  const target={installationId,claimId:claim}
  await fixture.runtime.query("UPDATE memory_claim_lifecycle SET value_assessment='low' WHERE installation_id=$1 AND claim_id=$2",[installationId,claim])
  await revoke()
  expect(await lifecycle.evaluateDueClaims()).toMatchObject({evaluated:0,cooled:0})
  await fixture.runtime.query(`UPDATE memory_claim_lifecycle SET storage_tier='cold',cold_since=clock_timestamp()-interval '91 days'
    WHERE installation_id=$1 AND claim_id=$2`,[installationId,claim])
  expect(await reclaimColdClaimBody(fixture.runtime,target,retention)).toMatchObject({versions:0})
  expect((await fixture.runtime.query('SELECT body_state FROM knowledge_versions WHERE version_id=$1',[version])).rows[0].body_state).toBe('present')
  for(let number=2;number<=5;number++){
   await fixture.runtime.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence,created_at)
    VALUES(gen_random_uuid(),$1,$2,$3,'synthetic retained history','user_accepted',1,clock_timestamp()-interval '120 days')`,[installationId,claim,number])
  }
  expect(await reclaimClaimHistory(fixture.runtime,target,retention)).toMatchObject({versions:0})
  await fixture.pool.query("UPDATE public.extension_installations SET status='active',authorization_epoch=authorization_epoch+1 WHERE installation_id=$1",[installationId])
  expect(await reclaimClaimHistory(fixture.runtime,target,retention)).toMatchObject({versions:1})
 })

 function budgetedWorker(statement:string,key:string){
  const raw=vi.fn(async()=>({ok:true as const,value:{assessment:'low',reason:'transient_procedure',support:statement},usage:{inputTokens:20,outputTokens:5,model:'synthetic'}}))
  const store=createProviderBudgetStore(fixture.runtime)
  const provider=withTextProviderBudget({generateJson:raw as TextGenerator['generateJson']},store,{
   key,maxRequests:10,maxInputTokens:20_000,maxOutputTokens:200,maxOutputTokensPerRequest:100,
  })
  const lifecycle=createLifecycleService(fixture.runtime,createClaimRepository(fixture.runtime),{lifecycleMode:'enabled'})
  const assessment=createLifecycleAssessmentService({pool:fixture.runtime,mode:'enabled',modelFingerprint:'budgeted-fixture',consentFingerprint,textGeneratorForInstallation:()=>provider})
  const jobs=createJobRepository(fixture.runtime),controller=new AbortController()
  const worker=createJobWorker({pool:fixture.runtime,jobs,workerId:key,signal:controller.signal})
  worker.register('evaluate_claim_lifecycle',createLifecycleJobHandler({shared:true,jobs,lifecycle,assessment}))
  return {raw,jobs,worker,controller}
 }
 test('the global Worker job fans out and the installation job settles one real budget reservation',async()=>{
  const {statement}=await assessmentClaim()
  await fixture.pool.query("UPDATE shared.memory_source_modes SET mode='shared-active' WHERE installation_id=$1",[installationId])
  const {raw,jobs,worker,controller}=budgetedWorker(statement,'lifecycle-fixture')
  await jobs.enqueueJob({jobType:'evaluate_claim_lifecycle',idempotencyKey:'lifecycle-test'})
  try{
   await worker.tick()
   expect(raw).not.toHaveBeenCalled()
   expect((await fixture.runtime.query("SELECT installation_id,state FROM memory_jobs WHERE job_type='evaluate_claim_lifecycle' ORDER BY installation_id NULLS FIRST")).rows).toEqual([
    {installation_id:null,state:'completed'},{installation_id:installationId,state:'pending'},
   ])
   await worker.tick()
   expect(raw).toHaveBeenCalledOnce()
   expect((await fixture.runtime.query("SELECT state,actual_input_tokens::int,actual_output_tokens::int FROM memory_provider_budget_reservations WHERE budget_key='lifecycle-fixture'")).rows).toEqual([
    {state:'settled',actual_input_tokens:20,actual_output_tokens:5},
   ])
   expect((await fixture.pool.query(`SELECT a.state,e.branch FROM shared.memory_source_provider_attempts a
    JOIN shared.memory_source_executions e USING(execution_id) WHERE e.installation_id=$1`,[installationId])).rows).toEqual([
    {state:'accounted',branch:'canonical-active'},
   ])
   expect((await fixture.runtime.query("SELECT state,assessment FROM memory_lifecycle_assessment_runs")).rows).toEqual([
    {state:'completed',assessment:'low'},
   ])
  }finally{controller.abort();await worker.stop()}
 })
 test('a policy change during the real budget lock wait records not-sent before provider IO',async()=>{
  const {statement}=await assessmentClaim()
  const key='lifecycle-budget-lock-fixture'
  const {raw,jobs,worker,controller}=budgetedWorker(statement,key)
  const blocker=await fixture.pool.connect()
  let tick:Promise<void>|undefined
  try{
   await blocker.query('BEGIN')
   const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
   await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key])
   await jobs.enqueueJob({installationId,jobType:'evaluate_claim_lifecycle',idempotencyKey:key})
   tick=worker.tick()
   await vi.waitFor(async()=>{
    const waiting=(await fixture.pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
     WHERE wait_event_type='Lock' AND wait_event='advisory' AND $1=ANY(pg_blocking_pids(pid))) AS waiting`,[pid])).rows[0].waiting
    expect(waiting).toBe(true)
   },{timeout:3000,interval:20})
   await fixture.runtime.query("UPDATE memory_curation_policies SET cold_mode='off' WHERE installation_id=$1",[installationId])
   await blocker.query('COMMIT')
   await tick
   expect(raw).not.toHaveBeenCalled()
   expect((await fixture.pool.query(`SELECT a.state,b.state AS budget_state FROM shared.memory_source_provider_attempts a
    JOIN memory.memory_provider_budget_reservations b USING(reservation_id) WHERE b.budget_key=$1`,[key])).rows).toEqual([
    {state:'not-sent',budget_state:'reserved'},
   ])
   expect((await fixture.runtime.query('SELECT state,input_tokens::int FROM memory_lifecycle_assessment_runs')).rows).toEqual([{state:'stale',input_tokens:0}])
  }finally{
   await blocker.query('ROLLBACK').catch(()=>undefined);blocker.release()
   await tick?.catch(()=>undefined);controller.abort();await worker.stop()
  }
 })
 test('known-unsent work recovers the same run after a competing native transaction rolls back',async()=>{
  const {statement}=await assessmentClaim()
  const blocker=await fixture.pool.connect()
  const clients=new Map<pg.PoolClient,pg.PoolClient['query']>()
  let held=false
  const observe=(client:pg.PoolClient)=>{
   if(clients.has(client))return
   const original=client.query
   clients.set(client,original)
   let reserved=false
   client.query=function(...args:any[]){
    const sql=typeof args[0]==='string'?args[0]:args[0]?.text??''
    const result=(original as any).apply(client,args)
    if(sql.includes('INSERT INTO memory_lifecycle_assessment_runs'))reserved=true
    if(sql==='COMMIT'&&reserved&&!held){
     reserved=false
     return result.then(async(value:unknown)=>{
      await blocker.query('BEGIN')
      await blocker.query("UPDATE public.extension_installations SET status='revoked' WHERE installation_id=$1",[installationId])
      held=true
      return value
     })
    }
    return result
   } as pg.PoolClient['query']
  }
  const generate=vi.fn(async()=>({ok:true as const,value:{assessment:'low',reason:'transient_procedure',support:statement},usage:{inputTokens:20,outputTokens:5,model:'synthetic'}}))
  const getRun=async()=>(await fixture.runtime.query('SELECT run_id,state,reason_code,claim_epoch::int FROM memory_lifecycle_assessment_runs')).rows[0]
  try{
   fixture.runtime.on('acquire',observe)
   await assess(generate as TextGenerator['generateJson'])
   expect(held).toBe(true)
   expect(generate).not.toHaveBeenCalled()
   const prior=await getRun()
   expect(prior).toMatchObject({state:'blocked',reason_code:'source_authority_unavailable',claim_epoch:1})
   await blocker.query('ROLLBACK')
   await fixture.runtime.query("UPDATE memory_lifecycle_assessment_runs SET retry_at=clock_timestamp()-interval '1 second' WHERE run_id=$1",[prior.run_id])
   await fixture.runtime.query("UPDATE memory_claim_lifecycle SET next_evaluate_at=clock_timestamp() WHERE installation_id=$1",[installationId])
   expect(await assess(generate as TextGenerator['generateJson'])).toMatchObject({evaluated:1})
   expect(generate).toHaveBeenCalledOnce()
   expect(await getRun()).toMatchObject({run_id:prior.run_id,state:'completed',claim_epoch:2})
  }finally{
   fixture.runtime.off('acquire',observe)
   for(const [client,query] of clients)client.query=query
   await blocker.query('ROLLBACK').catch(()=>undefined);blocker.release()
  }
 })
 test('cancellation before calling the provider keeps known-unsent work retryable',async()=>{
  await assessmentClaim()
  const generate=vi.fn(),controller=new AbortController()
  const service=createLifecycleAssessmentService({pool:fixture.runtime,mode:'enabled',modelFingerprint:'synthetic-only',
   consentFingerprint,textGeneratorForInstallation:()=>{
    controller.abort()
    return {generateJson:generate as TextGenerator['generateJson']}
   },
  })
  expect(await service.assessDueClaims({installationId,limit:1,signal:controller.signal})).toMatchObject({blocked:1})
  expect(generate).not.toHaveBeenCalled()
  expect((await fixture.runtime.query('SELECT state,reason_code FROM memory_lifecycle_assessment_runs')).rows).toEqual([
   {state:'blocked',reason_code:'source_authority_unavailable'},
  ])
 })
 test('a fallback budget refusal after a possible primary charge stays terminal',async()=>{
  await assessmentClaim()
  const generate=vi.fn(async()=>({
   ok:false as const,code:'budget_exceeded' as const,retryable:true,
   timeoutFallback:{primary:{code:'http_error' as const,detail:'timeout' as const,billingUncertain:true}},
  }))
  expect(await assess(generate as TextGenerator['generateJson'])).toMatchObject({blocked:1})
  expect((await fixture.runtime.query('SELECT state FROM memory_lifecycle_assessment_runs')).rows).toEqual([{state:'provider_result_unknown'}])
  await fixture.runtime.query("UPDATE memory_lifecycle_assessment_runs SET retry_at=clock_timestamp()-interval '1 hour'")
  await assess(generate as TextGenerator['generateJson'])
  expect(generate).toHaveBeenCalledOnce()
 })
 test.each(['off','different route'])('refuses assessment with extraction consent %s',async mode=>{
  await assessmentClaim()
  await fixture.runtime.query(`UPDATE memory_feature_settings SET extraction_mode=$2,extraction_consent_fingerprint=$3
   WHERE installation_id=$1`,[installationId,mode==='off'?'off':'enabled',mode==='off'?consentFingerprint:'b'.repeat(64)])
  const generate=vi.fn()
  await assess(generate as TextGenerator['generateJson'])
  expect(generate).not.toHaveBeenCalled()
  expect((await fixture.runtime.query('SELECT state FROM memory_lifecycle_assessment_runs')).rows).toEqual([])
 })
 test('a local cold policy change after reservation fences dispatch',async()=>{
  await assessmentClaim()
  await fixture.pool.query(`CREATE FUNCTION memory.fixture_disable_cold_after_reserve() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN UPDATE memory.memory_curation_policies SET cold_mode='off' WHERE installation_id=NEW.installation_id; RETURN NEW; END $$;
   CREATE TRIGGER fixture_disable_cold_after_reserve AFTER INSERT ON memory.memory_lifecycle_assessment_runs FOR EACH ROW
    EXECUTE FUNCTION memory.fixture_disable_cold_after_reserve()`)
  const generate=vi.fn()
  try{
   await assess(generate as TextGenerator['generateJson'])
   expect(generate).not.toHaveBeenCalled()
   expect((await fixture.runtime.query('SELECT state FROM memory_lifecycle_assessment_runs')).rows).toEqual([{state:'stale'}])
  }finally{
   await fixture.pool.query('DROP TRIGGER fixture_disable_cold_after_reserve ON memory.memory_lifecycle_assessment_runs; DROP FUNCTION memory.fixture_disable_cold_after_reserve()')
  }
 })
 test('a missing original source reference is never sent to the model',async()=>{
  const {sourceEventId}=await assessmentClaim()
  await fixture.runtime.query('DELETE FROM memory_task_bundle_sources WHERE installation_id=$1 AND source_event_id=$2',[installationId,sourceEventId])
  const generate=vi.fn()
  await assess(generate as TextGenerator['generateJson'])
  expect(generate).not.toHaveBeenCalled()
 })
 test('a deleted native session cannot authorize assessment or cooling',async()=>{
  const {claim}=await assessmentClaim()
  await fixture.publisher.query('DELETE FROM public.sessions WHERE session_id=$1',[source.session])
  const generate=vi.fn()
  await assess(generate as TextGenerator['generateJson'])
  expect(generate).not.toHaveBeenCalled()
  await fixture.runtime.query("UPDATE memory_claim_lifecycle SET value_assessment='low' WHERE installation_id=$1 AND claim_id=$2",[installationId,claim])
  const lifecycle=createLifecycleService(fixture.runtime,createClaimRepository(fixture.runtime),{lifecycleMode:'enabled'})
  expect(await lifecycle.evaluateDueClaims()).toMatchObject({cooled:0})
 })
})
