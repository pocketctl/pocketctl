import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {beforeAll,beforeEach,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {lifecyclePipelineFixture} from '../testing/lifecycle-pipeline-fixture.js'
import {createClaimRepository} from '../claims/repository.js'
import {createCurationExecutor} from '../curation/executor.js'
const url=process.env.MEMORY_TEST_DATABASE_URL,suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('source-grounded lifecycle entity resolution',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:5});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 const {fixture,ingest}=lifecyclePipelineFixture({query:(...args:any[])=>pool.query(...args as [any]),connect:()=>pool.connect()} as pg.Pool)
 for(const existingShort of [false,true])test(`AC-21 source_named_entity_blocks_${existingShort?'existing':'new'}_short_subject_competitor`,async()=>{
  const f=await fixture()
  const original=await ingest(f,'30 seconds',f.space,undefined,{kind:'fact',predicate:'service.timeout',subject:'Atlas service',statement:'Atlas service timeout is 30 seconds.'})
  const revision=Number((await pool.query('SELECT revision FROM knowledge_claims WHERE claim_id=$1',[original.claimId])).rows[0].revision)
  const corrected=await createClaimRepository(pool).correctClaim({installationId:f.personal,claimId:original.claimId!,expectedRevision:revision,statement:'Atlas service timeout is 90 seconds.',evidence:[],inheritCurrentEvidence:true})
  expect(corrected.ok).toBe(true);if(!corrected.ok)return
  if(existingShort)await pool.query("INSERT INTO memory_entities(installation_id,space_id,entity_id,kind,name) VALUES($1,$2,$3,'other','Atlas')",[f.personal,f.space,randomUUID()])
  const entityCount=Number((await pool.query('SELECT count(*) n FROM memory_entities WHERE installation_id=$1',[f.personal])).rows[0].n)
  const before=(await pool.query('SELECT claim_id,current_version_id FROM knowledge_claims WHERE installation_id=$1 ORDER BY claim_id',[f.personal])).rows
  const result=await ingest(f,'120 seconds',f.space,undefined,{kind:'fact',predicate:'service.timeout',subject:'Atlas',statement:'Atlas service timeout is 120 seconds.'})
  expect(result).toMatchObject({action:'defer',reason:'identity_unresolved',claimId:null,versionId:null})
  expect((await pool.query('SELECT claim_id,current_version_id FROM knowledge_claims WHERE installation_id=$1 ORDER BY claim_id',[f.personal])).rows).toEqual(before)
  expect(before.find(c=>c.claim_id===original.claimId)?.current_version_id).toBe(corrected.versionId)
  expect(Number((await pool.query('SELECT count(*) n FROM memory_entities WHERE installation_id=$1',[f.personal])).rows[0].n)).toBe(entityCount)
  expect((await pool.query('SELECT count(*)::int n FROM memory_entity_aliases WHERE installation_id=$1',[f.personal])).rows[0].n).toBe(0)
  expect((await pool.query('SELECT claim_id,version_id,expected_version_id,evidence_refs FROM memory_curation_decisions WHERE decision_id=$1',[result.decisionId])).rows[0]).toEqual({claim_id:null,version_id:null,expected_version_id:null,evidence_refs:[]})
  const job=(await pool.query("SELECT * FROM memory_jobs WHERE installation_id=$1 AND job_type='curate_conclusions' AND idempotency_key NOT LIKE 'curate-deadline:%' ORDER BY created_at DESC LIMIT 1",[f.personal])).rows[0]
  const executor=createCurationExecutor({pool,mode:'enabled',tombstoneKeys:[]})
  expect(await executor.curate(job,new AbortController().signal)).toEqual(result)
  expect((await pool.query("SELECT state,semantic_deadline<=clock_timestamp()+interval '7 days' AS bounded FROM memory_task_bundles WHERE bundle_id=$1",[job.payload.bundle_id])).rows[0]).toEqual({state:'deferred_semantic',bounded:true})
  const parent=(await pool.query('SELECT parent_bundle_id FROM memory_task_bundles WHERE bundle_id=$1',[job.payload.bundle_id])).rows[0].parent_bundle_id
  expect((await pool.query('SELECT complete FROM memory_source_processing_receipts WHERE installation_id=$1 AND session_id=(SELECT session_id FROM memory_task_bundles WHERE bundle_id=$2)',[f.personal,parent])).rows[0].complete).toBe(false)
  await pool.query("UPDATE memory_task_bundles SET semantic_deadline=clock_timestamp()-interval '1 second' WHERE bundle_id=$1",[job.payload.bundle_id])
  expect(await executor.curate(job,new AbortController().signal)).toMatchObject({action:'skip',reason:'semantic_deadline',claimId:null,versionId:null})
 })
 test('AC-21 other_scene_names_do_not_resolve_or_block_subject',async()=>{
  const f=await fixture()
  await pool.query("INSERT INTO memory_entities(installation_id,space_id,entity_id,kind,name) VALUES($1,$2,$3,'other','Atlas service')",[f.personal,f.other,randomUUID()])
  const result=await ingest(f,'30 seconds',f.space,undefined,{kind:'fact',predicate:'service.timeout',subject:'Atlas',statement:'Atlas service timeout is 30 seconds.'})
  expect(result.action).toBe('create')
  expect((await pool.query('SELECT e.name,m.space_id FROM memory_logical_claims m JOIN memory_entities e ON e.installation_id=m.installation_id AND e.space_id=m.space_id AND e.entity_id=m.subject_entity_id WHERE m.claim_id=$1',[result.claimId])).rows).toEqual([{name:'Atlas',space_id:f.space}])
 })

})
