import pg from 'pg'
import {beforeAll,beforeEach,afterAll,describe,test,expect} from 'vitest'
import {randomUUID} from 'node:crypto'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {createPurgeRepository} from '../purge/repository.js'
const url=process.env.MEMORY_TEST_DATABASE_URL,suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('feedback privacy rollups',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 test('installation purge keeps only anonymous bounded action totals once',async()=>{
  const f=await governanceFixture(pool)
  await pool.query(`INSERT INTO memory_feedback(feedback_id,installation_id,claim_id,version_id,action,reason_code,details,created_at)
   VALUES(gen_random_uuid(),$1,$2,$3,'claim_corrected','Bearer private-credential','{"note":"private feedback text"}','2001-01-01')`,[f.personal,f.claim,f.version])
  const purge=createPurgeRepository(pool,{hmacKey:'quality-purge-hmac-key'}),requestId=randomUUID()
  const first=await purge.purgeInstallation({installationId:f.personal,requestId,reason:'user_delete'})
  expect(await purge.purgeInstallation({installationId:f.personal,requestId,reason:'user_delete'})).toBe(first)
  expect((await pool.query('SELECT count(*)::int n FROM memory_feedback WHERE installation_id=$1',[f.personal])).rows[0].n).toBe(0)
  const retained=(await pool.query("SELECT action,reason_code,total_count::text FROM memory_feedback_rollups WHERE period_day='2001-01-01'")).rows
  expect(retained).toEqual([{action:'claim_corrected',reason_code:'other',total_count:'1'}])
  expect(JSON.stringify(retained)).not.toContain('private');expect(JSON.stringify(retained)).not.toContain(f.personal)
 })
 test('session purge removes linked feedback bodies and IDs while retaining the observed action',async()=>{
  const f=await governanceFixture(pool)
  await pool.query(`INSERT INTO memory_feedback(feedback_id,installation_id,claim_id,version_id,action,reason_code,details)
   VALUES(gen_random_uuid(),$1,$2,$3,'recall_incorrect','private freeform note','{"session_id":"transaction-fixture","note":"private source text"}')`,[f.personal,f.claim,f.version])
  await createPurgeRepository(pool,{hmacKey:'quality-purge-hmac-key'}).purgeSession({installationId:f.personal,sessionId:'transaction-fixture',reason:'user_delete',sourceFeedId:null})
  const feedback=(await pool.query('SELECT action,reason_code,details,claim_id,version_id FROM memory_feedback WHERE installation_id=$1',[f.personal])).rows
  expect(feedback).toEqual([{action:'recall_incorrect',reason_code:'other',details:{},claim_id:null,version_id:null}])
 })

})
