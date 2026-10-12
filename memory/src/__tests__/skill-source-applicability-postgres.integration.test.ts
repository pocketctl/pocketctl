import pg from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {createSkillGovernanceFixture} from '../testing/skill-fixture.js'
import {createSkillAdmissionService} from '../skills/admission-service.js'
import {loadSkillConfig} from '../skills/config.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('Skill claim source applicability (dedicated PostgreSQL)',()=>{
 let pool:pg.Pool
 const context={globalMode:'enabled' as const,sharedMode:'shadow' as const,config:loadSkillConfig({MEMORY_SKILL_MODE:'shadow'})}
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool?.end()})
 async function fixture(){
  const f=await createSkillGovernanceFixture(pool,context,'team')
  const row=(await pool.query("SELECT claim_id,current_version_id FROM knowledge_claims WHERE installation_id=$1 AND claim_type='work_method'",[f.installationId])).rows[0]
  const app={scopeKind:'repository',scopeKey:f.repositoryId,canonicalRepositoryKey:'github.com/Acme/Repo',repositoryId:f.repositoryId,snapshotId:f.snapshotId,branch:null,status:'verified'}
  await pool.query("UPDATE repositories SET canonical_remote='https://github.com/Acme/Repo.git' WHERE repository_id=$1",[f.repositoryId])
  await pool.query('UPDATE knowledge_claims SET canonical_repository_key=$2 WHERE claim_id=$1',[row.claim_id,app.canonicalRepositoryKey])
  await pool.query('UPDATE knowledge_versions SET repository_id=$2,repo_snapshot_id=$3,applicability=$4 WHERE version_id=$1',[row.current_version_id,f.repositoryId,f.snapshotId,app])
  const request={...f.author,candidateKey:'applicability',source:{kind:'claim_version',versionId:row.current_version_id,repositoryId:f.repositoryId,repoSnapshotId:f.snapshotId}}
  return{...f,claimId:row.claim_id,versionId:row.current_version_id,app,request,service:createSkillAdmissionService({pool,context})}
 }
 test('confirmed repository applicability admits an owned snapshot and binds source digest to metadata',async()=>{
  const f=await fixture(),one=await f.service.schedule(f.request)
  await pool.query('UPDATE knowledge_claims SET scope_kind=$2,scope_key=$3 WHERE claim_id=$1',[f.claimId,'snapshot',f.snapshotId])
  await pool.query('UPDATE knowledge_versions SET applicability=$2 WHERE version_id=$1',[f.versionId,{...f.app,scopeKind:'snapshot',scopeKey:f.snapshotId}])
  const two=await f.service.schedule(f.request)
  expect(two).toMatchObject({taskId:one.taskId,generation:2,deduplicated:false})
  expect((await pool.query('SELECT state,error_code FROM memory_skill_task_runs WHERE run_id=$1',[one.runId])).rows[0]).toMatchObject({state:'cancelled',error_code:'new_generation'})
 })
 test.each(['identity_requires_review','repository_mapping_missing'])('held %s source cannot schedule new work',async reason=>{
  const f=await fixture()
  await pool.query('UPDATE knowledge_claims SET consumption_hold_reason=$2 WHERE claim_id=$1',[f.claimId,reason])
  await expect(f.service.schedule(f.request)).rejects.toThrow('skill_claim_applicability_invalid')
  expect((await pool.query("SELECT 1 FROM memory_skill_tasks WHERE candidate_key='applicability'")).rowCount).toBe(0)
 })
 test.each(['legacy_unknown','requires_review'])('explicit %s source cannot schedule new work',async status=>{
  const f=await fixture()
  await pool.query('UPDATE knowledge_versions SET applicability=$2 WHERE version_id=$1',[f.versionId,{...f.app,status}])
  await expect(f.service.schedule(f.request)).rejects.toThrow('skill_claim_applicability_invalid')
 })
 test('canonical identity must match the current owned repository registry',async()=>{
  const f=await fixture()
  await pool.query("UPDATE repositories SET canonical_remote='https://github.com/Other/Repo.git' WHERE repository_id=$1",[f.repositoryId])
  await expect(f.service.schedule(f.request)).rejects.toThrow('skill_claim_applicability_invalid')
 })
 test('metadata projection mismatch is rejected',async()=>{
  const f=await fixture()
  await pool.query('UPDATE knowledge_versions SET applicability=$2 WHERE version_id=$1',[f.versionId,{...f.app,scopeKey:'unconfirmed-key'}])
  await expect(f.service.schedule(f.request)).rejects.toThrow('skill_claim_applicability_invalid')
 })
 test.each(['branch','task'])('%s applicability requires explicit request context and cannot use a snapshot label as proof',async scopeKind=>{
  const f=await fixture(),scopeKey=scopeKind==='branch'?'main':'task-a',branch=scopeKind==='branch'?'main':null
  await pool.query('UPDATE knowledge_claims SET scope_kind=$2,scope_key=$3 WHERE claim_id=$1',[f.claimId,scopeKind,scopeKey])
  await pool.query('UPDATE knowledge_versions SET branch=$2,applicability=$3 WHERE version_id=$1',[f.versionId,branch,{...f.app,scopeKind,scopeKey,branch}])
  await pool.query("UPDATE repo_snapshots SET branch='main' WHERE repo_snapshot_id=$1",[f.snapshotId])
  await expect(f.service.schedule(f.request)).rejects.toThrow('skill_claim_applicability_invalid')
 })
})
