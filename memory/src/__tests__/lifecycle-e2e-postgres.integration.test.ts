import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {beforeAll,beforeEach,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {lifecyclePipelineFixture} from '../testing/lifecycle-pipeline-fixture.js'
import {createClaimRepository} from '../claims/repository.js'
import {reclaimColdClaimBody} from '../retention/claim-history.js'
import {canonicalPayloadHash} from '../inbox/canonical-json.js'
import {stageLifecycleTurn} from '../curation/task-repository.js'
import {createCurationWorker} from '../curation/worker.js'
import {createCurationExecutor} from '../curation/executor.js'
import {createSearchService} from '../retrieval/search-service.js'
import {createContextCompiler} from '../context/compiler.js'
import {createAdmissionService} from '../context/admission-service.js'
import {createContextRetrieval} from '../context/retrieval.js'
import {createScopeResolver} from '../context/scope-resolver.js'
import {createLoadoutRepository} from '../context/loadout-repository.js'
import {createContextSettingsRepository} from '../context/settings-repository.js'
import {createPackRepository} from '../context/pack-repository.js'
import {createGenerationRunRepository} from '../generation/repository.js'
import {createPolicyRepository} from '../policies/repository.js'
import {createPolicyResolver} from '../policies/resolver.js'
import {createTrajectoryRepository} from '../context/trajectory-repository.js'
import type {TextGenerator} from '../ports/text-generator.js'
const url=process.env.MEMORY_TEST_DATABASE_URL,suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('lifecycle pipeline with declared synthetic model',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:5});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 const {fixture,ingest,deliver}=lifecyclePipelineFixture({query:(...args:any[])=>pool.query(...args as [any]),connect:()=>pool.connect()} as pg.Pool)
 test('AC-54 staged_source_to_current_context_update_and_scene_variant',async()=>{
  const f=await fixture(),first=await ingest(f,'trains'),a=await deliver(f)
  expect(a.items.some(i=>i.version_id===first.versionId)).toBe(true)
  const next=await ingest(f,'planes'),b=await deliver(f)
  expect(next.claimId).toBe(first.claimId);expect(next.versionId).not.toBe(first.versionId)
  expect(b.items.some(i=>i.version_id===next.versionId)).toBe(true);expect(b.items.some(i=>i.version_id===first.versionId)).toBe(false)
  const variant=await ingest(f,'buses',f.other),c=await deliver(f)
  expect(variant.claimId).not.toBe(first.claimId);expect(c.items.some(i=>i.claim_id===variant.claimId)).toBe(false)
  expect((await deliver(f,f.other)).items.some(i=>i.version_id===variant.versionId)).toBe(true)
  expect((await pool.query("SELECT count(*)::int n FROM memory_claim_usage WHERE claim_id=$1 AND signal='delivered'",[first.claimId])).rows[0].n).toBeGreaterThan(0)
 })
 test('AC-54 cold_and_deleted_no_longer_injected',async()=>{
  const f=await fixture(),fact=await ingest(f,'trains');await deliver(f)
  await pool.query("UPDATE memory_claim_lifecycle SET storage_tier='cold',cold_since=clock_timestamp(),revision=revision+1 WHERE claim_id=$1",[fact.claimId])
  const search=createSearchService({pool,recallEmbeddingTimeoutMs:100,cursorSigningKey:'synthetic'})
  const {resolveLifecycleFrame}=await import('../context/lifecycle-frame.js'),lifecycle=await resolveLifecycleFrame(pool,{installationId:f.personal,sessionId:f.session,spaceId:f.space,repositoryId:null,destination:'personal',mode:'enabled'})
  expect((await search.search({installationId:f.personal,query:'personal travel',lifecycle})).hits).toHaveLength(0)
  await pool.query('DELETE FROM knowledge_claims WHERE claim_id=$1',[fact.claimId])
  expect(await ingest(f,'trains')).toMatchObject({action:'skip',reason:'logical_identity_deleted',claimId:null,versionId:null})
  expect((await search.search({installationId:f.personal,query:'personal travel',lifecycle})).hits).toHaveLength(0)
 })
 test('AC-36 fresh_source_after_reclamation_creates_new_body_and_context',async()=>{
  const f=await fixture(),first=await ingest(f,'30 seconds',f.space,undefined,{kind:'fact',predicate:'service.timeout',subject:'API',statement:'API timeout is 30 seconds.'})
  await pool.query("UPDATE memory_curation_policies SET cold_mode='enabled',reclaim_mode='enabled' WHERE installation_id=$1",[f.personal])
  await pool.query("UPDATE knowledge_claims SET created_at=clock_timestamp()-interval '200 days' WHERE claim_id=$1",[first.claimId])
  await pool.query("UPDATE memory_claim_lifecycle SET storage_tier='cold',cold_since=clock_timestamp()-interval '91 days',last_confirmed_at=clock_timestamp()-interval '200 days',observation_state='observed',observation_started_at=clock_timestamp()-interval '200 days',value_assessment='low' WHERE claim_id=$1",[first.claimId])
  await pool.query(`INSERT INTO memory_lifecycle_observation_windows(installation_id,state,started_at,last_heartbeat_at,capability_since_at,last_native_delivery_at,settings_hash) VALUES($1,'observed',clock_timestamp()-interval '200 days',clock_timestamp(),clock_timestamp()-interval '201 days',clock_timestamp(),'synthetic-test-coverage')`,[f.personal])
  expect((await reclaimColdClaimBody(pool,{installationId:f.personal,claimId:first.claimId!},{lifecycleMode:'enabled',readerCompatible:true})).versions).toBe(1)
  const old=(await pool.query('SELECT statement,body_state,body_hash FROM knowledge_versions WHERE version_id=$1',[first.versionId])).rows[0];expect(old.body_state).toBe('reclaimed')
  const original=(await pool.query('SELECT c.* FROM memory_candidates c JOIN memory_curation_decisions d USING(installation_id,candidate_id) WHERE d.decision_id=$1',[first.decisionId])).rows[0],duplicate=randomUUID()
  await pool.query(`INSERT INTO memory_candidates(candidate_id,installation_id,ordinal,claim_type,statement,structured_content,normalized_key,scope_kind,scope_key,confidence,freshness_at,status,source_kind,bundle_id,curation_run_id,bundle_revision) SELECT $2,installation_id,1,claim_type,statement,structured_content,normalized_key,scope_kind,scope_key,confidence,freshness_at,'validated',source_kind,bundle_id,curation_run_id,bundle_revision FROM memory_candidates WHERE candidate_id=$1`,[original.candidate_id,duplicate])
  const replay=await createCurationExecutor({pool,mode:'enabled',tombstoneKeys:[]}).curate({job_id:randomUUID(),installation_id:f.personal,payload:{candidate_id:duplicate,bundle_id:original.bundle_id,run_id:original.curation_run_id}} as any,new AbortController().signal)
  expect(replay?.action).toBe('skip');expect((await pool.query('SELECT body_state FROM knowledge_versions WHERE version_id=$1',[first.versionId])).rows[0].body_state).toBe('reclaimed')
  const next=await ingest(f,'60 seconds',f.space,undefined,{kind:'fact',predicate:'service.timeout',subject:'API',statement:'API timeout is 60 seconds.'})
  expect(next.action).toBe('replace');expect(next.claimId).toBe(first.claimId);expect(next.versionId).not.toBe(first.versionId)
  expect((await pool.query('SELECT statement,body_state,body_hash FROM knowledge_versions WHERE version_id=$1',[first.versionId])).rows[0]).toEqual(old)
  expect((await pool.query('SELECT storage_tier,body_state,value_assessment FROM memory_claim_lifecycle WHERE claim_id=$1',[first.claimId])).rows[0]).toEqual({storage_tier:'hot',body_state:'present',value_assessment:'unknown'})
  const {resolveLifecycleFrame}=await import('../context/lifecycle-frame.js'),lifecycle=await resolveLifecycleFrame(pool,{installationId:f.personal,sessionId:f.session,spaceId:f.space,repositoryId:null,destination:'personal',mode:'enabled'})
  const search=createSearchService({pool,recallEmbeddingTimeoutMs:100,cursorSigningKey:'synthetic'});expect((await search.search({installationId:f.personal,query:'API timeout',lifecycle})).hits.map(h=>h.versionId)).toEqual([next.versionId])
  const delivered=await deliver(f,f.space,'API timeout');expect(delivered.items.some(item=>item.version_id===next.versionId)).toBe(true);expect(delivered.items.some(item=>item.version_id===first.versionId)).toBe(false)
 })
 test('AC-21 normal_user_correction_survives_machine_update',async()=>{
  const f=await fixture(),first=await ingest(f,'trains'),revision=Number((await pool.query('SELECT revision FROM knowledge_claims WHERE claim_id=$1',[first.claimId])).rows[0].revision)
  const correction=await createClaimRepository(pool).correctClaim({installationId:f.personal,claimId:first.claimId!,expectedRevision:revision,statement:'I prefer buses for personal travel.',evidence:[],inheritCurrentEvidence:true})
  expect(correction.ok).toBe(true);if(!correction.ok)return
  const next=await ingest(f,'planes');expect(next.action).toBe('defer')
  expect((await pool.query('SELECT current_version_id FROM knowledge_claims WHERE claim_id=$1',[first.claimId])).rows[0].current_version_id).toBe(correction.versionId)
  const delivered=await deliver(f);expect(delivered.items.some(i=>i.version_id===correction.versionId)).toBe(true)
 })
 test('AC-21 subject_alias_and_case_preserve_pinned_identity',async()=>{
  const f=await fixture(),first=await ingest(f,'30 seconds',f.space,undefined,{kind:'fact',predicate:'service.timeout',subject:'API',statement:'API timeout is 30 seconds.'})
  await pool.query("UPDATE memory_claim_lifecycle SET protection='pinned' WHERE claim_id=$1",[first.claimId])
  await pool.query("INSERT INTO memory_entity_aliases(installation_id,space_id,entity_id,alias) SELECT installation_id,space_id,subject_entity_id,'service' FROM memory_logical_claims WHERE claim_id=$1",[first.claimId])
  for(const subject of ['api','service']){
   const next=await ingest(f,'60 seconds',f.space,undefined,{kind:'fact',predicate:'service.timeout',subject,statement:subject+' timeout is 60 seconds.'})
   expect(next.action).toBe('defer');expect(next.claimId).toBe(first.claimId)
  }
  expect((await pool.query('SELECT current_version_id FROM knowledge_claims WHERE claim_id=$1',[first.claimId])).rows[0].current_version_id).toBe(first.versionId)
 })

})
