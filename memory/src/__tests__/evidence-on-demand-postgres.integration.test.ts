import Fastify from 'fastify'
import {registerReadRoutes} from '../api/read-routes.js'
import {createPackRepository} from '../context/pack-repository.js'
import pg from 'pg'
import {beforeAll,beforeEach,afterAll,describe,test,expect} from 'vitest'
import {randomUUID,createHash} from 'node:crypto'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {createEvidenceService} from '../claims/evidence-service.js'
import {createMemoryReadService} from '../retrieval/read-service.js'
const url=process.env.MEMORY_TEST_DATABASE_URL,suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('bound evidence references and current secondary reads',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:4});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 const service=()=>createEvidenceService(pool) as unknown as {summary(input:Record<string,unknown>):Promise<any>;readBound(input:Record<string,unknown>):Promise<any>}
 async function fixture(){
  const f=await governanceFixture(pool)
  const input={installationId:f.personal,evidenceId:f.evidence,scopeGrant:f.grant(f.publisher,['read'])}
  const hash=(await pool.query("SELECT encode(excerpt_hash,'hex') AS hash FROM knowledge_evidence WHERE evidence_id=$1",[f.evidence])).rows[0].hash
  return{f,input,bound:{...input,versionId:f.version,excerptHash:hash}}
 }
 test('summary carries immutable evidence ID, version and actual hash with honest missing material',async()=>{
  const {f,input,bound}=await fixture(),summary=await service().summary(input)
  expect(summary.reference).toMatchObject({evidence_id:f.evidence,version_id:f.version,excerpt_hash:bound.excerptHash})
  expect(summary.material_missing).toBe(true)
  expect(summary.excerpt).toBe('The fixture verifies transaction boundaries.')
 })
 test('secondary read rejects wrong version or hash',async()=>{
  const {bound}=await fixture()
  expect(await service().readBound({...bound,versionId:randomUUID()})).toBeNull()
  expect(await service().readBound({...bound,excerptHash:'0'.repeat(64)})).toBeNull()
 })
 test('existing evidence endpoint cannot expose withdrawn current content',async()=>{
  const {f}=await fixture();await pool.query("UPDATE knowledge_claims SET state='revoked' WHERE claim_id=$1",[f.claim])
  expect(await createMemoryReadService(pool,'evidence-test').getEvidence(f.personal,f.evidence)).toBeNull()
 })
 test('grant membership loss and claim expiry deny an old bound reference',async()=>{
  const {f,bound}=await fixture()
  await pool.query("UPDATE knowledge_versions SET valid_until=clock_timestamp()-interval '1 second' WHERE version_id=$1",[f.version])
  expect(await service().readBound(bound)).toBeNull()
  await pool.query('UPDATE knowledge_versions SET valid_until=NULL WHERE version_id=$1',[f.version])
  await pool.query("UPDATE memory_scope_memberships SET state='revoked' WHERE membership_id=$1",[f.publisher])
  expect(await service().readBound(bound)).toBeNull()
 })
 test('retained accepted capsule is distinct from inaccessible original source',async()=>{
  const {f,bound}=await fixture(),capsule=randomUUID()
  await pool.query(`INSERT INTO knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash)
    VALUES($1,$2,$3,'user_accepted',sha256('accepted'::bytea))`,[capsule,f.personal,f.version])
  await pool.query("UPDATE knowledge_evidence SET capsule_id=$2,episode_id=NULL,evidence_kind='accepted_excerpt' WHERE evidence_id=$1",[f.evidence,capsule])
  const read=await service().readBound(bound)
  expect(read).toMatchObject({material_kind:'retained_capsule',content:'The fixture verifies transaction boundaries.',material_missing:true})
 })
 test('sanitized original material requires source hash, is bounded to four pages and excludes secrets',async()=>{
  const {f,input,bound}=await fixture(),event=randomUUID()
  const text='api_key=private-secret-value '+Array.from({length:2000},(_,i)=>`evidence segment ${i}`).join(' ')
  await pool.query(`INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'raw-evidence',clock_timestamp(),clock_timestamp())`,[f.personal])
  await pool.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash)
    VALUES($1,$2,'feed','raw-evidence','raw-evidence','agent_text',clock_timestamp(),$3::jsonb,$4)`,[event,f.personal,JSON.stringify({text}),createHash('sha256').update(text).digest()])
  await pool.query("UPDATE knowledge_evidence SET source_event_id=$2,evidence_kind='event' WHERE evidence_id=$1",[f.evidence,event])
  const summary=await service().summary(input)
  expect(summary.reference.source_hash).toMatch(/^[a-f0-9]{64}$/)
  expect(await service().readBound({...bound,sourceHash:summary.reference.source_hash,sourceVersion:randomUUID()})).toBeNull()
  const page=await service().readBound({...bound,sourceHash:summary.reference.source_hash,sourceVersion:summary.reference.source_version,page:0,maxChars:1000})
  expect(page).toMatchObject({material_kind:'sanitized_source',next_page:1})
  expect(page.content.length).toBeLessThanOrEqual(1000)
  expect(page.content).not.toContain('private-secret-value')
  const last=await service().readBound({...bound,sourceHash:summary.reference.source_hash,sourceVersion:summary.reference.source_version,page:3,maxChars:1000})
  expect(last.next_page).toBeNull();expect(last.truncated).toBe(true)
  await expect(service().readBound({...bound,page:4})).rejects.toThrow('invalid_evidence_page')
  await pool.query("UPDATE source_events SET payload='{\"text\":\"changed source\"}'::jsonb WHERE source_event_id=$1",[event])
  expect(await service().readBound({...bound,sourceHash:summary.reference.source_hash,sourceVersion:summary.reference.source_version})).toBeNull()
 })
 test('body deletion produces missing evidence rather than an invented replacement',async()=>{
  const {f,bound}=await fixture();await pool.query('DELETE FROM knowledge_evidence WHERE evidence_id=$1',[f.evidence])
  expect(await service().readBound(bound)).toBeNull()
 })
 async function packed(){
  const base=await fixture(),{f}=base
  const packId=await createPackRepository(pool).persist({installationId:f.personal,generationRunId:null,trajectoryId:null,
    sessionId:'evidence-pack',clientRequestId:randomUUID(),agent:'codex',repositoryId:null,mode:'enabled',
    effectivePolicyHash:Buffer.alloc(32,1),settingsFingerprint:Buffer.alloc(32,2),loadoutFingerprint:Buffer.alloc(32,3),inputDigest:Buffer.alloc(32,4),
    policyRevision:1,settingsRevision:1,loadoutRevision:1,state:'ready',
    items:[{itemId:randomUUID(),claimId:f.claim,versionId:f.version,claimType:'test_invariant',layer:'L2',section:'stable',representation:'on_demand',
      statement:'Transactional fixture invariant',scopeKind:'installation',reasonCodes:['selected'],evidenceIds:[f.evidence]}]})
  return{...base,packId}
 }
 test('a new Context pack stores exact evidence version and hash and emits an idempotent generation receipt',async()=>{
  const {f,bound,packId}=await packed()
  const reference=(await pool.query("SELECT evidence_version_id::text,encode(excerpt_hash,'hex') excerpt_hash FROM memory_context_pack_evidence WHERE pack_id=$1",[packId])).rows[0]
  expect(reference).toEqual({evidence_version_id:f.version,excerpt_hash:bound.excerptHash})
  const read=await service().readBound({...bound,packId})
  expect(read.receipt_id).toMatch(/^[a-f0-9-]{36}$/)
  expect((await service().readBound({...bound,packId})).receipt_id).toBe(read.receipt_id)
  expect((await pool.query('SELECT count(*)::int n FROM memory_context_evidence_reads WHERE pack_id=$1',[packId])).rows[0].n).toBe(1)
 })
 test('a consumption-generation change invalidates an old bound pack',async()=>{
  const {f,bound,packId}=await packed()
  await pool.query("UPDATE knowledge_claims SET scope_key='changed-context' WHERE claim_id=$1",[f.claim])
  expect(await service().readBound({...bound,packId})).toBeNull()
  expect((await pool.query('SELECT count(*)::int n FROM memory_context_evidence_reads WHERE pack_id=$1',[packId])).rows[0].n).toBe(0)
 })
 test('legacy unproven pack references do not become new frozen proof',async()=>{
  const {bound,packId}=await packed()
  await pool.query('UPDATE memory_context_pack_evidence SET evidence_version_id=NULL,excerpt_hash=NULL,source_hash=NULL,source_version=NULL WHERE pack_id=$1',[packId])
  expect(await service().readBound({...bound,packId})).toBeNull()
 })

 async function readApp(f:Awaited<ReturnType<typeof governanceFixture>>){
  const app=Fastify(),grant={installationId:f.personal,configVersion:'1',services:['memory.search'],callerType:'web'}
  registerReadRoutes(app,{pool,guard:{guard:async()=>grant,guardMcp:async()=>grant} as never,
    policy:{hostAllowed:()=>true,originAllowed:()=>true},recallEmbeddingTimeoutMs:100,cursorSigningKey:'evidence-test'})
  return app
 }
 test('HTTP reference and content routes expose the bound contract with matching version and hash',async()=>{
  const {f,bound}=await fixture(),app=await readApp(f)
  try{
   const summary=await app.inject({url:`/api/v1/memory/evidence/${f.evidence}/reference`})
   expect(summary.statusCode).toBe(200);expect(summary.json().reference.excerpt_hash).toBe(bound.excerptHash)
   const body=await app.inject({url:`/api/v1/memory/evidence/${f.evidence}/content?version_id=${f.version}&excerpt_hash=${bound.excerptHash}&max_chars=20`})
   expect(body.statusCode).toBe(200);expect(body.json().content.length).toBeLessThanOrEqual(20)
  }finally{await app.close()}
 })
 test('HTTP rejects invalid or unbound content requests',async()=>{
  const {f,bound}=await fixture(),app=await readApp(f)
  try{
   expect((await app.inject({url:`/api/v1/memory/evidence/${f.evidence}/content`})).statusCode).toBe(400)
   expect((await app.inject({url:`/api/v1/memory/evidence/${f.evidence}/content?version_id=${f.version}&excerpt_hash=${bound.excerptHash}&source_hash=bad`})).statusCode).toBe(400)
  }finally{await app.close()}
 })
 test('a Team-origin artifact cannot obtain raw material through an omitted event pointer',async()=>{
  const {f,input}=await fixture(),event=randomUUID(),artifact=randomUUID()
  await pool.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash)
    VALUES($1,$2,'team','team-artifact','team-artifact','tool_result',clock_timestamp(),'{"text":"private Team result"}',sha256('team'::bytea))`,[event,f.personal])
  await pool.query(`INSERT INTO source_artifacts(artifact_id,installation_id,session_id,source_event_id,artifact_type,identity_key,details,occurred_at)
    VALUES($1,$2,'team-artifact',$3,'tool_result','team-artifact','{"text":"private Team result"}',clock_timestamp())`,[artifact,f.personal,event])
  await pool.query("UPDATE knowledge_evidence SET evidence_kind='artifact',artifact_id=$2,source_event_id=NULL WHERE evidence_id=$1",[f.evidence,artifact])
  const summary=await service().summary(input)
  expect(summary.source_available).toBe(false)
  expect(summary.reference.source_hash).toBeNull()
 })

 test('grant expiry after a real evidence lock wait denies content and creates no read receipt',async()=>{
  const {f,bound,packId}=await packed(),blocker=await pool.connect()
  await blocker.query('BEGIN');await blocker.query('SELECT 1 FROM knowledge_evidence WHERE evidence_id=$1 FOR UPDATE',[f.evidence])
  let pid=0
  const actor={connect:async()=>{const c=await pool.connect();pid=(await c.query('SELECT pg_backend_pid() pid')).rows[0].pid;return c}} as pg.Pool
  const reading=createEvidenceService(actor).readBound({...bound,packId,expiresAt:Date.now()/1000+.25})
  try{
   let blocked=false
   for(let i=0;i<100;i++){
    if(pid&&(await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 blocked',[pid])).rows[0].blocked){blocked=true;break}
    await new Promise(resolve=>setTimeout(resolve,5))
   }
   expect(blocked).toBe(true)
   await blocker.query('SELECT pg_sleep(.3)');await blocker.query('COMMIT')
   expect(await reading).toBeNull()
   expect((await pool.query('SELECT count(*)::int n FROM memory_context_evidence_reads WHERE pack_id=$1',[packId])).rows[0].n).toBe(0)
  }finally{await blocker.query('ROLLBACK').catch(()=>undefined);blocker.release()}
 })

})
