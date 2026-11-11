import type pg from 'pg'
import {AsyncLocalStorage} from 'node:async_hooks'
import {JobDeferredError} from '../jobs/types.js'
import {canonicalJsonString,SourceUnavailableError,type SourceRoot,type SourceScope,type SourceVersion} from '@pocketctl/session-source'
import {sourceConnectionKey} from './pool-context.js'
interface Pin {scope:SourceScope;root:SourceRoot;version:SourceVersion;currentProtection?:true}
const unavailable=()=>new SourceUnavailableError('processing_pin_expired_or_unavailable')
const protectionQueues=new WeakMap<object,Map<string,Promise<void>>>()
const protectionOwner=new AsyncLocalStorage<{identity:object;installationId:string;active:boolean}>()
/** Exact selected-source SQL contention, distinct from policy/version waits. */
export class SelectedSourceLockBusy extends JobDeferredError {
 constructor(){super('source_not_ready',new Date(Date.now()+1000))}
}
export class SelectedSourceTransactionUnavailable extends JobDeferredError {
 readonly code:string
 constructor(readonly commitOutcome:'not-dispatched'|'unknown'|'committed'='not-dispatched'){
  super('source_not_ready',new Date(Date.now()+1000))
  this.code=commitOutcome==='unknown'?'source_metadata_commit_outcome_unknown':commitOutcome==='committed'?'source_metadata_commit_acknowledged':'source_metadata_transaction_unavailable'
 }
}
async function withinProtectionDeadline(work:Promise<void>,deadline:number,expire=()=>{}){
 let timer:ReturnType<typeof setTimeout>|undefined
 try{await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expire();reject(unavailable())},Math.max(0,deadline-performance.now()))})])}
 finally{clearTimeout(timer)}
}
/** The database already serializes this exact installation metadata section.
 * Queue same-process protection operations before checkout, with their ORIGINAL
 * deadlines; never serialize bodies or hold a SQL connection while queued. */
async function currentProtectionSerial<T>(pool:pg.Pool,installationId:string,deadline:number,active:()=>boolean,work:()=>Promise<T>,signal?:AbortSignal,failure:()=>Error=unavailable):Promise<T>{
 const identity=sourceConnectionKey(pool),owner=protectionOwner.getStore()
 if(owner?.active&&owner.identity===identity&&owner.installationId===installationId)throw Error('source_metadata_nested_operation')
 let queues=protectionQueues.get(identity);if(!queues){queues=new Map();protectionQueues.set(identity,queues)}
 const previous=queues.get(installationId)??Promise.resolve();let begun=false,cancelled=false
 const queued=previous.then(async()=>{
  if(cancelled||!active()||signal?.aborted||performance.now()>=deadline)throw failure()
  begun=true;const ownership={identity,installationId,active:true}
  try{return await protectionOwner.run(ownership,work)}finally{ownership.active=false}
 })
 const tail=queued.then(()=>undefined,()=>undefined);queues.set(installationId,tail)
 void tail.then(()=>{if(queues!.get(installationId)===tail)queues!.delete(installationId)})
 let timer:ReturnType<typeof setTimeout>|undefined,abort:(()=>void)|undefined
 const waiting=new Promise<never>((_,reject)=>{
  timer=setTimeout(()=>{if(!begun){cancelled=true;reject(failure())}},Math.max(0,deadline-performance.now()))
  abort=()=>{cancelled=true;if(!begun)reject(failure())}
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true})
 })
 try{return await Promise.race([queued,waiting])}
 finally{clearTimeout(timer);if(abort)signal?.removeEventListener('abort',abort)}
}
/** Selected bodies are already prepared. The queue is local contention
 * avoidance only; the callback keeps every original SQL authority fence. */
export function runSelectedSourceTransaction<T>(pool:pg.Pool,installationId:string,signal:AbortSignal|undefined,work:(client:pg.PoolClient)=>Promise<T>):Promise<T>{
 const deadline=performance.now()+5000
 return currentProtectionSerial(pool,installationId,deadline,()=>!signal?.aborted,
  async()=>{
   for(let attempt=0;;attempt++){
    if(signal?.aborted||performance.now()>=deadline)throw new SelectedSourceTransactionUnavailable()
    let retrySafe=false
    try{return await metadata(pool,work,deadline,()=>!signal?.aborted,signal,true,()=>{retrySafe=true})}
    catch(error){
     if(!retrySafe||attempt>=3)throw error
     // The prior physical transaction is released. Repeat all authority
     // checks with the SAME prepared proof and original absolute deadline.
     await new Promise(resolve=>setTimeout(resolve,Math.max(0,Math.min(10,deadline-performance.now()))))
    }
   }
  },signal,()=>new SelectedSourceTransactionUnavailable())
}
/** Bound the entire physical metadata operation, including transport response
 * waits and rollback. SQL timeouts are a second, independent server-side bound.
 * Destruction also prevents a late response from sending any subsequent SQL. */
async function metadata<T>(pool:pg.Pool,work:(c:pg.PoolClient)=>Promise<T>,deadline=performance.now()+2000,active=()=>true,signal?:AbortSignal,selected=false,onRetryableRollback?:()=>void):Promise<T>{
 let expired=false,connectionExpired=false,released=false,client:pg.PoolClient|undefined,originalQuery:pg.PoolClient['query']|undefined
 let commitSent=false,commitAcknowledged=false,callbackActive=false,primaryFailureKnown=false
 let primaryFailure:unknown
 // Once a policy/predicate or authoritative server denial is known, cleanup
 // transport loss must not turn that failure into a successful-looking defer.
 const failure=()=>selected&&primaryFailureKnown?primaryFailure:selected?new SelectedSourceTransactionUnavailable(commitAcknowledged?'committed':commitSent?'unknown':'not-dispatched'):unavailable()
 let totalTimer:ReturnType<typeof setTimeout>|undefined,connectTimer:ReturnType<typeof setTimeout>|undefined
 let abort:(()=>void)|undefined
 const discard=(c:pg.PoolClient)=>{
  // Pool release(true) evicts the client; force socket destruction too, since
  // graceful connection.end cannot bound a half-open connected transport.
  try{(c as unknown as {connection?:{stream?:{destroy():void}}}).connection?.stream?.destroy()}catch{}
  try{c.release(true)}catch{}
 }
 const release=(destroy:boolean)=>{if(!client||released)return;released=true;if(destroy)discard(client);else{
  if(originalQuery)client.query=originalQuery
  try{client.release()}catch(error){discard(client);throw error}
 }}
 const live=()=>{if(expired||released||!active()||performance.now()>=deadline)throw failure()}
 // A retry shares its caller's original deadline, including pool checkout.
 if(!active()||performance.now()>=deadline)throw failure()
 const operation=(async()=>{
  try{
   const connected=pool.connect().then(c=>{if(expired||connectionExpired){discard(c);throw failure()}return c})
   client=await Promise.race([connected,new Promise<never>((_,reject)=>{
    connectTimer=setTimeout(()=>{connectionExpired=true;reject(failure())},1000)
   })]).finally(()=>clearTimeout(connectTimer))
   if(selected){
    originalQuery=client.query;const physical=client,query=originalQuery
    client.query=function(...args:any[]){
     live();const sql=typeof args[0]==='string'?args[0]:args[0]?.text??''
     if(callbackActive&&/^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql.trim()))throw Error('source_metadata_nested_transaction')
     if(/^COMMIT\b/i.test(sql.trim()))commitSent=true
     return (query as any).apply(physical,args)
    } as pg.PoolClient['query']
   }
   live();await client.query('BEGIN')
   live();await client.query(selected?"SET LOCAL statement_timeout='1s';SET LOCAL lock_timeout='1s'":"SET LOCAL statement_timeout='1s';SET LOCAL lock_timeout='250ms'")
   live();let result:T
   callbackActive=true
   try{result=await work(client)}finally{callbackActive=false}
   live();await client.query('COMMIT');commitAcknowledged=true
   live();return result
  }catch(error){
   const code=(error as {code?:string}).code
   if(selected&&commitSent&&!commitAcknowledged&&(!code||!(/^[0-9A-Z]{5}$/.test(code))||code.startsWith('08')||code.startsWith('57'))){release(true);throw failure()}
   // COMMIT uncertainty above takes precedence; only a known primary failure
   // reaches cleanup. Retain it across a hung rollback or cancellation.
   if(selected){primaryFailure=error;primaryFailureKnown=true}
   if(client&&!expired&&!released){try{
    live();await client.query('ROLLBACK');live()
    if(selected&&!commitSent&&(error instanceof SelectedSourceLockBusy||code==='55P03'&&(error as Error).message==='source_metadata_lock_busy')){
     release(false);onRetryableRollback?.()
    }
   }catch{release(true)}}
   throw error
  }finally{
   try{release(expired)}catch(error){if(!selected||!primaryFailureKnown)throw error}
  }
 })()
 const timeout=new Promise<never>((_,reject)=>{
  totalTimer=setTimeout(()=>{expired=true;release(true);reject(failure())},Math.max(0,deadline-performance.now()))
 })
 // Promise.race consumes late operation rejections after socket destruction.
 const cancelled=new Promise<never>((_,reject)=>{abort=()=>{expired=true;release(true);reject(failure())};if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true})})
 return Promise.race([operation,timeout,cancelled]).finally(()=>{clearTimeout(totalTimer);clearTimeout(connectTimer);if(abort)signal?.removeEventListener('abort',abort)})
}
/** Private execution lifetime: one renewal chain, no timer promise rejection,
 * no source/body data persisted, and no transaction spans the caller's IO. */
export class SourceProcessingPins {
 private readonly pins=new Map<string,Pin>()
 private timer:ReturnType<typeof setTimeout>|undefined
 private renewal:Promise<void>|undefined
 private chain:Promise<void>=Promise.resolve()
 private failed=false
 private closed=false
 private closing:Promise<void>|undefined
 constructor(private readonly pool:pg.Pool,private readonly executionId:string){}
 assertUsable():void{if(this.failed||this.closed)throw unavailable()}
 get count():number{return this.pins.size}
 private key(pin:Pin){return canonicalJsonString([pin.scope,pin.root])}
 private async acquire(pin:Pin,renew:boolean,deadline=performance.now()+2000,signal?:AbortSignal){
  try{
   if(pin.currentProtection)await currentProtectionSerial(this.pool,pin.scope.installationId,deadline,()=>!this.failed&&!this.closed&&!signal?.aborted,()=>this.acquireBounded(pin,renew,deadline,signal),signal)
   else await this.acquireBounded(pin,renew,deadline)
  }catch(error){this.failed=true;throw error}
 }
 private async acquireBounded(pin:Pin,renew:boolean,deadline:number,signal?:AbortSignal){
  if(this.failed||this.closed||signal?.aborted)throw unavailable()
  try{
   for(let attempt=0;attempt<4;attempt++){
    this.assertUsable()
    let protectedVersion=pin.version
    const ok=await metadata(this.pool,async c=>{
     // Metadata-only workflows protect a fixed selection independently of
     // its moving root. This is a fresh complete authority observation, inside
     // the SAME original 2s checkout/query/COMMIT budget on every renewal.
     // Ordinary prepared-body pins never enter this branch.
     if(pin.currentProtection){
      const current=(await c.query("SELECT * FROM shared.memory_relay_source_authority($1::jsonb,'relay_event',$2)",[JSON.stringify(pin.scope),pin.root.key])).rows[0]
      if(current?.state!=='current')return false
      protectedVersion={content:current.content_revision,authorization:current.authorization_revision,storage:current.storage_revision}
     }
     this.assertUsable();if(performance.now()>=deadline)throw unavailable()
     return (await c.query('SELECT shared.acquire_memory_source_processing_pin($1,$2::jsonb,$3,$4::jsonb,$5) AS valid',
      [this.executionId,JSON.stringify(pin.scope),pin.root.key,JSON.stringify(protectedVersion),renew])).rows[0]?.valid
    },
     deadline,()=>!this.closed&&!this.failed&&!signal?.aborted,signal)
    this.assertUsable()
    if(ok===true){pin.version=protectedVersion;return}
    if(ok!==false)throw unavailable()
    // FALSE includes permanent denial. Retry only the exact same immutable
    // metadata with the full SQL fence; never refresh a vector/window or job.
    const delay=[25,50,100][attempt]
    if(delay===undefined||performance.now()+delay>=deadline)break
    // metadata has COMMITted and returned its physical client before backoff.
    await new Promise(resolve=>setTimeout(resolve,delay))
   }
   throw unavailable()
  }catch(error){this.failed=true;throw error}
 }
 private serial(work:()=>Promise<void>):Promise<void>{
  const result=this.chain.then(work)
  this.chain=result.catch(()=>undefined)
  return result
 }
 async protect(scope:SourceScope,root:SourceRoot,version:SourceVersion):Promise<void>{
  const pin={scope:structuredClone(scope),root:{...root},version:{...version}},key=this.key(pin)
  try{await this.serial(async()=>{await this.acquire(pin,this.pins.has(key));this.pins.set(key,pin)});this.schedule()}catch(error){this.failed=true;throw error}
 }
 /** Internal metadata protection only; content proofs are held separately by
  * the opaque selected reader and its physical selected-source commit fence. */
 async protectCurrent(scope:SourceScope,root:SourceRoot):Promise<void>{
  const deadline=performance.now()+2000,controller=new AbortController()
  const pin:Pin={scope:structuredClone(scope),root:{...root},version:{content:'0',authorization:'0',storage:'0'},currentProtection:true},key=this.key(pin)
  try{await withinProtectionDeadline(this.serial(async()=>{await this.acquire(pin,this.pins.has(key),deadline,controller.signal);this.pins.set(key,pin)}),deadline,()=>controller.abort());this.schedule()}catch(error){this.failed=true;throw error}
 }
 private schedule(){
  if(this.timer||this.renewal||this.closed||this.failed)return
  this.timer=setTimeout(()=>{
   this.timer=undefined
   const deadline=[...this.pins.values()].some(p=>p.currentProtection)?performance.now()+2000:undefined
   const controller=new AbortController(),work=this.serial(()=>this.renew(deadline,controller.signal))
   this.renewal=(deadline?withinProtectionDeadline(work,deadline,()=>controller.abort()):work).catch(()=>{this.failed=true}).finally(()=>{this.renewal=undefined;this.schedule()})
  },10000)
  this.timer.unref()
 }
 private async renew(deadline?:number,signal?:AbortSignal){for(const pin of this.pins.values())await this.acquire(pin,true,pin.currentProtection?deadline:undefined,pin.currentProtection?signal:undefined)}
 async assertCurrent():Promise<void>{
  if(this.failed||this.closed)throw unavailable()
  // Recheck at every new expensive dispatch/positive output boundary. A
  // timer's in-flight renewal is awaited; renewal chains cannot overlap.
  const deadline=[...this.pins.values()].some(p=>p.currentProtection)?performance.now()+2000:undefined
  const controller=new AbortController(),work=(async()=>{if(this.renewal)await this.renewal;if(this.failed||controller.signal.aborted)throw unavailable();await this.serial(()=>this.renew(deadline,controller.signal))})()
  try{await(deadline?withinProtectionDeadline(work,deadline,()=>controller.abort()):work)}catch(error){this.failed=true;throw error}
 }
 close():Promise<void>{
  if(this.closing)return this.closing
  this.closed=true;clearTimeout(this.timer)
  // Only one already-started operation can remain; queued work sees closed.
  // Both that operation and best-effort release have total transport bounds.
  this.closing=(async()=>{
   await this.chain
   if(!this.pins.size)return
   await metadata(this.pool,async c=>{await c.query('SELECT shared.release_memory_source_processing_pins($1)',[this.executionId])}).catch(()=>undefined)
  })()
  return this.closing
 }
}
