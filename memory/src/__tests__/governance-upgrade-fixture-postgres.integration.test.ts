import pg from 'pg'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {applyMemoryV50Fixture,V50_IDS} from '../testing/fixtures/memory-v50.js'
import {seedMemoryV50UpgradeScenarios,UPGRADE_IDS} from '../testing/fixtures/memory-v50-upgrade.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('frozen v50 complete upgrade scenarios',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await applyMemoryV50Fixture(pool,url!);await seedMemoryV50UpgradeScenarios(pool,url!)},60000)
 afterAll(async()=>{await pool?.end()})
 test('T1a retains published authority that counted its actual publisher against frozen policy',async()=>{
  const rows=(await pool.query(`SELECT a.authority_id FROM memory_authority_records a JOIN knowledge_versions v ON v.version_id=a.version_id JOIN memory_review_policy_versions p ON p.policy_version_id=a.review_policy_version_id
    WHERE v.claim_id=$1 AND p.document->>'publisher_may_count_as_reviewer'='false' AND EXISTS(SELECT 1 FROM memory_review_decisions d WHERE d.decision_id=ANY(a.counted_decision_ids) AND d.membership_id=a.publisher_membership_id)`,[UPGRADE_IDS.publisherClaim])).rows
  expect(rows).toHaveLength(1)
 })
 test('T1b retains two active parallel variants with original authority and disallowing policy',async()=>{
  expect((await pool.query(`SELECT c.claim_id FROM knowledge_claims c JOIN memory_authority_records a ON a.version_id=c.current_version_id JOIN memory_review_policy_versions p ON p.policy_version_id=a.review_policy_version_id WHERE c.conflict_group_id=$1 AND c.state='active' AND p.document->>'allow_parallel_conflicts'='false'`,[UPGRADE_IDS.parallelGroup])).rows).toHaveLength(2)
 })
 test('T2 keeps a proven source branch/fact window and the target that lost both',async()=>{
  const row=(await pool.query(`SELECT source.branch,source.valid_until,source.repository_id,target.repository_id AS target_repository,target.valid_until AS target_until FROM knowledge_claims claim JOIN knowledge_versions target ON target.version_id=claim.current_version_id JOIN memory_authority_records a ON a.version_id=target.version_id JOIN memory_promotion_candidate_versions revision ON revision.candidate_revision_id=a.candidate_revision_id JOIN memory_promotion_candidates proposal ON proposal.candidate_id=revision.candidate_id JOIN knowledge_versions source ON source.version_id=proposal.source_version_id WHERE claim.claim_id=$1`,[UPGRADE_IDS.applicabilityClaim])).rows[0]
  expect(row).toMatchObject({branch:'main',repository_id:V50_IDS.repository,target_repository:null,target_until:null})
  expect(row.valid_until.toISOString()).toBe('2030-01-01T00:00:00.000Z')
 })
 test('T3 retains a recorded revoke-before-publish window without inferring historical permission from current roles',async()=>{
  const row=(await pool.query(`SELECT e.created_at<a.published_at AS revoked_before_publish,e.metadata->>'membership_revision' AS old_revision FROM memory_authority_records a JOIN memory_governance_events e ON e.actor_membership_id=a.publisher_membership_id AND e.action='fixture_membership_revoked' WHERE a.authority_id=$1`,[UPGRADE_IDS.revokedAuthority])).rows[0]
  expect(row).toEqual({revoked_before_publish:true,old_revision:'1'})
 })
 test('T4 retains opposite statements in separate identities and the original new classification',async()=>{
  const row=(await pool.query(`SELECT c.statement,e.metadata->>'classification' AS classification FROM memory_promotion_candidates p JOIN memory_promotion_candidate_versions c USING(candidate_id) JOIN memory_governance_events e ON e.target_id=p.candidate_id WHERE p.candidate_id=$1`,[UPGRADE_IDS.oppositeProposal])).rows[0]
  expect(row).toEqual({statement:'Never run focused tests before deploy.',classification:'new'})
 })
 test('T5 keeps the edited revision without evidence and preserves earlier evidence/review history',async()=>{
  const row=(await pool.query(`SELECT v.revision_number,(SELECT COUNT(*)::int FROM memory_promotion_evidence e WHERE e.candidate_revision_id=v.candidate_revision_id) AS evidence,(SELECT COUNT(*)::int FROM memory_review_decisions d JOIN memory_promotion_candidate_versions older ON older.candidate_revision_id=d.candidate_revision_id WHERE older.candidate_id=v.candidate_id AND older.revision_number<v.revision_number) AS older_votes FROM memory_promotion_candidate_versions v WHERE candidate_revision_id=$1`,[UPGRADE_IDS.editedRevision])).rows[0]
  expect(row).toEqual({revision_number:'2',evidence:0,older_votes:1})
 })
 test('T6 keeps old and current revisions with open fact windows without fabricating effective time',async()=>{
  const rows=(await pool.query('SELECT version_number,valid_until FROM knowledge_versions WHERE claim_id=$1 ORDER BY version_number',[V50_IDS.knownClaim])).rows
  expect(rows).toEqual([{version_number:1,valid_until:null},{version_number:2,valid_until:null}])
 })
 test('budget omission and privacy tombstone are present for bounded recovery and deletion replay',async()=>{
  expect((await pool.query('SELECT state,last_error_code FROM memory_jobs WHERE job_id=$1',[UPGRADE_IDS.budgetJob])).rows[0]).toEqual({state:'completed',last_error_code:'budget_exceeded'})
  expect((await pool.query("SELECT key_id,reason FROM knowledge_tombstones WHERE installation_id=$1",[V50_IDS.personal])).rows).toEqual([{key_id:'historical-key',reason:'privacy_delete'}])
 })
 test('additive startup preserves all historical IDs and statement/evidence bytes',async()=>{
  const snapshot=async()=>({versions:(await pool.query('SELECT version_id,statement FROM knowledge_versions ORDER BY version_id')).rows,evidence:(await pool.query('SELECT candidate_revision_id,ordinal,excerpt,excerpt_hash FROM memory_promotion_evidence ORDER BY candidate_revision_id,ordinal')).rows,authority:(await pool.query('SELECT authority_id,counted_decision_ids FROM memory_authority_records ORDER BY authority_id')).rows})
  const before=await snapshot();await applyMemorySchema(pool);expect(await snapshot()).toEqual(before)
 })
})
