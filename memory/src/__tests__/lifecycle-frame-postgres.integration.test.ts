import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {beforeAll,beforeEach,afterEach,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {resolveLifecycleFrame,lifecycleFrameCurrent,lifecycleFrameFenceSql} from '../context/lifecycle-frame.js'
import {consumptionGeneration} from '../context/consumption.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('lifecycle session frame isolation',()=>{
 let pool:pg.Pool,f:Awaited<ReturnType<typeof governanceFixture>>,first:string,second:string
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:5});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{
  f=await governanceFixture(pool);first=randomUUID();second=randomUUID()
  await pool.query("INSERT INTO memory_curation_policies(installation_id,mode,consume_mode) VALUES($1,'off','enabled')",[f.personal])
  for(const id of [first,second])await pool.query("INSERT INTO memory_spaces(installation_id,space_id,name,domain,destinations) VALUES($1,$2,'fixture','work',ARRAY['work'])",[f.personal,id])
 })
 afterEach(async()=>{await pool.query('DELETE FROM knowledge_claims WHERE installation_id=ANY($1::uuid[])',[[f.personal,f.team]]);await pool.query('DELETE FROM memory_installations WHERE installation_id=ANY($1::uuid[])',[[f.personal,f.team]])})
 afterAll(async()=>{await pool?.end()})
 const resolve=(sessionId:string,spaceId=first)=>resolveLifecycleFrame(pool,{installationId:f.personal,sessionId,repositoryId:null,spaceId,destination:'work',mode:'enabled'})
 test('AC-48 writing paused leaves independently enabled consumption available',async()=>{
  const frame=await resolve('one');expect(frame).toMatchObject({consume:true,spaceId:first})
  expect(await lifecycleFrameCurrent(pool,f.personal,frame)).toBe(true)
  expect(await lifecycleFrameCurrent(pool,f.personal,frame,'off')).toBe(false)
 })
 test('AC-29 unrelated sessions do not invalidate owner generation; own switch fails final SQL fence',async()=>{
  const before=await consumptionGeneration(pool,f.personal),one=await resolve('one')
  expect(await consumptionGeneration(pool,f.personal)).toBe(before)
  const two=await resolve('two');expect(await consumptionGeneration(pool,f.personal)).toBe(before)
  expect(await lifecycleFrameCurrent(pool,f.personal,one)).toBe(true)
  await resolve('two',second);expect(await consumptionGeneration(pool,f.personal)).toBe(before)
  expect(await lifecycleFrameCurrent(pool,f.personal,one)).toBe(true)
  expect(await lifecycleFrameCurrent(pool,f.personal,two)).toBe(false)
  const final=async(session:string,frame:unknown)=>(await pool.query(`WITH p AS(SELECT $1::uuid AS installation_id,$2::text AS session_id,$3::jsonb AS query_context) SELECT ${lifecycleFrameFenceSql()} AS valid FROM p`,[f.personal,session,JSON.stringify({lifecycle:frame})])).rows[0].valid
  expect(await final('one',one)).toBe(true)
  expect(await final('two',two)).toBe(false)
  await resolve('one',second);expect(await final('one',one)).toBe(false)
  expect(await final('one',null)).toBe(true)
 })
})
