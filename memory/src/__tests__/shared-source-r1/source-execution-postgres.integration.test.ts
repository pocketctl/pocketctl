import {installNativeModeFixture} from './input-start-fixture.js'
import pg from 'pg'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
const url=process.env.SHARED_R1_WORK_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('durable source execution generation and in-flight provider admission',()=>{
 let pool:pg.Pool
 const installation='10000000-0000-0000-0000-000000000094',job='20000000-0000-0000-0000-000000000094',epoch='9007199254740993'
 beforeAll(async()=>{
  if(!url||!/(^|_)test$/.test(new URL(url).pathname.slice(1)))throw Error('isolated_test_required')
  pool=new pg.Pool({connectionString:url,max:6})
  await pool.query('DROP SCHEMA IF EXISTS memory CASCADE;DROP SCHEMA IF EXISTS shared CASCADE;DROP SCHEMA public CASCADE;CREATE SCHEMA public')
  await installNativeModeFixture(pool,[installation])
  await applyMemorySchema(pool,{namespace:'memory'});await applySharedSourceContract(pool)
  await pool.query("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[installation])
  await pool.query("INSERT INTO memory.memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at) VALUES($1,$2,'extract_candidates','source-execution',85,'running','worker',$3::bigint,clock_timestamp()+interval '5 minutes')",[job,installation,epoch])
 },60000)
 afterAll(async()=>{await pool?.end()})
 const capture=async(branch:string)=>(await pool.query('SELECT shared.capture_memory_job_source($1,$2,$3::bigint,$4) AS execution',[job,'worker',epoch,branch])).rows[0].execution
 test('captures the original source generation, branch and exact bigint epoch once',async()=>{
  const first=await capture('legacy-active')
  expect(first).toMatchObject({installationId:installation,generation:'1',claimEpoch:epoch,branch:'legacy-active'})
  expect((await capture('legacy-active')).executionId).toBe(first.executionId)
  expect((await pool.query("SELECT shared.assert_memory_job_source($1,'publish') AS valid",[first.executionId])).rows[0].valid).toBe(true)
  await pool.query("SELECT shared.transition_memory_source_mode($1,1,'paused')",[installation])
  await pool.query("SELECT shared.transition_memory_source_mode($1,2,'legacy-feed')",[installation])
  expect((await pool.query("SELECT shared.assert_memory_job_source($1,'publish') AS valid",[first.executionId])).rows[0].valid).toBe(false)
  await expect(capture('legacy-active')).rejects.toThrow('source_execution_generation_changed')
 })
 test('canonical shadow cannot admit a provider or publish, while legacy active shadow may charge',async()=>{
  await pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
  await pool.query("SELECT shared.transition_memory_source_mode($1,3,'shared-shadow')",[installation])
  await pool.query('UPDATE memory.memory_jobs SET claim_epoch=claim_epoch+1 WHERE job_id=$1',[job])
  const next=async(branch:string)=>(await pool.query('SELECT shared.capture_memory_job_source($1,$2,$3::bigint,$4) AS execution',[job,'worker',(BigInt(epoch)+1n).toString(),branch])).rows[0].execution
  const legacy=await next('legacy-active')
  expect((await pool.query("SELECT shared.assert_memory_job_source($1,'provider') AS valid",[legacy.executionId])).rows[0].valid).toBe(true)
  // A separate actual queue claim owns the comparison branch.
  await pool.query('UPDATE memory.memory_jobs SET claim_epoch=claim_epoch+1 WHERE job_id=$1',[job])
  const shadow=(await pool.query("SELECT shared.capture_memory_job_source($1,'worker',$2::bigint,'canonical-shadow') AS execution",[job,(BigInt(epoch)+2n).toString()])).rows[0].execution
  for(const purpose of ['provider','publish'])expect((await pool.query('SELECT shared.assert_memory_job_source($1,$2) AS valid',[shadow.executionId,purpose])).rows[0].valid).toBe(false)
  expect((await pool.query("SELECT shared.assert_memory_job_source($1,'compare') AS valid",[shadow.executionId])).rows[0].valid).toBe(true)
  expect((await pool.query('SELECT shared.guard_memory_job_source_comparison($1) AS valid',[shadow.executionId])).rows[0].valid).toBe(true)
  expect((await pool.query('SELECT shared.guard_memory_job_source_commit($1) AS valid',[shadow.executionId])).rows[0].valid).toBe(false)
  const c=await pool.connect()
  try{
   await pool.query("UPDATE memory.memory_jobs SET claim_expires_at=clock_timestamp()+interval '0.2 seconds' WHERE job_id=$1",[job])
   await c.query('BEGIN')
   expect((await c.query('SELECT shared.guard_memory_job_source_comparison($1) AS valid',[shadow.executionId])).rows[0].valid).toBe(true)
   await c.query('SELECT pg_sleep(0.25)')
   await expect(c.query('COMMIT')).rejects.toMatchObject({code:'55000'})
  }finally{await c.query('ROLLBACK');c.release();await pool.query("UPDATE memory.memory_jobs SET claim_expires_at=clock_timestamp()+interval '5 minutes' WHERE job_id=$1",[job])}
 })
 test('in-flight requests block mode cutover; pausing still fences output and incurred accounting can finish',async()=>{
  await pool.query("SELECT shared.transition_memory_source_mode($1,4,'legacy-feed')",[installation])
  await pool.query('UPDATE memory.memory_jobs SET claim_epoch=claim_epoch+1 WHERE job_id=$1',[job])
  const execution=(await pool.query("SELECT shared.capture_memory_job_source($1,'worker',$2::bigint,'legacy-active') AS execution",[job,(BigInt(epoch)+3n).toString()])).rows[0].execution
  const reservation='30000000-0000-0000-0000-000000000094'
  await pool.query("INSERT INTO memory.memory_provider_budget_reservations(reservation_id,budget_key,provider_kind,reserved_input_tokens,reserved_output_tokens) VALUES($1,'synthetic-execution','text',100,100)",[reservation])
  expect((await pool.query('SELECT shared.start_memory_source_provider($1,$2,$3) AS admitted',[execution.executionId,reservation,'a'.repeat(64)])).rows[0].admitted).toBe(true)
  await expect(pool.query("SELECT shared.transition_memory_source_mode($1,5,'shared-active')",[installation])).rejects.toThrow('source_executions_not_drained')
  await pool.query("SELECT shared.transition_memory_source_mode($1,5,'paused')",[installation])
  expect((await pool.query("SELECT shared.assert_memory_job_source($1,'publish') AS valid",[execution.executionId])).rows[0].valid).toBe(false)
  // No current job/mode eligibility is required to preserve an incurred fact.
  expect((await pool.query("SELECT shared.finish_memory_source_provider($1,$2,'uncertain') AS recorded",[execution.executionId,reservation])).rows[0].recorded).toBe(true)
  await pool.query("SELECT shared.transition_memory_source_mode($1,6,'legacy-feed')",[installation])
  expect((await pool.query('SELECT shared.start_memory_source_provider($1,$2,$3) AS admitted',[execution.executionId,reservation,'a'.repeat(64)])).rows[0].admitted).toBe(false)
  expect((await pool.query('SELECT state FROM shared.memory_source_provider_attempts WHERE execution_id=$1',[execution.executionId])).rows).toEqual([{state:'uncertain'}])
 })
 test('a reclaimed job cannot admit the same reservation under a new execution or request hash',async()=>{
  await pool.query('UPDATE memory.memory_jobs SET claim_epoch=claim_epoch+1 WHERE job_id=$1',[job])
  const current=(await pool.query('SELECT claim_epoch::text FROM memory.memory_jobs WHERE job_id=$1',[job])).rows[0].claim_epoch
  const execution=(await pool.query("SELECT shared.capture_memory_job_source($1,'worker',$2::bigint,'legacy-active') AS execution",[job,current])).rows[0].execution
  const reservation='30000000-0000-0000-0000-000000000094'
  try{
   expect((await pool.query('SELECT shared.start_memory_source_provider($1,$2,$3) AS admitted',[execution.executionId,reservation,'c'.repeat(64)])).rows[0].admitted).toBe(false)
   expect((await pool.query('SELECT count(*)::int AS attempts FROM shared.memory_source_provider_attempts WHERE reservation_id=$1',[reservation])).rows[0].attempts).toBe(1)
  }finally{await pool.query("SELECT shared.finish_memory_source_provider($1,$2,'uncertain')",[execution.executionId,reservation])}
 })
 test('a stale repeatable-read snapshot cannot bypass in-flight drain admission',async()=>{
  await pool.query('UPDATE memory.memory_jobs SET claim_epoch=claim_epoch+1 WHERE job_id=$1',[job])
  const current=(await pool.query('SELECT claim_epoch::text FROM memory.memory_jobs WHERE job_id=$1',[job])).rows[0].claim_epoch
  const execution=(await pool.query("SELECT shared.capture_memory_job_source($1,'worker',$2::bigint,'legacy-active') AS execution",[job,current])).rows[0].execution
  const reservation='30000000-0000-0000-0000-000000000095',control=await pool.connect()
  try{
   await control.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
   await control.query('SELECT count(*) FROM shared.memory_source_provider_attempts')
   await pool.query("INSERT INTO memory.memory_provider_budget_reservations(reservation_id,budget_key,provider_kind,reserved_input_tokens,reserved_output_tokens) VALUES($1,'synthetic-drain-snapshot','text',100,100)",[reservation])
   expect((await pool.query('SELECT shared.start_memory_source_provider($1,$2,$3) AS admitted',[execution.executionId,reservation,'b'.repeat(64)])).rows[0].admitted).toBe(true)
   const refused=await control.query("SELECT shared.transition_memory_source_mode($1,7,'shared-active')",[installation]).then(()=>false,error=>error.message==='source_execution_requires_read_committed')
   expect(refused).toBe(true)
  }finally{await control.query('ROLLBACK');control.release();await pool.query("SELECT shared.finish_memory_source_provider($1,$2,'uncertain')",[execution.executionId,reservation])}
 })
 test.each(['capture','provider','publish'] as const)('%s admission rechecks the lease at physical commit',async purpose=>{
  await pool.query("UPDATE memory.memory_jobs SET claim_epoch=claim_epoch+1,claim_expires_at=clock_timestamp()+interval '500 milliseconds' WHERE job_id=$1",[job])
  const current=(await pool.query('SELECT claim_epoch::text FROM memory.memory_jobs WHERE job_id=$1',[job])).rows[0].claim_epoch
  const client=await pool.connect();let executionId:string|undefined,reservation:string|undefined
  try{
   if(purpose!=='capture'){
    executionId=(await pool.query("SELECT shared.capture_memory_job_source($1,'worker',$2::bigint,'legacy-active') AS execution",[job,current])).rows[0].execution.executionId
   }
   if(purpose==='provider'){
    reservation=(await pool.query("INSERT INTO memory.memory_provider_budget_reservations(reservation_id,budget_key,provider_kind,reserved_input_tokens,reserved_output_tokens) VALUES(gen_random_uuid(),'synthetic-commit-clock','text',100,100) RETURNING reservation_id::text")).rows[0].reservation_id
   }
   await client.query('BEGIN')
   if(purpose==='capture')executionId=(await client.query("SELECT shared.capture_memory_job_source($1,'worker',$2::bigint,'legacy-active') AS execution",[job,current])).rows[0].execution.executionId
   else if(purpose==='provider')expect((await client.query('SELECT shared.start_memory_source_provider($1,$2,$3) AS admitted',[executionId,reservation,'d'.repeat(64)])).rows[0].admitted).toBe(true)
   else expect((await client.query('SELECT shared.guard_memory_job_source_commit($1) AS admitted',[executionId])).rows[0].admitted).toBe(true)
   await client.query('SELECT pg_sleep(0.6)')
   const refused=await client.query('COMMIT').then(()=>false,error=>error.message==='source_execution_generation_changed')
   expect(refused).toBe(true)
   if(purpose==='capture')expect((await pool.query('SELECT 1 FROM shared.memory_source_executions WHERE execution_id=$1',[executionId])).rowCount).toBe(0)
   else if(purpose==='provider')expect((await pool.query('SELECT 1 FROM shared.memory_source_provider_attempts WHERE reservation_id=$1',[reservation])).rowCount).toBe(0)
   else expect((await pool.query('SELECT last_guarded_at FROM shared.memory_source_executions WHERE execution_id=$1',[executionId])).rows[0].last_guarded_at).toBeNull()
  }finally{
   await client.query('ROLLBACK');client.release()
   await pool.query("UPDATE memory.memory_jobs SET claim_expires_at=clock_timestamp()+interval '5 minutes' WHERE job_id=$1",[job])
   if(reservation)await pool.query("SELECT shared.finish_memory_source_provider($1,$2,'uncertain')",[executionId,reservation])
  }
 })
 test('an original control revision fences provider/output commits but never incurred accounting',async()=>{
  await pool.query("UPDATE memory.memory_jobs SET claim_epoch=claim_epoch+1,claim_expires_at=clock_timestamp()+interval '5 minutes' WHERE job_id=$1",[job])
  const current=(await pool.query('SELECT claim_epoch::text FROM memory.memory_jobs WHERE job_id=$1',[job])).rows[0].claim_epoch
  const execution=(await pool.query("SELECT shared.capture_memory_job_source($1,'worker',$2::bigint,'legacy-active') AS execution",[job,current])).rows[0].execution
  const before=(await pool.query('SELECT shared.memory_source_control_snapshot() AS revision')).rows[0].revision
  expect(execution.controlRevision).toBe(before)
  const reservation=(await pool.query("INSERT INTO memory.memory_provider_budget_reservations(reservation_id,budget_key,provider_kind,reserved_input_tokens,reserved_output_tokens) VALUES(gen_random_uuid(),'control-version','text',100,100) RETURNING reservation_id::text")).rows[0].reservation_id
  expect((await pool.query('SELECT shared.start_memory_source_provider($1,$2,$3) AS valid',[execution.executionId,reservation,'e'.repeat(64)])).rows[0].valid).toBe(true)
  const client=await pool.connect()
  try{
   await client.query('BEGIN')
   expect((await client.query('SELECT shared.guard_memory_job_source_commit($1) AS valid',[execution.executionId])).rows[0].valid).toBe(true)
   // The global clock is not held through the derived transaction: this
   // native control commit succeeds, then the deferred final check refuses us.
   await pool.query("SELECT shared.mark_memory_control_dirty('provider','pocketctl-memory')")
   await expect(client.query('COMMIT')).rejects.toThrow('source_execution_generation_changed')
   expect((await pool.query("SELECT shared.assert_memory_job_source($1,'provider') AS valid",[execution.executionId])).rows[0].valid).toBe(false)
   await expect(pool.query("SELECT shared.capture_memory_job_source($1,'worker',$2::bigint,'legacy-active')",[job,current])).rejects.toThrow('source_execution_generation_changed')
   expect((await pool.query("SELECT shared.finish_memory_source_provider($1,$2,'accounted') AS valid",[execution.executionId,reservation])).rows[0].valid).toBe(true)
   expect((await pool.query('SELECT control_revision::text FROM shared.memory_source_executions WHERE execution_id=$1',[execution.executionId])).rows[0].control_revision).toBe(before)
  }finally{await client.query('ROLLBACK');client.release()}
 })
 test('an unknown execution contract refuses Memory DDL before replacing functions',async()=>{
  expect((await pool.query("SELECT to_jsonb(c)->>'execution_version' AS execution_version FROM shared.memory_source_contract c")).rows[0].execution_version).toBe('1')
  const definition=async()=>(await pool.query("SELECT md5(pg_get_functiondef('shared.assert_memory_job_source(uuid,text)'::regprocedure)) AS digest")).rows[0].digest
  const before=await definition()
  await pool.query('UPDATE shared.memory_source_contract SET execution_version=2')
  try{
   await expect(applySharedSourceContract(pool)).rejects.toThrow('unsupported_shared_execution_contract')
   await expect(applyMemorySchema(pool,{namespace:'memory'})).rejects.toThrow('unsupported_shared_execution_contract')
   expect(await definition()).toBe(before)
  }finally{await pool.query('UPDATE shared.memory_source_contract SET execution_version=1')}
 })
})
