import {createJobRepository} from '../jobs/repository.js'
import {createClaimIndexer} from '../retrieval/indexer.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import type {JobClaim,JobFence} from '../jobs/types.js'
import pg from 'pg'
import {beforeAll,beforeEach,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {createSearchService} from '../retrieval/search-service.js'
import {createPostgresVectorIndex} from '../retrieval/postgres-vector-index.js'
const url=process.env.MEMORY_TEST_DATABASE_URL,suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
const installation='11111111-1111-4111-8111-111111111111',tail='ffffffff-ffff-4fff-8fff-ffffffffffff'
suite('bounded database candidate selection above legacy scan caps',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:4});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 async function corpus(vector=false,count=13001){
  await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[installation])
  await pool.query("INSERT INTO memory_feature_settings(installation_id,embedding_mode) VALUES($1,$2)",[installation,vector?'enabled':'off'])
  const episode=(await pool.query("INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version) VALUES($1,gen_random_uuid(),'capacity','capacity','ready','test') RETURNING episode_id",[installation])).rows[0].episode_id
  const generated=`SELECT g,md5('capacity-claim-'||g::text)::uuid claim_id,
    CASE WHEN g=13001 THEN '${tail}'::uuid ELSE md5('capacity-version-'||g::text)::uuid END version_id,
    CASE WHEN g=13001 AND NOT $2::boolean THEN 'knownneedle exact relevant invariant' ELSE 'unrelated filler '||g::text END AS statement FROM generate_series(1,${count}) g`
  await pool.query(`WITH generated AS(${generated}) INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state)
    SELECT claim_id,$1,'test_invariant','installation','','capacity-'||g::text,'active' FROM generated`,[installation,vector])
  await pool.query(`WITH generated AS(${generated}) INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence)
    SELECT version_id,$1,claim_id,1,statement,'user_accepted',.9 FROM generated`,[installation,vector])
  await pool.query(`WITH generated AS(${generated}) UPDATE knowledge_claims c SET current_version_id=g.version_id FROM generated g WHERE c.claim_id=g.claim_id AND c.installation_id=$1`,[installation,vector])
  await pool.query(`WITH generated AS(${generated}) INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal)
    SELECT gen_random_uuid(),$1,version_id,$3,'episode','capacity evidence',sha256('capacity evidence'::bytea),clock_timestamp(),0 FROM generated`,[installation,vector,episode])
  await pool.query(`WITH generated AS(${generated}) INSERT INTO claim_search_documents(installation_id,version_id,document,embedding,embedding_provider,embedding_model,embedding_dimensions,embedding_status)
    SELECT $1,version_id,statement,CASE WHEN g=13001 THEN ARRAY[1,0]::real[] ELSE ARRAY[0,1]::real[] END,'capacity','capacity-model',2,'ready' FROM generated`,[installation,vector])
 }
 function measured(){
  const rows:number[]=[]
  let primary:unknown[]|undefined
  const measuredPool=new Proxy(pool,{get(target,key){if(key==='query')return async(...args:unknown[])=>{
   if(!primary&&typeof args[0]==='string'&&args[0].includes('eligible AS MATERIALIZED'))primary=args
   const result=await Reflect.apply(target.query,target,args);rows.push(result.rows?.length??0);return result
  };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
  return {rows,measuredPool,primary:()=>primary as [string,unknown[]]}
 }
 test('known lexical tail above ten thousand is selected without loading the corpus',async()=>{
  await corpus();const {rows,measuredPool,primary}=measured()
  const service=createSearchService({pool:measuredPool,recallEmbeddingTimeoutMs:100,cursorSigningKey:'capacity'})
  const durations:number[]=[],heap=process.memoryUsage().heapUsed
  let result
  for(let i=0;i<12;i++){
   const started=performance.now();result=await service.search({installationId:installation,query:'knownneedle exact relevant invariant'});durations.push(performance.now()-started)
  }
  durations.sort((a,b)=>a-b)
  console.info(JSON.stringify({gate:'capacity_13001_lexical',versions:13001,samples:durations.length,p95Ms:durations[Math.ceil(durations.length*.95)-1],maxHydratedRows:Math.max(...rows),heapDeltaBytes:Math.max(0,process.memoryUsage().heapUsed-heap),hits:result!.hits.length}))
  expect(result!.hits.map(h=>h.versionId)).toContain(tail)
  expect(Math.max(...rows)).toBeLessThanOrEqual(600)
  expect(durations[Math.ceil(durations.length*.95)-1]).toBeLessThan(500)
  const [sql,bindings]=primary()
  const explained=await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,bindings)
  console.info(JSON.stringify({gate:'capacity_13001_query_plan',plan:explained.rows[0]['QUERY PLAN']}))
  expect(explained.rows[0]['QUERY PLAN'][0].Plan['Actual Rows']).toBeLessThanOrEqual(600)
  await createClaimIndexer({pool}).handleRebuildClaimIndex({job_id:'rebuild',installation_id:installation,job_type:'rebuild_claim_index',idempotency_key:'rebuild',payload:{},attempts:1,claim_epoch:1})
  expect((await pool.query("SELECT count(*)::int n FROM memory_jobs WHERE installation_id=$1 AND job_type='index_claim_version'",[installation])).rows[0].n).toBeLessThanOrEqual(1000)
  expect((await pool.query("SELECT count(*)::int n FROM memory_jobs WHERE installation_id=$1 AND job_type='rebuild_claim_index'",[installation])).rows[0].n).toBe(1)
 },60000)
 test('pure-vector tail above both scan caps is scored in SQL within one model family',async()=>{
  await corpus(true);const {rows,measuredPool}=measured()
  const embed={provider:'capacity',model:'capacity-model',dimensions:2,embed:async()=>({vectors:[[1,0]],model:'capacity-model',tokens:1,costMicros:0})}
  const result=await createSearchService({pool:measuredPool,embed,recallEmbeddingTimeoutMs:100,cursorSigningKey:'capacity'})
   .search({installationId:installation,query:'semantic intent'})
  expect(result.hits[0]?.versionId).toBe(tail)
  expect(result.hits[0]?.vectorSimilarity).toBe(1)
  expect(Math.max(...rows)).toBeLessThanOrEqual(600)
 },60000)
 test('an explicit empty vector authorization set yields no rows',async()=>{
  await corpus(true,1)
  const result=await createPostgresVectorIndex(pool).search({installationId:installation,provider:'capacity',model:'capacity-model',dimensions:2,vector:[1,0],limit:5,candidateVersionIds:[]})
  expect(result).toEqual([])
 },60000)
 test('an index worker cannot persist a vector returned after its lease expired',async()=>{
  const f=await governanceFixture(pool)
  await pool.query("INSERT INTO memory_feature_settings(installation_id,embedding_mode) VALUES($1,'enabled')",[f.personal])
  const jobs=createJobRepository(pool);await jobs.enqueueJob({installationId:f.personal,jobType:'index_claim_version',idempotencyKey:'index-fence',payload:{version_id:f.version}})
  const [job]=await jobs.claimJobs({workerId:'index-worker',limit:1,leaseMs:30000})
  const embed={provider:'capacity',model:'capacity-model',dimensions:2,embed:async()=>{
    await pool.query("UPDATE memory_jobs SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",[job.job_id])
    return{vectors:[[1,0]],model:'capacity-model',tokens:1,costMicros:0}
  }}
  const indexer=createClaimIndexer({pool,embed})
  const handler=indexer.handleIndexClaimVersion.bind(indexer) as unknown as (j:JobClaim,s:AbortSignal,c:{fence:JobFence})=>Promise<void>
  await expect(handler(job,new AbortController().signal,{fence:{jobId:job.job_id,claimedBy:'index-worker',claimEpoch:job.claim_epoch}})).rejects.toMatchObject({code:'stale_job_fence'})
  expect((await pool.query('SELECT embedding_status FROM claim_search_documents WHERE version_id=$1',[f.version])).rows[0].embedding_status).toBe('disabled')
 })

})
