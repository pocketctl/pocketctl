import pg from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {createPromotionRepository} from '../governance/promotion-repository.js'
import {createPublicationService,createSharedClaimLifecycle} from '../governance/publication-service.js'
import {createPurgeRepository} from '../purge/repository.js'
const url=process.env.MEMORY_TEST_DATABASE_URL,suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('governance expiry and declared retention',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:4});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 test('expired pending candidates are excluded independently of maintenance',async()=>{
  const f=await governanceFixture(pool),{candidate}=await f.proposed()
  await pool.query("UPDATE memory_promotion_candidates SET expires_at=clock_timestamp()-interval '1 second' WHERE candidate_id=$1",[candidate.candidate_id])
  expect(await createPromotionRepository(pool).listQueue(f.team,['proposed'])).toEqual([])
  expect((await createPromotionRepository(pool).getCandidate(f.team,candidate.candidate_id))?.state).toBe('proposed')
 })
 test('review of an expired candidate cannot create a vote or receipt',async()=>{
  const f=await governanceFixture(pool),{candidate}=await f.proposed()
  await pool.query("UPDATE memory_promotion_candidates SET expires_at=clock_timestamp()-interval '1 second' WHERE candidate_id=$1",[candidate.candidate_id])
  await expect(createPublicationService(pool).decide({grant:f.grant(f.reviewer,['read','review']),targetInstallationId:f.team,
   candidateId:candidate.candidate_id,expectedCandidateRevision:candidate.revision,decision:'approve'})).rejects.toMatchObject({code:'expired'})
  expect((await pool.query('SELECT count(*)::int n FROM memory_review_decisions')).rows[0].n).toBe(0)
 })
 test('expiry during publication writes rolls back authority, job and head',async()=>{
  const f=await governanceFixture(pool),{candidate}=await f.approved()
  await pool.query(`CREATE FUNCTION test_retention_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(.3); RETURN NEW; END $$;
   CREATE TRIGGER test_retention_delay BEFORE INSERT ON memory_authority_records FOR EACH ROW EXECUTE FUNCTION test_retention_delay()`)
  try{
   await pool.query("UPDATE memory_promotion_candidates SET expires_at=clock_timestamp()+interval '250 milliseconds' WHERE candidate_id=$1",[candidate.candidate_id])
   await expect(createPublicationService(pool).publish({grant:f.grant(f.publisher,['read','publish']),targetInstallationId:f.team,
    candidateId:candidate.candidate_id,expectedCandidateRevision:candidate.revision,resolution:'new'})).rejects.toMatchObject({code:'expired'})
  }finally{await pool.query('DROP TRIGGER test_retention_delay ON memory_authority_records; DROP FUNCTION test_retention_delay()')}
  expect((await pool.query('SELECT count(*)::int n FROM memory_authority_records')).rows[0].n).toBe(0)
  expect((await pool.query('SELECT count(*)::int n FROM knowledge_claims WHERE installation_id=$1',[f.team])).rows[0].n).toBe(0)
 })
 test('expiry sweep is bounded, idempotent and records a content-free event',async()=>{
  const f=await governanceFixture(pool),{candidate}=await f.proposed()
  await pool.query("UPDATE memory_promotion_candidates SET expires_at=clock_timestamp()-interval '1 second' WHERE candidate_id=$1",[candidate.candidate_id])
  const lifecycle=createSharedClaimLifecycle(pool)
  expect(await lifecycle.expirePromotionCandidates(f.team)).toBe(1)
  expect(await lifecycle.expirePromotionCandidates(f.team)).toBe(0)
  const events=await pool.query("SELECT metadata FROM memory_governance_events WHERE action='candidate_expired'")
  expect(events.rowCount).toBe(1);expect(JSON.stringify(events.rows)).not.toContain('Transactional fixture invariant')
 })
 async function revoked(){
  const f=await governanceFixture(pool),{candidate}=await f.approved()
  const published=await createPublicationService(pool).publish({grant:f.grant(f.publisher,['read','publish']),targetInstallationId:f.team,
   candidateId:candidate.candidate_id,expectedCandidateRevision:candidate.revision,resolution:'new'})
  await createSharedClaimLifecycle(pool).revokeSharedClaim({grant:f.grant(f.publisher,['read','publish']),targetInstallationId:f.team,
   claimId:published.claimId,expectedRevision:1,reason:'withdraw'})
  return {f,candidate,published}
 }
 test('declared revoked retention removes content once and preserves authority and hash-only receipt',async()=>{
  const {f,published}=await revoked()
  await pool.query("UPDATE memory_governance_events SET created_at=clock_timestamp()-interval '91 days' WHERE action='shared_claim_revoked' AND target_id=$1",[published.claimId])
  const purge=createPurgeRepository(pool,{hmacKey:'retention-test-key'}) as unknown as {cleanupRevokedSharedClaims(input:{limit:number}):Promise<number>}
  expect(await purge.cleanupRevokedSharedClaims({limit:1})).toBe(1)
  expect(await purge.cleanupRevokedSharedClaims({limit:1})).toBe(0)
  const version=(await pool.query('SELECT statement FROM knowledge_versions WHERE version_id=$1',[published.versionId])).rows[0]
  expect(version.statement).toBe('[retention purged]')
  expect((await pool.query('SELECT count(*)::int n FROM memory_authority_records WHERE version_id=$1',[published.versionId])).rows[0].n).toBe(1)
  const receipt=(await pool.query("SELECT metadata FROM memory_governance_events WHERE action='shared_claim_retention_purged' AND target_id=$1",[published.claimId])).rows[0].metadata
  expect(receipt).toMatchObject({policy_version_id:expect.any(String),versions:expect.any(Number)})
  expect(JSON.stringify(receipt)).not.toContain('Transactional fixture invariant')
  expect((await pool.query('SELECT statement FROM knowledge_versions WHERE version_id=$1',[f.version])).rows[0].statement).toBe('Transactional fixture invariant')
 })
 test('retention window and unknown historical authority both prevent content deletion',async()=>{
  const {published}=await revoked()
  const purge=createPurgeRepository(pool,{hmacKey:'retention-test-key'}) as unknown as {cleanupRevokedSharedClaims(input:{limit:number}):Promise<number>}
  expect(await purge.cleanupRevokedSharedClaims({limit:10})).toBe(0)
  await pool.query("UPDATE memory_governance_events SET created_at=clock_timestamp()-interval '1000 days' WHERE action='shared_claim_revoked' AND target_id=$1",[published.claimId])
  await pool.query('DELETE FROM memory_authority_records WHERE version_id=$1',[published.versionId])
  expect(await purge.cleanupRevokedSharedClaims({limit:10})).toBe(0)
  expect((await pool.query('SELECT statement FROM knowledge_versions WHERE version_id=$1',[published.versionId])).rows[0].statement).toBe('Transactional fixture invariant')
 })
 test('cleanup rechecks lifecycle after a real installation lock wait',async()=>{
  const {f,published}=await revoked()
  await pool.query("UPDATE memory_governance_events SET created_at=clock_timestamp()-interval '91 days' WHERE action='shared_claim_revoked' AND target_id=$1",[published.claimId])
  const blocker=await pool.connect();await blocker.query('BEGIN')
  await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('purge:installation:'||$1,0))",[f.team])
  let pid=0
  const actorPool={connect:async()=>{const client=await pool.connect();pid=(await client.query('SELECT pg_backend_pid() pid')).rows[0].pid;return client}} as pg.Pool
  const cleaning=createPurgeRepository(actorPool,{hmacKey:'retention-test-key'}).cleanupRevokedSharedClaims({limit:1})
  try{
   let blocked=false
   for(let i=0;i<100;i++){
    if(pid&&(await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 blocked',[pid])).rows[0].blocked){blocked=true;break}
    await new Promise(resolve=>setTimeout(resolve,5))
   }
   expect(blocked).toBe(true)
   await blocker.query("UPDATE knowledge_claims SET state='active' WHERE claim_id=$1",[published.claimId])
   await blocker.query('COMMIT')
   expect(await cleaning).toBe(0)
   expect((await pool.query('SELECT statement FROM knowledge_versions WHERE version_id=$1',[published.versionId])).rows[0].statement).toBe('Transactional fixture invariant')
  }finally{await blocker.query('ROLLBACK').catch(()=>undefined);blocker.release()}
 })

})
