import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {beforeAll,beforeEach,afterAll,describe,test,expect,vi} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {createCurationWorker} from '../curation/worker.js'
import {stageLifecycleTurn} from '../curation/task-repository.js'
import {canonicalPayloadHash} from '../inbox/canonical-json.js'
import type {TextGenerator} from '../ports/text-generator.js'
import type {JobClaim} from '../jobs/types.js'
import {createExtractionRepository} from '../extraction/repository.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('lifecycle consolidation transaction (synthetic provider, not model acceptance)',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 const success=(tasks:unknown[]=[])=>({ok:true,value:{tasks},usage:{inputTokens:20,outputTokens:5,model:'synthetic'}})
 async function fixture(unknown=false){
  const f=await governanceFixture(pool),id=randomUUID(),session='consolidation-session',turn='consolidation-turn'
  const payload={text:'I prefer concise answers.'},proof={version:1,producer:'claude',session_id:session,turn_id:turn,event_id:'event-1',sequence:'1',invocation_id:'user-input',source_role:'user',skill_state:'non_skill',lineage_complete:true,derived_from_event_ids:[]}
  await pool.query("INSERT INTO memory_curation_policies(installation_id,mode) VALUES($1,'enabled')",[f.personal])
  await pool.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,source_provenance)
   VALUES($1,$2,'feed','1',$3,$4,'user_text',clock_timestamp(),$5,$6,$7)`,[id,f.personal,session,turn,payload,canonicalPayloadHash(payload),{memory:proof}])
  if(unknown){const data={text:'UNKNOWN_EXCLUDED_CANARY'};await pool.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash) VALUES(gen_random_uuid(),$1,'feed','2',$2,$3,'user_text',clock_timestamp(),$4,$5)`,[f.personal,session,turn,data,canonicalPayloadHash(data)])}
  const client=await pool.connect()
  try{await client.query('BEGIN');const events=(await client.query('SELECT * FROM source_events WHERE installation_id=$1',[f.personal])).rows
   await stageLifecycleTurn(client,{installationId:f.personal,sessionId:session,turnId:turn,events},{mode:'enabled',revision:1,authorizationEpoch:'1',version:'memory-lifecycle-v1'});await client.query('COMMIT')
  }finally{client.release()}
  const job=(await pool.query("SELECT * FROM memory_jobs WHERE installation_id=$1 AND job_type='consolidate_task'",[f.personal])).rows[0] as JobClaim
  return {...f,id,payload,job,bundleId:String(job.payload.bundle_id)}
 }
 const worker=(generator:TextGenerator)=>createCurationWorker({pool,mode:'enabled',textGenerator:generator,modelFingerprint:'synthetic-v1'})
 const signal=()=>new AbortController().signal
 test('quoted model evidence persists numeric spans for downstream workers',async()=>{
  const f=await fixture(),space=randomUUID()
  await pool.query("INSERT INTO memory_spaces(installation_id,space_id,domain,name,destinations) VALUES($1,$2,'profile','preferences',ARRAY['personal'])",[f.personal,space])
  const generate=vi.fn(async()=>success([{space_id:space,task_id:null,spans:[{event_id:f.id,quote:f.payload.text}],conclusions:[]}]))
  await worker({generateJson:generate} as TextGenerator).consolidate(f.job,signal())
  const rows=(await pool.query("SELECT spans FROM memory_task_bundles WHERE installation_id=$1 AND bundle_kind='task'",[f.personal])).rows
  expect(rows).toEqual([{spans:[{event_id:f.id,start:0,end:f.payload.text.length}]}])
  expect((await pool.query('SELECT count(*)::int n FROM memory_candidates')).rows[0].n).toBe(0)
 })
 test('AC-16 zero conclusion receives complete coverage without a fabricated candidate',async()=>{
  const f=await fixture(),generate=vi.fn(async()=>success())
  await worker({generateJson:generate} as TextGenerator).consolidate(f.job,signal())
  expect((await pool.query('SELECT disposition,complete,allowed_count FROM memory_source_processing_receipts')).rows).toEqual([{disposition:'no_durable_conclusion',complete:true,allowed_count:1}])
  expect((await pool.query('SELECT count(*)::int n FROM memory_candidates')).rows[0].n).toBe(0)
  await worker({generateJson:generate} as TextGenerator).consolidate(f.job,signal())
  expect(generate).toHaveBeenCalledTimes(1)
 })
 test('AC-05 unknown source is excluded from provider and never complete coverage',async()=>{
  const f=await fixture(true),generate=vi.fn(async()=>success())
  await worker({generateJson:generate} as TextGenerator).consolidate(f.job,signal())
  expect(JSON.stringify(generate.mock.calls)).not.toContain('UNKNOWN_EXCLUDED_CANARY')
  expect((await pool.query('SELECT disposition,complete FROM memory_source_processing_receipts')).rows).toEqual([{disposition:'provenance_unknown',complete:false}])
 })
 test('AC-15 known budget block safely retries the same run after its retry time',async()=>{
  const f=await fixture(),generate=vi.fn().mockResolvedValueOnce({ok:false,code:'budget_exceeded',retryable:true}).mockResolvedValueOnce(success())
  const w=worker({generateJson:generate} as TextGenerator)
  await expect(w.consolidate(f.job,signal())).rejects.toThrow('source_not_ready')
  await pool.query("UPDATE memory_task_bundles SET next_evaluate_at=clock_timestamp()-interval '1 second'")
  await w.consolidate(f.job,signal())
  expect(generate).toHaveBeenCalledTimes(2)
  expect((await pool.query('SELECT state,claim_epoch FROM memory_curation_runs')).rows).toEqual([{state:'completed',claim_epoch:'2'}])
 })
 test('AC-15 expired provider lease becomes unknown and never repeats the provider call',async()=>{
  const f=await fixture(),generate=vi.fn(async()=>{await pool.query("UPDATE memory_curation_runs SET claim_expires_at=clock_timestamp()-interval '1 second'");return success()})
  const w=worker({generateJson:generate} as TextGenerator)
  await w.consolidate(f.job,signal());await w.consolidate(f.job,signal())
  expect(generate).toHaveBeenCalledTimes(1)
  expect((await pool.query('SELECT state FROM memory_curation_runs')).rows[0].state).toBe('provider_result_unknown')
  expect((await pool.query('SELECT count(*)::int n FROM memory_source_processing_receipts WHERE complete')).rows[0].n).toBe(0)
 })
 test('AC-16 source change during provider call cannot commit old output',async()=>{
  const f=await fixture(),generate=vi.fn(async()=>{const payload={text:'changed body'};await pool.query('UPDATE source_events SET payload=$2,payload_hash=$3 WHERE source_event_id=$1',[f.id,payload,canonicalPayloadHash(payload)]);return success()})
  await expect(worker({generateJson:generate} as TextGenerator).consolidate(f.job,signal())).rejects.toThrow('curation_source_changed')
  expect((await pool.query("SELECT count(*)::int n FROM memory_curation_runs WHERE state='completed'")).rows[0].n).toBe(0)
  expect((await pool.query('SELECT state,error_code,result FROM memory_curation_runs')).rows).toEqual([{state:'failed',error_code:'curation_source_changed',result:null}])
  await expect(worker({generateJson:generate} as TextGenerator).consolidate(f.job,signal())).rejects.toThrow('curation_source_changed')
  expect(generate).toHaveBeenCalledTimes(1)
 })
 test('AC-15 semantic deadline closes without another model call or operational-success disguise',async()=>{
  const f=await fixture(),generate=vi.fn(async()=>success([{space_id:null,task_id:null,spans:[{event_id:f.id,start:0,end:f.payload.text.length}],conclusions:[]}]))
  const w=worker({generateJson:generate} as TextGenerator)
  await expect(w.consolidate(f.job,signal())).rejects.toThrow('source_not_ready')
  await pool.query("UPDATE memory_task_bundles SET semantic_deadline=clock_timestamp()-interval '1 second'")
  await w.consolidate(f.job,signal())
  expect(generate).toHaveBeenCalledTimes(1)
  expect((await pool.query('SELECT state FROM memory_task_bundles WHERE bundle_id=$1',[f.bundleId])).rows[0].state).toBe('skipped_unresolved')
 })
 test('AC-08 off and shadow preserve legacy extraction while enabled owns the source',async()=>{
  const f=await fixture()
  await pool.query("INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'transaction-fixture',NOW(),NOW())",[f.personal])
  await pool.query("UPDATE work_episodes SET compiled_at=NOW(),source_digest=sha256('fixture'),document='{}',evidence_manifest='{}' WHERE installation_id=$1",[f.personal])
  for(const mode of ['off','shadow'] as const)expect(await createExtractionRepository(pool,undefined,{lifecycleMode:mode}).loadEpisodeForExtraction(f.personal,'transaction-turn')).not.toBeNull()
  expect(await createExtractionRepository(pool,undefined,{lifecycleMode:'enabled'}).loadEpisodeForExtraction(f.personal,'transaction-turn')).toBeNull()
 })
 test('AC-24 overlapping consolidation owns one provider call',async()=>{
  const f=await fixture()
  let release!:()=>void,started!:()=>void
  const entered=new Promise<void>(r=>{started=r}),gate=new Promise<void>(r=>{release=r})
  const generate=vi.fn(async()=>{started();await gate;return success()})
  const w=worker({generateJson:generate} as TextGenerator),first=w.consolidate(f.job,signal())
  await entered
  try{await expect(w.consolidate(f.job,signal())).rejects.toThrow('source_not_ready')}
  finally{release()}
  await first;expect(generate).toHaveBeenCalledTimes(1)
 })
 test('AC-09 valid bounded conclusion stages a task candidate and keeps coverage incomplete until decision',async()=>{
  const f=await fixture(),space=randomUUID()
  await pool.query("INSERT INTO memory_spaces(installation_id,space_id,domain,name,destinations) VALUES($1,$2,'profile','preferences',ARRAY['personal'])",[f.personal,space])
  const generate=vi.fn(async()=>success([{space_id:space,task_id:null,spans:[{event_id:f.id,quote:f.payload.text}],conclusions:[{
   kind:'preference',assertion_mode:'user_asserted',subject:'self',predicate:'user.preference',value:'concise',conditions:{},fact_at:null,valid_until:null,statement:f.payload.text,confirmed:true,
   evidence:{subject:[f.id],predicate:[f.id],value:[f.id]},
  }]}]))
  await worker({generateJson:generate} as TextGenerator).consolidate(f.job,signal())
  expect((await pool.query("SELECT source_kind,status,statement FROM memory_candidates WHERE source_kind='task_bundle'")).rows).toEqual([{source_kind:'task_bundle',status:'validated',statement:f.payload.text}])
  expect((await pool.query('SELECT disposition,complete FROM memory_source_processing_receipts')).rows).toEqual([{disposition:'concluded',complete:false}])
  expect((await pool.query("SELECT count(*)::int n FROM memory_jobs WHERE job_type='curate_conclusions'")).rows[0].n).toBe(1)
 })
 test.each([false,true])('AC-15 rejected conclusions defer coverage with valid subset %s and close only at semantic deadline',async(validSubset)=>{
  const f=await fixture(),space=randomUUID()
  await pool.query("INSERT INTO memory_spaces(installation_id,space_id,domain,name,destinations) VALUES($1,$2,'profile','preferences',ARRAY['personal'])",[f.personal,space])
  const valid={kind:'preference',assertion_mode:'user_asserted',subject:'self',predicate:'user.preference',value:'concise',conditions:{},fact_at:null,valid_until:null,statement:f.payload.text,confirmed:true,evidence:{subject:[f.id],predicate:[f.id],value:[f.id]}}
  const generate=vi.fn(async()=>success([{space_id:space,task_id:null,spans:[{event_id:f.id,start:0,end:f.payload.text.length}],conclusions:[{...valid,value:'invented unsupported'},...(validSubset?[valid]:[])]}]))
  const w=worker({generateJson:generate} as TextGenerator)
  await expect(w.consolidate(f.job,signal())).rejects.toThrow('source_not_ready')
  expect((await pool.query('SELECT state,reason_code FROM memory_task_bundles WHERE bundle_id=$1',[f.bundleId])).rows[0]).toMatchObject({state:'deferred_semantic',reason_code:'conclusion_invalid'})
  expect((await pool.query('SELECT complete FROM memory_source_processing_receipts')).rows[0].complete).toBe(false)
  expect((await pool.query("SELECT count(*)::int n FROM memory_candidates WHERE source_kind='task_bundle'")).rows[0].n).toBe(validSubset?1:0)
  await pool.query("UPDATE memory_task_bundles SET semantic_deadline=clock_timestamp()-interval '1 second' WHERE bundle_id=$1",[f.bundleId])
  await w.consolidate(f.job,signal())
  expect(generate).toHaveBeenCalledTimes(1)
  expect((await pool.query('SELECT state FROM memory_task_bundles WHERE bundle_id=$1',[f.bundleId])).rows[0].state).toBe('skipped_unresolved')
  expect((await pool.query('SELECT complete FROM memory_source_processing_receipts')).rows[0].complete).toBe(!validSubset)
 })
})
