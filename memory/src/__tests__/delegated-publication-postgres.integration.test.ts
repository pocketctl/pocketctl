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
 test('execution preserves genuine human quorum and records executor plus authorizer once',async()=>{
  const {f,delegated,deps,principalId}=await setup(),executor=createPublicationExecutor(deps)
  const first=await executor.execute(delegated.delegationId);expect(first.published).toBe(true)
  expect(await executor.execute(delegated.delegationId)).toMatchObject({published:true,versionId:first.versionId})
  expect((await pool.query('SELECT publisher_membership_id,executor_principal_id,publication_delegation_id FROM memory_authority_records')).rows).toEqual([{publisher_membership_id:f.publisher,executor_principal_id:principalId,publication_delegation_id:delegated.delegationId}])
  expect((await pool.query('SELECT COUNT(*)::int n FROM memory_review_decisions')).rows[0].n).toBe(1)
 })
 test('off is independently closed and a delegation does not create missing human votes',async()=>{
  const {delegated,deps}=await setup(false)
  expect(await createPublicationExecutor({...deps,mode:'off'}).execute(delegated.delegationId)).toMatchObject({published:false,reason:'delegated_publish_off'})
  expect((await createPublicationExecutor(deps).execute(delegated.delegationId)).published).toBe(false)
  expect((await pool.query('SELECT COUNT(*)::int n FROM memory_authority_records')).rows[0].n).toBe(0)
 })
 test('service caller cannot grant itself executor permissions',async()=>{
  const {f}=await setup()
  await expect(createExecutorPrincipals(pool).authorize({grant:{...f.grant(f.publisher,['read','policy_admin']),callerType:'provider'},installationId:f.team,providerClientId:'executor-fixture',permissions:['publish_delegated'],expiresAt:new Date(Date.now()+60000).toISOString()})).rejects.toThrow('human_executor_admin_required')
 })
 test('parallel execution produces one authority and one real publication',async()=>{
  const {delegated,deps}=await setup(),executor=createPublicationExecutor(deps)
  const result=await Promise.all([executor.execute(delegated.delegationId),executor.execute(delegated.delegationId)])
  expect(result.every(r=>r.published)).toBe(true)
  expect(new Set(result.map(r=>r.versionId)).size).toBe(1)
  expect((await pool.query('SELECT COUNT(*)::int n FROM memory_authority_records')).rows[0].n).toBe(1)
 })
 test('final commit beyond delegation expiry rolls back publication and receipt',async()=>{
  const {delegated,deps}=await setup(),blocker=await pool.connect(),key=8123063
  await pool.query(`CREATE FUNCTION delegation_test_commit_block() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(8123063);RETURN NEW;END $$`)
  await pool.query(`CREATE TRIGGER delegation_test_commit_block BEFORE INSERT ON memory_authority_records FOR EACH ROW EXECUTE FUNCTION delegation_test_commit_block()`)
  try{await blocker.query('SELECT pg_advisory_lock($1)',[key]);const pid=(await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid
   await pool.query("UPDATE memory_publication_delegations SET valid_until=clock_timestamp()+interval '500 milliseconds' WHERE delegation_id=$1",[delegated.delegationId])
   const work=createPublicationExecutor(deps).execute(delegated.delegationId)
   let blocked=false;for(let i=0;i<40;i++){blocked=(await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS yes',[pid])).rows[0].yes;if(blocked)break;await new Promise(r=>setTimeout(r,10))};expect(blocked).toBe(true)
   for(let i=0;i<80;i++){if((await pool.query('SELECT valid_until<=clock_timestamp() expired FROM memory_publication_delegations WHERE delegation_id=$1',[delegated.delegationId])).rows[0].expired)break;await new Promise(r=>setTimeout(r,10))}
   await blocker.query('SELECT pg_advisory_unlock($1)',[key]);expect(await work).toMatchObject({published:false,reason:'publication_delegation_expired'})
   expect((await pool.query('SELECT COUNT(*)::int n FROM memory_authority_records')).rows[0].n).toBe(0)
   expect((await pool.query('SELECT state FROM memory_publication_delegations WHERE delegation_id=$1',[delegated.delegationId])).rows[0].state).toBe('active')
  }finally{await blocker.query('SELECT pg_advisory_unlock($1)',[key]);blocker.release();await pool.query('DROP TRIGGER delegation_test_commit_block ON memory_authority_records;DROP FUNCTION delegation_test_commit_block()')}
 })
 test.each(['authorizer','expiry','revision','policy','principal','service_grant','revoke'])('%s change invalidates execution',async changed=>{
  const {f,c,delegated,deps,principalId}=await setup()
  if(changed==='authorizer')await pool.query("UPDATE memory_scope_memberships SET state='revoked',membership_revision=2 WHERE membership_id=$1",[f.publisher])
  if(changed==='expiry')await pool.query("UPDATE memory_publication_delegations SET valid_until=clock_timestamp()-interval '1 second' WHERE delegation_id=$1",[delegated.delegationId])
  if(changed==='revision')await pool.query('UPDATE memory_promotion_candidates SET revision=revision+1 WHERE candidate_id=$1',[c.candidate.candidate_id])
  if(changed==='policy')await pool.query('UPDATE memory_review_policy_heads SET revision=revision+1')
  if(changed==='principal')await pool.query("UPDATE memory_governance_executor_principals SET state='disabled' WHERE principal_id=$1",[principalId])
  if(changed==='service_grant')deps.executorGrant.expiresAt=1
  if(changed==='revoke')await createPublicationDelegation(pool).revoke({grant:{...f.grant(f.publisher,['read','publish']),callerType:'web'},installationId:f.team,delegationId:delegated.delegationId})
  expect((await createPublicationExecutor(deps).execute(delegated.delegationId)).published).toBe(false)
  expect((await pool.query('SELECT COUNT(*)::int n FROM memory_authority_records')).rows[0].n).toBe(0)
 })
})
