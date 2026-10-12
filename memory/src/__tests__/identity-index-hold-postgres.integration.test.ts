import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,beforeEach,describe,expect,test,vi} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {createClaimIndexer} from '../retrieval/indexer.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('identity hold fences asynchronous claim indexing',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:4});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool?.end()})
 async function fixture(){
  const f=await governanceFixture(pool)
  await pool.query("INSERT INTO memory_feature_settings(installation_id,embedding_mode,embedding_consent_fingerprint) VALUES($1,'enabled','index-hold-adapter')",[f.personal])
  return f
 }
 const result={vectors:[[0.6,0.8]],model:'index-hold-model',tokens:3,costMicros:4}
 const provider=(embed:()=>Promise<typeof result>)=>({provider:'openai-compatible',model:'index-hold-model',dimensions:2,embed})
 const indexer=(embed:()=>Promise<typeof result>)=>createClaimIndexer({pool,embed:provider(embed),embeddingConsentFingerprint:'index-hold-adapter'})
 function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve});return{promise,release}}
 async function fencedMutation(installation:string,run:(client:pg.PoolClient)=>Promise<void>){
  const client=await pool.connect()
  try{await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('purge:installation:'||$1,0))",[installation]);await run(client);await client.query('COMMIT')}
  catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
 }
 async function startBlocked(f:Awaited<ReturnType<typeof fixture>>,fail=false){
  const started=gate(),completion=gate(),embed=vi.fn(async()=>{started.release();await completion.promise;if(fail)throw new Error('provider failure');return result})
  const indexing=indexer(embed).indexVersion(f.personal,f.version,new AbortController().signal)
  await Promise.race([started.promise,indexing.then(()=>{throw new Error('provider dispatch expected')})])
  return{indexing,completion,embed}
 }
 test('queued held claims lose old projections and never dispatch or requeue embeddings',async()=>{
  const f=await fixture(),embed=vi.fn(async()=>result),service=indexer(embed)
  await pool.query("INSERT INTO claim_search_documents(installation_id,version_id,document) VALUES($1,$2,'old retained projection')",[f.personal,f.version])
  await fencedMutation(f.personal,async client=>{await client.query("UPDATE knowledge_claims SET consumption_hold_reason='tombstoned_identity' WHERE claim_id=$1",[f.claim])})
  await service.indexVersion(f.personal,f.version,new AbortController().signal)
  await service.handleRebuildClaimIndex({job_id:randomUUID(),installation_id:f.personal,job_type:'rebuild_claim_index',idempotency_key:'identity-hold-rebuild',
   payload:{adapter_fingerprint:'new-index-adapter'},attempts:0,claim_epoch:1})
  expect(embed).not.toHaveBeenCalled()
  expect((await pool.query('SELECT count(*)::int AS n FROM claim_search_documents WHERE installation_id=$1',[f.personal])).rows[0].n).toBe(0)
  expect((await pool.query("SELECT count(*)::int AS n FROM memory_jobs WHERE installation_id=$1 AND job_type='index_claim_version'",[f.personal])).rows[0].n).toBe(0)
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_usage_outbox WHERE installation_id=$1',[f.personal])).rows[0].n).toBe(0)
 })
 test('an in-flight embedding is discarded after the current identity enters hold',async()=>{
  const f=await fixture(),pending=await startBlocked(f)
  try{await fencedMutation(f.personal,async client=>{await client.query("UPDATE knowledge_claims SET consumption_hold_reason='tombstoned_identity' WHERE claim_id=$1",[f.claim])})}
  finally{pending.completion.release()}
  await pending.indexing
  expect((await pool.query('SELECT count(*)::int AS n FROM claim_search_documents WHERE installation_id=$1',[f.personal])).rows[0].n).toBe(0)
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_usage_outbox WHERE installation_id=$1',[f.personal])).rows[0].n).toBe(0)
 })
 test('an old in-flight result cannot overwrite or delete a newly indexed head',async()=>{
  const f=await fixture(),pending=await startBlocked(f),next=randomUUID()
  try{
   await fencedMutation(f.personal,async client=>{
    await client.query("INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) VALUES($1,$2,$3,2,'The new head stays searchable','user_corrected',0.9)",[next,f.personal,f.claim])
    await client.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[f.claim,next])
   })
   await createClaimIndexer({pool}).indexVersion(f.personal,next,new AbortController().signal)
  }finally{pending.completion.release()}
  await pending.indexing
  const docs=(await pool.query('SELECT version_id,document,embedding_status FROM claim_search_documents WHERE installation_id=$1',[f.personal])).rows
  expect(docs).toHaveLength(1);expect(docs[0]).toMatchObject({version_id:next,embedding_status:'disabled'})
  expect(docs[0].document).toContain('The new head stays searchable')
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_usage_outbox WHERE installation_id=$1',[f.personal])).rows[0].n).toBe(0)
 })
 test('consent revoked during dispatch leaves lexical data with no embedding or usage projection',async()=>{
  const f=await fixture(),pending=await startBlocked(f)
  try{await pool.query("UPDATE memory_feature_settings SET embedding_mode='off' WHERE installation_id=$1",[f.personal])}
  finally{pending.completion.release()}
  await pending.indexing
  expect((await pool.query('SELECT embedding,embedding_status FROM claim_search_documents WHERE version_id=$1',[f.version])).rows[0])
   .toEqual({embedding:null,embedding_status:'disabled'})
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_usage_outbox WHERE installation_id=$1',[f.personal])).rows[0].n).toBe(0)
 })
 test('provider failure after hold does not recreate projection state or schedule retries',async()=>{
  const f=await fixture(),pending=await startBlocked(f,true)
  try{await fencedMutation(f.personal,async client=>{await client.query("UPDATE knowledge_claims SET consumption_hold_reason='tombstoned_identity' WHERE claim_id=$1",[f.claim])})}
  finally{pending.completion.release()}
  await expect(pending.indexing).resolves.toBeUndefined()
  expect((await pool.query('SELECT count(*)::int AS n FROM claim_search_documents WHERE installation_id=$1',[f.personal])).rows[0].n).toBe(0)
 })
 test('successful current embedding retains its body-free accounting entry',async()=>{
  const f=await fixture()
  await indexer(async()=>result).indexVersion(f.personal,f.version,new AbortController().signal)
  expect((await pool.query('SELECT embedding_status,embedding FROM claim_search_documents WHERE version_id=$1',[f.version])).rows[0])
   .toMatchObject({embedding_status:'ready',embedding:[0.6,0.8]})
  expect((await pool.query('SELECT embedding_tokens::text,cost_micros::text FROM memory_usage_outbox WHERE installation_id=$1',[f.personal])).rows)
   .toEqual([{embedding_tokens:'3',cost_micros:'4'}])
 })
})
