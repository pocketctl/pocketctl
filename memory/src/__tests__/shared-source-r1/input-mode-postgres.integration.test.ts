import {installNativeModeFixture} from './input-start-fixture.js'
import pg from 'pg'
import {afterAll,beforeAll,describe,expect,test,vi} from 'vitest'
import {applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {createMemoryPool} from '../../db.js'
import {createSourceProjector} from '../../projection/source-projector.js'
import {createInboxRepository} from '../../inbox/repository.js'
import {createSnapshotRepository} from '../../snapshot/repository.js'
const url=process.env.SHARED_R1_INPUT_TEST_DATABASE_URL,suite=url?describe:describe.skip
const inst='10000000-0000-0000-0000-000000000089'
suite('legacy source input generation fences',()=>{
 let pool:pg.Pool,runtime:pg.Pool
 beforeAll(async()=>{
  if(!url||!/(^|_)test$/.test(new URL(url).pathname.slice(1)))throw Error('isolated_test_required')
  pool=new pg.Pool({connectionString:url})
  await pool.query('DROP SCHEMA IF EXISTS memory CASCADE;DROP SCHEMA IF EXISTS shared CASCADE;DROP SCHEMA public CASCADE;CREATE SCHEMA public')
  await installNativeModeFixture(pool,[inst,'10000000-0000-0000-0000-000000000088'])
  await applyMemorySchema(pool,{namespace:'memory'});await applySharedSourceContract(pool)
  runtime=createMemoryPool({databaseUrl:url,databaseNamespace:'memory',dbPoolMax:3})
  await runtime.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[inst])
  await pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
 },60000)
 afterAll(async()=>{await runtime?.end();await pool?.end()})
 test('projector rejects paused/active input but shadow keeps the legacy transport',async()=>{
  const projector=createSourceProjector(runtime)
  await expect(projector.projectOnce(inst)).resolves.toEqual({projected:0})
  await pool.query("SELECT shared.transition_memory_source_mode($1,1,'paused')",[inst])
  await expect(projector.projectOnce(inst)).rejects.toThrow('legacy_source_input_disabled')
  await pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[inst])
  await expect(projector.projectOnce(inst)).rejects.toThrow('legacy_source_input_disabled')
  const ack=vi.fn(async()=>0)
  await expect(createInboxRepository(runtime).commitBatch({installationId:inst,envelopes:[],rawQuarantined:[],cursor:'synthetic',leaseToken:'synthetic',ack})).rejects.toThrow('legacy_source_input_disabled')
  expect(ack).not.toHaveBeenCalled()
  expect((await runtime.query('SELECT count(*)::int n FROM memory_inbox_checkpoints')).rows[0].n).toBe(0)
  await pool.query("SELECT shared.transition_memory_source_mode($1,3,'shared-shadow')",[inst])
  await expect(projector.projectOnce(inst)).resolves.toEqual({projected:0})
 })
 test('snapshot persists its original generation and rejects stale landing/finalize after pause and resume',async()=>{
  const repository=createSnapshotRepository(runtime),run=await repository.startRun(inst)
  expect((await runtime.query('SELECT source_mode_generation::text FROM memory_snapshot_runs WHERE run_id=$1',[run.runId])).rows[0].source_mode_generation).toBe('4')
  await pool.query("SELECT shared.transition_memory_source_mode($1,4,'paused')",[inst])
  await pool.query("SELECT shared.transition_memory_source_mode($1,5,'legacy-feed')",[inst])
  await expect(repository.persistSessionEvents(inst,run.generation,'session',[{event_id:'1',event_type:'agent_text',payload:{text:'never landed'},created_at:'2026-11-06T00:00:00Z'}])).rejects.toThrow('source_mode_generation_changed')
  await expect(repository.finalizeRun({installationId:inst,generation:run.generation,inventorySessionIds:[],sessionsSeen:0,eventsSeen:0})).rejects.toThrow('source_mode_generation_changed')
  expect((await runtime.query('SELECT count(*)::int n FROM memory_snapshot_events')).rows[0].n).toBe(0)
  expect((await runtime.query('SELECT state FROM memory_snapshot_runs WHERE run_id=$1',[run.runId])).rows[0].state).toBe('running')
 })
 test('mode transition cannot overtake an open legacy input transaction',async()=>{
  const client=await runtime.connect(),writer=await pool.connect()
  try{
   await client.query('BEGIN')
   expect((await client.query('SELECT shared.lock_memory_legacy_input($1,NULL)::text AS generation',[inst])).rows[0].generation).toBe('6')
   await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='100ms'")
   await expect(writer.query("SELECT shared.transition_memory_source_mode($1,6,'paused')",[inst])).rejects.toMatchObject({code:'55P03'})
   await writer.query('ROLLBACK');await client.query('COMMIT')
   await expect(writer.query("SELECT shared.transition_memory_source_mode($1,6,'paused')",[inst])).resolves.toBeTruthy()
  }finally{await writer.query('ROLLBACK');await client.query('ROLLBACK');writer.release();client.release()}
 })
 test('mode records cannot be deleted and recreated to revive a stale input generation',async()=>{
  const observed=(await pool.query('SELECT mode,generation::text FROM shared.memory_source_modes WHERE installation_id=$1',[inst])).rows[0]
  await expect(pool.query('DELETE FROM shared.memory_source_modes WHERE installation_id=$1',[inst])).rejects.toThrow('source_mode_record_is_durable')
  expect((await pool.query('SELECT mode,generation::text FROM shared.memory_source_modes WHERE installation_id=$1',[inst])).rows[0]).toEqual(observed)
  await expect(pool.query('UPDATE shared.memory_source_modes SET installation_id=$2 WHERE installation_id=$1',[inst,'10000000-0000-0000-0000-000000000087'])).rejects.toThrow('source_mode_identity_is_immutable')
  await expect(pool.query('INSERT INTO shared.memory_source_modes(installation_id,generation) VALUES($1,1)',[inst])).rejects.toMatchObject({code:'23505'})
  await expect(runtime.query('SELECT shared.lock_memory_legacy_input($1,1)',[inst])).rejects.toThrow('source_mode_generation_changed')
 })

 test('a committed canonical execution makes subsequent mode transitions forward-only',async()=>{
  const id='10000000-0000-0000-0000-000000000088'
  await pool.query("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[id])
  await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-active',2)",[id])
  const job=(await pool.query(`INSERT INTO memory.memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at)
   VALUES(gen_random_uuid(),$1,'project_shared_source','forward-only-mode',52,'running','forward-only-mode-worker',1,clock_timestamp()+interval '5 minutes') RETURNING job_id::text`,[id])).rows[0].job_id
  const execution=(await pool.query("SELECT shared.capture_memory_job_source($1,'forward-only-mode-worker',1,'canonical-active') AS execution",[job])).rows[0].execution
  // A positive port's physical commit establishes target authority even if
  // its response is lost. This does not charge or call a model.
  expect((await pool.query('SELECT shared.guard_memory_job_source_commit($1) AS valid',[execution.executionId])).rows[0].valid).toBe(true)
  await pool.query("SELECT shared.transition_memory_source_mode($1,2,'paused')",[id])
  for(const mode of ['legacy-feed','shared-shadow'])await expect(pool.query('SELECT shared.transition_memory_source_mode($1,3,$2)',[id,mode])).rejects.toThrow('source_mode_forward_only')
  expect((await pool.query('SELECT mode,generation::text FROM shared.memory_source_modes WHERE installation_id=$1',[id])).rows[0]).toEqual({mode:'paused',generation:'3'})
  expect((await pool.query("SELECT shared.assert_memory_job_source($1,'publish') AS valid",[execution.executionId])).rows[0].valid).toBe(false)
  expect((await pool.query("SELECT shared.transition_memory_source_mode($1,3,'shared-active')::text AS generation",[id])).rows[0].generation).toBe('4')
 })

 test('unsupported old from_now cannot cut over or allocate successful mode state; paused remains available',async()=>{
  const id='10000000-0000-0000-0000-000000000086',owner=(await pool.query("INSERT INTO public.users(email,password_hash) VALUES('old-from-now-mode@test.invalid','x') RETURNING id")).rows[0].id
  await pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_user_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory',$2,'active',ARRAY['session:events:read'],ARRAY['session.event.v1'],ARRAY['memory.manage'],'from_now')",[id,owner])
  const c=await pool.connect();try{await c.query('BEGIN');await c.query('ALTER TABLE public.native_installation_starts DISABLE TRIGGER native_input_immutable');await c.query('DELETE FROM public.native_installation_starts WHERE installation_id=$1',[id]);await c.query('ALTER TABLE public.native_installation_starts ENABLE TRIGGER native_input_immutable')
   for(const mode of ['shared-shadow','shared-active']){await c.query('SAVEPOINT rejected_input_start');await expect(c.query('SELECT shared.transition_memory_source_mode($1,1,$2)',[id,mode])).rejects.toThrow('source_input_start_unproven');await c.query('ROLLBACK TO SAVEPOINT rejected_input_start');expect((await c.query('SELECT count(*)::int n FROM shared.memory_source_modes WHERE installation_id=$1',[id])).rows[0].n).toBe(0)}
   expect((await c.query("SELECT shared.transition_memory_source_mode($1,1,'paused')::text generation",[id])).rows[0].generation).toBe('2')
  }finally{await c.query('ROLLBACK');c.release()}
 })

})
