import {measureInventoryRecovery} from '../testing/measure-inventory-recovery.js'
import {capturePrivacyWatermarks,replayPrivacyWatermarks,type PrivacyWatermarks} from '../migrations/governance-v2/reconcile.js'
import {BACKFILL_FAMILIES,startGovernanceBackfill,backfillGovernance,governanceEnvironmentFingerprint} from '../migrations/governance-v2/backfill.js'
import {cutoverGovernance,ensureGovernanceIndexes} from '../migrations/governance-v2/cutover.js'
import {validateGovernanceMigration} from '../migrations/governance-v2/validate.js'
import {createExecutorPrincipals} from '../governance/executor-principals.js'
import {createAutomationRepository} from '../governance/automation-repository.js'
import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {beforeAll,beforeEach,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {createMemoryPool} from '../db.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {createPublicationDelegation} from '../governance/publication-delegation.js'
import {createPublicationExecutor} from '../governance/publication-executor.js'
import {createPromotionRepository} from '../governance/promotion-repository.js'
const url=process.env.MEMORY_TEST_DATABASE_URL,suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('A3 exact human delegation and independent executor',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=createMemoryPool({databaseUrl:url!,dbPoolMax:8});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 async function setup(approved=true){
  const f=await governanceFixture(pool),c=approved?await f.approved():await f.proposed(),principalId=randomUUID()
  await pool.query(`INSERT INTO memory_governance_executor_principals(principal_id,installation_id,provider_client_id,state,permissions,authorization_epoch,valid_until,authorized_by_owner_id,authorized_by_membership_id) VALUES($1,$2,'executor-fixture','active',ARRAY['publish_delegated'],1,NOW()+interval '1 hour',$2,$3)`,[principalId,f.team,f.publisher])
  await createAutomationRepository(pool).setPolicy({installationId:f.team,grant:f.grant(f.publisher,['read','policy_admin']),expectedRevision:0,document:{mode:'assist',model:'no-model-delegation',promptVersion:'review-v1',delegatedPublish:true}})
  const revision=(await createPromotionRepository(pool).getLatestRevision(c.candidate.candidate_id))!
  const delegated=await createPublicationDelegation(pool).create({grant:{...f.grant(f.publisher,['read','publish']),callerType:'web'},installationId:f.team,candidateId:c.candidate.candidate_id,expectedRevision:1,expectedHash:revision.revision_bundle_hash!,principalId,expiresAt:new Date(Date.now()+60000).toISOString()})
  const deps={pool,mode:'enabled' as const,executorGrant:{providerClientId:'executor-fixture',installationId:f.team,permissionRevision:'1',authorizationEpoch:'1',expiresAt:Math.floor(Date.now()/1000)+3600}}
  return {f,c,principalId,delegated,deps}
 }
 test('populated automation and delegation rows survive classified incremental backfill and cutover',async()=>{
  const {f,delegated,deps,principalId}=await setup()
  const result=await createPublicationExecutor(deps).execute(delegated.delegationId);expect(result.published).toBe(true)
  const runId=await startGovernanceBackfill(pool,{installationIds:[f.personal,f.team],environmentFingerprint:await governanceEnvironmentFingerprint(pool)})
  expect((await backfillGovernance(pool,{runId,batchSize:1,interruptAfterBatch:3})).interrupted).toBe(true)
  await backfillGovernance(pool,{runId,batchSize:2});await backfillGovernance(pool,{runId,batchSize:2})
  await ensureGovernanceIndexes(pool)
  expect((await validateGovernanceMigration(pool,runId)).violations).toEqual([])
  const baseline=(await pool.query('SELECT manifest FROM memory_governance_migration_runs WHERE run_id=$1',[runId])).rows[0].manifest
  for(const family of ['memory_governance_executor_principals','memory_publication_delegations','memory_review_automation_policies','memory_review_automation_policy_heads'])expect(Object.keys(baseline.rows[family]).length).toBeGreaterThan(0)
  expect(BACKFILL_FAMILIES).toContain('memory_automation_authority_records')
  await cutoverGovernance(pool,{runId,installationId:f.team,writerProof:['api:identity_v2','worker:identity_v2','relay:identity_v2']})
  expect((await validateGovernanceMigration(pool,runId)).violations).toEqual([])
  expect((await pool.query('SELECT published_version_id FROM memory_publication_delegations WHERE delegation_id=$1',[delegated.delegationId])).rows[0].published_version_id).toBe(result.versionId)
  const legacy=new pg.Pool({connectionString:url})
  try{
   await expect(legacy.query('UPDATE memory_governance_executor_principals SET max_accepts_per_day=max_accepts_per_day+1 WHERE principal_id=$1',[principalId])).rejects.toThrow('memory_writer_incompatible')
   await expect(legacy.query("UPDATE memory_governance_executor_principals SET state='disabled',permission_revision=permission_revision+1 WHERE principal_id=$1",[principalId])).resolves.toMatchObject({rowCount:1})
  }finally{await legacy.end()}
  expect((await pool.query("SELECT COUNT(*)::int n FROM memory_governance_migration_changes WHERE installation_id=$1 AND entity_kind='memory_governance_executor_principals' AND operation='UPDATE'",[f.team])).rows[0].n).toBeGreaterThan(0)
 })
 test('actual backup restore replays independent executor and delegation withdrawal',async()=>{
  const {f,principalId,delegated}=await setup()
  let watermarks!:PrivacyWatermarks
  await measureInventoryRecovery(pool,url!,{beforeRestore:async()=>{
   await pool.query("UPDATE memory_governance_executor_principals SET state='disabled',permission_revision=permission_revision+1 WHERE principal_id=$1",[principalId])
   await pool.query("UPDATE memory_publication_delegations SET state='revoked' WHERE delegation_id=$1",[delegated.delegationId])
   watermarks=await capturePrivacyWatermarks(pool)
  }})
  await replayPrivacyWatermarks(pool,watermarks,{purgeHmacKey:'fixture-watermark-key'})
  expect((await pool.query('SELECT state,permission_revision::text FROM memory_governance_executor_principals WHERE principal_id=$1',[principalId])).rows[0]).toMatchObject({state:'disabled',permission_revision:'2'})
  expect((await pool.query('SELECT state FROM memory_publication_delegations WHERE delegation_id=$1',[delegated.delegationId])).rows[0].state).toBe('revoked')
 })
 test('automation decisions are captured in the owned run scope',async()=>{
  const {f,c}=await setup(),run=randomUUID()
  const policy=(await pool.query('SELECT policy_id FROM memory_review_automation_policy_heads WHERE installation_id=$1',[f.team])).rows[0].policy_id
  await pool.query("INSERT INTO memory_review_automation_runs(run_id,installation_id,subject_kind,candidate_id,candidate_revision,input_digest,policy_id,model,prompt_version,evaluator_version,authorization_epoch) VALUES($1,$2,'promotion',$3,1,$4,$5,'fixture','fixture','fixture',1)",[run,f.team,c.candidate.candidate_id,'d'.repeat(64),policy])
  await pool.query("INSERT INTO memory_review_automation_decisions(run_id,recommendation,reason_code,cost_micros) VALUES($1,'needs_human','fixture',0)",[run])
  expect((await pool.query("SELECT installation_id FROM memory_governance_migration_changes WHERE entity_kind='memory_review_automation_decisions' ORDER BY sequence DESC LIMIT 1")).rows[0].installation_id).toBe(f.team)
 })
})
