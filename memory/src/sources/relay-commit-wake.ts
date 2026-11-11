import type pg from 'pg'
import {isPhysicalSourcePool} from './pool-context.js'
const CHANNEL='pocketctl_realtime',BOUND_MS=1000
const discardedSocketError=()=>{}
/** Non-authoritative COMMIT hint only. One client from the existing pool;
 * payloads are never read and missing notifications retain periodic polling. */
export function createRelayCommitWakeListener(options:{pool:pg.Pool;signal:AbortSignal;wake:()=>void;onError?:(error:unknown)=>void}){
 if(!isPhysicalSourcePool(options.pool))throw Error('relay_commit_listener_requires_memory_pool')
 type Lease={client:pg.PoolClient;released:boolean;notify:(n:{channel:string})=>void;failed:(e?:unknown)=>void}
 let started=false,stopped=false,current:Lease|undefined,connecting:Promise<void>|undefined,stopping:Promise<void>|undefined
 let retry:ReturnType<typeof setTimeout>|undefined,checkoutOutstanding=false
 const active=()=>started&&!stopped&&!options.signal.aborted
 const report=(e:unknown)=>{try{options.onError?.(e)}catch{}}
 async function bounded<T>(work:Promise<T>,code:string):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined
  try{return await Promise.race([work,new Promise<never>((_r,reject)=>{timer=setTimeout(()=>reject(Error(code)),BOUND_MS)})])}
  finally{if(timer)clearTimeout(timer)}
 }
 function release(lease:Lease,destroy=false){
  if(lease.released)return
  lease.released=true;if(current===lease)current=undefined
  lease.client.off('notification',lease.notify);lease.client.off('error',lease.failed);lease.client.off('end',lease.failed)
  // Destroyed sockets can deliver one final error after the owned handlers
  // are detached. This constant sink carries no lease or reconnect capability.
  if(destroy)lease.client.on('error',discardedSocketError)
  try{if(destroy)lease.client.release(true);else lease.client.release()}catch(e){report(e)}
 }
 function scheduleRetry(){
  if(!active()||retry||checkoutOutstanding)return
  retry=setTimeout(()=>{retry=undefined;void connect()},BOUND_MS);retry.unref?.()
 }
 async function close(lease:Lease){
  if(lease.released)return
  let destroy=false
  try{await bounded(lease.client.query('UNLISTEN '+CHANNEL),'relay_commit_listener_unlisten_timeout')}
  catch(e){destroy=true;report(e)}finally{release(lease,destroy)}
 }
 function connect():Promise<void>{
  if(!active()||current||checkoutOutstanding)return Promise.resolve()
  if(connecting)return connecting
  connecting=(async()=>{
   checkoutOutstanding=true;let abandoned=false,client:pg.PoolClient
   const checkout=options.pool.connect()
   try{client=await bounded(checkout,'relay_commit_listener_checkout_timeout');checkoutOutstanding=false}
   catch(e){
    // Never accumulate more checkout requests while a timed-out pool request
    // remains pending. Its late client is destroyed before retry admission.
    abandoned=true
    void checkout.then(c=>{checkoutOutstanding=false;c.release(true);scheduleRetry()},()=>{checkoutOutstanding=false;scheduleRetry()})
    throw e
   }
   if(abandoned||!active()){client.release(true);return}
   const lease:Lease={client,released:false,notify:n=>{if(active()&&current===lease&&!lease.released&&n.channel===CHANNEL)options.wake()},failed:e=>{if(lease.released)return;release(lease,true);report(e??Error('relay_commit_listener_closed'));scheduleRetry()}}
   client.on('notification',lease.notify);client.on('error',lease.failed);client.on('end',lease.failed)
   try{
    await bounded(client.query('LISTEN '+CHANNEL),'relay_commit_listener_listen_timeout')
    if(lease.released)return
    if(!active()){await close(lease);return}
    current=lease;options.wake() // Covers committed work before LISTEN ACK.
   }catch(e){release(lease,true);throw e}
  })().catch(e=>{report(e);scheduleRetry()}).finally(()=>{connecting=undefined})
  return connecting
 }
 const abort=()=>{void stop()}
 function stop():Promise<void>{
  if(stopping)return stopping
  stopped=true;if(retry)clearTimeout(retry);retry=undefined
  options.signal.removeEventListener('abort',abort)
  stopping=(async()=>{
   const lease=current;current=undefined
   if(lease)await close(lease)
   if(connecting)await bounded(connecting,'relay_commit_listener_stop_timeout').catch(report)
  })()
  return stopping
 }
 return{
  start():Promise<void>{
   if(started||stopped||options.signal.aborted||(options.pool.options.max??10)<2)return connecting??Promise.resolve()
   started=true;options.signal.addEventListener('abort',abort,{once:true});return connect()
  },stop,
 }
}
