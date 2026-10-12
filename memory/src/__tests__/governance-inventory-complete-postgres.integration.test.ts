import pg from 'pg'
import {spawnSync} from 'node:child_process'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {beforeAll,afterAll,beforeEach,describe,test,expect} from 'vitest'
import {applyMemoryV50Fixture,V50_IDS} from '../testing/fixtures/memory-v50.js'
import {seedMemoryV50UpgradeScenarios,UPGRADE_IDS} from '../testing/fixtures/memory-v50-upgrade.js'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('complete read-only inventory and bounded detail export',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!)})
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await applyMemoryV50Fixture(pool,url!);await seedMemoryV50UpgradeScenarios(pool,url!)},60000)
 const run=(args:string[]=[],env:Record<string,string>={})=>spawnSync(process.execPath,['--import','tsx',fileURLToPath(new URL('../migrations/governance-v2/cli.ts',import.meta.url)),'plan',...args],{encoding:'utf8',env:{...process.env,MEMORY_MIGRATION_DATABASE_URL:url,...env}})
 test('classifies recorded governance, scope loss, temporal, budget and privacy findings without plaintext',async()=>{
  const before=(await pool.query('SELECT authority_id,counted_decision_ids FROM memory_authority_records ORDER BY authority_id')).rows
  const result=run();expect(result.status,result.stderr).toBe(0);const m=JSON.parse(result.stdout)
  expect(m.counts).toMatchObject({legacyPublisherCountViolation:1,sharedApplicabilityLoss:1,budgetOmissions:1,parallelPolicyUnproven:2,revokedPublisherUnproven:1})
  expect(m.findingCounts).toEqual(expect.objectContaining({confirmed_violation:1}))
  expect(m.items).toContainEqual(expect.objectContaining({id:UPGRADE_IDS.publisherClaim,certainty:'confirmed_violation',action:'hold'}))
  expect(m.items).toContainEqual(expect.objectContaining({id:UPGRADE_IDS.budgetJob,certainty:'unproven',reason:'budget_source_unproven'}))
  expect(m.watermarks).toHaveProperty('snapshotAt')
  expect(result.stdout).not.toContain('Never run focused tests');expect(result.stdout).not.toContain('isolated-memory-test')
  expect((await pool.query('SELECT authority_id,counted_decision_ids FROM memory_authority_records ORDER BY authority_id')).rows).toEqual(before)
 })
 test('a repository-free task is not mistaken for a missing repository mapping',async()=>{
  const claim=crypto.randomUUID(),version=crypto.randomUUID()
  await pool.query("INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1,$2,'test_invariant','task','task-local','task-local','active')",[claim,V50_IDS.personal])
  await pool.query("INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) VALUES($1,$2,$3,1,'Task-local fact','user_accepted',1)",[version,V50_IDS.personal,claim])
  await pool.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,version])
  const m=JSON.parse(run().stdout);expect(m.counts.missingRepository).toBe(1)
 })
 test('detail export traverses every page while stdout preview stays bounded',async()=>{
  await pool.query(`INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state)
    SELECT gen_random_uuid(),$1,'implementation_map','branch','main','unknown-'||n,'active' FROM generate_series(1,125)n`,[V50_IDS.personal])
  const dir=mkdtempSync(join(tmpdir(),'inventory-details-'))
  try{
   const file=join(dir,'details.jsonl'),result=run(['--details',file]);expect(result.status,result.stderr).toBe(0)
   const m=JSON.parse(result.stdout),items=readFileSync(file,'utf8').trim().split('\n').map(line=>JSON.parse(line))
   expect(m.items.length).toBeLessThanOrEqual(100);expect(m.itemsTruncated).toBe(true)
   expect(items.filter(item=>item.reason==='invalid_current_pointer')).toHaveLength(125)
   expect(new Set(items.filter(item=>item.reason==='invalid_current_pointer').map(item=>item.id)).size).toBe(125)
  }finally{rmSync(dir,{recursive:true,force:true})}
 })
 test('missing source tables and schema holes produce blockers without startup mutation',async()=>{
  await pool.query('DROP TABLE memory_jobs CASCADE');await pool.query('DELETE FROM memory_schema_migrations WHERE version=49')
  const r=run();expect(r.status,r.stderr).toBe(0);const m=JSON.parse(r.stdout)
  expect(m.compatible).toBe(false);expect(m.blockers).toContain('incomplete_schema_history')
  expect((await pool.query("SELECT to_regclass('memory_jobs') AS table")).rows[0].table).toBeNull()
 })
 test('a missing source version is unknown rather than evidence of illegal historical approval',async()=>{
  await pool.query('UPDATE memory_promotion_candidates SET source_version_id=$2 WHERE candidate_id=$1',[UPGRADE_IDS.oppositeProposal,crypto.randomUUID()])
  const m=JSON.parse(run().stdout)
  expect(m.items).toContainEqual(expect.objectContaining({id:UPGRADE_IDS.oppositeProposal,reason:'missing_source_version',certainty:'unknown'}))
 })
 test('reports shadow v2 identity collisions without emitting stored normalized keys',async()=>{
  await applyMemorySchema(pool)
  await pool.query('UPDATE knowledge_claims SET normalized_key_v2=$2 WHERE claim_id=ANY($1::uuid[])',[[V50_IDS.knownClaim,V50_IDS.unknownClaim],'NO_KEY_TEXT_EXPORT'])
  const r=run();expect(r.status,r.stderr).toBe(0)
  expect(JSON.parse(r.stdout).counts.v2IdentityCollisions).toBe(1)
  expect(r.stdout).not.toContain('NO_KEY_TEXT_EXPORT')
 })
 test('inverted revision order is unknown and never proposed as a deterministic interval repair',async()=>{
  await pool.query("UPDATE knowledge_versions SET created_at='2027-01-01' WHERE version_id=$1",[V50_IDS.firstVersion])
  const r=run();expect(r.status,r.stderr).toBe(0);const m=JSON.parse(r.stdout)
  expect(m.items).toContainEqual(expect.objectContaining({id:V50_IDS.firstVersion,reason:'revision_time_order_unknown',certainty:'unknown'}))
  expect(m.items).not.toContainEqual(expect.objectContaining({id:V50_IDS.firstVersion,reason:'legacy_revision_interval_missing'}))
 })
 test('an inverted edge anywhere in a revision chain prevents deterministic interval repair for that chain',async()=>{
  const third=crypto.randomUUID()
  await pool.query("UPDATE knowledge_versions SET created_at='2026-01-03' WHERE version_id=$1",[V50_IDS.firstVersion])
  await pool.query("UPDATE knowledge_versions SET created_at='2026-01-02' WHERE version_id=$1",[V50_IDS.currentVersion])
  await pool.query("INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence,created_at) VALUES($1,$2,$3,3,'Later current revision','user_corrected',1,'2026-02-01')",[third,V50_IDS.personal,V50_IDS.knownClaim])
  await pool.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[V50_IDS.knownClaim,third])
  const r=run();expect(r.status,r.stderr).toBe(0);const m=JSON.parse(r.stdout)
  expect(m.items).not.toContainEqual(expect.objectContaining({id:V50_IDS.firstVersion,reason:'legacy_revision_interval_missing'}))
  expect(m.items).not.toContainEqual(expect.objectContaining({id:V50_IDS.currentVersion,reason:'legacy_revision_interval_missing'}))
 })
 test('corrupt frozen policy proof cannot be labelled a confirmed historical violation',async()=>{
  await pool.query("UPDATE memory_review_policy_versions SET content_hash='tampered-policy-hash' WHERE policy_version_id=$1",[V50_IDS.policyVersion])
  const r=run();expect(r.status,r.stderr).toBe(0);const m=JSON.parse(r.stdout)
  expect(m.counts.legacyPublisherCountViolation).toBe(0)
  expect(m.items).toContainEqual(expect.objectContaining({id:V50_IDS.policyVersion,reason:'review_policy_integrity_unproven',certainty:'unproven'}))
 })
 test('an empty database returns missing_schema without creating any object',async()=>{
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const r=run();expect(r.status,r.stderr).toBe(0)
  expect(JSON.parse(r.stdout)).toMatchObject({compatible:false,schemaVersion:0,blockers:['missing_schema']})
  expect((await pool.query("SELECT 1 FROM pg_tables WHERE schemaname='public'")).rowCount).toBe(0)
 })
 test('full details retain every authority record when one claim has more than one page of historical violations',async()=>{
  const original=(await pool.query('SELECT c.current_version_id,a.* FROM knowledge_claims c JOIN memory_authority_records a ON a.version_id=c.current_version_id WHERE c.claim_id=$1',[UPGRADE_IDS.publisherClaim])).rows[0]
  await pool.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence)
   SELECT gen_random_uuid(),$1,$2,n,'Repeated historical authority','user_accepted',1 FROM generate_series(2,106)n`,[original.installation_id,UPGRADE_IDS.publisherClaim])
  await pool.query(`INSERT INTO memory_authority_records(authority_id,installation_id,version_id,candidate_revision_id,review_policy_version_id,counted_decision_ids,publisher_membership_id,source_scope_kind,source_content_hash,published_at)
   SELECT gen_random_uuid(),v.installation_id,v.version_id,$3,$4,$5,$6,'personal','synthetic-source-hash','2026-01-03' FROM knowledge_versions v WHERE v.installation_id=$1 AND v.claim_id=$2 AND v.version_number>1`,[original.installation_id,UPGRADE_IDS.publisherClaim,original.candidate_revision_id,original.review_policy_version_id,original.counted_decision_ids,original.publisher_membership_id])
  const dir=mkdtempSync(join(tmpdir(),'authority-details-'))
  try{
   const file=join(dir,'details.jsonl'),r=run(['--details',file]);expect(r.status,r.stderr).toBe(0)
   const rows=readFileSync(file,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(item=>item.reason==='publisher_counted_against_policy')
   expect(JSON.parse(r.stdout).counts.legacyPublisherCountViolation).toBe(106)
   expect(rows).toHaveLength(106)
   expect(new Set(rows.map(row=>row.sourceRecordId)).size).toBe(106)
  }finally{rmSync(dir,{recursive:true,force:true})}
 })
 test('Relay reconciliation requires an explicit separate database configuration',()=>{
  const result=run(['--relay'],{MEMORY_MIGRATION_RELAY_DATABASE_URL:''})
  expect(result.status).not.toBe(0);expect(result.stderr).toContain('MEMORY_MIGRATION_RELAY_DATABASE_URL')
 })
})
