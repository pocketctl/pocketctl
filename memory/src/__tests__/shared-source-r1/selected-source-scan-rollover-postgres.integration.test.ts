import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {writeFile} from 'node:fs/promises'
import {setTimeout as delay} from 'node:timers/promises'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {createSharedSourceScheduler} from '../../sources/shared-scheduler.js'
import {createJobRepository} from '../../jobs/repository.js'
import {createJobWorker} from '../../jobs/worker.js'
import {createCanonicalProjectionHandler} from '../../sources/canonical-projection-worker.js'
import {createEpisodeRepository} from '../../episodes/repository.js'
import {loadSourceContextSet} from '../../sources/source-context-set.js'
import {JobDeferredError} from '../../jobs/types.js'
const url=process.env.TASK21_DATABASE_URL,suite=url?describe:describe.skip
const barrier=<T=void>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return {promise,resolve}}
suite('selected original Episode proof across legitimate scope-scan rollover',()=>{
 let f:DirectLaunchFixture
 beforeAll(async()=>{f=await directLaunchFixture(url!);await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')},60000)
 afterAll(async()=>{await f?.close()})
 test('proves the precise old-scan denial and defers only that known rollover without positive old-proof output',async()=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id,root=f.root(source)
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation]);await f.event(source);await f.event(source,true)
  const errors:any[]=[],outcomes:any[]=[],signal=new AbortController().signal,scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'rollover-scheduler',signal,onError:e=>errors.push({scheduler:String(e)})})
  const queue=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'rollover-worker',signal,onError:(e,j)=>errors.push({error:String(e),job:j?.job_id}),onExecution:(j,outcome)=>outcomes.push({job:j.job_id,type:j.job_type,outcome})})
  queue.register('project_shared_source',createCanonicalProjectionHandler(f.runtime,{stabilizationMs:0}),{branch:'canonical'})
  queue.register('compile_episode',createEpisodeRepository(f.runtime,{stabilizationMs:0}).handleCompileEpisode)
  const reached=barrier<{sql:string;values:any[];verify:(values?:any[],mutation?:{sql:string;values:any[]})=>Promise<any>}>(),release=barrier(),originals=new Map<any,any>();let pause=true,actualResult:any,actualError:any,run:Promise<void>|undefined,before:any,after:any,validation:any
  const instrument=(client:any)=>{
   if(originals.has(client))return
   const original=client.query;originals.set(client,original)
   client.query=function(...args:any[]){
    const sql=typeof args[0]==='string'?args[0]:args[0]?.text??'',values=Array.isArray(args[1])?args[1]:args[0]?.values??[]
    let expected:any;try{expected=typeof values[3]==='string'?JSON.parse(values[3]):values[3]}catch{}
    if(pause&&sql.includes('shared.lock_memory_personal_source_commit(')&&expected?.purpose==='episode'){
     pause=false;reached.resolve({sql,values:structuredClone(values),verify:async(override,mutation)=>{
      await original.call(client,'SAVEPOINT task21_original_proof')
      try{if(mutation)await original.call(client,mutation.sql,mutation.values);return (await original.call(client,sql,override??values)).rows}catch(error){return {error:{message:(error as Error).message,code:(error as {code?:string}).code}}}finally{await original.call(client,'ROLLBACK TO SAVEPOINT task21_original_proof');await original.call(client,'RELEASE SAVEPOINT task21_original_proof')}
     }})
     return release.promise.then(()=>original.apply(client,args)).then((result:any)=>{actualResult=result.rows;return result},(e:any)=>{actualError={message:e.message,code:e.code};throw e})
    }
    return original.apply(client,args)
   }
  }
  try{
   for(let n=0;n<64;n++){await scheduler.runOnce();if((await f.pool.query('SELECT 1 FROM shared.memory_source_distributions WHERE root_key=$1 AND dispatch_complete',[root])).rowCount)break;if(n===63)throw Error('rollover_dispatch_missing')}
   await queue.tick() // Original projection commits refs and enqueues original compile job.
   const originalJob=(await f.runtime.query("SELECT job_id::text,attempts FROM memory_jobs WHERE installation_id=$1 AND job_type='compile_episode'",[installation])).rows[0]
   before=(await f.pool.query('SELECT to_jsonb(d) AS row FROM shared.memory_source_distributions d WHERE root_key=$1',[root])).rows[0].row
   const priorSealReceipt=await f.runtime.query('SELECT shared.current_memory_source_distribution($1,$2,$3) AS seal',['relay_event',root,installation])
   expect(priorSealReceipt.rows[0].seal.scanId).toBe(before.scan_id)
   expect((await f.runtime.query('SELECT count(*)::int AS n FROM source_events WHERE installation_id=$1',[installation])).rows[0].n).toBe(2)
   f.runtime.on('acquire',instrument);run=queue.tick()
   const prepared=await reached.promise,expected=JSON.parse(prepared.values[3]);expect(expected.scanId).toBe(before.scan_id)
   validation=await prepared.verify();expect(validation).toEqual([{locked:true}])
   // Only native content append and original scheduler replacement intervene.
   // The original selected events, refs, scope/control/mode and job stay exact.
   const selectedIds=expected.rows.map((r:any)=>r.id)
   const facts=async()=>({events:(await f.pool.query('SELECT id::text,xmin::text,source_body_change_revision::text FROM public.events WHERE id=ANY($1::bigint[]) ORDER BY id',[selectedIds])).rows,refs:(await f.runtime.query('SELECT source_event_id::text,xmin::text,content_hash,source_provenance FROM source_events WHERE installation_id=$1 ORDER BY source_event_id',[installation])).rows})
   const originalFacts=await facts();await f.event(source)
   for(let n=0;n<32;n++){await scheduler.runOnce();after=(await f.pool.query('SELECT to_jsonb(d) AS row FROM shared.memory_source_distributions d WHERE root_key=$1',[root])).rows[0].row;if(after.scan_id!==before.scan_id)break;if(n===31)throw Error('rollover_replacement_missing')}
   expect(after.control_revision).toBe(before.control_revision);expect(after.scan_id).not.toBe(before.scan_id);expect(await facts()).toEqual(originalFacts)
   // A real earlier metadata reply can arrive after a legitimate replacement.
   // Replay only that delayed reply; the page query still executes real SQL
   // against the current native-authoritative scan and must yield no contexts.
   let delayed=true
   const delayedReply={async query(sql:string,args?:any[]){if(delayed&&sql.includes('shared.current_memory_source_distribution(')){delayed=false;return priorSealReceipt}return f.runtime.query(sql,args)}}
   await expect(loadSourceContextSet(delayedReply as any,installation,{kind:'relay_event',key:root},before.scan_id,'personal-projection')).rejects.toBeInstanceOf(JobDeferredError)
   // Known rollover must not hide a second native/ref/authority denial.
   for(const mutate of [
    (p:any)=>{p.scanId='00000000-0000-0000-0000-000000000001'},
    (p:any)=>{p.targetCursor='invented-target'},
    (p:any)=>{p.purpose='reference'},
    (p:any)=>{p.observedVersion.authorization=String(BigInt(p.observedVersion.authorization)+1n)},
    (p:any)=>{p.observedVersion.storage=String(BigInt(p.observedVersion.storage)+1n)},
    (p:any)=>{p.inputFingerprint='0'.repeat(64)},
    (p:any)=>{p.nativeSessionFingerprint='0'.repeat(64)},
    (p:any)=>{p.rows[0].nativeFingerprint='0'.repeat(64)},
    (p:any)=>{p.rows[0].contentHash='0'.repeat(64)},
    (p:any)=>{p.rows[0].bodyChangeRevision=String(BigInt(p.rows[0].bodyChangeRevision)+1n)},
    (p:any)=>{p.rows[0].ref.rowVersion=String(BigInt(p.rows[0].ref.rowVersion)+1n)},
    (p:any)=>{p.rows[0].ref.fingerprint='0'.repeat(64)},
   ]){const invalid=structuredClone(expected);mutate(invalid);const args=[...prepared.values];args[3]=JSON.stringify(invalid);expect(await prepared.verify(args)).toEqual([{locked:false}])}
   const projectJob=outcomes.find(o=>o.type==='project_shared_source').job
   for(const mutation of [
    {sql:"UPDATE memory_jobs SET state='dead' WHERE job_id=$1",values:[projectJob]},
    {sql:"UPDATE memory_jobs SET state='running' WHERE job_id=$1",values:[projectJob]},
    {sql:'UPDATE memory_jobs SET completed_at=NULL WHERE job_id=$1',values:[projectJob]},
    {sql:'DELETE FROM memory_jobs WHERE job_id=$1',values:[projectJob]},
    {sql:"UPDATE memory_jobs SET payload=jsonb_set(payload,'{target_cursor}','\"wrong\"') WHERE job_id=$1",values:[projectJob]},
   ])expect(await prepared.verify(undefined,mutation)).toEqual([{locked:false}])
   expect(await prepared.verify()).toEqual({error:{code:'P0001',message:'source_metadata_scan_changed'}})
   release.resolve();await run
   expect((await f.runtime.query('SELECT attempts FROM memory_jobs WHERE job_id=$1',[originalJob.job_id])).rows[0].attempts).toBe(originalJob.attempts)
   expect((await f.runtime.query('SELECT count(*)::int AS n FROM work_episodes WHERE installation_id=$1',[installation])).rows[0].n).toBe(0)
   // Desired typed metadata replacement wait, not generic FALSE-to-busy.
   expect(outcomes.find(o=>o.type==='compile_episode')?.outcome).toBe('deferred')
   for(let n=0;n<120;n++){
    await scheduler.runOnce();await queue.tick()
    const complete=(await f.pool.query(`SELECT (SELECT count(*)::int FROM memory.work_episodes WHERE installation_id=$1) AS episodes,
     (SELECT count(*)::int FROM memory.source_events WHERE installation_id=$1) AS refs,
     (SELECT count(*)::int FROM memory.memory_jobs WHERE installation_id=$1 AND state IN('pending','running')) AS jobs,
     (SELECT processed_revision=revision FROM shared.memory_source_work WHERE root_key=$2) AS source_complete`,[installation,root])).rows[0]
    if(complete.episodes===1&&complete.refs===3&&complete.jobs===0&&complete.source_complete)break
    if(n===119)throw Error('rollover_fresh_preparation_drain_timeout');await delay(30)
   }
   expect(errors).toEqual([])
  }finally{
   release.resolve();await run;f.runtime.off('acquire',instrument);for(const [client,query]of originals)client.query=query
   await scheduler.stop();await queue.stop()
   if(process.env.TASK21_EVIDENCE)await writeFile(process.env.TASK21_EVIDENCE,JSON.stringify({before,after,validation,actualResult,actualError,errors,outcomes},null,2)+'\n')
  }
 },15000)
})
