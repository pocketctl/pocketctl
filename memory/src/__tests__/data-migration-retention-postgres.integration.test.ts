import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,beforeEach,describe,expect,test,vi} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {createMemoryPool} from '../db.js'
import {governanceEnvironmentFingerprint,startGovernanceBackfill,backfillGovernance} from '../migrations/governance-v2/backfill.js'
import {validateGovernanceMigration} from '../migrations/governance-v2/validate.js'
import {reconcileGovernanceChanges,capturePrivacyWatermarks,replayPrivacyWatermarks} from '../migrations/governance-v2/reconcile.js'
import {cutoverGovernance} from '../migrations/governance-v2/cutover.js'
import {sealGovernanceMigration,abandonGovernanceMigration,previewMigrationRetention,retainMigrationHistory,retainMigrationChanges} from '../retention/migrations.js'
const url=process.env.MEMORY_TEST_DATABASE_URL,suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('migration lifecycle retention (PostgreSQL)',()=>{
 let pool:pg.Pool,a:string,b:string
 beforeAll(async()=>{pool=createMemoryPool({databaseUrl:url!,dbPoolMax:6});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{
  await pool.query('TRUNCATE memory_purge_receipts,memory_session_tombstones,memory_installations CASCADE')
  await pool.query('TRUNCATE memory_governance_migration_summaries,memory_governance_migration_runs CASCADE')
  await pool.query('UPDATE memory_retention_control SET change_gc_floor=0 WHERE singleton')
  a=randomUUID();b=randomUUID()
  for(const id of [a,b]){await pool.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)`,[id]);await pool.query(`INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$1)`,[id])}
 })
 async function run(ids=[a],watermark='0'){
  const id=randomUUID();await pool.query(`INSERT INTO memory_governance_migration_runs(run_id,environment_fingerprint,schema_version,manifest,state)
   VALUES($1,'fixture',72,$2,'running')`,[id,{installationIds:ids,startWatermark:watermark,rows:{},owners:{}}]);return id
 }
 async function sealed(ids:string[],days:number){
  const id=await run(ids)
  await pool.query(`INSERT INTO memory_governance_migration_summaries(run_id,migration_kind,scope_ids,schema_version,environment_fingerprint,started_at,completed_at,outcome,action_counts,verification)
   VALUES($1,'governance_v2',$2,72,'fixture',NOW()-($3::int*INTERVAL '24 hours'),NOW()-($3::int*INTERVAL '24 hours'),'complete','{}','{}')`,[id,ids,days])
  await pool.query(`INSERT INTO memory_governance_migration_actions(run_id,installation_id,entity_kind,entity_id,action,reason,change_summary) VALUES($1,$2,'source_events','id','unchanged','fixture','{"digest":"hash"}')`,[id,ids[0]])
  await pool.query(`UPDATE memory_governance_migration_runs SET sealed_at=NOW()-($2::int*INTERVAL '24 hours'),completed_at=NOW()-($2::int*INTERVAL '24 hours'),state='complete' WHERE run_id=$1`,[id,days])
  return id
 }
 test('two per scope is a union with fourteen days, multi-scope runs survive if any scope retains them',async()=>{
  const old=await sealed([a],50),mixed=await sealed([a,b],40),newer=await sealed([a],30),newest=await sealed([a],20)
  const recent=[];for(let d=1;d<4;d++)recent.push(await sealed([a],d))
  const eligible=(await previewMigrationRetention(pool)).history.map(r=>r.run_id)
  expect(eligible).toEqual([old,newer,newest]);expect(eligible).not.toContain(mixed)
  const result=await retainMigrationHistory(pool,1);expect(result).toEqual({actions:1,checkpoints:0,runs:1})
  const compact=(await pool.query('SELECT * FROM memory_governance_migration_runs WHERE run_id=$1',[old])).rows[0]
  expect(compact.manifest).toEqual({});expect(compact.scope_ids).toEqual([a]);expect(compact.details_reclaimed_at).toBeTruthy()
  expect((await pool.query('SELECT * FROM memory_governance_migration_summaries WHERE run_id=$1',[old])).rows[0].details_reclaimed_at).toBeTruthy()
  await expect(backfillGovernance(pool,{runId:old})).rejects.toThrow('migration_run_not_resumable')
 })
 test('unsealed and interrupted runs are protected; abandoned grace starts at explicit abandonment',async()=>{
  const id=await run();await pool.query(`UPDATE memory_governance_migration_runs SET started_at=NOW()-INTERVAL '100 days',state='interrupted' WHERE run_id=$1`,[id])
  expect((await previewMigrationRetention(pool)).history).toEqual([])
  await abandonGovernanceMigration(pool,id)
  expect((await previewMigrationRetention(pool)).history).toEqual([])
  await expect(reconcileGovernanceChanges(pool,{runId:id})).rejects.toThrow('migration_run_not_resumable')
  await expect(validateGovernanceMigration(pool,id)).rejects.toThrow('migration_run_not_resumable')
  await expect(pool.query(`UPDATE memory_governance_migration_runs SET state='running' WHERE run_id=$1`,[id])).rejects.toThrow('migration_run_sealed')
  await expect(pool.query(`INSERT INTO memory_governance_migration_actions(run_id,installation_id,entity_kind,entity_id,action,reason) VALUES($1,$2,'source_events','id','unchanged','late')`,[id,a])).rejects.toThrow('migration_run_sealed')
 })
 test('bounded detail cleanup leaves summary and frozen run through interruption',async()=>{
  const id=await sealed([a],40);await sealed([a],30);await sealed([a],20)
  // Write historical details through the fixture only, before reenabling guard.
  await pool.query('ALTER TABLE memory_governance_migration_actions DISABLE TRIGGER memory_retention_migration_guard')
  try{await pool.query(`INSERT INTO memory_governance_migration_actions(run_id,installation_id,entity_kind,entity_id,action,reason) VALUES($1,$2,'source_events','id2','unchanged','old')`,[id,a])}finally{await pool.query('ALTER TABLE memory_governance_migration_actions ENABLE TRIGGER memory_retention_migration_guard')}
  expect(await retainMigrationHistory(pool,1)).toMatchObject({actions:1,runs:0})
  expect((await pool.query('SELECT manifest FROM memory_governance_migration_runs WHERE run_id=$1',[id])).rows[0].manifest).not.toEqual({})
  expect(await retainMigrationHistory(pool,1)).toMatchObject({actions:1,runs:1})
 })
 test('change log protects from oldest open starting watermark; durable floor survives an empty log',async()=>{
  await pool.query('DELETE FROM memory_governance_migration_changes')
  const rows=[]
  for(let n=0;n<4;n++)rows.push((await pool.query(`INSERT INTO memory_governance_migration_changes(installation_id,entity_kind,entity_id,operation,occurred_at) VALUES($1,'source_events',$2,'UPDATE',NOW()-INTERVAL '20 days') RETURNING sequence::text`,[a,String(n)])).rows[0].sequence)
  const id=await run([a],rows[1])
  expect(await retainMigrationChanges(pool,100)).toEqual({changes:2})
  expect((await pool.query('SELECT sequence::text FROM memory_governance_migration_changes ORDER BY sequence')).rows.map(r=>r.sequence)).toEqual(rows.slice(2))
  await abandonGovernanceMigration(pool,id)
  expect(await retainMigrationChanges(pool,1)).toEqual({changes:1});expect(await retainMigrationChanges(pool,100)).toEqual({changes:1})
  const next=await startGovernanceBackfill(pool,{installationIds:[a],environmentFingerprint:await governanceEnvironmentFingerprint(pool)})
  expect((await pool.query('SELECT start_watermark::text FROM memory_governance_migration_runs WHERE run_id=$1',[next])).rows[0].start_watermark).toBe(rows[3])
 })
 test('in-flight low sequence transaction blocks GC rather than slipping behind its floor',async()=>{
  const c=await pool.connect();try{await c.query('BEGIN');await c.query(`INSERT INTO memory_governance_migration_changes(installation_id,entity_kind,entity_id,operation,occurred_at) VALUES($1,'source_events','low','UPDATE',NOW()-INTERVAL '20 days')`,[a])
   await expect(retainMigrationChanges(pool)).rejects.toMatchObject({code:'55P03'})
  }finally{await c.query('ROLLBACK');c.release()}
 })
 test('a baseline waiting behind committed GC serializes rather than using a stale repeatable-read snapshot',async()=>{
  const barrier=await pool.connect();let pending:Promise<unknown>|undefined
  try{
   await barrier.query('BEGIN');await barrier.query(`SELECT pg_advisory_xact_lock(hashtextextended('memory:retention:migrations',0))`)
   pending=startGovernanceBackfill(pool,{installationIds:[a],environmentFingerprint:await governanceEnvironmentFingerprint(pool)}).then(value=>({value}),error=>({error}))
   await vi.waitFor(async()=>expect((await pool.query(`SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND NOT granted`)).rows[0].n).toBeGreaterThan(0),{timeout:800,interval:10})
   await barrier.query('UPDATE memory_retention_control SET generation=generation+1,change_gc_floor=change_gc_floor+1 WHERE singleton');await barrier.query('COMMIT')
   expect(await pending).toMatchObject({error:{code:'40001'}})
   expect((await pool.query('SELECT count(*)::int n FROM memory_governance_migration_runs')).rows[0].n).toBe(0)
  }finally{await barrier.query('ROLLBACK');barrier.release();await pending}
 })
 test('sealing requires every scope cut over, final reconciliation, successful validation and freezes all resumes',async()=>{
  const id=await startGovernanceBackfill(pool,{installationIds:[a,b],environmentFingerprint:await governanceEnvironmentFingerprint(pool)})
  await backfillGovernance(pool,{runId:id})
  await expect(sealGovernanceMigration(pool,id)).rejects.toThrow('migration_cutover_required')
  for(const installationId of [a,b])await cutoverGovernance(pool,{runId:id,installationId,writerProof:['api:identity_v2','worker:identity_v2','relay:identity_v2']})
  expect(await sealGovernanceMigration(pool,id)).toMatchObject({sealed:true,validation:{violations:[]}})
  await expect(backfillGovernance(pool,{runId:id})).rejects.toThrow('migration_run_not_resumable')
  await expect(cutoverGovernance(pool,{runId:id,installationId:a,writerProof:['api:identity_v2','worker:identity_v2','relay:identity_v2']})).rejects.toThrow('migration_run_not_resumable')
  const capsule=await capturePrivacyWatermarks(pool)
  expect(capsule.migrationClosures).toHaveLength(1)
  // A backup containing an open run cannot silently resume a subsequently sealed run.
  await pool.query('ALTER TABLE memory_governance_migration_runs DISABLE TRIGGER memory_retention_migration_guard')
  try{await pool.query(`UPDATE memory_governance_migration_runs SET sealed_at=NULL,completed_at=NULL,state='validated' WHERE run_id=$1`,[id])}finally{await pool.query('ALTER TABLE memory_governance_migration_runs ENABLE TRIGGER memory_retention_migration_guard')}
  await replayPrivacyWatermarks(pool,JSON.parse(JSON.stringify(capsule)),{purgeHmacKey:'test'})
  await expect(backfillGovernance(pool,{runId:id})).rejects.toThrow('migration_run_not_resumable')
 })
})
