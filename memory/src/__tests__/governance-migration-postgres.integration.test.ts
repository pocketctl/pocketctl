import {writeFile} from 'node:fs/promises'
import {createMemoryPool} from '../db.js'
import {assertMemoryRuntimeCompatibility} from '../migrations/governance-v2/compatibility.js'
import {applyGovernanceCommand} from '../migrations/governance-v2/apply-cli.js'
import pg from 'pg'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {applyMemoryV50Fixture,V50_IDS} from '../testing/fixtures/memory-v50.js'
import {seedMemoryV50UpgradeScenarios} from '../testing/fixtures/memory-v50-upgrade.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceEnvironmentFingerprint,startGovernanceBackfill,backfillGovernance} from '../migrations/governance-v2/backfill.js'
import {validateGovernanceMigration} from '../migrations/governance-v2/validate.js'
import {cutoverGovernance,ensureGovernanceIndexes} from '../migrations/governance-v2/cutover.js'
import {migrationTransaction} from '../migrations/governance-v2/backfill.js'
import {measureInventoryRecovery} from '../testing/measure-inventory-recovery.js'
import {createPurgeRepository} from '../purge/repository.js'
import {capturePrivacyWatermarks,replayPrivacyWatermarks,type PrivacyWatermarks,reconcileGovernanceChanges} from '../migrations/governance-v2/reconcile.js'
const url=process.env.MEMORY_TEST_DATABASE_URL,suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('v50 durable backfill and cutover',()=>{
 const started=Date.now()
 let pool:pg.Pool,runId:string,fingerprint:string
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await applyMemoryV50Fixture(pool,url!);await seedMemoryV50UpgradeScenarios(pool,url!);await applyMemorySchema(pool);fingerprint=await governanceEnvironmentFingerprint(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 test('third batch interrupt resumes without losing historical IDs or content',async()=>{
  runId=await startGovernanceBackfill(pool,{installationIds:[V50_IDS.personal,V50_IDS.team],environmentFingerprint:fingerprint})
  const first=await backfillGovernance(pool,{runId,batchSize:1,interruptAfterBatch:Number(process.env.MEMORY_UPGRADE_MIGRATION_INTERRUPT??3)||3})
  expect(first.interrupted).toBe(true)
  const second=await backfillGovernance(pool,{runId,batchSize:2})
  expect(second.interrupted).toBe(false)
  for(let i=1;i<Number(process.env.MEMORY_UPGRADE_MIGRATION_REPEAT??2);i++)await backfillGovernance(pool,{runId,batchSize:2})
  const check=await validateGovernanceMigration(pool,runId)
  expect(check.invariants.slice(0,6).every(i=>i.passed)).toBe(true)
  expect(check.counts.quarantined).toBeGreaterThan(0)
  expect((await pool.query('SELECT COUNT(*)::int n FROM memory_authority_records')).rows[0].n).toBeGreaterThan(0)
 })
 test('operator CLI binds run, database fingerprint and explicit scope without mutating on mismatch',async()=>{
  const args=['--phase','validate','--run-id',runId,'--installation',V50_IDS.personal,'--installation',V50_IDS.team,'--environment-fingerprint',fingerprint]
  expect((await applyGovernanceCommand(pool,args)).phase).toBe('validate')
  await expect(applyGovernanceCommand(pool,[...args.slice(0,-1),'0'.repeat(64)])).rejects.toThrow('migration_environment_mismatch')
  await expect(applyGovernanceCommand(pool,['--phase','reconcile','--run-id',runId,'--installation',V50_IDS.personal,'--environment-fingerprint',fingerprint])).rejects.toThrow('migration_scope_mismatch')
 })
 test('concurrent revision is reconciled after primary-key scan without a created_at gap',async()=>{
  const c=await pool.connect();try{await c.query('BEGIN');await c.query("SET LOCAL pocketctl.writer_capability='identity_v2'; SET LOCAL pocketctl.writer_identity_generation='adaptive'");await c.query('UPDATE knowledge_claims SET revision=revision+1 WHERE claim_id=$1',[V50_IDS.knownClaim]);await c.query('COMMIT')}finally{c.release()}
  expect((await reconcileGovernanceChanges(pool,{runId})).processed).toBeGreaterThan(0)
  const check=await validateGovernanceMigration(pool,runId);expect(check.invariants.slice(0,6).every(i=>i.passed)).toBe(true)
 })
 test('index failure leaves the legacy protection and scoped generation unchanged',async()=>{
  await pool.query('ALTER INDEX knowledge_claims_active_identity_v2_idx RENAME TO knowledge_claims_saved_v2_idx')
  await pool.query('CREATE INDEX knowledge_claims_active_identity_v2_idx ON knowledge_claims(claim_id)')
  await expect(ensureGovernanceIndexes(pool)).rejects.toThrow('index_build_failed')
  await pool.query('DROP INDEX knowledge_claims_active_identity_v2_idx')
  await pool.query('ALTER INDEX knowledge_claims_saved_v2_idx RENAME TO knowledge_claims_active_identity_v2_idx')
  expect((await pool.query("SELECT to_regclass('knowledge_claims_active_identity_variant_idx') IS NOT NULL AS present")).rows[0].present).toBe(true)
  expect((await pool.query('SELECT bool_and(identity_generation=1) AS old FROM memory_governance_v2_states')).rows[0].old).toBe(true)
 })
 test('index catalog validation supports PostgreSQL 13/14 and rejects NULLS NOT DISTINCT on newer catalogs',async()=>{
  await expect(ensureGovernanceIndexes(pool)).resolves.toBeUndefined()
  const version=Number((await pool.query('SHOW server_version_num')).rows[0].server_version_num)
  if(version<150000){
   expect((await pool.query("SELECT to_jsonb(i) ? 'indnullsnotdistinct' present FROM pg_index i WHERE indexrelid=to_regclass('knowledge_claims_active_identity_v2_idx')")).rows[0].present).toBe(false)
   return
  }
  await pool.query('ALTER INDEX knowledge_claims_active_identity_v2_idx RENAME TO knowledge_claims_saved_v2_idx')
  try{
   await pool.query("CREATE UNIQUE INDEX knowledge_claims_active_identity_v2_idx ON knowledge_claims(installation_id,duplicate_digest_v2,conflict_variant) NULLS NOT DISTINCT WHERE state='active' AND identity_generation=2")
   await expect(ensureGovernanceIndexes(pool)).rejects.toThrow('index_build_failed')
  }finally{await pool.query('DROP INDEX IF EXISTS knowledge_claims_active_identity_v2_idx');await pool.query('ALTER INDEX knowledge_claims_saved_v2_idx RENAME TO knowledge_claims_active_identity_v2_idx')}
 })
 test('wrong state or OR predicate cannot substitute for the active unique domain',async()=>{
  for(const predicate of ["state='revoked' AND identity_generation=2","state='active' OR identity_generation=2"]){
   await pool.query('ALTER INDEX knowledge_claims_active_identity_v2_idx RENAME TO knowledge_claims_saved_v2_idx')
   try{
    await pool.query(`CREATE UNIQUE INDEX knowledge_claims_active_identity_v2_idx ON knowledge_claims(installation_id,duplicate_digest_v2,conflict_variant) WHERE ${predicate}`)
    await expect(ensureGovernanceIndexes(pool)).rejects.toThrow('index_build_failed')
   }finally{await pool.query('DROP INDEX IF EXISTS knowledge_claims_active_identity_v2_idx');await pool.query('ALTER INDEX knowledge_claims_saved_v2_idx RENAME TO knowledge_claims_active_identity_v2_idx')}
  }
 })
 test('actual concurrent unique-index build failure preserves legacy protection',async()=>{
  await pool.query('DROP INDEX CONCURRENTLY knowledge_claims_active_identity_v2_idx')
  const c=await pool.connect()
  try{await c.query('BEGIN');await c.query("SET LOCAL pocketctl.writer_capability='identity_v2'; SET LOCAL pocketctl.writer_identity_generation='adaptive'")
   await c.query(`INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state,identity_generation,normalized_key_v2,topic_key_v2,duplicate_digest_v2,consumption_hold_reason)
     SELECT gen_random_uuid(),$1,'implementation_map','installation','index-failure-probe',key,'active',2,$2,$2,$2,'index_failure_probe' FROM unnest(ARRAY['probe-one','probe-two']) key`,[V50_IDS.personal,'9'.repeat(64)])
   await c.query('COMMIT')
   await expect(ensureGovernanceIndexes(pool)).rejects.toThrow('index_build_failed')
   expect((await pool.query("SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass('knowledge_claims_active_identity_v2_idx')")).rows[0].indisvalid).toBe(false)
   expect((await pool.query("SELECT to_regclass('knowledge_claims_active_identity_variant_idx') IS NOT NULL present")).rows[0].present).toBe(true)
  }finally{await c.query('ROLLBACK').catch(()=>undefined);c.release()}
  await pool.query("DELETE FROM knowledge_claims WHERE scope_key='index-failure-probe'")
  await pool.query('DROP INDEX CONCURRENTLY knowledge_claims_active_identity_v2_idx')
  await ensureGovernanceIndexes(pool)
 })
 test('cutover requires explicit current writer proof, fences queued old work and verifies seven invariants',async()=>{
  await expect(cutoverGovernance(pool,{runId,installationId:V50_IDS.personal,writerProof:[]})).rejects.toThrow('writer_proof_required')
  await ensureGovernanceIndexes(pool)
  await cutoverGovernance(pool,{runId,installationId:V50_IDS.personal,writerProof:['api:identity_v2','worker:identity_v2','relay:identity_v2']})
  const result=await validateGovernanceMigration(pool,runId)
  expect(result.invariants.every(i=>i.passed)).toBe(true)
  const legacy=new pg.Pool({connectionString:url});try{await expect(legacy.query('UPDATE knowledge_claims SET revision=revision+1 WHERE claim_id=$1',[V50_IDS.knownClaim])).rejects.toThrow('memory_writer_incompatible')}finally{await legacy.end()}
 })
 test('the current schema-aware Bridge declaration remains compatible after cutover',async()=>{
  const bridge=createMemoryPool({databaseUrl:url!,dbPoolMax:2})
  try{await expect(assertMemoryRuntimeCompatibility(bridge)).resolves.toBeUndefined()}finally{await bridge.end()}
 })
 test('real row-lock wait detects a changed revision and resolves its retry receipt',async()=>{
  await pool.query("UPDATE memory_governance_migration_checkpoints SET last_id=NULL WHERE run_id=$1 AND installation_id=$2 AND entity_kind='knowledge_claims'",[runId,V50_IDS.personal])
  const blocker=await pool.connect()
  try{await blocker.query('BEGIN');await blocker.query("SET LOCAL pocketctl.writer_capability='identity_v2'; SET LOCAL pocketctl.writer_identity_generation='adaptive'");await blocker.query('UPDATE knowledge_claims SET revision=revision+1 WHERE claim_id=$1',[V50_IDS.knownClaim])
   const pid=(await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid
   const running=backfillGovernance(pool,{runId,batchSize:200})
   let blocked=false;for(let i=0;i<50;i++){blocked=(await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS yes',[pid])).rows[0].yes;if(blocked)break;await new Promise(r=>setTimeout(r,10))}
   expect(blocked).toBe(true);await blocker.query('COMMIT');await running
   expect((await pool.query("SELECT COUNT(*)::int n FROM memory_governance_migration_actions WHERE run_id=$1 AND action='retry'",[runId])).rows[0].n).toBeGreaterThan(0)
   await reconcileGovernanceChanges(pool,{runId})
   expect((await validateGovernanceMigration(pool,runId)).invariants.every(i=>i.passed)).toBe(true)
  }finally{await blocker.query('ROLLBACK').catch(()=>undefined);blocker.release()}
 })
 test('terminated database process cannot commit its checkpoint',async()=>{
  let ready!:(pid:number)=>void;const pidPromise=new Promise<number>(r=>ready=r)
  const work=migrationTransaction(pool,async c=>{await c.query("INSERT INTO memory_governance_migration_checkpoints(run_id,installation_id,entity_kind,last_id) VALUES($1,$2,'termination_probe','uncommitted')",[runId,V50_IDS.personal]);ready((await c.query('SELECT pg_backend_pid() pid')).rows[0].pid);await c.query('SELECT pg_sleep(30)')})
  const rejected=work.then(()=>false,()=>true)
  expect((await pool.query('SELECT pg_terminate_backend($1) terminated',[await pidPromise])).rows[0].terminated).toBe(true)
  expect(await rejected).toBe(true)
  expect((await pool.query("SELECT COUNT(*)::int n FROM memory_governance_migration_checkpoints WHERE run_id=$1 AND entity_kind='termination_probe'",[runId])).rows[0].n).toBe(0)
 })
 test('physical v2 unique domain permits different repositories and blocks exact duplicates',async()=>{
  const c=await pool.connect();try{await c.query('BEGIN');await c.query("SET LOCAL pocketctl.writer_capability='identity_v2'; SET LOCAL pocketctl.writer_identity_generation='adaptive'")
   for(const [key,dup] of [['c','d'],['e','f']])await c.query(`INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state,identity_generation,normalized_key_v2,topic_key_v2,duplicate_digest_v2,canonical_repository_key) VALUES(gen_random_uuid(),$1,'implementation_map','repository','constraint-fixture','same-v1-key','active',2,$2,$2,$3,$4)`,[V50_IDS.personal,key.repeat(64),dup.repeat(64),`fixture/${key}`])
   await c.query('SAVEPOINT duplicate_probe')
   await expect(c.query(`INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state,identity_generation,normalized_key_v2,topic_key_v2,duplicate_digest_v2) VALUES(gen_random_uuid(),$1,'implementation_map','repository','constraint-fixture','another-v1-key','active',2,$2,$2,$3)`,[V50_IDS.personal,'a'.repeat(64),'d'.repeat(64)])).rejects.toMatchObject({code:'23505'})
   await c.query('ROLLBACK TO SAVEPOINT duplicate_probe')
   expect((await c.query("SELECT COUNT(*)::int n FROM knowledge_claims WHERE normalized_key='same-v1-key'")).rows[0].n).toBe(2)
  }finally{await c.query('ROLLBACK');c.release()}
 })
 test('actual dump/restore replays newer purge/revocation and holds every restored scope',async()=>{
  let watermark!:PrivacyWatermarks
  const recovery=await measureInventoryRecovery(pool,url!,{beforeRestore:async()=>{
   await createPurgeRepository(pool,{hmacKey:'migration-recovery-fixture-key'}).purgeInstallation({installationId:V50_IDS.personal,requestId:'aa500000-0000-4000-8000-000000000001',reason:'user_delete'})
   await pool.query("UPDATE memory_owner_scopes SET authorization_epoch=authorization_epoch+1,state='suspended' WHERE installation_id=$1",[V50_IDS.team])
   watermark=await capturePrivacyWatermarks(pool)
  }})
  expect(recovery.beforeDigest).toBe(recovery.afterDigest)
  expect(recovery.productionEstimate).toBe(false)
  await replayPrivacyWatermarks(pool,watermark,{purgeHmacKey:'migration-recovery-fixture-key'})
  expect((await pool.query('SELECT COUNT(*)::int n FROM knowledge_claims WHERE installation_id=$1',[V50_IDS.personal])).rows[0].n).toBe(0)
  expect((await pool.query('SELECT authorization_epoch::text,state FROM memory_owner_scopes WHERE installation_id=$1',[V50_IDS.team])).rows[0]).toMatchObject({authorization_epoch:'2',state:'suspended'})
  expect((await pool.query("SELECT COUNT(*)::int n FROM memory_governance_v2_states WHERE phase<>'hold'")).rows[0].n).toBe(0)
  expect((await pool.query("SELECT COUNT(*)::int n FROM knowledge_claims WHERE state='active' AND consumption_hold_reason IS NULL")).rows[0].n).toBe(0)
  expect((await validateGovernanceMigration(pool,runId)).violations).toEqual([])
  await writeFile((process.env.MEMORY_UPGRADE_REPORT_DIR??'/reports')+'/migration-measurements.json',JSON.stringify({kind:'isolated_v50_fixture',durationMs:Date.now()-started,recovery,lockTimeoutMs:1000,statementTimeoutMs:5000,lockWaitMeasurement:'real blocking barriers; no production latency estimate',invariants:(await validateGovernanceMigration(pool,runId)).invariants,remediation:(await pool.query('SELECT consumption_hold_reason,COUNT(*)::int n FROM knowledge_claims WHERE consumption_hold_reason IS NOT NULL GROUP BY consumption_hold_reason')).rows},null,2))
  await expect(startGovernanceBackfill(pool,{installationIds:[V50_IDS.team],environmentFingerprint:fingerprint})).rejects.toThrow('migration_scope_held')
 },60000)

})
