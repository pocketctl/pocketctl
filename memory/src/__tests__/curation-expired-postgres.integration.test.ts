import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {beforeAll,beforeEach,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {directLaunchFixture,type DirectLaunchFixture} from './shared-source-r1/direct-launch-fixture.js'
import {lifecycleStatus} from '../curation/status.js'
import {reconcileExpiredCurationRuns} from '../curation/reconcile-expired.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('expired curation reconciliation',()=>{
 let pool:pg.Pool
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE');await pool.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)`,[id])})
 afterAll(async()=>{await pool?.end()})
 async function fixture(jobState='dead',lease='-1 hour',revision=1){
  const job=randomUUID(),bundle=randomUUID(),run=randomUUID()
  await pool.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,state,attempts) VALUES($1::uuid,$2,'consolidate_task',$1::text,$3,12)`,[job,id,jobState])
  await pool.query(`INSERT INTO memory_task_bundles(installation_id,bundle_id,session_id,task_key,source_digest,watermark,state,revision) VALUES($1,$2::uuid,'s',$2::text,decode(repeat('aa',32),'hex'),1,'running',$3)`,[id,bundle,revision])
  await pool.query(`INSERT INTO memory_curation_runs(installation_id,run_id,bundle_id,bundle_revision,source_digest,policy_revision,policy_hash,model_config_hash,mode,state,claimed_by,claim_expires_at,input_tokens,output_tokens) VALUES($1,$2,$3,1,decode(repeat('aa',32),'hex'),1,repeat('a',64),repeat('b',64),'enabled','running',$4,now()+$5::interval,2157,190)`,[id,run,bundle,job,lease])
  return {job,bundle,run}
 }
 async function state(run:string){return (await pool.query('SELECT state,error_code,input_tokens::int,output_tokens::int,result FROM memory_curation_runs WHERE run_id=$1',[run])).rows[0]}
 test('terminal job plus expired lease becomes unknown exactly once, preserving usage and absence of result',async()=>{
  const x=await fixture();expect(await reconcileExpiredCurationRuns(pool)).toBe(1)
  expect(await state(x.run)).toMatchObject({state:'provider_result_unknown',error_code:'lease_expired',input_tokens:2157,output_tokens:190,result:null})
  expect((await pool.query('SELECT state,reason_code FROM memory_task_bundles WHERE bundle_id=$1',[x.bundle])).rows[0]).toEqual({state:'blocked',reason_code:'provider_result_unknown'})
  expect(await reconcileExpiredCurationRuns(pool)).toBe(0)
  expect((await pool.query('SELECT state FROM memory_jobs WHERE job_id=$1',[x.job])).rows[0].state).toBe('dead')
 })
 test('an interrupted publication with a durable response marker cannot revert to unknown provider effect',async()=>{
  const x=await fixture()
  await pool.query("UPDATE memory_curation_runs SET error_code='provider_response_received' WHERE run_id=$1",[x.run])
  expect(await reconcileExpiredCurationRuns(pool)).toBe(1)
  expect(await state(x.run)).toMatchObject({state:'failed',error_code:'publication_interrupted',result:null})
  expect(await reconcileExpiredCurationRuns(pool)).toBe(0)
 })
 test('an explicitly uncertain attempt with a partial charge still needs provider reconciliation',async()=>{
  const x=await fixture()
  await pool.query("UPDATE memory_curation_runs SET error_code='provider_response_uncertain' WHERE run_id=$1",[x.run])
  await pool.query(`INSERT INTO memory_usage_outbox(installation_id,usage_id,operation,model,input_tokens,output_tokens,occurred_at)
   VALUES($1,$2,'curation','synthetic',2157,190,now())`,[id,'curation:'+x.run])
  expect(await reconcileExpiredCurationRuns(pool)).toBe(1)
  const status=await lifecycleStatus(pool,id,'enabled')
  expect(status.records[0]).toMatchObject({run_state:'provider_result_unknown',accounting_state:'recorded',publication_state:'not_published',
   waiting_for:'provider_reconciliation',automatic_model_retry:false})
 })
 test('legacy expiry exposes the exact reported charge without inventing a publication cause',async()=>{
  const x=await fixture()
  await pool.query("UPDATE memory_curation_runs SET state='provider_result_unknown',error_code='lease_expired' WHERE run_id=$1",[x.run])
  await pool.query(`INSERT INTO memory_usage_outbox(installation_id,usage_id,operation,model,input_tokens,output_tokens,occurred_at,reported_at)
   VALUES($1,$2,'curation','synthetic',2157,190,now(),now())`,[id,'curation:'+x.run])
  const status=await lifecycleStatus(pool,id,'enabled')
  expect(status.records[0]).toMatchObject({run_state:'provider_result_unknown',accounting_state:'reported',publication_state:'not_published',
   publication_reason:'unknown',source_stage:null,source_reason:null,waiting_for:'publication_reconciliation',automatic_model_retry:false})
 })
 test('live or retryable job and unexpired run are not reconciled',async()=>{
  for(const state of ['pending','running'])await fixture(state)
  await fixture('dead','1 hour');expect(await reconcileExpiredCurationRuns(pool)).toBe(0)
 })
 test('superseded bundle is not blocked by its older orphan run',async()=>{
  const x=await fixture('dead','-1 hour',2);expect(await reconcileExpiredCurationRuns(pool)).toBe(1)
  expect((await pool.query('SELECT state,revision::int FROM memory_task_bundles WHERE bundle_id=$1',[x.bundle])).rows[0]).toEqual({state:'running',revision:2})
  expect((await lifecycleStatus(pool,id,'enabled')).records[0]).toMatchObject({run_id:null,publication_state:'unknown'})
 })
 test('another live run for the same bundle revision preserves the bundle state',async()=>{
  const x=await fixture()
  await pool.query(`INSERT INTO memory_curation_runs(installation_id,run_id,bundle_id,bundle_revision,source_digest,policy_revision,policy_hash,model_config_hash,mode,state,claim_expires_at) SELECT installation_id,gen_random_uuid(),bundle_id,bundle_revision,source_digest,2,repeat('c',64),model_config_hash,mode,'running',now()+interval '1 hour' FROM memory_curation_runs WHERE run_id=$1`,[x.run])
  expect(await reconcileExpiredCurationRuns(pool)).toBe(1)
  expect((await pool.query('SELECT state FROM memory_task_bundles WHERE bundle_id=$1',[x.bundle])).rows[0].state).toBe('running')
 })
 test('locked dead owner is skipped, then recovered after the lock is released',async()=>{
  const x=await fixture(),locker=await pool.connect()
  try{await locker.query('BEGIN');await locker.query('SELECT 1 FROM memory_jobs WHERE job_id=$1 FOR UPDATE',[x.job]);expect(await reconcileExpiredCurationRuns(pool)).toBe(0);expect((await state(x.run)).state).toBe('running')}
  finally{await locker.query('ROLLBACK');locker.release()}
  expect(await reconcileExpiredCurationRuns(pool)).toBe(1)
 })
 test('a foreign installation job cannot authorize reconciliation',async()=>{
  const x=await fixture(),other=randomUUID()
  await pool.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)`,[other])
  await pool.query('UPDATE memory_jobs SET installation_id=$1 WHERE job_id=$2',[other,x.job])
  expect(await reconcileExpiredCurationRuns(pool)).toBe(0);expect((await state(x.run)).state).toBe('running')
 })
 test('concurrent reconcilers converge without duplicate transitions',async()=>{
  await fixture();expect((await Promise.all([reconcileExpiredCurationRuns(pool),reconcileExpiredCurationRuns(pool)])).reduce((a,b)=>a+b,0)).toBe(1)
 })
})

const sharedUrl=process.env.DIRECT_LAUNCH_MEMORY_TEST_DATABASE_URL
;(sharedUrl?describe:describe.skip)('expired curation with production shared namespace privileges',()=>{
 let f:DirectLaunchFixture
 beforeAll(async()=>{f=await directLaunchFixture(sharedUrl!)},60000)
 afterAll(async()=>{await f?.close()})
 test('runtime role can restrict orphan state without source authority grants',async()=>{
  const source=await f.source(),{inst}=await f.install(source,'retained_history'),id=inst.installation_id,job=randomUUID(),bundle=randomUUID()
  await f.runtime.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,state,attempts) VALUES($1::uuid,$2,'consolidate_task',$1::text,'dead',12)`,[job,id])
  await f.runtime.query(`INSERT INTO memory_task_bundles(installation_id,bundle_id,session_id,task_key,source_digest,watermark,state) VALUES($1,$2::uuid,$3,$2::text,decode(repeat('aa',32),'hex'),1,'running')`,[id,bundle,source.session])
  await f.runtime.query(`INSERT INTO memory_curation_runs(installation_id,bundle_id,bundle_revision,source_digest,policy_revision,policy_hash,model_config_hash,mode,state,claimed_by,claim_expires_at,input_tokens,output_tokens) VALUES($1,$2,1,decode(repeat('aa',32),'hex'),1,repeat('a',64),repeat('b',64),'enabled','running',$3,now()-interval '1 hour',2157,190)`,[id,bundle,job])
  expect(await reconcileExpiredCurationRuns(f.runtime)).toBe(1)
  expect((await f.runtime.query('SELECT state,input_tokens::int FROM memory_curation_runs WHERE bundle_id=$1',[bundle])).rows[0]).toEqual({state:'provider_result_unknown',input_tokens:2157})
  await f.runtime.query(`INSERT INTO memory_usage_outbox(installation_id,usage_id,operation,model,input_tokens,output_tokens,occurred_at,reported_at)
   SELECT installation_id,'curation:'||run_id::text,'curation','synthetic',input_tokens,output_tokens,now(),now()
   FROM memory_curation_runs WHERE installation_id=$1 AND bundle_id=$2`,[id,bundle])
  expect((await lifecycleStatus(f.runtime,id,'enabled')).records.find(r=>r.bundle_id===bundle)).toMatchObject({
   run_state:'provider_result_unknown',accounting_state:'reported',run_result_state:'not_committed',publication_state:'not_published',publication_reason:'unknown',
   input_tokens:2157,output_tokens:190,automatic_model_retry:false})
  expect((await f.pool.query("SELECT has_table_privilege('direct_launch_memory','shared.memory_source_work','SELECT') allowed")).rows[0].allowed).toBe(false)
 })
})
