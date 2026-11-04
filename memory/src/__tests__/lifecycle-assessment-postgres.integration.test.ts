import pg from 'pg'
import {randomUUID,createHash} from 'node:crypto'
import {beforeAll,beforeEach,afterAll,describe,test,expect,vi} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {createLifecycleObservationService,invalidateLifecycleObservation} from '../claims/lifecycle-observation.js'
import {createLifecycleAssessmentService} from '../claims/lifecycle-assessment.js'
import {createLifecycleService} from '../claims/lifecycle-service.js'
import type {ClaimRepository} from '../claims/repository.js'
import type {TextGenerator} from '../ports/text-generator.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('lifecycle assessment and instrumented coverage (synthetic model)',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 const observation=()=>createLifecycleObservationService({pool,mode:'enabled'})
 async function fixture(){
  const f=await governanceFixture(pool),bundle=randomUUID(),run=randomUUID(),digest=createHash('sha256').update('fixture').digest()
  await pool.query("INSERT INTO memory_curation_policies(installation_id,mode,cold_mode,reclaim_mode,consume_mode) VALUES($1,'enabled','enabled','enabled','enabled')",[f.personal])
  await pool.query(`INSERT INTO memory_task_bundles(installation_id,bundle_id,session_id,task_key,source_digest,watermark,state) VALUES($1,$2,'assessment-fixture','source:assessment-fixture',$3,1,'completed')`,[f.personal,bundle,digest])
  await pool.query(`INSERT INTO memory_curation_runs(installation_id,run_id,bundle_id,bundle_revision,source_digest,policy_revision,policy_hash,model_config_hash,mode,state) VALUES($1,$2,$3,1,$4,1,$5,$5,'enabled','completed')`,[f.personal,run,bundle,digest,'a'.repeat(64)])
  await pool.query(`INSERT INTO memory_curation_decisions(installation_id,run_id,action,idempotency_key,claim_id,version_id,reason_code,state) VALUES($1,$2,'create','fixture',$3,$4,'fixture','committed')`,[f.personal,run,f.claim,f.version])
  await pool.query("UPDATE knowledge_versions SET authority='machine_concluded',statement='Temporary debug prints for this one migration.' WHERE version_id=$1",[f.version])
  await pool.query("UPDATE knowledge_claims SET created_at=clock_timestamp()-interval '91 days' WHERE claim_id=$1",[f.claim])
  await pool.query("INSERT INTO memory_claim_lifecycle(installation_id,claim_id,kind,assertion_mode) VALUES($1,$2,'method','verified')",[f.personal,f.claim])
  await pool.query('DELETE FROM knowledge_evidence WHERE version_id=$1',[f.version])
  const capsule=randomUUID()
  await pool.query("INSERT INTO knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash) VALUES($1,$2,$3,'automation_conclusion',$4)",[capsule,f.personal,f.version,digest])
  await pool.query(`INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,capsule_id,evidence_kind,locator,excerpt,excerpt_hash,occurred_at,ordinal)
   VALUES(gen_random_uuid(),$1,$2,$3,'accepted_excerpt','{"source_kind":"task_bundle"}','Temporary debug prints for this one migration.',sha256('Temporary debug prints for this one migration.'),clock_timestamp()-interval '91 days',0)`,[f.personal,f.version,capsule])
  await pool.query("INSERT INTO memory_context_settings(setting_id,installation_id,scope_kind,scope_key,agent,mode,revision) VALUES(gen_random_uuid(),$1,'installation','global',NULL,'enabled',1)",[f.personal])
  return f
 }
 async function observed(installationId:string){
  await nativeDelivery(installationId)
  expect(await observation().recordObservationHeartbeat({installationId})).toBe('unknown')
  await pool.query("UPDATE memory_lifecycle_observation_windows SET started_at=clock_timestamp()-interval '91 days',capability_since_at=clock_timestamp()-interval '92 days',last_limitation_at=NULL WHERE installation_id=$1",[installationId])
  expect(await observation().recordObservationHeartbeat({installationId})).toBe('observed')
 }
 async function nativeDelivery(installationId:string){
  const pack=randomUUID(),request=randomUUID(),hash=createHash('sha256').update(request).digest()
  await pool.query(`INSERT INTO memory_context_packs(pack_id,installation_id,session_id,client_request_id,agent,mode,effective_policy_hash,input_digest,state)
   VALUES($1,$2,$3,$3,'codex','enabled',$4,$4,'ready')`,[pack,installationId,request,hash])
  await pool.query(`INSERT INTO memory_context_injections(injection_id,installation_id,pack_id,session_id,client_request_id,agent,adapter,admission_nonce_hmac,state,delivered_at)
   VALUES(gen_random_uuid(),$1,$2,$3,$3,'codex','codex-app-server',$4,'delivered',clock_timestamp())`,[installationId,pack,request,hash])
 }
 const generator=()=>vi.fn(async()=>({ok:true,value:{assessment:'low',reason:'transient_procedure',support:'Temporary debug prints'},usage:{inputTokens:20,outputTokens:5,model:'synthetic'}}))
 const assessor=(generate:ReturnType<typeof generator>,mode:'off'|'shadow'|'enabled'='enabled')=>createLifecycleAssessmentService({pool,mode,modelFingerprint:'synthetic-v1',textGeneratorForInstallation:()=>({generateJson:generate} as TextGenerator)})
 test('AC-35 no observation invented from first heartbeat or a delivery; gap and specific off reset immediately',async()=>{
  const f=await fixture()
  expect(await observation().recordObservationHeartbeat({installationId:f.personal})).toBe('unknown')
  await pool.query("INSERT INTO memory_claim_usage(installation_id,claim_id,signal_key,signal,occurred_at) VALUES($1,$2,'delivery-1','delivered',clock_timestamp())",[f.personal,f.claim])
  expect((await pool.query('SELECT observation_state FROM memory_claim_lifecycle')).rows[0].observation_state).toBe('unknown')
  await observed(f.personal)
  await pool.query("UPDATE memory_lifecycle_observation_windows SET last_heartbeat_at=clock_timestamp()-interval '6 minutes'")
  expect(await observation().recordObservationHeartbeat({installationId:f.personal})).toBe('unknown')
  await observed(f.personal)
  await pool.query("INSERT INTO memory_context_settings(setting_id,installation_id,scope_kind,scope_key,agent,mode,revision) VALUES(gen_random_uuid(),$1,'session','private-session',NULL,'off',1)",[f.personal])
  expect((await pool.query('SELECT observation_state,observation_started_at FROM memory_claim_lifecycle')).rows[0]).toEqual({observation_state:'unknown',observation_started_at:null})
  expect(await observation().recordObservationHeartbeat({installationId:f.personal})).toBe('unknown')
 })
 test('AC-35 low classification is budgeted, semantic only, idempotent and enables a separate cold evaluation',async()=>{
  const f=await fixture();await observed(f.personal)
  const generate=generator(),service=assessor(generate)
  expect(await service.assessDueClaims()).toMatchObject({evaluated:1,low:1})
  const document=JSON.stringify((generate.mock.calls as unknown as Array<[{document:unknown}]>)[0][0].document)
  for(const excluded of ['created_at','observation','last_delivered','usage','age'])expect(document).not.toContain(excluded)
  expect(await service.assessDueClaims()).toMatchObject({evaluated:0});expect(generate).toHaveBeenCalledTimes(1)
  const lifecycle=createLifecycleService(pool,{correctClaim(){},supersedeClaim(){}} as unknown as ClaimRepository,{lifecycleMode:'enabled'})
  expect(await lifecycle.evaluateDueClaims()).toMatchObject({cooled:1})
 })
 test.each(['off','shadow'] as const)('AC-35 assessment %s never calls the provider',async mode=>{
  const f=await fixture();await observed(f.personal);const generate=generator()
  expect(await assessor(generate,mode).assessDueClaims()).toMatchObject({evaluated:0});expect(generate).not.toHaveBeenCalled()
 })
 test('AC-35 pin during provider evaluation rejects the stale low classification',async()=>{
  const f=await fixture();await observed(f.personal)
  const generate=vi.fn(async()=>{await pool.query("UPDATE memory_claim_lifecycle SET protection='pinned',revision=revision+1");return {ok:true,value:{assessment:'low',reason:'transient_procedure',support:'Temporary debug prints'},usage:{inputTokens:20,outputTokens:5,model:'synthetic'}}})
  expect(await assessor(generate).assessDueClaims()).toMatchObject({evaluated:0,blocked:1})
  expect((await pool.query('SELECT value_assessment FROM memory_claim_lifecycle')).rows[0].value_assessment).toBe('unknown')
  expect((await pool.query('SELECT state FROM memory_lifecycle_assessment_runs')).rows[0].state).toBe('stale')
 })
 test('AC-35 unknown provider result does not cause repeat billing or classify low',async()=>{
  const f=await fixture();await observed(f.personal)
  const generate=vi.fn(async()=>({ok:false,code:'provider_result_unknown',retryable:false}))
  const service=createLifecycleAssessmentService({pool,mode:'enabled',modelFingerprint:'synthetic',textGeneratorForInstallation:()=>({generateJson:generate} as TextGenerator)})
  expect(await service.assessDueClaims()).toMatchObject({blocked:1});await service.assessDueClaims();expect(generate).toHaveBeenCalledTimes(1)
  expect((await pool.query('SELECT value_assessment FROM memory_claim_lifecycle')).rows[0].value_assessment).toBe('unknown')
 })
 test('AC-35 model-free protected/stable/unknown-coverage facts never enter assessment',async()=>{
  const f=await fixture(),generate=generator(),service=assessor(generate)
  await service.assessDueClaims();expect(generate).not.toHaveBeenCalled()
  await observed(f.personal)
  for(const kind of ['preference','constraint','decision','event']){await pool.query('UPDATE memory_claim_lifecycle SET kind=$1',[kind]);await service.assessDueClaims()}
  await pool.query("UPDATE memory_claim_lifecycle SET kind='method',protection='critical'");await service.assessDueClaims()
  expect(generate).not.toHaveBeenCalled()
 })
 test('AC-35 global off leaves untouched legacy owners without creating coverage rows',async()=>{
  const f=await governanceFixture(pool)
  expect(await createLifecycleObservationService({pool,mode:'off'}).recordObservationHeartbeat({installationId:f.personal})).toBe('unknown')
  expect((await pool.query('SELECT count(*)::int n FROM memory_lifecycle_observation_windows')).rows[0].n).toBe(0)
 })
 test('AC-35 enabled settings and heartbeat without native delivery never establish observable capability',async()=>{
  const f=await fixture()
  expect(await observation().recordObservationHeartbeat({installationId:f.personal})).toBe('unknown')
  expect((await pool.query('SELECT count(*)::int n FROM memory_lifecycle_observation_windows')).rows[0].n).toBe(0)
  await nativeDelivery(f.personal)
  await observation().recordObservationHeartbeat({installationId:f.personal})
  await invalidateLifecycleObservation(pool,f.personal,'unsupported_adapter')
  expect((await pool.query('SELECT capability_since_at FROM memory_lifecycle_observation_windows')).rows[0].capability_since_at).toBeNull()
  expect(await observation().recordObservationHeartbeat({installationId:f.personal})).toBe('unknown')
 })
 test('AC-35 shadow pack or no-pack degradation immediately invalidates established observation',async()=>{
  const f=await fixture();await observed(f.personal)
  await pool.query("UPDATE memory_context_packs SET mode='shadow',state='shadow' WHERE installation_id=$1",[f.personal])
  expect((await pool.query('SELECT observation_state FROM memory_claim_lifecycle')).rows[0].observation_state).toBe('unknown')
  expect(await observation().recordObservationHeartbeat({installationId:f.personal})).toBe('unknown')
  await observed(f.personal)
  await invalidateLifecycleObservation(pool,f.personal,'degraded')
  expect((await pool.query('SELECT observation_started_at FROM memory_claim_lifecycle')).rows[0].observation_started_at).toBeNull()
 })
 test('AC-35 stale native activity resets even with live server heartbeat, and a fresh delivery cannot retain old window',async()=>{
  const f=await fixture();await observed(f.personal)
  await pool.query("UPDATE memory_lifecycle_observation_windows SET last_native_delivery_at=clock_timestamp()-interval '25 hours'")
  const generate=generator();expect(await assessor(generate).assessDueClaims()).toMatchObject({evaluated:0})
  expect(await observation().recordObservationHeartbeat({installationId:f.personal})).toBe('unknown')
  expect((await pool.query('SELECT started_at,capability_since_at FROM memory_lifecycle_observation_windows')).rows[0]).toEqual({started_at:null,capability_since_at:null})
  await observed(f.personal)
  await pool.query("UPDATE memory_lifecycle_observation_windows SET last_native_delivery_at=clock_timestamp()-interval '25 hours'")
  await nativeDelivery(f.personal)
  expect((await pool.query('SELECT started_at FROM memory_lifecycle_observation_windows')).rows[0].started_at).toBeNull()
  expect(await observation().recordObservationHeartbeat({installationId:f.personal})).toBe('unknown')
 })
 test('AC-35 completed unknown and ineligible rows cannot starve a bounded batch',async()=>{
  const first=await fixture();await observed(first.personal)
  const generate=vi.fn(async()=>({ok:true,value:{assessment:'unknown',reason:'uncertain',support:''},usage:{inputTokens:20,outputTokens:5,model:'synthetic'}}))
  const service=assessor(generate)
  expect(await service.assessDueClaims({limit:1})).toMatchObject({unknown:1})
  const fresh=await fixture();await observed(fresh.personal)
  await pool.query("UPDATE knowledge_claims SET created_at=clock_timestamp() WHERE claim_id=$1",[fresh.claim])
  const next=await fixture();await observed(next.personal)
  expect(await service.assessDueClaims({limit:1})).toMatchObject({unknown:1})
  expect((await pool.query('SELECT claim_id FROM memory_lifecycle_assessment_runs ORDER BY started_at')).rows.map(r=>r.claim_id)).toEqual([first.claim,next.claim])
  expect(await service.assessDueClaims({limit:1})).toMatchObject({evaluated:0})
 })
 test('AC-35 a known budget block yields the batch until retry is due',async()=>{
  const first=await fixture();await observed(first.personal)
  const generate=vi.fn(async()=>({ok:false,code:'budget_exceeded',retryable:true}))
  const service=createLifecycleAssessmentService({pool,mode:'enabled',modelFingerprint:'synthetic',textGeneratorForInstallation:()=>({generateJson:generate} as TextGenerator)})
  expect(await service.assessDueClaims({limit:1})).toMatchObject({blocked:1})
  const next=await fixture();await observed(next.personal)
  expect(await service.assessDueClaims({limit:1})).toMatchObject({blocked:1})
  expect((await pool.query('SELECT claim_id FROM memory_lifecycle_assessment_runs ORDER BY started_at')).rows.map(r=>r.claim_id)).toEqual([first.claim,next.claim])
  expect(await service.assessDueClaims({limit:1})).toMatchObject({blocked:0})
  await pool.query("UPDATE memory_lifecycle_assessment_runs SET retry_at=clock_timestamp()-interval '1 second' WHERE claim_id=$1",[first.claim])
  expect(await service.assessDueClaims({limit:1})).toMatchObject({blocked:1})
  expect(generate).toHaveBeenCalledTimes(3)
 })

 test('AC-35 abort after reservation does not call the provider or apply assessment',async()=>{
  const f=await fixture();await observed(f.personal);const generate=generator(),controller=new AbortController()
  const service=createLifecycleAssessmentService({pool,mode:'enabled',modelFingerprint:'synthetic',textGeneratorForInstallation:()=>{controller.abort();return {generateJson:generate} as TextGenerator}})
  expect(await service.assessDueClaims({signal:controller.signal})).toMatchObject({evaluated:0,blocked:1})
  expect(generate).not.toHaveBeenCalled()
  expect((await pool.query('SELECT value_assessment FROM memory_claim_lifecycle')).rows[0].value_assessment).toBe('unknown')
 })

})
