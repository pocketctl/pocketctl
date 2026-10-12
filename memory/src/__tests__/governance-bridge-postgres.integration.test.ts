import pg from 'pg'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {applyMemoryV50Fixture,seedMemoryV50Anomalies,V50_IDS} from '../testing/fixtures/memory-v50.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const HISTORICAL_PACK='a0520000-0000-4000-8000-000000000001'
const HISTORICAL_INJECTION='a0520000-0000-4000-8000-000000000002'
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('additive governance Bridge upgrade',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await applyMemoryV50Fixture(pool,url!);await seedMemoryV50Anomalies(pool)
  await pool.query(`INSERT INTO memory_context_packs(pack_id,installation_id,session_id,client_request_id,agent,mode,effective_policy_hash,input_digest,state,dynamic_text,dynamic_hash)
    VALUES($1,$2,'history','history','codex','enabled',sha256('policy'::bytea),sha256('input'::bytea),'ready','immutable historical text',sha256('immutable historical text'::bytea))`,[HISTORICAL_PACK,V50_IDS.personal])
  await pool.query(`INSERT INTO memory_context_injections(injection_id,installation_id,pack_id,session_id,client_request_id,agent,adapter,admission_nonce_hmac,state)
    VALUES($1,$2,$3,'history','history','codex','codex-app-server',sha256('nonce'::bytea),'delivered')`,[HISTORICAL_INJECTION,V50_IDS.personal,HISTORICAL_PACK])
  await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 test('adds identity and revision fields without rewriting human content',async()=>{
  const columns=(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='knowledge_claims'")).rows.map(r=>r.column_name)
  expect(columns).toContain('identity_generation');expect(columns).toContain('normalized_key_v2')
  const r=(await pool.query('SELECT identity_generation,normalized_key_v2 FROM knowledge_claims WHERE claim_id=$1',[V50_IDS.knownClaim])).rows[0]
  expect(r).toEqual({identity_generation:1,normalized_key_v2:null})
  expect((await pool.query('SELECT statement,effective_from,effective_until FROM knowledge_versions WHERE version_id=$1',[V50_IDS.firstVersion])).rows[0]).toEqual({statement:'Fixture symbol location',effective_from:null,effective_until:null})
 })
 test('startup is repeatable and never creates migration runs or changes source IDs',async()=>{
  await applyMemorySchema(pool)
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_governance_migration_runs')).rows[0].n).toBe(0)
  expect((await pool.query('SELECT count(*)::int AS n FROM knowledge_versions')).rows[0].n).toBe(3)
 })
 test('generation two cannot exist without a v2 identity',async()=>{
  await expect(pool.query('UPDATE knowledge_claims SET identity_generation=2 WHERE claim_id=$1',[V50_IDS.unknownClaim])).rejects.toMatchObject({code:'23514'})
 })
 test('invalid revision intervals are refused',async()=>{
  await expect(pool.query("UPDATE knowledge_versions SET effective_from='2026-03-01',effective_until='2026-02-01' WHERE version_id=$1",[V50_IDS.firstVersion])).rejects.toMatchObject({code:'23514'})
 })
 test('upgrade leaves historical pack bytes, delivery state and unknown consumption stamps frozen',async()=>{
  expect((await pool.query("SELECT dynamic_text,encode(dynamic_hash,'hex') AS hash,consumption_generation,query_context FROM memory_context_packs WHERE pack_id=$1",[HISTORICAL_PACK])).rows[0]).toEqual({dynamic_text:'immutable historical text',hash:(await pool.query("SELECT encode(sha256('immutable historical text'::bytea),'hex') AS hash")).rows[0].hash,consumption_generation:null,query_context:null})
  expect((await pool.query('SELECT state,consumption_generation FROM memory_context_injections WHERE injection_id=$1',[HISTORICAL_INJECTION])).rows[0]).toEqual({state:'delivered',consumption_generation:null})
 })
 test('rolled-back metadata holds do not invalidate an admitted consumption generation',async()=>{
  const before=(await pool.query('SELECT generation::text FROM memory_scope_consumption_generations WHERE installation_id=$1',[V50_IDS.personal])).rows
  const client=await pool.connect()
  try{await client.query('BEGIN');await client.query("UPDATE knowledge_claims SET consumption_hold_reason='fixture_hold' WHERE claim_id=$1",[V50_IDS.knownClaim]);await client.query('ROLLBACK')}finally{client.release()}
  expect((await pool.query('SELECT generation::text FROM memory_scope_consumption_generations WHERE installation_id=$1',[V50_IDS.personal])).rows).toEqual(before)
  expect((await pool.query('SELECT consumption_hold_reason FROM knowledge_claims WHERE claim_id=$1',[V50_IDS.knownClaim])).rows[0].consumption_hold_reason).toBeNull()
 })
 test('scope deletion resolves the Team owner tuple to its distinct installation',async()=>{
  const owner='a0520000-0000-4000-8000-000000000003'
  await pool.query('UPDATE memory_owner_scopes SET owner_scope_id=$2 WHERE installation_id=$1',[V50_IDS.team,owner])
  const before=(await pool.query('SELECT generation::text FROM memory_scope_consumption_generations WHERE installation_id=$1',[V50_IDS.team])).rows[0].generation
  await pool.query("INSERT INTO memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason) VALUES('team',$1,1,'fixture')",[owner])
  expect(BigInt((await pool.query('SELECT generation::text FROM memory_scope_consumption_generations WHERE installation_id=$1',[V50_IDS.team])).rows[0].generation)).toBe(BigInt(before)+1n)
  expect((await pool.query('SELECT 1 FROM memory_scope_consumption_generations WHERE installation_id=$1',[owner])).rowCount).toBe(0)
 })
 test('installation deletion cascades consumption generations without resurrecting the parent',async()=>{
  const installation='a0520000-0000-4000-8000-000000000004'
  await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[installation])
  await pool.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$1)",[installation])
  await pool.query('DELETE FROM memory_installations WHERE installation_id=$1',[installation])
  expect((await pool.query('SELECT 1 FROM memory_scope_consumption_generations WHERE installation_id=$1',[installation])).rowCount).toBe(0)
 })

})
