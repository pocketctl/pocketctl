import type pg from 'pg'
const unavailable=()=>Error('team_semantic_registration_budget_exceeded')
/** Whole-operation wall deadline, including acquisition and rollback. SQL
 * statement timeouts cannot bound a half-open transport. The physical client
 * proxy guards every query, including queries sent by execution fence helpers. */
export async function teamSemanticRegistrationTransaction<T>(pool:pg.Pool,work:(client:pg.PoolClient)=>Promise<T>):Promise<T>{
 let expired=false,connectionExpired=false,released=false,client:pg.PoolClient|undefined
 let totalTimer:ReturnType<typeof setTimeout>|undefined,connectTimer:ReturnType<typeof setTimeout>|undefined
 const discard=(c:pg.PoolClient)=>{
  try{(c as unknown as {connection?:{stream?:{destroy():void}}}).connection?.stream?.destroy()}catch{}
  try{c.release(true)}catch{}
 }
 const release=(destroy:boolean)=>{if(!client||released)return;released=true;if(destroy)discard(client);else client.release()}
 const live=()=>{if(expired||released)throw unavailable()}
 const deadline=new Promise<never>((_,reject)=>{
  totalTimer=setTimeout(()=>{expired=true;release(true);reject(unavailable())},5000)
 })
 const operation=(async()=>{
  try{
   const connected=pool.connect().then(c=>{if(expired||connectionExpired){discard(c);throw unavailable()}return c})
   client=await Promise.race([connected,new Promise<never>((_,reject)=>{
    connectTimer=setTimeout(()=>{connectionExpired=true;reject(unavailable())},1000)
   })]).finally(()=>clearTimeout(connectTimer))
   live()
   const query=(...args:unknown[])=>{
    live()
    return Promise.resolve(Reflect.apply(client!.query,client,args)).then(result=>{live();return result})
   }
   const bounded=new Proxy(client,{get(target,key){return key==='query'?query:Reflect.get(target,key,target)}})
   await bounded.query('BEGIN');await bounded.query("SET LOCAL statement_timeout='1s';SET LOCAL lock_timeout='1s'")
   const result=await work(bounded);live();await bounded.query('COMMIT');live();return result
  }catch(error){
   if(client&&!expired&&!released){try{live();await client.query('ROLLBACK');live()}catch{release(true)}}
   throw error
  }finally{release(expired)}
 })()
 // Keep handlers attached to late operation/connection rejections. A destroyed
 // socket may answer later; it can neither send another statement nor release
 // the same physical client a second time.
 return Promise.race([operation,deadline]).finally(()=>{clearTimeout(totalTimer);clearTimeout(connectTimer)})
}
