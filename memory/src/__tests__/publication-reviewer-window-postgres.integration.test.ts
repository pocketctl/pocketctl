import pg from'pg'
import{beforeAll,afterAll,describe,test,expect}from'vitest'
import{applyMemorySchema}from'../schema.js'
import{governanceFixture}from'../testing/governance-fixture.js'
import{copyHistoricalAuthorityFixture}from'../testing/publication-reviewer-window-fixture.js'
import{createPublicationService}from'../governance/publication-service.js'
import{createTransactionBoundPool}from'../api/transaction-bound-pool.js'
const url=process.env.MEMORY_TEST_DATABASE_URL,suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('public publication reviewer window physical commit guard',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 for(const change of ['revoked','missing'])test(`a counted ${change} public membership rejects outer physical COMMIT`,async()=>{
  const g=await governanceFixture(pool),proposal=await g.approved(),outer=await pool.connect()
  try{
   await outer.query('BEGIN');await createPublicationService(createTransactionBoundPool(outer)).publish({grant:g.grant(g.publisher,['read','publish']),targetInstallationId:g.team,candidateId:proposal.candidate.candidate_id,expectedCandidateRevision:proposal.candidate.revision,resolution:'new'})
   if(change==='revoked')await outer.query("UPDATE memory_scope_memberships SET state='revoked' WHERE membership_id=$1",[g.reviewer])
   else await outer.query('DELETE FROM memory_scope_memberships WHERE membership_id=$1',[g.reviewer])
   await expect(outer.query('COMMIT')).rejects.toMatchObject({code:'55000',message:'reviewer_validity_expired'})
   expect((await pool.query('SELECT state FROM memory_promotion_candidates WHERE candidate_id=$1',[proposal.candidate.candidate_id])).rows[0].state).not.toBe('published')
  }finally{await outer.query('ROLLBACK');outer.release()}
 })
 test('historical authority copying retains expired reviewer provenance without a live mutation stamp',async()=>{
  const g=await governanceFixture(pool),proposal=await g.approved(),result=await createPublicationService(pool).publish({grant:g.grant(g.publisher,['read','publish']),targetInstallationId:g.team,candidateId:proposal.candidate.candidate_id,expectedCandidateRevision:proposal.candidate.revision,resolution:'new'})
  await pool.query("UPDATE memory_scope_memberships SET valid_until=clock_timestamp()-interval '1 second' WHERE membership_id=$1",[g.reviewer])
  const copied=await copyHistoricalAuthorityFixture(pool,result.versionId)
  expect((await pool.query('SELECT 1 FROM memory_authority_records WHERE version_id=$1',[copied])).rowCount).toBe(1)
 })
})
