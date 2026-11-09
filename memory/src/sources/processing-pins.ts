import type pg from 'pg'
import {canonicalJsonString,SourceUnavailableError,type SourceRoot,type SourceScope,type SourceVersion} from '@pocketctl/session-source'
interface Pin {scope:SourceScope;root:SourceRoot;version:SourceVersion}
const unavailable=()=>new SourceUnavailableError('processing_pin_expired_or_unavailable')
/** Bound the entire physical metadata operation, including transport response
 * waits and rollback. SQL timeouts are a second, independent server-side bound.
 * Destruction also prevents a late response from sending any subsequent SQL. */
async function metadata<T>(pool:pg.Pool,work:(c:pg.PoolClient)=>Promise<T>):Promise<T>{
 let expired=false,connectionExpired=false,released=false,client:pg.PoolClient|undefined
 let totalTimer:ReturnType<typeof setTimeout>|undefined,connectTimer:ReturnType<typeof setTimeout>|undefined
 const discard=(c:pg.PoolClient)=>{
  // Pool release(true) evicts the client; force socket destruction too, since
  // graceful connection.end cannot bound a half-open connected transport.
  try{(c as unknown as {connection?:{stream?:{destroy():void}}}).connection?.stream?.destroy()}catch{}
  try{c.release(true)}catch{}
 }
 const release=(destroy:boolean)=>{if(!client||released)return;released=true;if(destroy)discard(client);else client.release()}
 const live=()=>{if(expired||released)throw unavailable()}
 const operation=(async()=>{
  try{
   const connected=pool.connect().then(c=>{if(expired||connectionExpired){discard(c);throw unavailable()}return c})
   client=await Promise.race([connected,new Promise<never>((_,reject)=>{
    connectTimer=setTimeout(()=>{connectionExpired=true;reject(unavailable())},1000)
   })]).finally(()=>clearTimeout(connectTimer))
   live();await client.query('BEGIN')
   live();await client.query("SET LOCAL statement_timeout='1s';SET LOCAL lock_timeout='250ms'")
   live();const result=await work(client)
   live();await client.query('COMMIT')
   live();return result
  }catch(error){
   if(client&&!expired&&!released){try{live();await client.query('ROLLBACK')}catch{release(true)}}
   throw error
  }finally{release(expired)}
 })()
 const deadline=new Promise<never>((_,reject)=>{
  totalTimer=setTimeout(()=>{expired=true;release(true);reject(unavailable())},2000)
 })
 // Promise.race consumes late operation rejections after socket destruction.
 return Promise.race([operation,deadline]).finally(()=>{clearTimeout(totalTimer);clearTimeout(connectTimer)})
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
 private async acquire(pin:Pin,renew:boolean){
  if(this.failed||this.closed)throw unavailable()
  try{
   const ok=await metadata(this.pool,async c=>(await c.query('SELECT shared.acquire_memory_source_processing_pin($1,$2::jsonb,$3,$4::jsonb,$5) AS valid',
    [this.executionId,JSON.stringify(pin.scope),pin.root.key,JSON.stringify(pin.version),renew])).rows[0]?.valid)
   if(ok!==true)throw unavailable()
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
 private schedule(){
  if(this.timer||this.renewal||this.closed||this.failed)return
  this.timer=setTimeout(()=>{
   this.timer=undefined
   this.renewal=this.serial(()=>this.renew()).catch(()=>{this.failed=true}).finally(()=>{this.renewal=undefined;this.schedule()})
  },10000)
  this.timer.unref()
 }
 private async renew(){for(const pin of this.pins.values())await this.acquire(pin,true)}
 async assertCurrent():Promise<void>{
  if(this.failed||this.closed)throw unavailable()
  // Recheck at every new expensive dispatch/positive output boundary. A
  // timer's in-flight renewal is awaited; renewal chains cannot overlap.
  if(this.renewal)await this.renewal
  if(this.failed)throw unavailable()
  await this.serial(()=>this.renew())
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
