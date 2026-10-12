import pg from 'pg'
import {gitDbFixture,gitClaimFixture,insertGitConnection} from '../testing/phase6-db-fixture.js'
import {afterEach,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {createMemoryPool} from '../db.js'
import {applyMemoryV50Fixture,seedMemoryV50Anomalies,V50_IDS} from '../testing/fixtures/memory-v50.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('live Bridge writer fence',()=>{
 let pool:pg.Pool;let runtime:pg.Pool
 beforeEach(async()=>{
  pool=new pg.Pool({connectionString:url,max:5});await assertMemoryTestDatabase(pool,url!)
  await pool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');await applyMemoryV50Fixture(pool,url!);await seedMemoryV50Anomalies(pool);await applyMemorySchema(pool)
  await pool.query('INSERT INTO memory_governance_v2_states(installation_id) VALUES($1)',[V50_IDS.personal])
  runtime=createMemoryPool({databaseUrl:url!,dbPoolMax:3})
 },60000)
 afterEach(async()=>{await runtime.end();await pool.end()})
 const edit=(db:pg.Pool|pg.PoolClient)=>db.query("UPDATE knowledge_versions SET statement='writer edit' WHERE version_id=$1",[V50_IDS.firstVersion])
 test('old connection writes are rejected after its installation requires Bridge',async()=>{
  await pool.query("UPDATE memory_governance_v2_states SET writer_floor='bridge_v2' WHERE installation_id=$1",[V50_IDS.personal])
  await expect(edit(pool)).rejects.toMatchObject({code:'55000',message:'memory_writer_incompatible:capability'})
  expect((await pool.query('SELECT statement FROM knowledge_versions WHERE version_id=$1',[V50_IDS.firstVersion])).rows[0].statement).toBe('Fixture symbol location')
  expect((await pool.query('SELECT 1 FROM memory_governance_migration_changes')).rowCount).toBe(0)
  await edit(runtime)
  expect((await pool.query('SELECT writer_capability FROM memory_governance_migration_changes')).rows[0].writer_capability).toBe('identity_v2')
 })
 test('an installation requiring generation two rejects this generation-one Bridge',async()=>{
  await pool.query('UPDATE memory_governance_v2_states SET identity_generation=2 WHERE installation_id=$1',[V50_IDS.personal])
  const bridge=new pg.Pool({connectionString:url,options:'-c pocketctl.writer_capability=bridge_v2 -c pocketctl.writer_identity_generation=1'})
  try{await expect(edit(bridge)).rejects.toMatchObject({code:'55000',message:'memory_writer_incompatible:identity_generation'})}finally{await bridge.end()}
 })
 test('missing control state is initialized at the first write rather than schema startup',async()=>{
  await pool.query('DELETE FROM memory_governance_v2_states WHERE installation_id=$1',[V50_IDS.personal])
  expect((await pool.query('SELECT 1 FROM memory_governance_v2_states')).rowCount).toBe(0)
  await edit(pool)
  expect((await pool.query('SELECT writer_floor,identity_generation FROM memory_governance_v2_states')).rows).toEqual([{writer_floor:'v1',identity_generation:1}])
 })
 test('hold blocks fresh semantic writes while feed ingress and restrictive lifecycle changes remain durable',async()=>{
  await pool.query("UPDATE memory_governance_v2_states SET phase='hold' WHERE installation_id=$1",[V50_IDS.personal])
  await expect(edit(runtime)).rejects.toMatchObject({code:'55000',message:'memory_writer_incompatible:phase'})
  await pool.query("INSERT INTO memory_feed_inbox(installation_id,feed_id,envelope_version,topic,source_kind,source_id,event_type,recorded_at,data,payload_hash) VALUES($1,1,1,'session.delta','session','fixture-session','fixture',NOW(),'{}',sha256('feed'::bytea))",[V50_IDS.personal])
  await pool.query("UPDATE knowledge_claims SET state='revoked',revision=revision+1 WHERE claim_id=$1",[V50_IDS.knownClaim])
  await pool.query('DELETE FROM knowledge_claims WHERE claim_id=$1',[V50_IDS.unknownClaim])
  await pool.query("INSERT INTO knowledge_tombstones(installation_id,key_id,identity_hmac,reason) VALUES($1,'fixture',sha256('privacy'::bytea),'privacy_delete')",[V50_IDS.personal])
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_feed_inbox')).rows[0].n).toBe(1)
  expect((await pool.query('SELECT count(*)::int AS n FROM knowledge_tombstones')).rows[0].n).toBe(1)
  expect((await pool.query('SELECT state FROM knowledge_claims WHERE claim_id=$1',[V50_IDS.knownClaim])).rows[0].state).toBe('revoked')
 })
 test('the control transaction cannot modify semantic sources in either order',async()=>{
  const client=await runtime.connect()
  try{
   await client.query('BEGIN')
   await client.query("UPDATE memory_governance_v2_states SET writer_floor='bridge_v2' WHERE installation_id=$1",[V50_IDS.personal])
   await expect(edit(client)).rejects.toMatchObject({code:'55000',message:'memory_writer_incompatible:control_transaction'})
   await client.query('ROLLBACK');await client.query('BEGIN');await edit(client)
   await expect(client.query("UPDATE memory_governance_v2_states SET writer_floor='bridge_v2' WHERE installation_id=$1",[V50_IDS.personal])).rejects.toMatchObject({code:'55000',message:'memory_writer_incompatible:control_transaction'})
  }finally{await client.query('ROLLBACK');client.release()}
 })
 async function waitBlocked(pid:number,finished:()=>boolean){
  for(let attempt=0;attempt<60;attempt++){
   if((await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0].blocked)return
   if(finished())throw new Error('write completed before the competing transaction released its fence')
   await new Promise(resolve=>setTimeout(resolve,20))
  }
  throw new Error('expected transaction to wait on the writer fence')
 }
 test('floor commits first: an already-started old writer waits and then refuses',async()=>{
  const barrier=await pool.connect(),writer=await pool.connect()
  let finished=false
  let result:Promise<{ok:boolean,error?:unknown}>|undefined
  try{
   const pid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
   await barrier.query('BEGIN');await barrier.query("UPDATE memory_governance_v2_states SET writer_floor='bridge_v2' WHERE installation_id=$1",[V50_IDS.personal])
   await writer.query('BEGIN')
   result=edit(writer).then(()=>{finished=true;return {ok:true}},error=>{finished=true;return {ok:false,error}})
   await waitBlocked(pid,()=>finished)
   await barrier.query('COMMIT')
   expect(await result).toMatchObject({ok:false,error:{code:'55000',message:'memory_writer_incompatible:capability'}})
  }finally{await barrier.query('ROLLBACK');await result;await writer.query('ROLLBACK');barrier.release();writer.release()}
 })
 test('writer commits first: the floor waits and the committed change stays auditable',async()=>{
  const writer=await pool.connect(),barrier=await pool.connect()
  let finished=false
  let result:Promise<void>|undefined
  try{
   const pid=(await barrier.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
   await writer.query('BEGIN');await edit(writer)
   await barrier.query('BEGIN')
   result=barrier.query("UPDATE memory_governance_v2_states SET writer_floor='bridge_v2' WHERE installation_id=$1",[V50_IDS.personal]).then(()=>{finished=true})
   await waitBlocked(pid,()=>finished)
   await writer.query('COMMIT');await result;await barrier.query('COMMIT')
   expect((await pool.query('SELECT operation,writer_capability FROM memory_governance_migration_changes')).rows).toEqual([{operation:'UPDATE',writer_capability:'legacy_unknown'}])
   await expect(pool.query("UPDATE knowledge_versions SET statement=statement||' old retry' WHERE version_id=$1",[V50_IDS.firstVersion])).rejects.toMatchObject({code:'55000'})
  }finally{await writer.query('ROLLBACK');await result;await barrier.query('ROLLBACK');writer.release();barrier.release()}
 })
 test('a repeatable-read snapshot cannot bypass a newly committed floor',async()=>{
  const writer=await pool.connect()
  try{
   await writer.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
   await writer.query('SELECT * FROM memory_governance_v2_states')
   await pool.query("UPDATE memory_governance_v2_states SET writer_floor='bridge_v2' WHERE installation_id=$1",[V50_IDS.personal])
   await expect(edit(writer)).rejects.toMatchObject({code:'40001'})
  }finally{await writer.query('ROLLBACK');writer.release()}
 })
 test('the current Bridge cannot declare unsupported generation-two writes even through connection options',async()=>{
  await pool.query('UPDATE memory_governance_v2_states SET identity_generation=2 WHERE installation_id=$1',[V50_IDS.personal])
  const future=new pg.Pool({connectionString:url,options:'-c pocketctl.writer_capability=bridge_v2 -c pocketctl.writer_identity_generation=2'})
  try{await expect(edit(future)).rejects.toMatchObject({code:'55000',message:'memory_writer_incompatible:identity_generation'})}finally{await future.end()}
 })
 test('an old snapshot missing the control row cannot bypass a newly inserted floor',async()=>{
  await pool.query('DELETE FROM memory_governance_v2_states')
  const writer=await pool.connect()
  try{
   await writer.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await writer.query('SELECT * FROM memory_governance_v2_states')
   await pool.query("INSERT INTO memory_governance_v2_states(installation_id,writer_floor) VALUES($1,'bridge_v2')",[V50_IDS.personal])
   await expect(edit(writer)).rejects.toMatchObject({code:'40001'})
  }finally{await writer.query('ROLLBACK');writer.release()}
 })

 test('old Git enrollment cannot append semantic bindings after the Bridge floor',async()=>{
  const f=await gitDbFixture(pool),claim=await gitClaimFixture(pool,f),connection=await insertGitConnection(pool,f)
  await pool.query("UPDATE memory_governance_v2_states SET writer_floor='bridge_v2' WHERE installation_id=$1",[f.installationId])
  const sql="INSERT INTO memory_git_asset_bindings(binding_id,installation_id,connection_id,repository_id,kind,claim_id,path) VALUES(gen_random_uuid(),$1,$2,$3,'claim',$4,'.pocketctl/knowledge/claims/fixture.json')"
  const args=[f.installationId,connection,f.repositoryId,claim.claimId]
  await expect(pool.query(sql,args)).rejects.toMatchObject({code:'55000',message:'memory_writer_incompatible:capability'})
  await runtime.query(sql,args)
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_git_asset_bindings')).rows[0].n).toBe(1)
 })

})
