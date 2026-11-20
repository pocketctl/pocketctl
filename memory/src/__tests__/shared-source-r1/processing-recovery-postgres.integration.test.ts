import {randomUUID} from 'node:crypto'
import {archiveObjectKey,canonicalPayloadHash,createPostgresPersonalMetadataReader,encodeArchiveChunk,MemoryArchiveStorage} from '@pocketctl/session-source'
import {bindSourcePool,sourcePoolContext} from '../../sources/pool-context.js'
import {readFile} from 'node:fs/promises'
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
   const trace=await readFile('../scripts/verification/memory-lifecycle/trace-receipt.sql','utf8')
   const bindings=[inst,source.session,'direct-turn-'+source.session]
   const traceClient=await f.runtime.connect()
   try{
    await traceClient.query('BEGIN READ ONLY')
    const traced=(await traceClient.query(trace,bindings)).rows[0]
    expect(traced).toMatchObject({sampled:'3',matched_headers:'3',projection_differences:'0',incomplete_at_relay:'0'})
    const missing=(await traceClient.query(trace,[inst,source.session,'absent-turn'])).rows[0]
    expect(missing).toMatchObject({sampled:'0',matched_headers:'0'})
   }finally{await traceClient.query('ROLLBACK');traceClient.release()}
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
 test('a real personal projection verifies a historical cold first page with no stored hash',async()=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id
  const root={kind:'relay_event' as const,key:f.root(source)}
  await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation])
  const payload={text:'archived fixture',turn_id:'cold-first-page'}
  const id=(await f.publisher.query(`INSERT INTO public.events(session_id,event_type,payload,event_hash,effect_status,user_id)
   VALUES($1,'agent_text',$2,$3,'completed',$4) RETURNING id::text`,[source.session,payload,randomUUID().replaceAll('-',''),source.owner])).rows[0].id
  const epoch=(await f.pool.query('SELECT activity_epoch::text FROM public.sessions WHERE session_id=$1',[source.session])).rows[0].activity_epoch
  const manifestId=randomUUID(),key=archiveObjectKey(manifestId,0)
  const limits={maxRawBytes:1048576,maxCompressedBytes:1048576,maxRecords:64}
  const encoded=await encodeArchiveChunk({userId:source.owner,sessionId:source.session,activityEpoch:epoch,manifestId,ordinal:0},[{id,eventType:'agent_text',payload}],limits)
  const manifest=encoded.manifest,storage=Object.assign(new MemoryArchiveStorage(),{namespace:'cold-first-page'})
  await storage.put(key,encoded.bytes)
  await f.pool.query(`INSERT INTO public.session_archive_manifests(manifest_id,user_id,session_id,activity_epoch,schema_version,codec,state,event_high_water,published_at,storage_namespace)
   VALUES($1,$2,$3,$4,1,'gzip','published',$5,NOW(),$6)`,[manifestId,source.owner,source.session,epoch,id,storage.namespace])
  await f.pool.query(`INSERT INTO public.session_archive_chunks(manifest_id,ordinal,object_key,first_event_id,last_event_id,event_count,raw_bytes,compressed_bytes,raw_sha256,compressed_sha256)
   VALUES($1,0,$2,$3,$3,1,$4,$5,$6,$7)`,[manifestId,key,id,manifest.rawBytes,manifest.compressedBytes,manifest.rawSha256,manifest.compressedSha256])
  await f.pool.query('ALTER TABLE public.events ALTER COLUMN payload DROP NOT NULL')
  await f.pool.query(`UPDATE public.events SET payload=NULL,body_storage='cold',body_session_id=$1,body_manifest_id=$2,
   body_chunk_ordinal=0,body_owner_user_id=$3,body_activity_epoch=$4 WHERE id=$5`,[source.session,manifestId,source.owner,epoch,id])
  const scope=(await f.runtime.query("SELECT source_scope FROM shared.enumerate_memory_source_targets('relay_event',$1,'',64)",[root.key])).rows[0].source_scope
  await expect(createPostgresPersonalMetadataReader(f.runtime).selectPage(scope,root,{limit:64})).rejects.toMatchObject({code:'body_hash_unavailable'})
  const prior=sourcePoolContext(f.runtime),signal=new AbortController().signal,errors:unknown[]=[]
  let reads=0
  bindSourcePool(f.runtime,{...prior,archive:{storage:{namespace:storage.namespace,read:async k=>{reads++;return storage.read(k)}},limits}})
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'cold-first-page-scheduler',signal,onError:e=>errors.push(e)})
  const queue=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'cold-first-page-worker',signal,onError:e=>errors.push(e)})
  queue.register('project_shared_source',createCanonicalProjectionHandler(f.runtime),{branch:'canonical'})
  try{
   let jobId:string|undefined
   for(let n=0;n<50&&!jobId;n++){
    await scheduler.runOnce()
    jobId=(await f.runtime.query("SELECT job_id FROM memory_jobs WHERE installation_id=$1 AND job_type='project_shared_source'",[installation])).rows[0]?.job_id
   }
   expect(jobId).toBeTruthy()
   await f.pool.query("UPDATE memory.memory_jobs SET state='dead',attempts=12,last_error_code='handler_failed_Error',completed_at=NOW() WHERE job_id=$1",[jobId])
   const repair=await f.runtime.connect()
   try{
    const frozen=await planSourceProjectionRepair(repair,[jobId!])
    // A successor that has already checkpointed this scope invalidates a
    // first-page recovery even when the old job and archive are unchanged.
    await repair.query('BEGIN')
    await repair.query(`INSERT INTO memory_canonical_projection_progress
     (installation_id,source_kind,root_key,context_key,source_version,state)
     VALUES($1,'relay_event',$2,$3,'{}','ready')`,[installation,root.key,canonicalPayloadHash(scope).toString('hex')])
    await expect(applySourceProjectionRepair(repair,frozen)).rejects.toThrow('source_repair_not_eligible')
    await repair.query('ROLLBACK')
    const reviewed=await planSourceProjectionRepair(repair,[jobId!])
    await repair.query('BEGIN')
    expect(await applySourceProjectionRepair(repair,reviewed)).toEqual([{jobId,state:'requeued'}])
    await repair.query('COMMIT')
   }finally{await repair.query('ROLLBACK');repair.release()}
   let state=''
   for(let i=0;i<100&&state!=='completed';i++){
    await scheduler.runOnce();await queue.tick()
    if(errors.length)throw errors[0]
    state=(await f.runtime.query("SELECT state FROM memory_jobs WHERE installation_id=$1 AND job_type='project_shared_source'",[installation])).rows[0]?.state
    if(state!=='completed')await new Promise(resolve=>setTimeout(resolve,30))
   }
   expect(state).toBe('completed')
   expect(reads).toBeGreaterThan(0)
   const compiles=await f.runtime.query("SELECT priority FROM memory_jobs WHERE installation_id=$1 AND job_type='compile_episode'",[installation])
   expect(compiles.rows).toEqual([{priority:70}])
   const ref=await f.runtime.query("SELECT encode(content_hash,'hex') AS hash,payload,mapping_state FROM source_events WHERE installation_id=$1 AND canonical_key=$2",[installation,id])
   expect(ref.rows).toEqual([{hash:canonicalPayloadHash(payload).toString('hex'),payload:null,mapping_state:'verified'}])
  }finally{await queue.stop();await scheduler.stop();bindSourcePool(f.runtime,prior)}
 },90000)

})
