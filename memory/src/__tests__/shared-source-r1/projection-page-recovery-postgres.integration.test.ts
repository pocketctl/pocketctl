import {createSharedSourceScheduler} from '../../sources/shared-scheduler.js'
import {createJobRepository} from '../../jobs/repository.js'
import {createJobWorker} from '../../jobs/worker.js'
import {createCanonicalProjectionHandler} from '../../sources/canonical-projection-worker.js'
import {createEpisodeRepository} from '../../episodes/repository.js'
import {randomUUID} from 'node:crypto'
import type pg from 'pg'
import type {SourceScope} from '@pocketctl/session-source'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {prepareCanonicalReferencePage,persistCanonicalReferencePage} from '../../sources/canonical-references.js'
import {withSourceJobExecution} from '../../sources/source-execution.js'
import {workerErrorFields} from '../../jobs/worker-diagnostics.js'

const url=process.env.PROJECTION_PAGE_RECOVERY_TEST_DATABASE_URL
const suite=url?describe:describe.skip
suite('PG13 canonical page recovery',()=>{
 let f:DirectLaunchFixture
 beforeAll(async()=>{f=await directLaunchFixture(url!);await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')},90000)
 afterAll(async()=>{await f?.close()})

 test('an exhausted page budget rolls back the entire page and a fresh claim reuses only committed references',async()=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id
  const root={kind:'relay_event' as const,key:f.root(source)}
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation])
  const keys:string[]=[]
  for(let n=0;n<64;n++)keys.push(await f.event(source))
  const scope=(await f.runtime.query("SELECT source_scope FROM shared.enumerate_memory_source_targets('relay_event',$1,'',64)",[root.key])).rows[0].source_scope
  const job=randomUUID(),claimedBy='projection-page-test'
  await f.runtime.query("INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at) VALUES($1::uuid,$2,'project_shared_source',$1::text,52,'running',$3,1,clock_timestamp()+interval '5 minutes')",[job,installation,claimedBy])
  let inject=false,measure=false,loseCommitAck=false
  const clients=new Map<pg.PoolClient,pg.PoolClient['query']>()
  const counts:Record<string,number>={}
  const acquire=(c:pg.PoolClient)=>{
   if(clients.has(c))return
   const original=c.query;clients.set(c,original)
   c.query=(async function(...args:any[]){
    const sql=typeof args[0]==='string'?args[0]:args[0]?.text??''
    const result=await (original as any).apply(c,args)
    if(loseCommitAck&&sql==='COMMIT'){
     loseCommitAck=false
     throw Object.assign(new Error('private transport detail'),{code:'EPIPE'})
    }
    if(inject&&sql.includes('INSERT INTO source_events')){
     inject=false
     await new Promise(resolve=>setTimeout(resolve,5050))
    }
    if(measure)for(const [key,fragment]of Object.entries({refs:'INSERT INTO source_events',tombstones:'FROM memory_session_tombstones',installs:'FROM memory_installations WHERE installation_id',sessions:'INSERT INTO source_sessions(installation_id,session_id,first_recorded_at',markers:'UPDATE source_events SET canonical_projected_at'})){
     if(sql.includes(fragment))counts[key]=(counts[key]??0)+1
    }
    return result
   }) as pg.PoolClient['query']
  }
  f.runtime.on('acquire',acquire)
  const execute=(work:()=>Promise<void>)=>withSourceJobExecution(f.runtime,{jobId:job,claimedBy,claimEpoch:1},work)
  try{
   let fields:Record<string,unknown>={}
   await execute(async()=>{
    const page=await prepareCanonicalReferencePage(f.runtime,scope,root,{keys})
    inject=true
    const error=await persistCanonicalReferencePage(f.runtime,page,{project:true}).then(()=>null,e=>e)
    expect(error?.message).toBe('canonical_reference_budget_exceeded')
    fields=workerErrorFields(error)
   })
   expect((await f.runtime.query('SELECT count(*)::int AS n FROM source_events WHERE installation_id=$1',[installation])).rows[0].n).toBe(0)
   await execute(async()=>{
    const page=await prepareCanonicalReferencePage(f.runtime,scope,root,{keys})
    measure=true;const start=performance.now()
    const fresh=await persistCanonicalReferencePage(f.runtime,page,{project:true});measure=false
    console.info('canonical_page_recovery',JSON.stringify({events:fresh.length,ms:Math.round(performance.now()-start),statements:counts,firstFailure:fields}))
    expect(fresh.map(r=>r.canonicalKey)).toEqual(keys)
    expect(fresh.every(r=>r.created)).toBe(true)
    const replay=await persistCanonicalReferencePage(f.runtime,page,{project:true})
    expect(replay).toEqual(fresh.map(r=>({...r,created:false})))
   })
   await execute(async()=>{
    const page=await prepareCanonicalReferencePage(f.runtime,scope,root,{limit:32})
    loseCommitAck=true
    const error=await persistCanonicalReferencePage(f.runtime,page,{project:true,checkpoint:true}).then(()=>null,e=>e)
    expect(workerErrorFields(error)).toMatchObject({code:'projection_commit_outcome_unknown',projection_stage:'commit',projection_commit_sent:true})
    const progress=(await f.runtime.query('SELECT state,next_cursor FROM memory_canonical_projection_progress WHERE installation_id=$1',[installation])).rows[0]
    expect(progress).toMatchObject({state:'scanning',next_cursor:page.nextCursor})
    const next=await prepareCanonicalReferencePage(f.runtime,scope,root,{limit:32,cursor:progress.next_cursor})
    const refs=await persistCanonicalReferencePage(f.runtime,next,{project:true,checkpoint:true})
    expect(refs.map(r=>r.canonicalKey)).toEqual(keys.slice(32))
    expect(refs.every(r=>!r.created)).toBe(true)
   })
   expect(counts).toEqual({refs:1,tombstones:1,installs:1,sessions:1,markers:1})
   expect(fields).toMatchObject({code:'canonical_reference_budget_exceeded',projection_stage:'write_references',projection_page_size:64,projection_commit_sent:false})
  }finally{
   f.runtime.removeListener('acquire',acquire)
   for(const [client,original]of clients)client.query=original
   await createJobRepository(f.runtime).completeJob({jobId:job,claimedBy,claimEpoch:1})
  }
 },70000)
 test('a filtered physical page commits its scanned prefix and resumes with only admitted references',async()=>{
  const source=await f.source()
  const denied=[await f.event(source),await f.event(source)]
  const installation=(await f.install(source,'from_now')).inst.installation_id
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation])
  const allowed=await f.event(source)
  const root={kind:'relay_event' as const,key:f.root(source)}
  const scope=(await f.runtime.query("SELECT source_scope FROM shared.enumerate_memory_source_targets('relay_event',$1,'',64)",[root.key])).rows[0].source_scope
  const fence={jobId:randomUUID(),claimedBy:'physical-page',claimEpoch:1}
  await f.runtime.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at,attempts)
   VALUES($1,$2,'project_shared_source','physical',52,'running',$3,1,now()+interval '5 minutes',10)`,[fence.jobId,installation,fence.claimedBy])
  const prepare=(cursor?:string)=>prepareCanonicalReferencePage(f.runtime,scope,root,{limit:2,cursor,scanCandidates:true})
  const progress=async()=>(await f.runtime.query("SELECT state,next_cursor FROM memory_canonical_projection_progress WHERE installation_id=$1",[installation])).rows[0]
  const first=await withSourceJobExecution(f.runtime,fence,async()=>{
   const page=await prepare()
   expect(page).toMatchObject({count:0,hasMore:true})
   expect(JSON.parse(Buffer.from(page.nextCursor!,'base64url').toString())).toMatchObject({after:denied[1],through:allowed})
   expect(await persistCanonicalReferencePage(f.runtime,page,{project:true,checkpoint:true,retryFence:fence})).toEqual([])
   return page.nextCursor!
  })
  expect(await progress()).toEqual({state:'scanning',next_cursor:first})
  expect((await f.runtime.query('SELECT attempts FROM memory_jobs WHERE job_id=$1',[fence.jobId])).rows[0].attempts).toBe(1)
  await withSourceJobExecution(f.runtime,fence,async()=>{
   const page=await prepare(first)
   expect(page).toMatchObject({count:1,hasMore:false})
   expect((await persistCanonicalReferencePage(f.runtime,page,{project:true,checkpoint:true})).map(r=>r.canonicalKey)).toEqual([allowed])
  })
  expect(await progress()).toEqual({state:'ready',next_cursor:null})
  await f.event(source)
  await expect(withSourceJobExecution(f.runtime,fence,()=>prepare(first))).rejects.toMatchObject({code:'changed'})
  await f.pool.query("UPDATE public.extension_installations SET status='revoked' WHERE installation_id=$1",[installation])
  await expect(withSourceJobExecution(f.runtime,fence,()=>prepare())).rejects.toThrow()
  await createJobRepository(f.runtime).completeJob(fence)
 },30000)
 test('enabled lifecycle compilation publishes a complete prepared membership once across replay',async()=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation])
  await f.runtime.query("INSERT INTO memory_curation_policies(installation_id,mode,consume_mode) VALUES($1,'enabled','enabled')",[installation])
  const keys=[await f.event(source),await f.event(source,true)]
  const expected=(await f.pool.query('SELECT id::text AS canonical_key,source_sequence::text FROM public.events WHERE id=ANY($1::bigint[]) ORDER BY public.events.id',[keys])).rows
  const signal=new AbortController().signal,errors:unknown[]=[]
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'lifecycle-source',signal,onError:e=>errors.push(e)})
  const queue=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'lifecycle-compile',signal,claimLimit:1,onError:e=>errors.push(e)})
  const project=createCanonicalProjectionHandler(f.runtime,{stabilizationMs:0,projectionScanInstallations:[installation]})
  queue.register('project_shared_source',async(job,abort,ctx)=>{
   if(job.installation_id===installation)await project(job,abort,ctx)
  },{branch:'canonical'})
  let compiled=false
  const episodes=createEpisodeRepository(f.runtime,{lifecycleMode:'enabled'})
  queue.register('compile_episode',async(job,abort,ctx)=>{
   if(job.installation_id!==installation)return
   await episodes.handleCompileEpisode(job,abort,ctx)
   await episodes.handleCompileEpisode(job,abort,ctx)
   compiled=true
  })
  try{
   const deadline=Date.now()+20000
   while(!compiled&&Date.now()<deadline){
    await scheduler.runOnce();await queue.tick()
    if(errors.length)throw errors[0]
    if(!compiled)await new Promise(resolve=>setTimeout(resolve,30))
   }
   expect(compiled).toBe(true)
   expect((await f.runtime.query(`SELECT s.canonical_key,m.source_sequence::text FROM memory_task_bundle_sources m
    JOIN source_events s USING(installation_id,source_event_id) WHERE m.installation_id=$1 ORDER BY s.canonical_key::bigint`,[installation])).rows).toEqual(expected)
   expect((await f.runtime.query("SELECT revision::int FROM memory_task_bundles WHERE installation_id=$1",[installation])).rows).toEqual([{revision:1}])
   expect((await f.runtime.query("SELECT job_id FROM memory_jobs WHERE installation_id=$1 AND job_type='consolidate_task'",[installation])).rowCount).toBe(1)
  }finally{await queue.stop();await scheduler.stop()}
 },30000)
 test.each([
  {delayMs:0,code:'projection_read_page_timeout',rollback:false},
  {delayMs:4000,code:'canonical_reference_budget_exceeded',rollback:true},
  {delayMs:5400,code:'canonical_reference_write_timeout',rollback:false},
 ])('selected worker persists $code before COMMIT and resumes at a smaller page',async({delayMs,code,rollback})=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation])
  const count=70
  for(let i=0;i<count;i++)await f.event(source)
  const signal=new AbortController().signal,workerId='selected-budget-worker'
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:workerId+'-scheduler',signal})
  const repo=createJobRepository(f.runtime),errors:Record<string,unknown>[]=[]
  const queue=createJobWorker({pool:f.runtime,jobs:repo,workerId,signal,onError:(error,job)=>{
   if(job?.installation_id===installation)errors.push(workerErrorFields(error,job))
  }})
  const project=createCanonicalProjectionHandler(f.runtime,{stabilizationMs:0})
  const inserts:number[]=[]
  let projectionActive=false,timedOut=false
  queue.register('project_shared_source',async(job,abort,ctx)=>{
   if(job.installation_id!==installation)return
   projectionActive=true
   try{await project(job,abort,ctx)}finally{projectionActive=false}
  },{branch:'canonical'})
  queue.register('compile_episode',createEpisodeRepository(f.runtime,{stabilizationMs:0}).handleCompileEpisode)
  const clients=new Map<pg.PoolClient,pg.PoolClient['query']>()
  const acquire=(c:pg.PoolClient)=>{
   if(clients.has(c))return
   const original=c.query;clients.set(c,original)
   c.query=(async function(...args:any[]){
    const sql=typeof args[0]==='string'?args[0]:args[0]?.text??''
    if(projectionActive&&code==='projection_read_page_timeout'&&!timedOut&&sql.includes('read_memory_relay_sources')){
     timedOut=true
     throw Object.assign(Error('canceling statement due to statement timeout'),{code:'57014'})
    }
    const result=await (original as any).apply(c,args)
    if(projectionActive&&sql.includes('INSERT INTO source_events')){
     inserts.push(JSON.parse(args[1][3]).length)
     if(inserts.length===1)await new Promise(resolve=>setTimeout(resolve,delayMs))
     // Force the acknowledged 32-row claim to yield. The next claim reads
     // the durable budget step after last_error_code becomes source_not_ready.
     if(inserts.length===2)await new Promise(resolve=>setTimeout(resolve,1050))
    }
    return result
   }) as pg.PoolClient['query']
  }
  f.runtime.on('acquire',acquire)
  try{
   for(let n=0;n<128&&!errors.length;n++){await scheduler.runOnce();await queue.tick()}
   if(timedOut)expect(errors[0]).toMatchObject({code,projection_stage:'select_page'})
   else expect(errors[0]).toMatchObject({code,projection_stage:'write_references',projection_page_size:64,projection_commit_sent:false})
   expect(errors[0].projection_rollback_confirmed===true).toBe(rollback)
   const states=()=>f.runtime.query("SELECT state,attempts,last_error_code FROM memory_jobs WHERE installation_id=$1 AND job_type='project_shared_source'",[installation])
   expect((await states()).rows).toEqual([{state:'pending',attempts:1,last_error_code:code}])
   expect((await f.runtime.query('SELECT count(*)::int AS count FROM source_events WHERE installation_id=$1',[installation])).rows[0].count).toBe(0)
   for(let n=0;n<8&&(await states()).rows[0]?.state!=='completed';n++){
    await f.runtime.query("UPDATE memory_jobs SET available_at=clock_timestamp() WHERE installation_id=$1 AND job_type='project_shared_source'",[installation])
    await queue.tick()
   }
   expect((await states()).rows[0].state).toBe('completed')
   expect(inserts).toEqual(timedOut?[32,32,6]:[64,32,32,6])
   expect((await f.runtime.query('SELECT count(DISTINCT canonical_key)::int AS count FROM source_events WHERE installation_id=$1',[installation])).rows[0].count).toBe(count)
  }finally{
   f.runtime.removeListener('acquire',acquire)
   for(const [client,original]of clients)client.query=original
   await queue.stop();await scheduler.stop()
  }
 },60000)
 // The opted-in load probe exercises ordinary writer contention on one installation.
 // It records SQL timings and durable results even when a concurrent attempt loses a fence.
 test.runIf(process.env.PROJECTION_PAGE_BENCHMARK==='1')('compares bounded same-installation projection concurrency', async()=>{
  const count=8,events=16
  for(const concurrency of [1,2,4,8]){
   const seed=await f.source(),installation=(await f.install(seed,'retained_history')).inst.installation_id
   await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation])
   const roots:Array<{source:typeof seed;keys:string[];root:{kind:'relay_event';key:string};scope:SourceScope;fence:{jobId:string;claimedBy:string;claimEpoch:number}}>=[]
   for(let index=0;index<count;index++){
    const source={...seed,session:'load-'+randomUUID()}
    await f.publisher.query("INSERT INTO public.sessions(session_id,daemon_id,user_id,agent_type,source,status) VALUES($1,$2,$3,'codex','terminal','running')",[source.session,source.daemon,source.owner])
    const keys:string[]=[]
    for(let j=0;j<events;j++)keys.push(await f.event(source,j+1===events))
    const root={kind:'relay_event' as const,key:f.root(source)}
    const scope=(await f.runtime.query("SELECT source_scope FROM shared.enumerate_memory_source_targets('relay_event',$1,'',64)",[root.key])).rows[0].source_scope
    const jobId=randomUUID(),claimedBy='projection-load'
    await f.runtime.query("INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at) VALUES($1::uuid,$2,'project_shared_source',$1::text,52,'running',$3,1,clock_timestamp()+interval '5 minutes')",[jobId,installation,claimedBy])
    roots.push({source,keys,root,scope,fence:{jobId,claimedBy,claimEpoch:1}})
   }
   let done=false,completed=0,latestMs=0
   const sample={checkout:[] as number[],sql:[] as number[],hold:[] as number[],relay:[] as number[]}
   const originalConnect=f.runtime.connect.bind(f.runtime),clients=new Map<pg.PoolClient,pg.PoolClient['query']>()
   const acquired=(c:pg.PoolClient)=>{
    if(clients.has(c))return
    const original=c.query;clients.set(c,original)
    let fenceAt:number|undefined
    c.query=(async function(...args:any[]){
     const sql=typeof args[0]==='string'?args[0]:args[0]?.text??'',began=performance.now()
     try{
      const result=await (original as any).apply(c,args)
      if(sql.includes('lock_memory_personal_source_commit')&&result.rows[0]?.locked)fenceAt=began
      return result
     }finally{
      sample.sql.push(performance.now()-began)
      if((sql==='COMMIT'||sql==='ROLLBACK')&&fenceAt!==undefined){sample.hold.push(performance.now()-fenceAt);fenceAt=undefined}
     }
    }) as pg.PoolClient['query']
   }
   f.runtime.on('acquire',acquired)
   f.runtime.connect=(function(callback?:any){
    const began=performance.now()
    if(callback)return originalConnect((err,c,release)=>{sample.checkout.push(performance.now()-began);callback(err,c,release)})
    return originalConnect().finally(()=>sample.checkout.push(performance.now()-began))
   }) as typeof f.runtime.connect
   const started=performance.now()
   const probe=(async()=>{while(!done){
    const before=performance.now()
    await f.publisher.query('SELECT id,event_type FROM public.events WHERE session_id=$1 AND user_id=$2 ORDER BY id DESC LIMIT 50',[roots[count-1].source.session,seed.owner])
    sample.relay.push(performance.now()-before)
    await new Promise(resolve=>setTimeout(resolve,20))
   }})()
   const failed:number[]=[],reasons:Record<string,number>={}
   const attempt=async(i:number)=>{
    const item=roots[i]
    try{
     await withSourceJobExecution(f.runtime,item.fence,async()=>{
      const page=await prepareCanonicalReferencePage(f.runtime,item.scope,item.root,{keys:item.keys})
      const rows=await persistCanonicalReferencePage(f.runtime,page,{project:true})
      expect(rows).toHaveLength(events)
     })
     completed++
     if(i===count-1)latestMs=performance.now()-started
    }catch(e){const code=String(workerErrorFields(e).code);reasons[code]=(reasons[code]??0)+1;failed.push(i)}
   }
   try{
    let index=0
    await Promise.all(Array.from({length:concurrency},async()=>{while(index<count)await attempt(index++)}))
    const firstPass={roots:completed,ms:Math.round(performance.now()-started),errors:{...reasons}}
    for(const index of failed.splice(0))await attempt(index)
    const ms=performance.now()-started
    const p95=(xs:number[])=>Math.round((xs.slice().sort((a,b)=>a-b)[Math.ceil(xs.length*.95)-1]??0)*100)/100
    console.info('projection_concurrency_sample',JSON.stringify({concurrency,firstPass,roots:completed,events:completed*events,ms:Math.round(ms),
     eventsPerSecond:Math.round(completed*events*1000/ms),lastRootMs:Math.round(latestMs),errors:reasons,
     p95ms:Object.fromEntries(Object.entries(sample).map(([key,times])=>[key,p95(times)])),relaySamples:sample.relay.length}))
    expect(completed).toBe(count)
    expect((await f.runtime.query('SELECT count(*)::int AS n FROM source_events WHERE installation_id=$1',[installation])).rows[0].n).toBe(count*events)
   }finally{
    done=true;await probe
    f.runtime.connect=originalConnect
    f.runtime.removeListener('acquire',acquired)
    for(const [client,original]of clients)client.query=original
   }
  }
 },240000)
})
