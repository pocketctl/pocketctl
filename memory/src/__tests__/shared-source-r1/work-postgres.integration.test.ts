import {installNativeModeFixture} from './input-start-fixture.js'
import pg from 'pg'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import type {SourceWorkClaim,SourceSqlClient} from '@pocketctl/session-source'
import {enqueueSourceWork,claimSourceWork,completeSourceWork,failSourceWork} from '../../sources/shared-work.js'
const url=process.env.SHARED_R1_WORK_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('durable body-free roots and revision leases',()=>{
 let pool:pg.Pool
 const complete=(claim:SourceWorkClaim,commit:(c:SourceSqlClient)=>Promise<void>)=>completeSourceWork(pool,claim,async()=>{},commit)
 beforeAll(async()=>{
  if(!url || !/(^|_)test$/.test(new URL(url).pathname.slice(1)))throw Error('isolated_test_required')
  pool=new pg.Pool({connectionString:url,max:8});await pool.query('DROP SCHEMA IF EXISTS memory CASCADE; DROP SCHEMA IF EXISTS shared CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await installNativeModeFixture(pool,['90000000-0000-0000-0000-000000000001'])
  await applyMemorySchema(pool,{namespace:'memory'});await applySharedSourceContract(pool)
  await pool.query('CREATE TABLE memory.reader_test_outputs(id text PRIMARY KEY)')
 },60000)
 afterAll(async()=>{await pool?.end()})
 test('claims are exclusive; completing r retains a newer revision',async()=>{
  await enqueueSourceWork(pool,{kind:'relay_event',key:'root-1'})
  const [a,b]=await Promise.all([claimSourceWork(pool,'worker-a',30,1),claimSourceWork(pool,'worker-b',30,1)])
  expect(a.length+b.length).toBe(1);const claim=[...a,...b][0]
  await enqueueSourceWork(pool,{kind:'relay_event',key:'root-1'})
  await complete(claim,async c=>{await c.query("INSERT INTO memory.reader_test_outputs VALUES('revision-1')")})
  const state=(await pool.query("SELECT revision::text,processed_revision::text,lease_token FROM shared.memory_source_work WHERE root_key='root-1'")).rows[0]
  expect(state).toEqual({revision:'2',processed_revision:'1',lease_token:null})
  const next=(await claimSourceWork(pool,'worker-next',30,1))[0];expect(next.claimedRevision).toBe('2')
  await complete(next,async()=>{})
 })
 test('crash/rollback/expired token recover without allowing the old worker to commit',async()=>{
  await enqueueSourceWork(pool,{kind:'relay_event',key:'crash-root'})
  const old=(await claimSourceWork(pool,'crashed-worker',30,1))[0]
  await expect(complete(old,async c=>{await c.query("INSERT INTO memory.reader_test_outputs VALUES('rolled-back')");throw Error('crash')})).rejects.toThrow('crash')
  expect((await pool.query("SELECT count(*)::int n FROM memory.reader_test_outputs WHERE id='rolled-back'")).rows[0].n).toBe(0)
  await pool.query("UPDATE shared.memory_source_work SET lease_until=clock_timestamp()-interval '1 second' WHERE root_key='crash-root'")
  const replacement=(await claimSourceWork(pool,'replacement-worker',30,1))[0]
  await expect(complete(old,async()=>{})).rejects.toThrow('source_lease_lost')
  await complete(replacement,async()=>{})
 })
 test('unknown provider result is terminal, temporary errors back off, arbitrary error text is rejected',async()=>{
  await enqueueSourceWork(pool,{kind:'relay_event',key:'uncertain-root'})
  const claim=(await claimSourceWork(pool,'worker',30,1))[0]
  await expect(failSourceWork(pool,claim,'credential=private' as any)).rejects.toThrow('invalid_source_error_code')
  await failSourceWork(pool,claim,'provider_result_unknown')
  expect((await pool.query("SELECT dead_at IS NOT NULL AS dead,last_error_code FROM shared.memory_source_work WHERE root_key='uncertain-root'")).rows[0]).toEqual({dead:true,last_error_code:'provider_result_unknown'})
  expect(await claimSourceWork(pool,'worker',30,1)).toHaveLength(0)
  await enqueueSourceWork(pool,{kind:'relay_event',key:'uncertain-root'})
  expect(await claimSourceWork(pool,'worker',30,1)).toHaveLength(0)
 })
 test('temporary failures back off and exhausted crash retries terminate',async()=>{
  await enqueueSourceWork(pool,{kind:'relay_event',key:'temporary-root'})
  const claim=(await claimSourceWork(pool,'worker',30,1))[0]
  await failSourceWork(pool,claim,'temporary_unavailable')
  expect((await pool.query("SELECT available_at>clock_timestamp() AS delayed,dead_at FROM shared.memory_source_work WHERE root_key='temporary-root'")).rows[0]).toEqual({delayed:true,dead_at:null})
  await pool.query("UPDATE shared.memory_source_work SET attempt=32,available_at=clock_timestamp() WHERE root_key='temporary-root'")
  expect(await claimSourceWork(pool,'worker',30,1)).toHaveLength(0)
  expect((await pool.query("SELECT last_error_code,dead_at IS NOT NULL AS dead FROM shared.memory_source_work WHERE root_key='temporary-root'")).rows[0]).toEqual({last_error_code:'retry_exhausted',dead:true})
 })
 test('source modes require activation readiness and CAS; shadow cannot advance active progress',async()=>{
  const id='90000000-0000-0000-0000-000000000001'
  await expect(pool.query("SELECT shared.transition_memory_source_mode($1,1,'shared-active')",[id])).rejects.toThrow('source_activation_not_ready')
  await pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
  expect((await pool.query("SELECT shared.transition_memory_source_mode($1,1,'shared-shadow')::text AS generation",[id])).rows[0].generation).toBe('2')
  await expect(pool.query("SELECT shared.transition_memory_source_mode($1,1,'shared-active')",[id])).rejects.toThrow('source_mode_generation_changed')
  await expect(pool.query("SELECT shared.record_memory_source_dispatch($1,2,'relay_event','root-1',1,1,1)",[id])).rejects.toThrow('source_mode_generation_changed')
  await pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[id])
  await pool.query("SELECT shared.record_memory_source_dispatch($1,3,'relay_event','root-1',1,1,1)",[id])
  expect((await pool.query('SELECT mode_generation::text,dispatched_revision::text FROM shared.memory_source_progress WHERE installation_id=$1',[id])).rows[0]).toEqual({mode_generation:'3',dispatched_revision:'1'})
  await pool.query("SELECT shared.transition_memory_source_mode($1,3,'paused')",[id])
  await expect(pool.query("SELECT shared.record_memory_source_dispatch($1,3,'relay_event','root-1',2,1,1)",[id])).rejects.toThrow('source_mode_generation_changed')
  await pool.query('UPDATE shared.memory_source_contract SET activation_ready=FALSE')
 })
 test('authority fences are acquired before the root lease lock, avoiding a publisher/worker deadlock',async()=>{
  await enqueueSourceWork(pool,{kind:'relay_event',key:'lock-order-root'})
  const claim=(await claimSourceWork(pool,'lock-worker',30,1))[0]
  const publisher=await pool.connect();await publisher.query('BEGIN');await publisher.query('SELECT pg_advisory_xact_lock(31337,1)')
  const completion=completeSourceWork(pool,claim,async c=>{await c.query('SELECT pg_advisory_xact_lock(31337,1)')},async c=>{await c.query("INSERT INTO memory.reader_test_outputs VALUES('ordered-locks')")})
  try{
   for(let i=0;i<200;i++){
    const waiting=(await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query='SELECT pg_advisory_xact_lock(31337,1)'")).rows[0].n
    if(waiting)break
    if(i===199)throw Error('worker_guard_wait_not_observed')
    await new Promise(r=>setTimeout(r,10))
   }
   await publisher.query("SET LOCAL lock_timeout='1s'")
   await enqueueSourceWork(publisher,{kind:'relay_event',key:'lock-order-root'})
   await publisher.query('COMMIT');await completion
   expect((await pool.query("SELECT revision::text,processed_revision::text FROM shared.memory_source_work WHERE root_key='lock-order-root'")).rows[0]).toEqual({revision:'2',processed_revision:'1'})
  }finally{await publisher.query('ROLLBACK');publisher.release();await completion.catch(()=>undefined)}
  const next=(await claimSourceWork(pool,'lock-worker',30,1))[0];await complete(next,async()=>{})
 })
 test('root lease upgrade never waits while a final reader holds a shared root fence',async()=>{
  const root={kind:'relay_event' as const,key:'upgrade-conflict'}
  await enqueueSourceWork(pool,root)
  const claim=(await claimSourceWork(pool,'upgrade-worker',30,256)).find(c=>c.rootKey===root.key)!
  const reader=await pool.connect(),worker=await pool.connect()
  try{
   await reader.query('BEGIN');await reader.query('SELECT 1 FROM shared.memory_source_work WHERE source_kind=$1 AND root_key=$2 FOR SHARE',[root.kind,root.key])
   await worker.query('BEGIN');await worker.query("SET LOCAL lock_timeout='100ms'")
   const params=[claim.kind,claim.rootKey,claim.token,claim.workerId,claim.claimedRevision]
   await expect(worker.query('SELECT shared.assert_memory_source_lease($1,$2,$3,$4,$5) AS owned',params)).rejects.toMatchObject({code:'55P03'})
   // Typed contention aborts this metadata transaction; release before retry.
   await worker.query('ROLLBACK');await reader.query('COMMIT')
   await complete(claim,async()=>{})
  }finally{await worker.query('ROLLBACK');await reader.query('ROLLBACK');worker.release();reader.release()}
 })
 test('late committed roots remain claimable after another root completed',async()=>{
  const late=await pool.connect();await late.query('BEGIN');await enqueueSourceWork(late,{kind:'relay_event',key:'late-root'})
  await enqueueSourceWork(pool,{kind:'relay_event',key:'early-root'})
  const first=(await claimSourceWork(pool,'worker',30,1))[0];expect(first.rootKey).toBe('early-root');await complete(first,async()=>{})
  await late.query('COMMIT');late.release()
  const second=(await claimSourceWork(pool,'worker',30,1))[0];expect(second.rootKey).toBe('late-root');await complete(second,async()=>{})
 })
 test('dirty age survives lease polling and an r+1 arrival, then restarts only after catch-up',async()=>{
  const root={kind:'relay_event' as const,key:'dirty-age-proof'}
  await enqueueSourceWork(pool,root)
  await pool.query("UPDATE shared.memory_source_work SET dirty_since='2020-01-01T00:00:00Z' WHERE root_key=$1",[root.key])
  const read=async()=>(await pool.query('SELECT dirty_since::text AS since,processed_revision::text,revision::text FROM shared.memory_source_work WHERE root_key=$1',[root.key])).rows[0]
  const initial=await read(),claim=(await claimSourceWork(pool,'age-proof',30,256)).find(c=>c.rootKey===root.key)!
  expect((await read()).since).toBe(initial.since)
  await enqueueSourceWork(pool,root)
  await complete(claim,async()=>{})
  expect(await read()).toMatchObject({since:initial.since,processed_revision:'1',revision:'2'})
  const next=(await claimSourceWork(pool,'age-proof',30,256)).find(c=>c.rootKey===root.key)!
  await complete(next,async()=>{})
  expect((await read()).since).toBeNull()
  await enqueueSourceWork(pool,root)
  expect(new Date((await read()).since).getTime()).toBeGreaterThan(new Date(initial.since).getTime())
 })

})
