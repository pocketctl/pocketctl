import pg from 'pg'
import Fastify from 'fastify'
import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {registerManageRoutes} from '../api/manage-routes.js'
import {createCorsHostPolicy} from '../auth/cors-host-policy.js'
import {createClaimRepository} from '../claims/repository.js'
import {createPurgeRepository} from '../purge/repository.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('personal source discovery owns a bounded Session set',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:8});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_session_tombstones,memory_purge_receipts,memory_installations CASCADE')})
 afterAll(async()=>{await pool.end()})
 function barrier(){let reach!:()=>void,release!:()=>void;return {reached:new Promise<void>(r=>{reach=r}),allowed:new Promise<void>(r=>{release=r}),reach:()=>reach(),release:()=>release()}}
 function hooked(after:(sql:string,result:pg.QueryResult)=>Promise<void>){return {query:pool.query.bind(pool),connect:async()=>{
  const client=await pool.connect()
  return new Proxy(client,{get(target,key){if(key==='query')return async(...args:unknown[])=>{
   const result=await Reflect.apply(target.query,target,args)
   if(typeof args[0]==='string')await after(args[0],result)
   return result
  };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
 }} as unknown as pg.Pool}
 function appFor(installationId:string,db:pg.Pool){const app=Fastify();registerManageRoutes(app,{pool:db,
  guard:{guard:async()=>({installationId,configVersion:'1'})} as never,
  policy:createCorsHostPolicy({allowedHosts:['localhost'],allowedOrigins:[],isProduction:false}),
  textConfigured:false,embeddingConfigured:false,tombstoneHmacKeys:[]});return app}
 async function source(installationId:string,episodeId:string,candidateId:string,sessionId='new-source'){
  const client=await pool.connect()
  try{await client.query('BEGIN')
   await client.query("SELECT pg_advisory_xact_lock(hashtextextended('purge:session:'||$1||':'||$2,0))",[installationId,sessionId])
   await client.query("SELECT pg_advisory_xact_lock(hashtextextended('purge:installation:'||$1,0))",[installationId])
   await client.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,source_digest,document,evidence_manifest,compiled_at)
    VALUES($1,$2::uuid,$3,$2::uuid::text,'ready','fixture','x'::bytea,$4::jsonb,$5::jsonb,NOW())`,[installationId,episodeId,sessionId,
     JSON.stringify({final_outcome:{text:'Late source invariant',evidence_handle:'h0-aaaaaaaa'}}),JSON.stringify({'h0-aaaaaaaa':{kind:'episode'}})])
   const run=(await client.query(`INSERT INTO memory_extraction_runs(run_id,installation_id,episode_id,episode_source_digest,extractor_version,prompt_version,model_config_hash,input_digest,mode,state,provider,model)
    VALUES(gen_random_uuid(),$1,$2,'x'::bytea,'test','test','x'::bytea,'x'::bytea,'enabled','succeeded','fixture','fixture') RETURNING run_id`,[installationId,episodeId])).rows[0].run_id
   await client.query(`INSERT INTO memory_candidates(candidate_id,installation_id,run_id,episode_id,ordinal,claim_type,statement,structured_content,normalized_key,scope_kind,scope_key,confidence,freshness_at,evidence_handles,status)
    VALUES($1,$2,$3,$4,0,'test_invariant','Late source invariant','{}'::jsonb,'late-source','installation','global',0.9,NOW(),'["h0-aaaaaaaa"]'::jsonb,'validated')`,[candidateId,installationId,run,episodeId])
   await client.query('COMMIT')
  }finally{await client.query('ROLLBACK');client.release()}
 }
 function request(operation:string,claimId:string,candidateId:string,episodeId:string){return {method:'POST' as const,
  url:operation==='accept'?`/api/v1/memory/candidates/${candidateId}/accept`:`/api/v1/memory/claims/${claimId}/correct`,
  headers:{'idempotency-key':'source-discovery'},payload:operation==='accept'?{expected_revision:1}:{expected_revision:1,statement:'Late source invariant',
   evidence:[{evidence_kind:'episode',episode_id:episodeId,excerpt:'Late source invariant is supported',occurred_at:new Date().toISOString()}]}}}
 function discovery(sql:string){return sql.includes('SELECT e.session_id FROM memory_candidates')||sql.startsWith('SELECT session_id FROM work_episodes WHERE installation_id=$1')}
 for(const operation of ['accept','correct']){
  test(`${operation} rejects missing-to-present discovery with no receipt, then fresh request succeeds`,async()=>{
   const f=await governanceFixture(pool),episodeId=randomUUID(),candidateId=randomUUID(),gate=barrier();let paused=false
   const app=appFor(f.personal,hooked(async sql=>{if(!paused&&discovery(sql)){paused=true;gate.reach();await gate.allowed}}))
   const req=request(operation,f.claim,candidateId,episodeId),pending=app.inject(req)
   try{await gate.reached;await source(f.personal,episodeId,candidateId);gate.release()
    const response=await pending
    expect(response.statusCode).toBe(409)
    expect(response.json().error.reason_code).toBe('source_discovery_changed')
    expect((await pool.query('SELECT 1 FROM memory_idempotency_keys WHERE installation_id=$1',[f.personal])).rowCount).toBe(0)
    expect((await pool.query('SELECT revision::int FROM knowledge_claims WHERE claim_id=$1',[f.claim])).rows[0].revision).toBe(1)
    expect((await pool.query('SELECT status FROM memory_candidates WHERE candidate_id=$1',[candidateId])).rows[0].status).toBe('validated')
    expect((await app.inject(req)).statusCode).toBe(200)
    expect((await app.inject(req)).statusCode).toBe(200)
    expect((await pool.query('SELECT 1 FROM memory_idempotency_keys WHERE installation_id=$1',[f.personal])).rowCount).toBe(1)
   }finally{gate.release();await pending;await app.close()}
  },15000)
  test(`${operation} refuses a newly discovered Session while purge owns it`,async()=>{
   const f=await governanceFixture(pool),episodeId=randomUUID(),candidateId=randomUUID(),discovered=barrier(),receipt=barrier(),purgeSession=barrier();let first=false,reserved=false
   const app=appFor(f.personal,hooked(async sql=>{
    if(!first&&discovery(sql)){first=true;discovered.reach();await discovered.allowed}
    if(!reserved&&sql.includes('INSERT INTO memory_idempotency_keys')){reserved=true;receipt.reach();await receipt.allowed}
   }))
   const pending=app.inject(request(operation,f.claim,candidateId,episodeId));let purging:Promise<unknown>|undefined
   try{await discovered.reached;await source(f.personal,episodeId,candidateId);discovered.release();await receipt.reached
    purging=createPurgeRepository(hooked(async sql=>{if(sql.includes('pg_advisory_xact_lock')&&sql.includes('purge:session:')){purgeSession.reach();await purgeSession.allowed}}),{hmacKey:'isolated-personal-discovery'})
     .purgeSession({installationId:f.personal,sessionId:'new-source',reason:'user_deleted',sourceFeedId:null})
    const outcome=purging.then(value=>({value}),error=>({error}));await purgeSession.reached
    receipt.release();purgeSession.release()
    const response=await pending,purgeResult=await outcome
    expect({statusCode:response.statusCode,purgeResult}).toMatchObject({statusCode:409,purgeResult:{value:expect.anything()}})
    expect((await pool.query('SELECT 1 FROM memory_idempotency_keys WHERE installation_id=$1',[f.personal])).rowCount).toBe(0)
    expect((await pool.query('SELECT 1 FROM work_episodes WHERE episode_id=$1',[episodeId])).rowCount).toBe(0)
   }finally{discovered.release();receipt.release();purgeSession.release();await pending;await purging?.catch(()=>undefined);await app.close()}
  },15000)
 }
 test('direct acceptance rejects a candidate published after its empty preload; fresh retry succeeds',async()=>{
  const f=await governanceFixture(pool),episodeId=randomUUID(),candidateId=randomUUID(),gate=barrier();let paused=false
  const claims=createClaimRepository(hooked(async sql=>{if(!paused&&sql.includes('FROM memory_candidates c')&&sql.includes('JOIN work_episodes e')){paused=true;gate.reach();await gate.allowed}}))
  const input={installationId:f.personal,candidateId,expectedRevision:1},pending=claims.acceptCandidate(input)
  try{await gate.reached;await source(f.personal,episodeId,candidateId);gate.release()
   expect(await pending).toMatchObject({ok:false,error:{code:'candidate_not_found'}})
   expect((await pool.query('SELECT status FROM memory_candidates WHERE candidate_id=$1',[candidateId])).rows[0].status).toBe('validated')
   expect(await claims.acceptCandidate(input)).toMatchObject({ok:true})
  }finally{gate.release();await pending}
 },15000)
 test('direct acceptance revalidates the locked candidate source tuple before copying evidence',async()=>{
  const f=await governanceFixture(pool),episodeId=randomUUID(),candidateId=randomUUID(),gate=barrier();let paused=false
  await source(f.personal,episodeId,candidateId)
  const claims=createClaimRepository(hooked(async sql=>{if(!paused&&sql.includes('FROM memory_candidates c')&&sql.includes('JOIN work_episodes e')){paused=true;gate.reach();await gate.allowed}}))
  const input={installationId:f.personal,candidateId,expectedRevision:1},pending=claims.acceptCandidate(input)
  try{await gate.reached
   // Explicit fixture provenance replacement; normal compile upserts keep this Session immutable.
   await pool.query('UPDATE work_episodes SET session_id=$2 WHERE episode_id=$1',[episodeId,'replacement-source']);gate.release()
   expect(await pending).toMatchObject({ok:false,error:{code:'source_discovery_changed'}})
   expect((await pool.query('SELECT 1 FROM knowledge_versions WHERE source_candidate_id=$1',[candidateId])).rowCount).toBe(0)
   expect((await pool.query('SELECT status FROM memory_candidates WHERE candidate_id=$1',[candidateId])).rows[0].status).toBe('validated')
   expect(await claims.acceptCandidate(input)).toMatchObject({ok:true})
  }finally{gate.release();await pending}
 },15000)
 test('direct correction rejects a changed Episode Session after prelock and permits fresh retry',async()=>{
  const f=await governanceFixture(pool),episodeId=randomUUID(),candidateId=randomUUID(),gate=barrier();let paused=false
  await source(f.personal,episodeId,candidateId)
  const claims=createClaimRepository(hooked(async sql=>{if(!paused&&sql.includes('SELECT episode_id::text, session_id FROM work_episodes')){paused=true;gate.reach();await gate.allowed}}))
  const input={installationId:f.personal,claimId:f.claim,expectedRevision:1,statement:'Late source invariant',evidence:[{evidenceKind:'episode' as const,episodeId,locator:{},excerpt:'Late source invariant is supported',occurredAt:new Date()}]}
  const pending=claims.correctClaim(input)
  try{await gate.reached
   // Fixture source replacement deliberately changes provenance while the reader owns no locks.
   await pool.query('UPDATE work_episodes SET session_id=$2 WHERE episode_id=$1',[episodeId,'replacement-source']);gate.release()
   expect(await pending).toMatchObject({ok:false,error:{code:'source_discovery_changed'}})
   expect((await pool.query('SELECT revision::int FROM knowledge_claims WHERE claim_id=$1',[f.claim])).rows[0].revision).toBe(1)
   expect(await claims.correctClaim(input)).toMatchObject({ok:true})
  }finally{gate.release();await pending}
 },15000)
})
