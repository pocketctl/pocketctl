import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {setTimeout as delay} from 'node:timers/promises'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {createSharedSourceScheduler} from '../../sources/shared-scheduler.js'
import {createJobRepository} from '../../jobs/repository.js'
import {createJobWorker} from '../../jobs/worker.js'
import {createCanonicalProjectionHandler} from '../../sources/canonical-projection-worker.js'
import {createEpisodeRepository} from '../../episodes/repository.js'
import {wakeCompletedPersonalProjection} from '../../sources/projection-job-handoff.js'
const url=process.env.TASK21_DATABASE_URL,suite=url?describe:describe.skip
suite('local durable handoffs use actual native authority',()=>{
 let f:DirectLaunchFixture
 beforeAll(async()=>{f=await directLaunchFixture(url!);await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')},60000)
 afterAll(async()=>{await f?.close()})
 test('real dispatch wakes original job claims and ready COMMIT wakes exact cached source recovery',async()=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation])
  await f.event(source);await f.event(source,true)
  const signal=new AbortController().signal,errors:unknown[]=[],hints:{kind:string;t:number}[]=[]
  const queue=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'handoff-jobs',signal,onError:e=>errors.push(e)})
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'handoff-source',signal,onError:e=>errors.push(e),onDispatch:()=>{hints.push({kind:'dispatch',t:performance.now()});queue.wake()}})
  queue.register('project_shared_source',createCanonicalProjectionHandler(f.runtime,{stabilizationMs:0,onReady:root=>{hints.push({kind:'ready',t:performance.now()});scheduler.wake(root)}}),{branch:'canonical'})
  queue.register('compile_episode',createEpisodeRepository(f.runtime,{stabilizationMs:0}).handleCompileEpisode)
  queue.start();scheduler.start()
  try{
   const until=performance.now()+12000
   let row:any
   do{row=(await f.pool.query(`SELECT (SELECT count(*)::int FROM memory.source_events WHERE installation_id=$1) AS refs,(SELECT count(*)::int FROM memory.work_episodes WHERE installation_id=$1 AND state='ready') AS episodes,(SELECT bool_and(processed_revision>=revision) FROM shared.memory_source_work WHERE root_key=$2) AS consumed`,[installation,f.root(source)])).rows[0];if(row.refs===2&&row.episodes===1&&row.consumed)break;await delay(20)}while(performance.now()<until)
   expect(row).toEqual({refs:2,episodes:1,consumed:true});expect(hints.some(x=>x.kind==='dispatch')).toBe(true);expect(hints.some(x=>x.kind==='ready')).toBe(true);expect(errors).toEqual([])
   // Follow-on work must not inherit the completed source job's async scope.
   const second={...source,session:source.session+'-follow-on'}
   await f.publisher.query("INSERT INTO public.sessions(session_id,daemon_id,user_id,agent_type,source,status) VALUES($1,$2,$3,'codex','terminal','running')",[second.session,source.daemon,source.owner])
   await f.event(second);await f.event(second,true)
   const secondDeadline=performance.now()+12000
   do{row=(await f.pool.query(`SELECT (SELECT count(*)::int FROM memory.source_events WHERE installation_id=$1) AS refs,(SELECT count(*)::int FROM memory.work_episodes WHERE installation_id=$1 AND state='ready') AS episodes,(SELECT bool_and(processed_revision>=revision) FROM shared.memory_source_work WHERE root_key=ANY($2::text[])) AS consumed`,[installation,[f.root(source),f.root(second)]])).rows[0];if(row.refs===4&&row.episodes===2&&row.consumed)break;await delay(20)}while(performance.now()<secondDeadline)
   expect(row).toEqual({refs:4,episodes:2,consumed:true});expect(errors).toEqual([])
   expect((await f.pool.query('SELECT count(*)::int AS n FROM memory.source_events WHERE installation_id=$1 AND payload IS NOT NULL',[installation])).rows[0].n).toBe(0)
  }finally{await scheduler.stop();await queue.stop()}
 },30000)
 test('a ready checkpoint cannot lose its wake while fenced job completion is still pending',async()=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id,root=f.root(source)
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation]);await f.event(source)
  const signal=new AbortController().signal,errors:unknown[]=[],scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'completion-source',signal,onError:e=>errors.push(e)})
  for(let n=0;n<64;n++){await scheduler.runOnce();if((await f.pool.query('SELECT 1 FROM shared.memory_source_distributions WHERE root_key=$1 AND dispatch_complete',[root])).rowCount)break;if(n===63)throw Error('completion_setup_deadline')}
  const old=(await f.pool.query('SELECT scan_id::text,work_revision::text FROM shared.memory_source_distributions WHERE root_key=$1',[root])).rows[0]
  const jobs=createJobRepository(f.runtime),complete=jobs.completeJob.bind(jobs);let target='',entered=false,ready=false,waitingCommit=0
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve})
  jobs.completeJob=async input=>{if(input.jobId===target){entered=true;await held}return complete(input)}
  const queue=createJobWorker({pool:f.runtime,jobs,workerId:'completion-jobs',signal,claimLimit:1,onClaim:j=>{if(j.job_type==='project_shared_source'&&j.installation_id===installation)target=j.job_id},onExecution:(j,result)=>wakeCompletedPersonalProjection(j,result,r=>scheduler.wake(r)),onError:e=>errors.push(e)})
  queue.register('project_shared_source',createCanonicalProjectionHandler(f.runtime,{stabilizationMs:0,onReady:()=>{ready=true}}),{branch:'canonical'})
  queue.register('compile_episode',createEpisodeRepository(f.runtime,{stabilizationMs:0}).handleCompileEpisode)
  const originals=new Map<any,any>();const instrument=(client:any)=>{if(originals.has(client))return;const original=client.query;originals.set(client,original);let waiting=false
   client.query=function(...args:any[]){const sql=typeof args[0]==='string'?args[0]:args[0]?.text??'',values=Array.isArray(args[1])?args[1]:args[0]?.values??[];const result=original.apply(client,args)
    if(!result?.then)return result
    return result.then((r:any)=>{if(sql.includes('shared.step_memory_source_distribution(')&&values[1]===root)waiting=r.rows[0]?.result?.waiting===true;if(sql==='COMMIT'){if(waiting)waitingCommit=performance.now();waiting=false}if(sql==='ROLLBACK'||sql==='BEGIN')waiting=false;return r})
   }
  }
  f.runtime.on('acquire',instrument);let tick:Promise<void>|undefined
  const until=async(check:()=>Promise<boolean>|boolean,deadline:number)=>{while(performance.now()<deadline){if(await check())return;await delay(10)}throw Error('completion_handoff_deadline')}
  try{
   tick=queue.tick();await until(()=>ready&&entered,performance.now()+5000)
   expect((await f.pool.query('SELECT state FROM memory.memory_jobs WHERE job_id=$1',[target])).rows[0].state).toBe('running')
   await f.event(source,true);scheduler.start();await until(()=>waitingCommit>0,performance.now()+3000)
   expect((await f.pool.query('SELECT scan_id::text FROM shared.memory_source_distributions WHERE root_key=$1',[root])).rows[0].scan_id).toBe(old.scan_id)
   await delay(20);const releasedAt=performance.now();release();await tick
   expect((await f.pool.query('SELECT state FROM memory.memory_jobs WHERE job_id=$1',[target])).rows[0].state).toBe('completed')
   await until(async()=>(await f.pool.query('SELECT scan_id::text FROM shared.memory_source_distributions WHERE root_key=$1',[root])).rows[0].scan_id!==old.scan_id,releasedAt+750)
   expect(performance.now()-releasedAt).toBeLessThan(1000);expect(errors).toEqual([])
   for(let n=0;n<64;n++){await queue.tick();const row=(await f.pool.query("SELECT (SELECT count(*)::int FROM memory.source_events WHERE installation_id=$1) AS refs,(SELECT count(*)::int FROM memory.work_episodes WHERE installation_id=$1 AND state='ready') AS episodes",[installation])).rows[0];if(row.refs===2&&row.episodes===1)break;if(n===63)throw Error('completion_followon_deadline');await delay(20)}
   expect(errors).toEqual([])
  }finally{release();await tick?.catch(()=>{});await scheduler.stop();await queue.stop();f.runtime.off('acquire',instrument);for(const[client,query]of originals)client.query=query}
 },15000)
})
