import pg from 'pg'
import {createHash,randomUUID} from 'node:crypto'
import {beforeAll,beforeEach,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {writeManualEntry} from '../claims/manual-entry.js'
import {resolveLifecycleFrame,lifecycleFrameCurrent} from '../context/lifecycle-frame.js'
import {createSearchService} from '../retrieval/search-service.js'
import {createContextCompiler} from '../context/compiler.js'
import {createAdmissionService} from '../context/admission-service.js'
import {createContextRetrieval} from '../context/retrieval.js'
import {createScopeResolver} from '../context/scope-resolver.js'
import {createLoadoutRepository} from '../context/loadout-repository.js'
import {createContextSettingsRepository} from '../context/settings-repository.js'
import {createPackRepository} from '../context/pack-repository.js'
import {createGenerationRunRepository} from '../generation/repository.js'
import {createPolicyRepository} from '../policies/repository.js'
import {createPolicyResolver} from '../policies/resolver.js'
import {createTrajectoryRepository} from '../context/trajectory-repository.js'
import {createFeedbackService} from '../context/feedback-service.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('lifecycle context',()=>{
 let pool:pg.Pool,f:Awaited<ReturnType<typeof governanceFixture>>,work:string,life:string,workClaim:string,workVersion:string
 let compiler:ReturnType<typeof createContextCompiler>,admission:ReturnType<typeof createAdmissionService>
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:5});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{
  await pool.query('TRUNCATE memory_installations CASCADE');f=await governanceFixture(pool)
  await pool.query("INSERT INTO memory_curation_policies(installation_id,mode,consume_mode) VALUES($1,'enabled','enabled')",[f.personal])
  await pool.query("INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'context-lifecycle',NOW(),NOW())",[f.personal])
  work=randomUUID();life=randomUUID()
  for(const [space,domain,dest,value]of [[work,'work','work','timeout production 30'],[life,'life','personal','timeout travel 90']]){
   await pool.query('INSERT INTO memory_spaces(installation_id,space_id,name,domain,destinations) VALUES($1,$2,$3,$3,ARRAY[$4])',[f.personal,space,domain,dest])
   const c=await pool.connect();let written:any
   try{await c.query('BEGIN');written=await writeManualEntry(c,{installationId:f.personal,statement:value,claimType:'work_method',repositoryId:null},[]);await c.query('COMMIT')}finally{c.release()}
   const entity=randomUUID();await pool.query("INSERT INTO memory_entities(installation_id,space_id,entity_id,kind,name) VALUES($1,$2,$3,'service','fixture')",[f.personal,space,entity])
   await pool.query("INSERT INTO memory_logical_claims(installation_id,space_id,subject_entity_id,logical_key,predicate_id,cardinality,claim_id) VALUES($1,$2,$3,$4,'service.timeout','single',$5)",[f.personal,space,entity,createHash('sha256').update(space).digest('hex'),written.metadata.claim_id])
   if(space===work){workClaim=written.metadata.claim_id;workVersion=written.metadata.version_id}
  }
  const settings=createContextSettingsRepository(pool);await settings.upsert({installationId:f.personal,scopeKind:'installation',scopeKey:'global',agent:null,mode:'enabled',maxTokens:null,expectedRevision:1})
  const search=createSearchService({pool,recallEmbeddingTimeoutMs:100,cursorSigningKey:'k'})
  compiler=createContextCompiler({pool,lifecycleMode:'enabled',retrieval:createContextRetrieval({pool,search,trajectory:createTrajectoryRepository(pool)}),scope:createScopeResolver(pool),loadouts:createLoadoutRepository(pool),settings,packs:createPackRepository(pool),generation:createGenerationRunRepository(pool),policyResolver:createPolicyResolver({pool,repository:createPolicyRepository(pool)})})
  admission=createAdmissionService({pool,lifecycleMode:'enabled',nonceHmacKey:Buffer.alloc(32,7)})
 })
 const compile=(sceneId=work,destination:'work'|'personal'='work')=>compiler.compile({installationId:f.personal,sessionId:'context-lifecycle',clientRequestId:randomUUID(),agent:'codex',adapterCapability:'native_hidden_v1',sceneId,destination,query:'timeout',requestKey:{keyId:'k',hmacKey:Buffer.alloc(32,3)}})
 async function ticket(){const result=await compile();expect(result.kind).toBe('ready');if(result.kind!=='ready')throw new Error('compile');const t=await admission.admit({installationId:f.personal,sessionId:'context-lifecycle',clientRequestId:(await pool.query('SELECT client_request_id FROM memory_context_packs WHERE pack_id=$1',[result.packId])).rows[0].client_request_id,packId:result.packId,agent:'codex',adapter:'codex-app-server',grantConfigVersion:'1',sharedGrantAuthorized:true});if(!t.ok||!('nonce'in t))throw new Error('admit '+JSON.stringify(t));return{...t,packId:result.packId}}
 const consume=(t:Awaited<ReturnType<typeof ticket>>)=>admission.consume({installationId:f.personal,sessionId:'context-lifecycle',packId:t.packId,injectionId:t.injectionId,nonce:t.nonce})
 test('AC-25 scene filtered before search hydration',async()=>{
  const lifecycle=await resolveLifecycleFrame(pool,{installationId:f.personal,sessionId:'context-lifecycle',repositoryId:null,spaceId:work,destination:'work',mode:'enabled'})
  const search=createSearchService({pool,recallEmbeddingTimeoutMs:100,cursorSigningKey:'k'})
  expect((await search.search({installationId:f.personal,query:'timeout',lifecycle})).hits.map(h=>h.statement)).toEqual(['timeout production 30'])
  expect((await search.search({installationId:f.personal,query:'timeout'})).hits).toEqual([])
  await pool.query("UPDATE memory_claim_lifecycle SET storage_tier='cold',cold_since=NOW() WHERE claim_id=$1",[workClaim])
  expect((await search.search({installationId:f.personal,query:'timeout',lifecycle})).hits).toEqual([])
 })
 test('AC-30 plans without fact time do not enter current-fact context',async()=>{
  await pool.query("UPDATE memory_claim_lifecycle SET assertion_mode='planned' WHERE claim_id=$1",[workClaim])
  const lifecycle=await resolveLifecycleFrame(pool,{installationId:f.personal,sessionId:'context-lifecycle',repositoryId:null,spaceId:work,destination:'work',mode:'enabled'})
  const search=createSearchService({pool,recallEmbeddingTimeoutMs:100,cursorSigningKey:'k'})
  expect((await search.search({installationId:f.personal,query:'timeout',lifecycle})).hits).toEqual([])
  expect((await compile()).kind).toBe('empty')
 })
 test('AC-29 scene switch expires admitted undelivered pack',async()=>{
  const t=await ticket();await compile(life,'personal');expect(await consume(t)).toEqual({ok:false,error:'expired'})
 })
 test('AC-28 policy or authorization changes invalidate frozen frame',async()=>{
  const frame=await resolveLifecycleFrame(pool,{installationId:f.personal,sessionId:'context-lifecycle',repositoryId:null,spaceId:work,destination:'work',mode:'enabled'})
  expect(await lifecycleFrameCurrent(pool,f.personal,frame)).toBe(true)
  await pool.query('UPDATE memory_owner_scopes SET authorization_epoch=authorization_epoch+1 WHERE installation_id=$1',[f.personal])
  expect(await lifecycleFrameCurrent(pool,f.personal,frame)).toBe(false)
 })
 test.each(['policy','cold','head','global_off'])('AC-28 admitted pack rejects %s change',async change=>{
  const t=await ticket()
  if(change==='policy')await pool.query("UPDATE memory_curation_policies SET consume_mode='off',revision=revision+1 WHERE installation_id=$1",[f.personal])
  if(change==='cold')await pool.query("UPDATE memory_claim_lifecycle SET storage_tier='cold',cold_since=NOW() WHERE claim_id=$1",[workClaim])
  if(change==='head'){
   const c=await pool.connect();try{await c.query('BEGIN');await writeManualEntry(c,{installationId:f.personal,claimId:workClaim,expectedRevision:1,statement:'timeout production 60',claimType:'work_method',repositoryId:null},[]);await c.query('COMMIT')}finally{c.release()}
  }
  if(change==='global_off')admission=createAdmissionService({pool,lifecycleMode:'off',nonceHmacKey:Buffer.alloc(32,7)})
  expect(await consume(t)).toEqual({ok:false,error:'expired'})
 })
 test('AC-31 receipt and per-item confirmation are separate and idempotent',async()=>{
  const t=await ticket();expect((await consume(t)).ok).toBe(true)
  for(let i=0;i<2;i++)await admission.receipt({installationId:f.personal,sessionId:'context-lifecycle',injectionId:t.injectionId,delivered:true})
  expect((await pool.query("SELECT count(*)::int n FROM memory_claim_usage WHERE claim_id=$1 AND signal='delivered'",[workClaim])).rows[0].n).toBe(1)
  expect((await pool.query('SELECT last_delivered_at,last_confirmed_use_at,observation_state FROM memory_claim_lifecycle WHERE claim_id=$1',[workClaim])).rows[0]).toMatchObject({last_delivered_at:expect.any(Date),last_confirmed_use_at:null,observation_state:'unknown'})
  const item=(await pool.query('SELECT item_id FROM memory_context_pack_items WHERE pack_id=$1 AND claim_id=$2',[t.packId,workClaim])).rows[0].item_id
  const feedback=createFeedbackService({pool});for(let i=0;i<2;i++)await feedback.submit({installationId:f.personal,injectionId:t.injectionId,packId:t.packId,itemId:item,actor:'user',action:'used'})
  expect((await pool.query("SELECT count(*)::int n FROM memory_claim_usage WHERE claim_id=$1 AND signal='user_confirmed'",[workClaim])).rows[0].n).toBe(1)
  expect((await pool.query('SELECT authority FROM knowledge_versions WHERE version_id=$1',[workVersion])).rows[0].authority).toBe('user_accepted')
 })
})
