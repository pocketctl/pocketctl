import type pg from 'pg'
import type {SourceWorkClaim} from '@pocketctl/session-source'
import {claimSourceWork,failSourceWork} from './shared-work.js'
import {resumeSourceDistribution,stepSourceDistribution,dispatchSourceDistribution} from './source-distribution.js'
import {sourceConnectionKey,sourcePoolContext} from './pool-context.js'
import {createNonOverlappingPoller} from '../non-overlapping-poller.js'

interface ControlClaim {control_kind:string;control_key:string;lease_token:string;claimed_revision:string}
/** Two bounded metadata pages per pass: one control/bootstrap page and one
 * distribution page. No body, network, model or active projection runs here.
 * Durable checkpoints survive lost responses; leases span passes, not SQL
 * transactions. Renewal keeps a large valid scan from exhausting retries. */
export function createSharedSourceScheduler(options:{pool:pg.Pool;workerId:string;signal:AbortSignal;intervalMs?:number;pageSize?:number;onError?:(error:unknown)=>void}){
 const {pool,workerId,signal}=options,interval=options.intervalMs??1000,pageSize=options.pageSize??64
 if(sourceConnectionKey(pool)!==pool||sourcePoolContext(pool).namespace!=='memory')throw Error('shared_scheduler_requires_physical_pool')
 if(!workerId||workerId.length>128||!Number.isInteger(interval)||interval<100||interval>60000||!Number.isInteger(pageSize)||pageSize<1||pageSize>128)throw Error('invalid_shared_scheduler_options')
 let control:ControlClaim|undefined,source:SourceWorkClaim|undefined,timer:ReturnType<typeof setTimeout>|undefined,stopped=false
 async function query(sql:string,args?:unknown[]){
  const c=await pool.connect()
  try{
   await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'")
   const result=await c.query(sql,args);await c.query('COMMIT');return result
  }catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}
 }
 const params=(c:ControlClaim)=>[c.control_kind,c.control_key,c.lease_token,workerId,c.claimed_revision]
 async function controlPage(){
  try{
   control??=(await query('SELECT control_kind,control_key,lease_token::text,claimed_revision::text FROM shared.claim_memory_control_work($1,30,1)',[workerId])).rows[0]
   if(!control)return
   if(!(await query('SELECT shared.renew_memory_control_lease($1,$2,$3,$4,$5,30) AS valid',params(control))).rows[0].valid){control=undefined;return}
   const result=(await query('SELECT shared.step_memory_control_bootstrap($1,$2,$3,$4,$5,$6) AS result',[...params(control),pageSize])).rows[0].result
   if(result.complete)control=undefined
  }catch(error){
   if(control)await query("SELECT shared.fail_memory_control_work($1,$2,$3,$4,$5,'temporary_unavailable')",params(control)).catch(()=>undefined)
   control=undefined;options.onError?.(error)
  }
 }
 async function sourcePage(){
  try{
   source??=(await claimSourceWork(pool,workerId,30,1))[0]
   if(!source)return
   if(!(await query('SELECT shared.renew_memory_source_lease($1,$2,$3,$4,$5,30) AS valid',[source.kind,source.rootKey,source.token,source.workerId,source.claimedRevision])).rows[0].valid){source=undefined;return}
   if(source.kind==='legacy_archive'){
    // The archive is existing immutable custody, not a native publication.
    // Capture has already changed its reader version. Acknowledge only this
    // notification: no scope fan-out, positive facts, jobs or active progress.
    // The lease CAS retains a newer concurrent dirty revision for another pass.
    if(!(await query('SELECT shared.ack_memory_source_work($1,$2,$3,$4,$5) AS valid',[source.kind,source.rootKey,source.token,source.workerId,source.claimedRevision])).rows[0].valid)throw Error('source_lease_lost')
    source=undefined;return
   }
   const checkpoint=await resumeSourceDistribution(pool,source)
   if(!checkpoint||checkpoint.state==='scanning')await stepSourceDistribution(pool,source,checkpoint??undefined,pageSize)
   else if((await dispatchSourceDistribution(pool,source,checkpoint,{cursor:checkpoint.dispatchCursor},pageSize)).complete)source=undefined
  }catch(error){
   if(source)await failSourceWork(pool,source,'temporary_unavailable').catch(()=>undefined)
   source=undefined;options.onError?.(error)
  }
 }
 const poller=createNonOverlappingPoller(async()=>{
  if(stopped||signal.aborted)return
  const contract=(await query('SELECT activation_ready FROM shared.memory_source_contract WHERE singleton')).rows[0]
  if(!contract?.activation_ready)return
  await controlPage()
  if(!stopped&&!signal.aborted)await sourcePage()
 })
 function schedule(delay:number){
  if(stopped||signal.aborted)return
  timer=setTimeout(()=>{timer=undefined;void poller.runOnce().catch(error=>options.onError?.(error)).finally(()=>schedule(interval))},delay)
  timer.unref?.()
 }
 return {
  runOnce:()=>poller.runOnce(),
  start(){if(!timer&&!stopped&&!signal.aborted)schedule(0)},
  async stop(){stopped=true;if(timer)clearTimeout(timer);await poller.stop()},
 }
}
