import {expect,test} from 'vitest'
import type pg from 'pg'
import {createJobWorker} from '../jobs/worker.js'
import {createSharedSourceScheduler} from '../sources/shared-scheduler.js'
import {bindSourcePool} from '../sources/pool-context.js'
import {withSourceJobExecution,sourceExecutionTokenFor,sourceProviderRequestKey} from '../sources/source-execution.js'
const inst='30000000-0000-0000-0000-000000000001',fenceA={jobId:'job-a',claimedBy:'worker-a',claimEpoch:1}
function fixture(){
 const captures:string[]=[],client={query:async(sql:string,args:any[])=>{if(sql.includes('shared.capture_memory_job_source(')){captures.push(args[0]);return{rows:[{execution:{branch:'canonical-active',claimEpoch:String(args[2]),executionId:'exec-'+args[0],installationId:inst,generation:'3',controlRevision:'4'}}]}}return{rows:[]}},release:()=>{}}
 const pool={connect:async()=>client}as unknown as pg.Pool;bindSourcePool(pool,{namespace:'memory'});return{pool,captures}
}
test('a durable A callback waking B starts B with fresh source authority and restores A',async()=>{
 const {pool,captures}=fixture(),errors:unknown[]=[],tokens:object[]=[],keys:(string|undefined)[]=[],signal=new AbortController().signal
 const claims:any[]=[{job_id:'job-b',job_type:'compile_episode',installation_id:inst,claim_epoch:1,payload:{},attempts:1}]
 let finish!:()=>void;const finished=new Promise<void>(r=>{finish=r}),jobs={claimJobs:async()=>claims.splice(0),completeJob:async()=>{finish();return true},rescheduleJob:async()=>{finish();return false}}
 const worker=createJobWorker({pool,jobs:jobs as any,workerId:'worker-b',signal,onError:e=>errors.push(e)})
 worker.register('compile_episode',async()=>{tokens.push(sourceExecutionTokenFor(pool,inst)!);keys.push(sourceProviderRequestKey('test',[]))});worker.start()
 try{await withSourceJobExecution(pool,fenceA,async()=>{
  const parent=sourceExecutionTokenFor(pool,inst),key=sourceProviderRequestKey('test',[]);worker.wake();await Promise.race([finished,new Promise(r=>setTimeout(r,200))]);expect(errors).toEqual([]);expect(tokens).toHaveLength(1);expect(tokens[0]).not.toBe(parent);expect(keys[0]).not.toBe(key);expect(sourceExecutionTokenFor(pool,inst)).toBe(parent)
 });expect(captures).toEqual(['job-a','job-b'])}finally{await worker.stop()}
})
test('direct nested cross-job execution remains rejected with the original strict mismatch guard',async()=>{
 const {pool,captures}=fixture();await withSourceJobExecution(pool,fenceA,async()=>{await expect(withSourceJobExecution(pool,{jobId:'job-b',claimedBy:'worker-b',claimEpoch:1},async()=>{})).rejects.toThrow('source_execution_scope_mismatch')});expect(captures).toEqual(['job-a'])
})

test('automatic source scheduler timers run outside the caller job execution context',async()=>{
 const {pool}=fixture(),observed:(object|undefined)[]=[],connect=pool.connect.bind(pool)
 pool.connect=(async()=>{const c:any=await connect();const query=c.query.bind(c);return{...c,query:async(sql:string,args:any[])=>{if(sql.includes('activation_ready'))observed.push(sourceExecutionTokenFor(pool,inst));return query(sql,args)}}})as any
 const scheduler=createSharedSourceScheduler({pool,workerId:'neutral-source',signal:new AbortController().signal})
 try{await withSourceJobExecution(pool,fenceA,async()=>{const token=sourceExecutionTokenFor(pool,inst);scheduler.start();await new Promise(r=>setTimeout(r,20));expect(observed).toEqual([undefined]);expect(sourceExecutionTokenFor(pool,inst)).toBe(token)})}finally{await scheduler.stop()}
})
