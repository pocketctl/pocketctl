import pg from 'pg'
import Fastify from 'fastify'
import {beforeAll,beforeEach,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {registerManageRoutes} from '../api/manage-routes.js'
import {createCorsHostPolicy} from '../auth/cors-host-policy.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('personal scene creation authorization and idempotency',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool?.end()})
 function app(installationId:string,callerType='web'){
  const a=Fastify();registerManageRoutes(a,{pool,guard:{guard:async()=>({installationId,callerType,configVersion:'1',expiresAt:Date.now()/1000+60})} as never,policy:createCorsHostPolicy({allowedOrigins:[],allowedHosts:['memory.example'],isProduction:false}),textConfigured:false,embeddingConfigured:false,tombstoneHmacKeys:[{version:'test',key:'test-scene'.repeat(8)}]});return a
 }
 const payload={expected_revision:0,name:'Acceptance project',domain:'personal_project'}
 const headers={host:'memory.example',authorization:'Bearer synthetic','idempotency-key':'scene-create-one'}
 test('normal create repeats exactly once and preserves formal content and switches',async()=>{
  const f=await governanceFixture(pool),a=app(f.personal)
  try{
   const one=await a.inject({method:'POST',url:'/api/v1/memory/scenes',headers,payload})
   expect(one.statusCode).toBe(200);expect(one.json()).toMatchObject({name:payload.name,domain:'personal_project',destinations:['personal']})
   const repeated=await a.inject({method:'POST',url:'/api/v1/memory/scenes',headers,payload});expect(repeated.json()).toEqual(one.json())
   expect((await pool.query('SELECT count(*)::int n FROM memory_spaces WHERE installation_id=$1',[f.personal])).rows[0].n).toBe(1)
   expect((await pool.query('SELECT count(*)::int n FROM knowledge_claims WHERE installation_id=$1',[f.personal])).rows[0].n).toBe(1)
   expect((await pool.query('SELECT count(*)::int n FROM memory_curation_policies WHERE installation_id=$1',[f.personal])).rows[0].n).toBe(0)
   expect((await a.inject({method:'POST',url:'/api/v1/memory/scenes',headers,payload:{...payload,name:'Different'}})).statusCode).toBe(409)
  }finally{await a.close()}
 })
 test.each(['provider','team'])('rejects %s authority and creates nothing',async(kind)=>{
  const f=await governanceFixture(pool),a=app(kind==='team'?f.team:f.personal,kind==='provider'?'provider':'web')
  try{expect((await a.inject({method:'POST',url:'/api/v1/memory/scenes',headers,payload})).statusCode).toBe(403);expect((await pool.query('SELECT count(*)::int n FROM memory_spaces')).rows[0].n).toBe(0)}finally{await a.close()}
 })
})
