import {createEpisodeRepository} from '../../episodes/repository.js'
import {snapshotFormatPage} from '../../maintenance/snapshot-format.js'
import {snapshotProvenanceSql} from '../../sources/snapshot-provenance.js'
import {setTimeout as delay} from 'node:timers/promises'
import {describe,expect,test} from 'vitest'
import {directLaunchFixture} from './direct-launch-fixture.js'
import {observeProjectionCommits} from './helpers/projection-commit-observer.js'
import {SHARED_JOB_CAPACITY} from '../../jobs/scheduling.js'
import {createJobRepository} from '../../jobs/repository.js'
import {createJobWorker} from '../../jobs/worker.js'
import {claimSourceWork} from '../../sources/shared-work.js'
import {advancePersonalSourceDistribution} from '../../sources/source-distribution.js'
import {createSharedSourceScheduler} from '../../sources/shared-scheduler.js'
import {createCanonicalProjectionHandler} from '../../sources/canonical-projection-worker.js'

const url=process.env.OFFLINE_PROJECTION_TEST_DATABASE_URL
;(url?describe:describe.skip)('offline personal projection on PostgreSQL',()=>{
 test('compares a shadow window, seeks late IDs, and closes a frozen target while another window is open',async()=>{
  const f=await directLaunchFixture(url!),signal=new AbortController().signal,errors:unknown[]=[]
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'offline-scheduler',signal,onError:e=>errors.push(e)})
  const queue=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'offline-worker',capacity:SHARED_JOB_CAPACITY,signal,onError:e=>errors.push(e)})
  const source=await f.source(),root=f.root(source),installation=(await f.install(source,'retained_history')).inst.installation_id
  const basis=async()=>(await f.runtime.query('SELECT state,offline_basis AS b FROM memory_canonical_projection_progress WHERE installation_id=$1 AND root_key=$2',[installation,root])).rows[0]
  const window=async()=>(await f.pool.query('SELECT * FROM shared.memory_projection_windows WHERE root_key=$1',[root])).rows[0]
  const expire=()=>f.pool.query("UPDATE shared.memory_projection_windows SET due_at=clock_timestamp() WHERE root_key=$1",[root])
  const drain=async(condition:()=>Promise<boolean>)=>{
   for(let i=0;i<160;i++){
    await scheduler.runOnce();await queue.tick()
    if(errors.length)throw errors[0]
    if(await condition())return
    await delay(25)
   }
   throw Error('offline_projection_timeout '+JSON.stringify(await basis()))
  }
  queue.register('compile_episode',createEpisodeRepository(f.runtime,{stabilizationMs:0}).handleCompileEpisode)
  const compactSnapshotInstallations:string[]=[]
  queue.register('project_shared_source',createCanonicalProjectionHandler(f.runtime,{pageSize:1,deferMs:5,stabilizationMs:0,compactSnapshotInstallations,pageDerivedWriteInstallations:[installation]}),{branch:'canonical'})
  let onPage:(()=>Promise<void>)|undefined
  const close=observeProjectionCommits(f.runtime,async e=>{
   if(e.rootKey===root&&onPage){const run=onPage;onPage=undefined;await run()}
  },errors)
  try{
   await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
   await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation])
   await f.pool.query("INSERT INTO shared.memory_projection_policies VALUES($1,'shadow')",[installation])
   const migration=await f.pool.connect()
   try{
    await migration.query('BEGIN')
    await migration.query('ALTER TABLE public.events DISABLE TRIGGER memory_window_capture_update')
    expect((await migration.query('SELECT shared.memory_projection_runtime_ready() AS ready')).rows[0].ready).toBe(false)
    await expect(migration.query("UPDATE shared.memory_projection_policies SET mode='active' WHERE installation_id=$1",[installation])).rejects.toThrow('offline_projection_capture_migration_required')
   }finally{await migration.query('ROLLBACK');migration.release()}
   expect((await f.runtime.query('SELECT shared.memory_projection_runtime_ready() AS ready')).rows[0].ready).toBe(true)
   expect((await f.publisher.query('SELECT shared.memory_projection_runtime_ready() AS ready')).rows[0].ready).toBe(true)
   const late=await f.event(source)
   await f.publisher.query("UPDATE public.events SET effect_status='pending' WHERE id=$1",[late])
   const history=[await f.event(source),await f.event(source),await f.event(source)]
   await drain(async()=>(await basis())?.state==='ready')
   expect((await basis()).b).toMatchObject({strategy:'baseline',scanned:history.length,covered:true})
   expect((await f.runtime.query('SELECT DISTINCT snapshot_format FROM source_events WHERE installation_id=$1',[installation])).rows).toEqual([{snapshot_format:0}])
   compactSnapshotInstallations.push(installation)
   const shadow=await f.event(source)
   await drain(async()=>(await basis())?.b?.strategy==='shadow'&&(await basis()).b.covered)
   expect((await basis()).b).toMatchObject({scanned:4,outside:0})

   await f.pool.query("UPDATE shared.memory_projection_policies SET mode='active' WHERE installation_id=$1",[installation])
   await f.publisher.query("UPDATE public.events SET effect_status='completed' WHERE id=$1",[late])
   const fresh=await f.event(source)
   const open=await window()
   expect(open).toMatchObject({first_id:fresh,last_id:fresh,late_ids:[late]})
   expect(open.due_at.getTime()%300000).toBe(0)
   await f.pool.query("UPDATE shared.memory_projection_windows SET due_at=clock_timestamp()+interval '5 minutes' WHERE root_key=$1",[root])
   await scheduler.runOnce()
   expect((await window()).first_revision).toBe(open.first_revision)
   await expire()
   let next:string|undefined
   onPage=async()=>{next=await f.event(source)}
   await drain(async()=>(await basis())?.b?.strategy==='incremental'&&(await basis()).b.covered)
   const frozen=await basis()
   expect(frozen).toMatchObject({state:'scanning',b:{scanned:2,version:{content:open.last_revision}}})
   expect(next).toBeTruthy()
   expect((await window()).first_id).toBe(next)
   await expire()
   await drain(async()=>(await basis())?.state==='ready')
   expect((await basis()).b).toMatchObject({strategy:'incremental',scanned:1})
   const refs=await f.runtime.query('SELECT canonical_key FROM source_events WHERE installation_id=$1 ORDER BY canonical_key::bigint',[installation])
   expect(refs.rows.map(r=>r.canonical_key)).toEqual([late,...history,shadow,fresh,next])
   const compact=(await f.runtime.query(`SELECT snapshot_format,source_provenance,classification->'memory_source' AS proof
     FROM source_events WHERE installation_id=$1 AND canonical_key=$2`,[installation,fresh])).rows[0]
   expect(compact).toMatchObject({snapshot_format:1,source_provenance:{state:'known'},proof:{version:1,session_id:source.session}})
   expect(compact.source_provenance).not.toHaveProperty('memory')
   // A historical header/body touch creates a revision hole. The following
   // append cannot use its own interval to cover that change.
   await f.publisher.query('UPDATE public.events SET payload=payload WHERE id=$1',[history[0]])
   await f.event(source)
   await drain(async()=>(await basis())?.b?.strategy==='baseline'&&(await basis()).b.covered)
   expect((await basis()).b.scanned).toBe(8)

   // Roll back the publisher transaction; neither the native revision nor a
   // half-open change window may survive.
   const native=await f.publisher.connect()
   try{
    await native.query('BEGIN')
    await native.query("UPDATE public.events SET effect_status='pending' WHERE id=$1",[late])
    await native.query("UPDATE public.events SET effect_status='completed' WHERE id=$1",[late])
    await native.query('ROLLBACK')
   }finally{native.release()}
   expect(await window()).toBeUndefined()

   const retryEvents=[await f.event(source),await f.event(source)]
   await expire()
   // A real transaction elsewhere holds the second native row. An earlier
   // committed page survives, and the failed page advances neither refs nor cursor.
   const locker=await f.pool.connect()
   try{
    await locker.query('BEGIN')
    await locker.query('SELECT id FROM public.events WHERE id=$1 FOR UPDATE',[retryEvents[1]])
    await drain(async()=>(await basis())?.b?.after===retryEvents[0])
    const partial=await basis()
    expect(partial.b).toMatchObject({scanned:1,covered:false})
    await queue.tick()
    expect(await basis()).toEqual(partial)
    expect((await f.runtime.query('SELECT 1 FROM source_events WHERE installation_id=$1 AND canonical_key=$2',[installation,retryEvents[1]])).rowCount).toBe(0)
   }finally{await locker.query('ROLLBACK');locker.release()}
   await drain(async()=>(await basis())?.state==='ready')
   const recovered=await basis()
   expect(recovered.b).toMatchObject({strategy:'incremental',scanned:2,covered:true})
   const receipt=(await f.pool.query('SELECT offline_ack FROM shared.memory_source_distribution_targets WHERE scan_id=$1 AND installation_id=$2',[recovered.b.scanId,installation])).rows[0]
   expect(receipt.offline_ack).toEqual(recovered.b)
   expect((await f.runtime.query("SELECT payload->>'offline_projection' AS lane FROM memory_jobs WHERE payload->>'distribution_scan'=$1",[recovered.b.scanId])).rows[0].lane).toBe('true')

   // A writer can commit between lease acquisition and target enumeration.
   // The target still processes precisely the range that the lease froze.
   const claimedEvent=await f.event(source)
   await expire()
   const [claim]=await claimSourceWork(f.runtime,'offline-race',30,1,true)
   expect(claim?.rootKey).toBe(root)
   const afterClaim=await f.event(source)
   let dispatched=false
   for(let step=0;step<8&&!dispatched;step++){
    const result=await advancePersonalSourceDistribution(f.runtime,claim)
    dispatched=result.valid&&'dispatched' in result&&result.dispatched.complete
   }
   expect(dispatched).toBe(true)
   await expire()
   const [waiting]=await claimSourceWork(f.runtime,'offline-waiting',30,1,true)
   const waitingAppend=await f.event(source)
   const wait=await advancePersonalSourceDistribution(f.runtime,waiting)
   if(!wait.valid||!('step' in wait)||!('waiting' in wait.step))throw Error('expected_frozen_distribution_wait')
   const frontier={...waiting,claimedRevision:wait.step.claimedRevision}
   const carried=(await f.pool.query("SELECT offline_claim FROM shared.memory_source_work WHERE source_kind='relay_event' AND root_key=$1",[root])).rows[0].offline_claim
   expect(carried).toMatchObject({lo:afterClaim,hi:waitingAppend,revision:frontier.claimedRevision})
   await drain(async()=>(await basis())?.b?.version.content===claim.claimedRevision&&(await basis()).b.covered)
   expect(await basis()).toMatchObject({state:'scanning',b:{scanned:1,strategy:'incremental'}})
   const projected=await f.runtime.query('SELECT canonical_key FROM source_events WHERE installation_id=$1 AND canonical_key=ANY($2::text[])',[installation,[claimedEvent,afterClaim]])
   expect(projected.rows).toEqual([{canonical_key:claimedEvent}])
   dispatched=false
   for(let step=0;step<8&&!dispatched;step++){
    const result=await advancePersonalSourceDistribution(f.runtime,frontier)
    dispatched=result.valid&&'dispatched' in result&&result.dispatched.complete
   }
   expect(dispatched).toBe(true)
   await drain(async()=>(await basis())?.state==='ready')

   // Disable compact writes with existing compact rows still in use.
   compactSnapshotInstallations.length=0
   const legacyAgain=await f.event(source,true)
   await f.pool.query('DELETE FROM shared.memory_projection_policies WHERE installation_id=$1',[installation])
   await drain(async()=>(await f.runtime.query('SELECT count(*)::int AS n FROM source_events WHERE installation_id=$1',[installation])).rows[0].n===14)

   expect((await f.runtime.query('SELECT snapshot_format FROM source_events WHERE installation_id=$1 AND canonical_key=$2',[installation,legacyAgain])).rows[0]).toEqual({snapshot_format:0})
   await drain(async()=>(await f.runtime.query("SELECT 1 FROM work_episodes WHERE installation_id=$1 AND state='ready'",[installation])).rowCount===1)
   const manifest=await f.runtime.query(`SELECT witness.value->'source_provenance'= ${snapshotProvenanceSql('s')} AS same
     FROM work_episodes episode CROSS JOIN LATERAL jsonb_each(episode.evidence_manifest) witness
     JOIN source_events s ON s.source_event_id=(witness.value->>'source_event_id')::uuid
     WHERE episode.installation_id=$1 AND s.snapshot_format=1`,[installation])
   expect(manifest.rows.length).toBeGreaterThan(0)
   expect(manifest.rows.every(r=>r.same===true)).toBe(true)
   const maintenance=await f.pool.connect()
   try{
    const logical=async()=>(await maintenance.query(`SELECT source_event_id,${snapshotProvenanceSql('s')} AS proof
      FROM memory.source_events s WHERE installation_id=$1 ORDER BY source_event_id`,[installation])).rows
    const before=await logical()
    const preview=await snapshotFormatPage(maintenance,'preview',installation,null)
    expect(preview).toMatchObject({scanned:14,changed:0,done:true})
    expect(preview.eligible).toBeGreaterThan(0)
    const locked=await f.pool.connect()
    try{
     await locked.query('BEGIN')
     await locked.query('SELECT 1 FROM memory.source_events WHERE installation_id=$1 AND snapshot_format=0 LIMIT 1 FOR UPDATE',[installation])
     await expect(snapshotFormatPage(maintenance,'pack',installation,null)).rejects.toMatchObject({code:'55P03'})
     expect(await logical()).toEqual(before)
    }finally{await locked.query('ROLLBACK');locked.release()}
    expect((await snapshotFormatPage(maintenance,'pack',installation,null)).changed).toBe(preview.eligible)
    expect((await snapshotFormatPage(maintenance,'pack',installation,null)).changed).toBe(0)
    expect(await logical()).toEqual(before)
    expect((await snapshotFormatPage(maintenance,'restore',installation,null)).changed).toBe(14)
    expect(await logical()).toEqual(before)
    const id=before[0].source_event_id
    // A missing key, JSON null, empty object, and conflicting proof retain their own values.
    for(const document of [{state:'unknown'},{state:'known',memory:null},{state:'known',memory:{}},{state:'known',memory:{version:2}}]){
     const result=await maintenance.query(`UPDATE memory.source_events SET snapshot_format=1,source_provenance=$2
      WHERE source_event_id=$1 RETURNING snapshot_format,source_provenance`,[id,document])
     expect(result.rows[0]).toEqual({snapshot_format:0,source_provenance:document})
    }
    const proof={...before[0].proof,extra:{saved:true}}
    await maintenance.query('UPDATE memory.source_events SET snapshot_format=1,source_provenance=$2 WHERE source_event_id=$1',[id,proof])
    const result=await maintenance.query(`UPDATE memory.source_events SET classification=classification-'memory_source'
     WHERE source_event_id=$1 RETURNING source_provenance,snapshot_format`,[id])
    expect(result.rows[0]).toEqual({snapshot_format:0,source_provenance:proof})
    // The retention guard can set body_reclaimed_at on an unrelated update.
    // It must run before the storage-format guard and preserve the proof.
    await maintenance.query('BEGIN')
    try{
     const target=before[1]
     await maintenance.query('UPDATE memory.source_events SET snapshot_format=1 WHERE source_event_id=$1',[target.source_event_id])
     await maintenance.query(`INSERT INTO memory.memory_source_retention_receipts(installation_id,turn_id,session_id,episode_id,source_digest,
      compiler_version,extraction_completed_at,state) SELECT installation_id,turn_id,session_id,gen_random_uuid(),content_hash,'test',now(),'reclaiming'
      FROM memory.source_events WHERE source_event_id=$1`,[target.source_event_id])
     const reclaimed=await maintenance.query(`UPDATE memory.source_events SET canonical_projected_at=now()
      WHERE source_event_id=$1 RETURNING snapshot_format,source_provenance,body_reclaimed_at IS NOT NULL AS reclaimed`,[target.source_event_id])
     expect(reclaimed.rows[0]).toEqual({snapshot_format:0,source_provenance:target.proof,reclaimed:true})
    }finally{await maintenance.query('ROLLBACK')}
   }finally{maintenance.release()}

   const jobs=createJobRepository(f.runtime)
   for(const priority of [51,52])await jobs.enqueueJob({installationId:installation,jobType:'project_shared_source',
    priority,idempotencyKey:'offline-capacity-'+priority,payload:{offline_projection:true}})
   await jobs.enqueueJob({installationId:installation,jobType:'invalidate_scope_authorization',priority:1,idempotencyKey:'offline-capacity-control'})
   const claimLimits={limit:8,leaseMs:60000,globalLimit:8,perInstallationLimit:8,capacity:SHARED_JOB_CAPACITY}
   const claims=(await Promise.all(['first','second'].map(workerId=>jobs.claimJobs({...claimLimits,workerId})))).flat()
   expect(claims.filter(c=>c.payload.offline_projection)).toHaveLength(1)
   expect(claims.some(c=>c.idempotency_key==='offline-capacity-control')).toBe(true)
  }finally{await close();await scheduler.stop();await queue.stop();await f.close()}
 },90000)
})
