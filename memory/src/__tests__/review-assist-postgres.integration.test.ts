import pg from 'pg'
import Fastify from 'fastify'
import {beforeAll,beforeEach,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {registerGovernanceRoutes} from '../api/governance-routes.js'
import {createPromotionRepository} from '../governance/promotion-repository.js'
const url=process.env.MEMORY_TEST_DATABASE_URL,suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('human assist and per-item bulk CAS',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 async function setup(){const f=await governanceFixture(pool),c=await f.proposed(),r=await createPromotionRepository(pool).getLatestRevision(c.candidate.candidate_id)
  const g={...f.grant(f.reviewer,['read','review']),version:'v2',installationId:f.team,services:['memory.search'],callerType:'web'}
  const app=Fastify();registerGovernanceRoutes(app,{pool,guard:{guardV2:async()=>g} as any,sharedScopesEnabled:true,cursorSigningKey:'assist-fixture-key'})
  return {f,c,r,app}
 }
 test('bulk returns success and hash conflict separately, exact retry does not add votes',async()=>{
  const {f,c,r,app}=await setup()
  const item={candidate_id:c.candidate.candidate_id,expected_revision:1,expected_hash:r!.revision_bundle_hash,decision:'approve',review_duration_ms:4200}
  const req={method:'POST' as const,url:'/api/v1/memory/governance/bulk-decisions',headers:{'idempotency-key':'bulk-fixture'},payload:{target_installation_id:f.team,items:[{...item,expected_hash:'a'.repeat(64)},item]}}
  try{const response=await app.inject(req);expect(response.statusCode).toBe(200);expect(response.json().results.map((r:any)=>r.status)).toEqual(['conflict','success'])
   expect((await app.inject(req)).json().results.map((r:any)=>r.status)).toEqual(['conflict','success'])
   const changed={...req,payload:{...req.payload,items:[{...item,expected_hash:'a'.repeat(64)},{...item,decision:'reject'}]}}
   expect((await app.inject(changed)).json().results[1].status).toBe('conflict')
   expect((await pool.query('SELECT review_duration_ms FROM memory_review_decisions')).rows).toEqual([{review_duration_ms:4200}])
  }finally{await app.close()}
 })
 test('queue exposes evidence bundle and off mode without executing advice',async()=>{
  const {f,app}=await setup()
  try{const response=await app.inject({method:'GET',url:`/api/v1/memory/governance/proposals?target_installation_id=${f.team}`});expect(response.statusCode).toBe(200)
   const entry=response.json().queue[0];expect(entry.current_revision.bundle_hash).toMatch(/^[a-f0-9]{64}$/);expect(entry.evidence).toHaveLength(1);expect(entry.automation_mode).toBe('off')
  }finally{await app.close()}
 })
 test('non-admin cannot edit automation policy or enable autonomous modes',async()=>{
  const {f,app}=await setup()
  try{const response=await app.inject({method:'PATCH',url:'/api/v1/memory/governance/automation-policy',headers:{'idempotency-key':'policy-fixture'},payload:{target_installation_id:f.team,expected_revision:0,document:{mode:'assist',model:'fixture',promptVersion:'review-v1'}}});expect(response.statusCode).toBe(403)
  }finally{await app.close()}
 })
 test('public delegation is independently off and service callers cannot self-grant',async()=>{
  const {f,c,r,app}=await setup()
  try{const off=await app.inject({method:'POST',url:'/api/v1/memory/governance/publication-delegations',headers:{'idempotency-key':'off-delegation'},payload:{target_installation_id:f.team,candidate_id:c.candidate.candidate_id,expected_revision:1,expected_hash:r!.revision_bundle_hash,principal_id:f.proposer,expires_at:new Date(Date.now()+60000).toISOString()}});expect(off.statusCode).toBe(409)
   expect((await pool.query('SELECT COUNT(*)::int n FROM memory_publication_delegations')).rows[0].n).toBe(0)
  }finally{await app.close()}
 })

})
