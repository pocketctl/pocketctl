import {planSourceProjectionRepair,applySourceProjectionRepair} from '../../maintenance/repair-source-projections.js'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {createSharedSourceScheduler} from '../../sources/shared-scheduler.js'
import {createJobRepository} from '../../jobs/repository.js'
import {createJobWorker} from '../../jobs/worker.js'
import {createCanonicalProjectionHandler} from '../../sources/canonical-projection-worker.js'
import {createEpisodeRepository} from '../../episodes/repository.js'
import {observeProjectionCommits} from './helpers/projection-commit-observer.js'
import {loadBusinessHealth,evaluateBusinessHealth} from '../../reporting/business-health.js'

const url=process.env.PROCESSING_RECOVERY_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('quiet expired roots recover through the actual deterministic worker',()=>{
 let f:DirectLaunchFixture
 beforeAll(async()=>{f=await directLaunchFixture(url!)},60000)
 afterAll(async()=>{await f?.close()})
 test('projects and compiles without new activity or renewed purge protection',async()=>{
  const source=await f.source(),inst=(await f.install(source,'retained_history')).inst.installation_id
  await f.event(source);await f.event(source,true)
  await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[inst])
  await f.pool.query(`INSERT INTO shared.memory_source_processing_windows(owner_user_id,session_id,activity_epoch,business_activity_at,started_at,hard_deadline)
   SELECT user_id,session_id,activity_epoch,last_business_activity_at,t.stamp-interval '3 minutes',t.stamp-interval '1 minute'
   FROM public.sessions CROSS JOIN(SELECT clock_timestamp() AS stamp)t WHERE session_id=$1`,[source.session])
  const signal=new AbortController().signal,errors:unknown[]=[]
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'expired-root-scheduler',signal,onError:e=>errors.push(e)})
  const queue=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'expired-root-worker',signal,onError:e=>errors.push(e)})
  queue.register('project_shared_source',createCanonicalProjectionHandler(f.runtime,{pageSize:1,stabilizationMs:0}),{branch:'canonical'})
  queue.register('compile_episode',createEpisodeRepository(f.runtime,{stabilizationMs:0}).handleCompileEpisode)
  // Freeze and recover a deterministic dead projection, including refusal of
  // source drift. This exercises the production repair API with the app role.
  let projection:string|undefined
  for(let n=0;n<50&&!projection;n++){
   await scheduler.runOnce()
   projection=(await f.runtime.query("SELECT job_id FROM memory_jobs WHERE installation_id=$1 AND job_type='project_shared_source' LIMIT 1",[inst])).rows[0]?.job_id
  }
  expect(projection).toBeTruthy()
  await f.pool.query("UPDATE memory.memory_jobs SET state='dead',attempts=10,last_error_code='processing_pin_expired_or_unavailable',completed_at=clock_timestamp() WHERE job_id=$1",[projection])
  const planner=await f.runtime.connect()
  await planner.query('BEGIN READ ONLY')
  const manifest=await planSourceProjectionRepair(planner,[projection!])
  await planner.query('COMMIT');planner.release()
  await f.event(source)
  const repair=await f.runtime.connect()
  try{
   await repair.query('BEGIN')
   await expect(applySourceProjectionRepair(repair,manifest)).rejects.toThrow('source_repair_source_changed')
   await repair.query('ROLLBACK')
   const fresh=await planSourceProjectionRepair(repair,[projection!])
   await repair.query('BEGIN')
   expect(await applySourceProjectionRepair(repair,fresh)).toEqual([{jobId:projection,state:'requeued'}])
   await repair.query('COMMIT')
   await repair.query('BEGIN')
   expect(await applySourceProjectionRepair(repair,fresh)).toEqual([{jobId:projection,state:'already_resumed'}])
   await repair.query('COMMIT')
  }finally{await repair.query('ROLLBACK').catch(()=>undefined);repair.release()}
  let observedUnprotected=false
  const closeObserver=observeProjectionCommits(f.runtime,async event=>{
   if(event.installationId!==inst)return
   const leases=(await f.pool.query('SELECT blocks_purge FROM shared.memory_source_processing_pins WHERE installation_id=$1',[inst])).rows
   expect(leases.length).toBeGreaterThan(0)
   expect(leases.every(p=>p.blocks_purge===false)).toBe(true)
   expect((await f.publisher.query('SELECT shared.memory_source_processing_blocks_purge($1,$2::text[]) AS blocked',[source.owner,[source.session]])).rows[0].blocked).toBe(false)
   observedUnprotected=true
  },errors)
  try{
   let complete=false
   for(let n=0;n<100;n++){
    await scheduler.runOnce();await queue.tick()
    if(errors.length)throw errors[0]
    const progress=(await f.pool.query('SELECT processed_revision=dispatched_revision AND dispatched_revision>0 AS caught FROM shared.memory_source_progress WHERE installation_id=$1',[inst])).rows
    const compiled=(await f.runtime.query("SELECT 1 FROM memory_jobs WHERE installation_id=$1 AND job_type='compile_episode' AND state='completed'",[inst])).rowCount
    if(progress.length&&progress.every(p=>p.caught)&&compiled){complete=true;break}
    await new Promise(resolve=>setTimeout(resolve,30))
   }
   expect(complete).toBe(true);expect(observedUnprotected).toBe(true)
   expect((await f.pool.query('SELECT hard_deadline<clock_timestamp() AS expired FROM shared.memory_source_processing_windows WHERE owner_user_id=$1 AND session_id=$2',[source.owner,source.session])).rows[0].expired).toBe(true)
   expect((await f.runtime.query("SELECT count(*)::int AS n FROM memory_jobs WHERE installation_id=$1 AND state='dead'",[inst])).rows[0].n).toBe(0)
   const row=(await loadBusinessHealth(f.runtime)).find(r=>r.installation_id===inst)!
   expect(row.source_failed_jobs).toBe('0');expect(row.source_stalled_roots).toBe('0')
   expect(evaluateBusinessHealth(row).reasons).not.toContain('source_processing_failed')
   // Exercise diagnostic failure/recovery using a real projected turn. This
   // fixture-only state change is not a production replay mechanism.
   const compiledJob=(await f.runtime.query("SELECT job_id FROM memory_jobs WHERE installation_id=$1 AND job_type='compile_episode' AND state='completed'",[inst])).rows[0].job_id
   await f.pool.query("UPDATE memory.memory_jobs SET state='dead',completed_at=clock_timestamp() WHERE job_id=$1",[compiledJob])
   const failed=(await loadBusinessHealth(f.runtime)).find(r=>r.installation_id===inst)!
   expect(failed.source_failed_jobs).toBe('1')
   expect(evaluateBusinessHealth(failed).reasons).toContain('source_processing_failed')
   await f.pool.query("UPDATE shared.memory_source_modes SET mode='paused' WHERE installation_id=$1",[inst])
   expect((await loadBusinessHealth(f.runtime)).find(r=>r.installation_id===inst)!.source_failed_jobs).toBe('0')
   await f.pool.query("UPDATE shared.memory_source_modes SET mode='shared-active' WHERE installation_id=$1",[inst])
   // A later processing outcome, including a policy skip, resolves this
   // compile failure without deleting the old dead job or calling a model.
   await f.runtime.query(`INSERT INTO memory_source_processing_receipts(installation_id,session_id,turn_id,source_digest,policy_version,disposition,allowed_count,excluded_count,complete)
    SELECT installation_id,session_id,turn_id,decode(repeat('ab',32),'hex'),'health-recovery-fixture','skipped_policy',0,2,true
    FROM source_turns WHERE installation_id=$1`,[inst])
   const recovered=(await loadBusinessHealth(f.runtime)).find(r=>r.installation_id===inst)!
   expect(recovered.source_failed_jobs).toBe('0')
   expect(evaluateBusinessHealth(recovered).reasons).not.toContain('source_processing_failed')
  }finally{closeObserver();await queue.stop();await scheduler.stop()}
 },90000)
})
