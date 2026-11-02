import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {createMemoryPool} from '../db.js'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {startGovernanceBackfill,backfillGovernance,governanceEnvironmentFingerprint} from '../migrations/governance-v2/backfill.js'
import {validateGovernanceMigration} from '../migrations/governance-v2/validate.js'
import {reconcileGovernanceChanges} from '../migrations/governance-v2/reconcile.js'
import {cutoverGovernance,ensureGovernanceIndexes} from '../migrations/governance-v2/cutover.js'
import {sealGovernanceMigration} from '../retention/migrations.js'
import {createPurgeRepository} from '../purge/repository.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('governance validation across source and queue lifecycles (PostgreSQL)',()=>{
 let pool:pg.Pool,installationId:string,eventId:string
 beforeAll(async()=>{pool=createMemoryPool({databaseUrl:url!,dbPoolMax:6});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool);await ensureGovernanceIndexes(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{
  await pool.query('TRUNCATE memory_purge_receipts,memory_session_tombstones,memory_installations CASCADE')
  await pool.query('TRUNCATE memory_governance_migration_summaries,memory_governance_migration_runs CASCADE')
  await pool.query('UPDATE memory_retention_control SET change_gc_floor=0 WHERE singleton')
  installationId=randomUUID();eventId=randomUUID()
  await installation(installationId)
  await pool.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash)
   VALUES($1::uuid,$2,'feed',$1::text,'lifecycle-source','message',NOW(),'{}',decode('abcd','hex'))`,[eventId,installationId])
 })
 async function installation(id:string){
  await pool.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)`,[id])
  await pool.query(`INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$1)`,[id])
 }
 async function baseline(){
  const id=await startGovernanceBackfill(pool,{installationIds:[installationId],environmentFingerprint:await governanceEnvironmentFingerprint(pool)})
  await backfillGovernance(pool,{runId:id});return id
 }
 async function failedIds(runId:string){expect((await validateGovernanceMigration(pool,runId)).violations).toContain('historical_ids_retained')}

 test('expired completed queue jobs may disappear without weakening durable source IDs',async()=>{
  await pool.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,state,completed_at)
   VALUES(gen_random_uuid(),$1,'project_feed','expired-job','completed',NOW()-INTERVAL '25 hours')`,[installationId])
  const runId=await baseline()
  await pool.query(`DELETE FROM memory_jobs WHERE state='completed' AND completed_at<NOW()-INTERVAL '24 hours'`)
  const check=await validateGovernanceMigration(pool,runId)
  expect(check.violations).toEqual([]);expect(check.lifecycle).toEqual({transientJobsMissing:1,sourceEventsPurged:0})
  await pool.query('DELETE FROM source_events WHERE source_event_id=$1',[eventId])
  await failedIds(runId)
 })
 test('a real session purge has same-transaction deletion evidence and remains valid',async()=>{
  const runId=await baseline()
  await createPurgeRepository(pool,{hmacKey:'isolated-fixture'}).purgeSession({installationId,sessionId:'lifecycle-source',sourceFeedId:null,reason:'test'})
  const check=await validateGovernanceMigration(pool,runId)
  expect(check.violations).toEqual([]);expect(check.lifecycle.sourceEventsPurged).toBe(1)
 })
 test('an unrelated earlier session tombstone cannot excuse a later raw deletion',async()=>{
  const runId=await baseline()
  await pool.query(`INSERT INTO memory_session_tombstones(installation_id,session_id,reason,purged_at) VALUES($1,'other-session','test',NOW())`,[installationId])
  await pool.query('DELETE FROM source_events WHERE source_event_id=$1',[eventId])
  await failedIds(runId)
 })
 test('a tombstone from another installation in the same transaction cannot excuse a deletion',async()=>{
  const other=randomUUID();await installation(other);const runId=await baseline()
  const c=await pool.connect()
  try{await c.query('BEGIN');await c.query(`INSERT INTO memory_session_tombstones(installation_id,session_id,reason,purged_at) VALUES($1,'lifecycle-source','test',NOW())`,[other]);await c.query('DELETE FROM source_events WHERE source_event_id=$1',[eventId]);await c.query('COMMIT')}finally{await c.query('ROLLBACK');c.release()}
  await failedIds(runId)
 })
 test('removing a purge tombstone invalidates its deletion exception',async()=>{
  const runId=await baseline()
  await createPurgeRepository(pool,{hmacKey:'isolated-fixture'}).purgeSession({installationId,sessionId:'lifecycle-source',sourceFeedId:null,reason:'test'})
  await pool.query('DELETE FROM memory_session_tombstones WHERE installation_id=$1',[installationId])
  await failedIds(runId)
 })
 test('queue classification cannot excuse a missing knowledge version',async()=>{
  const claim=randomUUID(),version=randomUUID()
  await pool.query(`INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state)
   VALUES($1,$2,'test_invariant','installation','','missing-version','active')`,[claim,installationId])
  await pool.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence)
   VALUES($1,$2,$3,1,'immutable fixture','user_accepted',0.9)`,[version,installationId,claim])
  const runId=await baseline();await pool.query('DELETE FROM knowledge_versions WHERE version_id=$1',[version]);await failedIds(runId)
 })
 test('bounded replay preserves every change receipt and is idempotent across pages',async()=>{
  const runId=await baseline()
  for(let n=0;n<205;n++)await pool.query(`UPDATE source_events SET payload=jsonb_build_object('revision',$2::int) WHERE source_event_id=$1`,[eventId,n])
  await reconcileGovernanceChanges(pool,{runId})
  const count=async()=>Number((await pool.query(`SELECT count(*)::int AS n FROM memory_governance_migration_actions WHERE run_id=$1 AND reason='captured_immutable_change'`,[runId])).rows[0].n)
  const captured=Number((await pool.query(`SELECT count(*)::int AS n FROM memory_governance_migration_changes WHERE installation_id=$1 AND entity_kind='source_events'`,[installationId])).rows[0].n)
  const first=await count();expect(first).toBe(captured);expect(first).toBeGreaterThan(200)
  await reconcileGovernanceChanges(pool,{runId});expect(await count()).toBe(first)
 })
 test('closing an old migration preserves current v2 knowledge even when tombstones exist',async()=>{
  const runId=await baseline()
  await cutoverGovernance(pool,{runId,installationId,writerProof:['api:identity_v2','worker:identity_v2','relay:identity_v2']})
  const claim=randomUUID(),version=randomUUID(),identity='a'.repeat(64)
  await pool.query(`INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state,
   identity_generation,normalized_key_v2,topic_key_v2,duplicate_digest_v2)
   VALUES($1,$2,'test_invariant','installation','','current-v2-knowledge','active',2,$3,$3,$3)`,[claim,installationId,identity])
  await pool.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence,applicability)
   VALUES($1,$2,$3,1,'Current governed knowledge','user_accepted',0.9,'{"status":"verified"}')`,[version,installationId,claim])
  await pool.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,version])
  await pool.query(`INSERT INTO knowledge_tombstones(installation_id,key_id,identity_hmac,reason,deleted_at)
   VALUES($1,'legacy',decode(repeat('01',32),'hex'),'privacy_delete',NOW())`,[installationId])
  const before=(await pool.query('SELECT to_jsonb(c) AS row FROM knowledge_claims c WHERE claim_id=$1',[claim])).rows[0].row
  const vBefore=(await pool.query('SELECT to_jsonb(v) AS row FROM knowledge_versions v WHERE version_id=$1',[version])).rows[0].row
  await reconcileGovernanceChanges(pool,{runId})
  expect((await pool.query('SELECT to_jsonb(c) AS row FROM knowledge_claims c WHERE claim_id=$1',[claim])).rows[0].row).toEqual(before)
  expect((await pool.query('SELECT to_jsonb(v) AS row FROM knowledge_versions v WHERE version_id=$1',[version])).rows[0].row).toEqual(vBefore)
  expect((await validateGovernanceMigration(pool,runId)).violations).toEqual([])
 })
 test('seal rejects a late low-sequence commit even when maximum sequence is unchanged',async()=>{
  const runId=await baseline()
  await cutoverGovernance(pool,{runId,installationId,writerProof:['api:identity_v2','worker:identity_v2','relay:identity_v2']})
  const late=await pool.connect();let committed=false
  try{
   await late.query('BEGIN')
   await late.query(`INSERT INTO memory_governance_migration_changes(installation_id,entity_kind,entity_id,operation) VALUES($1,'source_sessions','{}','UPDATE')`,[installationId])
   await pool.query(`INSERT INTO memory_governance_migration_changes(installation_id,entity_kind,entity_id,operation) VALUES($1,'source_sessions','{}','UPDATE')`,[installationId])
   const wrapped=new Proxy(pool,{get(target,key){
    if(key==='connect')return async()=>{
     const c=await target.connect()
     return new Proxy(c,{get(client,property){
      if(property==='query')return async(sql:string,values?:unknown[])=>{
       if(sql==='LOCK TABLE memory_governance_migration_changes IN SHARE ROW EXCLUSIVE MODE NOWAIT'&&!committed){await late.query('COMMIT');committed=true}
       return client.query(sql,values)
      }
      const value=Reflect.get(client,property);return typeof value==='function'?value.bind(client):value
     }})
    }
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
   }})
   await expect(sealGovernanceMigration(wrapped,runId)).rejects.toThrow('migration_validation_stale')
   expect(committed).toBe(true)
   expect((await pool.query('SELECT sealed_at FROM memory_governance_migration_runs WHERE run_id=$1',[runId])).rows[0].sealed_at).toBeNull()
   expect((await sealGovernanceMigration(pool,runId)).sealed).toBe(true)
  }finally{await late.query('ROLLBACK');late.release()}
 })
})
