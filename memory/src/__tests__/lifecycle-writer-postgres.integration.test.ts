import pg from 'pg'
import {createHash,randomUUID} from 'node:crypto'
import {beforeAll,beforeEach,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {lifecycleSourceDigest} from '../curation/task-repository.js'
import {canonicalPacketJson} from '../episodes/packet.js'
import {canonicalPayloadHash} from '../inbox/canonical-json.js'
import {writeLifecycleConclusion} from '../curation/writer.js'
import {createCurationExecutor} from '../curation/executor.js'
import type {JobClaim} from '../jobs/types.js'
const url=process.env.MEMORY_TEST_DATABASE_URL,suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('lifecycle writer',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 async function setup(){const f=await governanceFixture(pool),space=randomUUID();await pool.query("INSERT INTO memory_curation_policies(installation_id,mode) VALUES($1,'enabled')",[f.personal]);await pool.query("INSERT INTO memory_spaces(installation_id,space_id,domain,name,destinations) VALUES($1,$2,'life','Travel',ARRAY['personal'])",[f.personal,space]);return {...f,space}}
 async function candidate(f:Awaited<ReturnType<typeof setup>>,value='trains',space=f.space,occurredAt=new Date()){
  const parent=randomUUID(),bundle=randomUUID(),run=randomUUID(),event=randomUUID(),id=randomUUID(),session='s-'+id,turn='t-'+id,text=`I prefer ${value} for personal travel.`,payload={text},digest=canonicalPayloadHash(payload)
  const provenance={memory:{version:1,producer:'claude',session_id:session,turn_id:turn,event_id:event,sequence:'1',invocation_id:'user',source_role:'user',skill_state:'non_skill',lineage_complete:true,derived_from_event_ids:[]}}
  await pool.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,source_provenance) VALUES($1::uuid,$2,'feed',$1::text,$3,$4,'user_text',$8,$5::jsonb,$6,$7::jsonb)`,[event,f.personal,session,turn,JSON.stringify(payload),digest,JSON.stringify(provenance),occurredAt])
  const storedEvents=(await pool.query('SELECT * FROM source_events WHERE installation_id=$1 AND source_event_id=$2',[f.personal,event])).rows
  const parentDigest=lifecycleSourceDigest(f.personal,storedEvents),spans=[{event_id:event,start:0,end:text.length}],childDigest=createHash('sha256').update(canonicalPacketJson({source:parentDigest.toString('hex'),spans,space})).digest()
  await pool.query(`INSERT INTO memory_task_bundles(installation_id,bundle_id,session_id,task_key,source_digest,watermark,state) VALUES($1,$2::uuid,$3,$5,$4,1,'completed')`,[f.personal,parent,session,parentDigest,'source:'+turn])
  await pool.query(`INSERT INTO memory_task_bundles(installation_id,bundle_id,session_id,task_key,space_id,source_digest,watermark,state,bundle_kind,parent_bundle_id,parent_revision,spans) VALUES($1,$2::uuid,$3,$2::text,$4,$5,1,'completed','task',$6,1,$7::jsonb)`,[f.personal,bundle,session,space,childDigest,parent,JSON.stringify(spans)])
  for(const b of [parent,bundle])await pool.query('INSERT INTO memory_task_bundle_sources(installation_id,bundle_id,source_event_id,source_digest,source_sequence) VALUES($1,$2,$3,$4,1)',[f.personal,b,event,digest])
  await pool.query(`INSERT INTO memory_curation_runs(installation_id,run_id,bundle_id,bundle_revision,source_digest,policy_revision,policy_hash,model_config_hash,mode,state) VALUES($1,$2,$3,1,$4,1,$5,$5,'enabled','completed')`,[f.personal,run,bundle,childDigest,'a'.repeat(64)])
  const conclusion={kind:'preference',assertion_mode:'user_asserted',subject:'self',predicate:'travel.transport',value,conditions:{},fact_at:null,valid_until:null,statement:text,confirmed:true,evidence:{subject:[event],predicate:[event],value:[event]}}
  await pool.query(`INSERT INTO memory_candidates(candidate_id,installation_id,ordinal,claim_type,statement,structured_content,normalized_key,scope_kind,scope_key,confidence,freshness_at,status,source_kind,bundle_id,curation_run_id,bundle_revision) VALUES($1::uuid,$2,0,'work_method',$3,$4::jsonb,$1::text,'task',$5,1,clock_timestamp(),'validated','task_bundle',$6,$7,1)`,[id,f.personal,text,JSON.stringify(conclusion),space,bundle,run])
  const job={job_id:randomUUID(),installation_id:f.personal,payload:{candidate_id:id,bundle_id:bundle,run_id:run}} as unknown as JobClaim
  return {job,event,id,bundle,parent,run}
 }
 const execute=(job:JobClaim)=>createCurationExecutor({pool,mode:'enabled',tombstoneKeys:[]}).curate(job,new AbortController().signal)
 test('AC-17 automatic_create_real_evidence_and_idempotency',async()=>{
  const f=await setup(),a=await candidate(f);const first=await execute(a.job),second=await execute(a.job)
  expect(first?.action).toBe('create');expect(second?.claimId).toBe(first?.claimId)
  const v=(await pool.query('SELECT authority FROM knowledge_versions WHERE version_id=$1',[first?.versionId])).rows[0];expect(v.authority).toBe('machine_concluded')
  expect((await pool.query('SELECT count(*)::int n FROM knowledge_evidence WHERE version_id=$1',[first?.versionId])).rows[0].n).toBe(1)
 })
 test('AC-19 same_claim_new_value_version',async()=>{
  const f=await setup(),a=await execute((await candidate(f)).job),b=await execute((await candidate(f,'planes')).job)
  expect(b?.action).toBe('replace');expect(b?.claimId).toBe(a?.claimId);expect(b?.versionId).not.toBe(a?.versionId)
  expect((await pool.query('SELECT count(*)::int n FROM knowledge_versions WHERE claim_id=$1',[a?.claimId])).rows[0].n).toBe(2)
 })
 test('AC-17 equivalent_only_links_independent_evidence',async()=>{
  const f=await setup(),a=await execute((await candidate(f)).job),b=await execute((await candidate(f)).job)
  expect(b?.action).toBe('link_evidence');expect(b?.versionId).toBe(a?.versionId)
  expect((await pool.query('SELECT count(*)::int n FROM knowledge_evidence WHERE version_id=$1',[a?.versionId])).rows[0].n).toBe(2)
 })
 test('AC-24 stale_parent_rejected_before_write',async()=>{
  const f=await setup(),a=await candidate(f);await pool.query('UPDATE memory_task_bundles SET revision=revision+1 WHERE bundle_id=$1',[a.parent]);await expect(execute(a.job)).rejects.toThrow('curation_parent_changed')
  expect((await pool.query('SELECT count(*)::int n FROM memory_logical_claims')).rows[0].n).toBe(0)
 })
 test('AC-24 source_changed_after_extraction_rejected',async()=>{
  const f=await setup(),a=await candidate(f);await pool.query("UPDATE source_events SET payload='{}'::jsonb WHERE source_event_id=$1",[a.event]);await expect(execute(a.job)).rejects.toThrow('curation_source_changed')
 })
 test('AC-21 protected_current_value_not_overwritten',async()=>{
  const f=await setup(),a=await execute((await candidate(f)).job);await pool.query("UPDATE memory_claim_lifecycle SET protection='pinned' WHERE claim_id=$1",[a?.claimId]);const b=await execute((await candidate(f,'planes')).job);expect(b?.action).toBe('defer')
  expect((await pool.query('SELECT current_version_id FROM knowledge_claims WHERE claim_id=$1',[a?.claimId])).rows[0].current_version_id).toBe(a?.versionId)
 })
 test('AC-24 logical_delete_blocks_old_source_replay',async()=>{
  const f=await setup(),a=await execute((await candidate(f)).job)
  await pool.query('DELETE FROM knowledge_claims WHERE claim_id=$1',[a?.claimId])
  const remaining=(await pool.query('SELECT count(*)::int n FROM knowledge_claims WHERE installation_id=$1',[f.personal])).rows[0].n
  const replay=await candidate(f)
  // A completed intake run is required for a terminal processing receipt.
  await pool.query(`INSERT INTO memory_curation_runs(installation_id,run_id,bundle_id,bundle_revision,source_digest,policy_revision,policy_hash,model_config_hash,mode,state)
   SELECT installation_id,gen_random_uuid(),bundle_id,revision,source_digest,1,$3,$3,'enabled','completed' FROM memory_task_bundles WHERE installation_id=$1 AND bundle_id=$2`,[f.personal,replay.parent,'a'.repeat(64)])
  const skipped=await execute(replay.job)
  expect(skipped).toMatchObject({action:'skip',reason:'logical_identity_deleted',claimId:null,versionId:null})
  expect(await execute(replay.job)).toEqual(skipped)
  expect((await pool.query('SELECT action,state,reason_code,evidence_refs FROM memory_curation_decisions WHERE candidate_id=$1',[replay.id])).rows).toEqual([{action:'skip',state:'skipped',reason_code:'logical_identity_deleted',evidence_refs:[]}])
  expect((await pool.query('SELECT status FROM memory_candidates WHERE candidate_id=$1',[replay.id])).rows[0].status).toBe('rejected')
  expect((await pool.query('SELECT complete FROM memory_source_processing_receipts WHERE installation_id=$1 AND session_id=(SELECT session_id FROM memory_task_bundles WHERE bundle_id=$2)',[f.personal,replay.parent])).rows[0].complete).toBe(true)
  expect((await pool.query('SELECT count(*)::int n FROM knowledge_claims WHERE installation_id=$1',[f.personal])).rows[0].n).toBe(remaining)
  expect((await pool.query('SELECT count(*)::int n FROM memory_logical_claims WHERE installation_id=$1',[f.personal])).rows[0].n).toBe(0)
 })
 test('AC-24 late_skill_event_before_recompile_refuses_write',async()=>{
  const f=await setup(),a=await candidate(f),id=randomUUID(),source=(await pool.query('SELECT * FROM source_events WHERE source_event_id=$1',[a.event])).rows[0],payload={text:'Excluded skill marker'}
  const provenance={memory:{...source.source_provenance.memory,event_id:id,sequence:'2',skill_state:'skill'}}
  await pool.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,source_provenance) VALUES($1::uuid,$2,'feed',$1::text,$3,$4,'agent_text',clock_timestamp(),$5::jsonb,$6,$7::jsonb)`,[id,f.personal,source.session_id,source.turn_id,JSON.stringify(payload),canonicalPayloadHash(payload),JSON.stringify(provenance)])
  await expect(execute(a.job)).rejects.toThrow('curation_source_changed')
  expect((await pool.query('SELECT count(*)::int n FROM memory_logical_claims')).rows[0].n).toBe(0)
 })
 test('AC-24 authorization_epoch_change_refuses_write',async()=>{
  const f=await setup(),a=await candidate(f);await pool.query('UPDATE memory_owner_scopes SET authorization_epoch=authorization_epoch+1 WHERE installation_id=$1',[f.personal]);await expect(execute(a.job)).rejects.toThrow('curation_policy_or_source_changed')
 })
 test('AC-18 equal_text_separate_scene_keeps_distinct_claims',async()=>{
  const f=await setup(),other=randomUUID();await pool.query("INSERT INTO memory_spaces(installation_id,space_id,domain,name,destinations) VALUES($1,$2,'life','Other travel',ARRAY['personal'])",[f.personal,other])
  const a=await execute((await candidate(f)).job),b=await execute((await candidate(f,'trains',other)).job)
  expect(a?.claimId).not.toBe(b?.claimId);expect((await pool.query('SELECT count(*)::int n FROM memory_logical_claims')).rows[0].n).toBe(2)
 })
 test('AC-15 deferred_relation_expires_without_manual_review',async()=>{
  const f=await setup(),a=await execute((await candidate(f)).job);await pool.query("UPDATE memory_claim_lifecycle SET protection='pinned' WHERE claim_id=$1",[a?.claimId]);const b=await candidate(f,'planes');expect((await execute(b.job))?.action).toBe('defer')
  await pool.query("UPDATE memory_task_bundles SET semantic_deadline=clock_timestamp()-interval '1 second' WHERE bundle_id=$1",[b.bundle]);expect((await execute(b.job))?.action).toBe('skip')
  expect((await pool.query('SELECT state FROM memory_task_bundles WHERE bundle_id=$1',[b.bundle])).rows[0].state).toBe('skipped_unresolved')
 })
 test('AC-17 same_source_duplicate_is_noop',async()=>{
  const f=await setup(),a=await candidate(f),first=await execute(a.job),duplicate=randomUUID()
  await pool.query(`INSERT INTO memory_candidates(candidate_id,installation_id,ordinal,claim_type,statement,structured_content,normalized_key,scope_kind,scope_key,confidence,freshness_at,status,source_kind,bundle_id,curation_run_id,bundle_revision) SELECT $2,installation_id,1,claim_type,statement,structured_content,normalized_key,scope_kind,scope_key,confidence,freshness_at,'validated',source_kind,bundle_id,curation_run_id,bundle_revision FROM memory_candidates WHERE candidate_id=$1`,[a.id,duplicate])
  const repeated=await execute({...a.job,payload:{...a.job.payload,candidate_id:duplicate}})
  expect(repeated?.action).toBe('noop');expect(repeated?.versionId).toBe(first?.versionId)
  expect((await pool.query('SELECT count(*)::int n FROM knowledge_evidence WHERE version_id=$1',[first?.versionId])).rows[0].n).toBe(1)
 })
 test('AC-23 late_source_time_cannot_replace_current_preference',async()=>{
  const f=await setup(),first=await execute((await candidate(f)).job),late=await candidate(f,'planes',f.space,new Date('2020-01-01T00:00:00Z'))
  expect((await execute(late.job))?.action).toBe('defer')
  expect((await pool.query('SELECT current_version_id FROM knowledge_claims WHERE claim_id=$1',[first?.claimId])).rows[0].current_version_id).toBe(first?.versionId)
 })
 test('AC-21 corrected_authority_without_lifecycle_protection_is_preserved',async()=>{
  const f=await setup(),a=await execute((await candidate(f)).job)
  await pool.query("UPDATE knowledge_versions SET authority='user_corrected' WHERE version_id=$1",[a?.versionId])
  await pool.query("UPDATE memory_claim_lifecycle SET protection='none' WHERE claim_id=$1",[a?.claimId])
  expect((await execute((await candidate(f,'planes')).job))?.action).toBe('defer')
  expect((await pool.query('SELECT current_version_id FROM knowledge_claims WHERE claim_id=$1',[a?.claimId])).rows[0].current_version_id).toBe(a?.versionId)
 })

 test('AC-21 ledger_independently_fences_identity_protection_and_late_source',async()=>{
  const f=await setup(),a=await execute((await candidate(f)).job),target=(await pool.query('SELECT c.*,v.version_number FROM knowledge_claims c JOIN knowledge_versions v ON v.version_id=c.current_version_id WHERE c.claim_id=$1',[a?.claimId])).rows[0]
  const c=await pool.connect();await c.query('BEGIN')
  try{
   const input={installationId:f.personal,target,relation:{action:'create_variant'},evidence:[{occurredAt:new Date()}]} as any
   await expect(writeLifecycleConclusion(c,input)).rejects.toThrow('curation_action_identity_mismatch')
   input.relation={action:'replace'};await c.query("UPDATE memory_claim_lifecycle SET protection='pinned' WHERE claim_id=$1",[a?.claimId])
   await expect(writeLifecycleConclusion(c,input)).rejects.toThrow('curation_target_protected')
   await c.query("UPDATE memory_claim_lifecycle SET protection='none' WHERE claim_id=$1",[a?.claimId]);await c.query("UPDATE knowledge_versions SET authority='user_corrected' WHERE version_id=$1",[a?.versionId])
   await expect(writeLifecycleConclusion(c,input)).rejects.toThrow('curation_target_protected')
   await c.query("UPDATE knowledge_versions SET authority='machine_concluded' WHERE version_id=$1",[a?.versionId]);input.evidence=[{occurredAt:new Date('2000-01-01T00:00:00Z')}]
   await expect(writeLifecycleConclusion(c,input)).rejects.toThrow('curation_late_source_event')
  }finally{await c.query('ROLLBACK');c.release()}
 })

})
