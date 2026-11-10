import type pg from 'pg'
import {performance} from 'node:perf_hooks'

/** One controlled SQL observation, never an entire reader/archive operation.
 * PostgreSQL bounds execution; the independent monotonic deadline also bounds
 * acquisition and missing transport responses, including COMMIT/ROLLBACK. */
export async function boundedSourceQuery(pool:pg.Pool,sql:string,args?:any[]):Promise<pg.QueryResult>{
 const started=performance.now(),connectionDeadline=started+1000,totalDeadline=started+8000
 const unavailable=()=>Error('source_query_deadline_exceeded')
 let expired=false,connectionExpired=false,released=false,client:pg.PoolClient|undefined
 let failure:{error:unknown}|undefined
 let totalTimer:ReturnType<typeof setTimeout>|undefined,connectTimer:ReturnType<typeof setTimeout>|undefined
 const discard=(c:pg.PoolClient)=>{
  // release(true) evicts the pool slot. Force socket destruction as well:
  // graceful end alone cannot bound a half-open connected transport.
  try{(c as unknown as {connection?:{stream?:{destroy():void}}}).connection?.stream?.destroy()}catch{}
  try{c.release(true)}catch{}
 }
 const release=(destroy:boolean)=>{if(!client||released)return;released=true;if(destroy)discard(client);else client.release()}
 const live=()=>{
  if(expired||released||performance.now()>=totalDeadline){expired=true;throw unavailable()}
 }
 const operation=(async()=>{
  try{
   const connected=pool.connect().then(c=>{
    if(expired||connectionExpired||performance.now()>=connectionDeadline){discard(c);throw unavailable()}
    return c
   })
   client=await Promise.race([connected,new Promise<never>((_,reject)=>{
    connectTimer=setTimeout(()=>{connectionExpired=true;reject(unavailable())},Math.max(0,connectionDeadline-performance.now()))
   })]).finally(()=>clearTimeout(connectTimer))
   live();await client.query('BEGIN READ ONLY')
   live();await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'")
   live();const result=await client.query(sql,args)
   live();await client.query('COMMIT')
   live();return result
  }catch(error){
   failure={error}
   // Preserve the original database error for the shared store's existing
   // revoked/deleted/changed mapping. Failed cleanup evicts the connection.
   if(client&&!expired&&!released){try{live();await client.query('ROLLBACK')}catch{release(true)}}
   throw error
  }finally{release(expired)}
 })()
 const deadline=new Promise<never>((_,reject)=>{
  totalTimer=setTimeout(()=>{expired=true;release(true);reject(failure?failure.error:unavailable())},Math.max(0,totalDeadline-performance.now()))
 })
 // Both races attach rejection handlers to their losing operation: a late
 // connection is destroyed and late query/rollback errors stay consumed.
 return Promise.race([operation,deadline]).finally(()=>{clearTimeout(totalTimer);clearTimeout(connectTimer)})
}
