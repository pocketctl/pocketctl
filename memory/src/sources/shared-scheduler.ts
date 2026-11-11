import type pg from 'pg'
import type {SourceRoot,SourceWorkClaim} from '@pocketctl/session-source'
import {claimSourceWork,failSourceWork} from './shared-work.js'
import {advancePersonalSourceDistribution,resumeSourceDistribution,stepSourceDistribution,dispatchSourceDistribution,recoverSourceDistributionClaim,sourceDistributionTransportLost} from './source-distribution.js'
import {sourceConnectionKey,sourcePoolContext} from './pool-context.js'
import {createNonOverlappingPoller} from '../non-overlapping-poller.js'
import {runOutsideSourceJobExecution} from './source-execution.js'
import {createRelayCommitWakeListener} from './relay-commit-wake.js'
import {releaseCachedSourceClaims} from './source-claim-cleanup.js'

interface ControlClaim {control_kind:string;control_key:string;lease_token:string;claimed_revision:string}
type PageOutcome='idle'|'progress'|'rotate'|'yield'
/** One control/source metadata round per explicit pass. Automatic polling can
 * continue successful pages in a bounded burst; physical transactions remain
 * separate and every page retains its full current database authority check. */
export function createSharedSourceScheduler(options:{pool:pg.Pool;workerId:string;signal:AbortSignal;intervalMs?:number;pageSize?:number;refreshInstallations?:()=>Promise<unknown>;refreshWithdrawals?:()=>Promise<unknown>;onDispatch?:()=>void;listenForRelay?:boolean;onError?:(error:unknown)=>void}){
 const {pool,workerId,signal}=options,interval=options.intervalMs??1000,pageSize=options.pageSize??64
 if(sourceConnectionKey(pool)!==pool||sourcePoolContext(pool).namespace!=='memory')throw Error('shared_scheduler_requires_physical_pool')
 if(!workerId||workerId.length>128||!Number.isInteger(interval)||interval<100||interval>60000||!Number.isInteger(pageSize)||pageSize<1||pageSize>128)throw Error('invalid_shared_scheduler_options')
 let control:ControlClaim|undefined,source:SourceWorkClaim|undefined,timer:ReturnType<typeof setTimeout>|undefined,stopped=false,started=false
 let initialized=false,inventoryToken:string|undefined,continueFast=false,ordinaryIdle=true,burstRounds=0,burstStarted=0
 let stopping:Promise<void>|undefined,automaticPass=false,wakeRequested=false,lastWakeAt=-Infinity
 // FIFO contains only exact live-token candidates, never authority. Four is
 // a strict lease-admission bound, including the active source; all SQL remains
 // sequential on the original pool and every revisit recovers/renews normally.
 const parked:SourceWorkClaim[]=[],deferredRoots=new Map<string,number>(),maxHeldSources=4
 // Only records an acknowledged frontier, never lease authority. Every visit
 // still crosses strict SQL renewal; any lost response requires recovery first.
 const confirmedFrontiers=new Set<string>()
 const key=(claim:SourceWorkClaim)=>claim.kind+'\0'+claim.rootKey
 const park=(defer=false)=>{if(source){if(defer)deferredRoots.set(key(source),performance.now()+interval);parked.push(source);source=undefined}}
 async function nextSource(){
  if(source)return
  if(parked.length<maxHeldSources){
   source=(await claimSourceWork(pool,workerId,30,1))[0]
   if(source){
    // Only ordinary SQL claim may reacquire an expired queued root. Discard
    // its obsolete local token so it cannot occupy a second queue slot.
    const stale=parked.findIndex(claim=>key(claim)===key(source!))
    if(stale>=0){confirmedFrontiers.delete(parked[stale].token);parked.splice(stale,1)}
    confirmedFrontiers.delete(source.token)
    deferredRoots.delete(key(source))
    return
   }
  }
  const index=parked.findIndex(claim=>(deferredRoots.get(key(claim))??-Infinity)<=performance.now())
  if(index>=0){source=parked.splice(index,1)[0];deferredRoots.delete(key(source))}
 }
 const active=()=>!stopped&&!signal.aborted,halted=Error('shared_scheduler_stopped')
 async function query(sql:string,args?:unknown[]){
  if(!active())throw halted
  const c=await pool.connect();let begun=false
  try{
   if(!active())throw halted
   await c.query('BEGIN');begun=true
   if(!active())throw halted
   await c.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'")
   if(!active())throw halted
   const result=await c.query(sql,args);await c.query('COMMIT');begun=false;return result
  }catch(error){if(begun)await c.query('ROLLBACK');throw error}finally{c.release()}
 }
 // 55P03 proves metadata lock contention, never ownership. Keep the cached
 // token only for another full SQL authority check; expired/stolen claims still
 // return FALSE (or lease_lost) and are discarded without admitting a page.
 const busy=(error:unknown)=>(error as {code?:unknown}|null)?.code==='55P03'
 const params=(c:ControlClaim)=>[c.control_kind,c.control_key,c.lease_token,workerId,c.claimed_revision]
 async function controlPage():Promise<PageOutcome>{
  try{
   if(!active())return 'yield'
   control??=(await query('SELECT control_kind,control_key,lease_token::text,claimed_revision::text FROM shared.claim_memory_control_work($1,30,1)',[workerId])).rows[0]
   if(!active())return 'yield'
   if(!control)return 'idle'
   if(inventoryToken!==control.lease_token){await options.refreshInstallations?.();if(!active())return 'yield';inventoryToken=control.lease_token}
   const valid=(await query('SELECT shared.renew_memory_control_lease($1,$2,$3,$4,$5,30) AS valid',params(control))).rows[0].valid
   if(!active())return 'yield'
   if(!valid){control=undefined;return 'yield'}
   const result=(await query('SELECT shared.step_memory_control_bootstrap($1,$2,$3,$4,$5,$6) AS result',[...params(control),pageSize])).rows[0].result
   if(result.complete)control=undefined
   return 'progress'
  }catch(error){
   if(error===halted||!active()||busy(error))return 'yield'
   if(control)await query("SELECT shared.fail_memory_control_work($1,$2,$3,$4,$5,'temporary_unavailable')",params(control)).catch(()=>undefined)
   control=undefined;options.onError?.(error);return 'yield'
  }
 }
 async function sourcePage():Promise<PageOutcome>{
  try{
   if(!active())return 'yield'
   await nextSource()
   if(!active())return 'yield'
   if(!source)return 'idle'
   // Reconcile a new token or an unknown page reply BEFORE strict renewal.
   // A positively acknowledged page already supplied its exact durable
   // frontier; repeating its recovery-only transaction adds no authority.
   if(!confirmedFrontiers.has(source.token)){
    const recovered=await recoverSourceDistributionClaim(pool,source)
    source={...source,claimedRevision:recovered.claimedRevision}
    confirmedFrontiers.add(source.token)
   }
   if(!active())return 'yield'
   if(source.kind==='relay_event'){
    const result=await advancePersonalSourceDistribution(pool,source,pageSize,active)
    if(!active())return 'yield'
    if(!result.valid){confirmedFrontiers.delete(source.token);source=undefined;return 'yield'}
    if('step'in result){
     if('waiting'in result.step){source={...source,claimedRevision:result.step.claimedRevision};park(true);return 'rotate'}
    }else{
     if(result.dispatched.complete){confirmedFrontiers.delete(source.token);source=undefined}
     if(result.dispatched.pageCount>0)options.onDispatch?.()
    }
    park();return 'progress'
   }
   const valid=(await query('SELECT shared.renew_memory_source_lease($1,$2,$3,$4,$5,30) AS valid',[source.kind,source.rootKey,source.token,source.workerId,source.claimedRevision])).rows[0].valid
   if(!active())return 'yield'
   if(!valid){confirmedFrontiers.delete(source.token);source=undefined;return 'yield'}
   if(source.kind==='legacy_archive'){
    // Acknowledge this immutable-custody notification only. The existing lease
    // CAS retains a newer concurrent dirty revision for another pass.
    if(!(await query('SELECT shared.ack_memory_source_work($1,$2,$3,$4,$5) AS valid',[source.kind,source.rootKey,source.token,source.workerId,source.claimedRevision])).rows[0].valid)throw Error('source_lease_lost')
    confirmedFrontiers.delete(source.token);source=undefined;return 'progress'
   }
   const checkpoint=await resumeSourceDistribution(pool,source)
   if(!active())return 'yield'
   if(!checkpoint||checkpoint.state==='scanning'){
    const step=await stepSourceDistribution(pool,source,checkpoint??undefined,pageSize)
    if('waiting'in step){source={...source,claimedRevision:step.claimedRevision};park(true);return 'rotate'}
   }
   else{
    const dispatched=await dispatchSourceDistribution(pool,source,checkpoint,{cursor:checkpoint.dispatchCursor},pageSize)
    if(dispatched.complete){confirmedFrontiers.delete(source.token);source=undefined}
    if(dispatched.pageCount>0)options.onDispatch?.()
   }
   park();return 'progress'
  }catch(error){
   if(error===halted||!active())return 'yield'
   if(busy(error)||sourceDistributionTransportLost(error)){
    if(source&&sourceDistributionTransportLost(error))confirmedFrontiers.delete(source.token)
    park(true);return 'yield'
   }
   if(source)await failSourceWork(pool,source,'temporary_unavailable').catch(()=>undefined)
   if(source)confirmedFrontiers.delete(source.token)
   source=undefined;options.onError?.(error);return 'yield'
  }
 }
 const poller=createNonOverlappingPoller(async()=>{
  continueFast=false;ordinaryIdle=true
  if(!active())return
  try{
   const contract=(await query('SELECT activation_ready FROM shared.memory_source_contract WHERE singleton')).rows[0]
   if(!active()||!contract?.activation_ready)return
   if(!initialized){await options.refreshInstallations?.();if(!active())return;initialized=true}
   await options.refreshWithdrawals?.()
   if(!active())return
   const c=await controlPage()
   if(!active())return
   const s=await sourcePage()
   ordinaryIdle=c==='yield'||s==='yield'
   // Successful pages/ACKs warrant at most a bounded next-work probe. A lease
   // renewal/read alone never does. Any contention/error wins over progress
   // from the other kind. Rotation only probes a DIFFERENT nondeferred root;
   // all-waiting/empty admission restores the ordinary idle interval.
   continueFast=active()&&c!=='yield'&&s!=='yield'&&(c==='progress'||s==='progress'||s==='rotate')
  }catch(error){if(error!==halted)throw error}
 })
 const listener=options.listenForRelay?createRelayCommitWakeListener({pool,signal,wake:()=>requestWake(),onError:options.onError}):undefined
 function wakeDelay(){return Math.max(0,100-(performance.now()-lastWakeAt))}
 function idleDelay(){
  // A global hint cannot postpone a waiting root's original fallback deadline.
  // Expired entries do not create a zero-delay loop after contention/yield.
  const now=performance.now();let delay=interval
  for(const until of deferredRoots.values())if(until>now)delay=Math.min(delay,until-now)
  return delay
 }
 function requestWake(){
  if(!started||!active())return
  if(automaticPass){wakeRequested=true;return}
  if(timer)clearTimeout(timer)
  burstRounds=0;schedule(wakeDelay(),true)
 }
 function schedule(delay:number,woken=false){
  if(!active())return
  timer=runOutsideSourceJobExecution(()=>setTimeout(()=>{
   timer=undefined
   if(woken)lastWakeAt=performance.now()
   // Only this root's durable-ready hint or its original bounded fallback
   // releases waiting admission; unrelated Relay hints carry no such fact.
   if(!burstRounds)burstStarted=performance.now()
   burstRounds++;automaticPass=true
   void poller.runOnce().catch(error=>{continueFast=false;options.onError?.(error)}).finally(()=>{
    // 16 rounds is a strict admission cap. The 100ms elapsed check is
    // cooperative, between awaited rounds, not a deadline for an in-flight SQL
    // transaction (which retains its existing 5s statement/1s lock timeouts).
    automaticPass=false
    if(wakeRequested){wakeRequested=false;burstRounds=0;schedule(wakeDelay(),true);return}
    const fast=continueFast&&burstRounds<16&&performance.now()-burstStarted<100
    if(!fast)burstRounds=0
    schedule(fast?0:ordinaryIdle?interval:idleDelay())
   })
  },delay))
  timer.unref?.()
 }
 return {
  // A durable personal projection may finish after normal source ACK released
  // its claim. Hint only a fresh ordinary pass; SQL grants all new authority.
  wake(root:SourceRoot){
   if(!started||!active()||root.kind!=='relay_event'||typeof root.key!=='string'||!root.key||root.key.length>1024)return
   const rootKey=root.kind+'\0'+root.key
   deferredRoots.delete(rootKey)
   requestWake()
  },
  runOnce:()=>{if(!started)deferredRoots.clear();return poller.runOnce()},
  start(){if(!started&&active()){started=true;schedule(0);void runOutsideSourceJobExecution(()=>listener?.start())}},
  stop({releaseOwnedClaims=false}:{releaseOwnedClaims?:boolean}={}){
   if(stopping)return stopping
   stopped=true;if(timer)clearTimeout(timer)
   const deadline=performance.now()+5000
   stopping=(async()=>{
    await Promise.all([poller.stop(),listener?.stop()])
    const cached=[...(source?[source]:[]),...parked]
    source=undefined;parked.length=0;confirmedFrontiers.clear()
    if(releaseOwnedClaims&&cached.length){try{await releaseCachedSourceClaims(pool,workerId,cached,deadline)}catch(error){options.onError?.(error)}}
   })()
   return stopping
  },
 }
}
