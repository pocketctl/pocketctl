import type pg from 'pg'
import type {SourceWorkClaim} from '@pocketctl/session-source'
import {sourceConnectionKey,sourcePoolContext} from './pool-context.js'
/** Explicit graceful-shutdown cleanup; never used for crash recovery. */
export async function releaseCachedSourceClaims(pool:pg.Pool,workerId:string,claims:readonly SourceWorkClaim[],requestedDeadline:number):Promise<void>{
 if(sourceConnectionKey(pool)!==pool||sourcePoolContext(pool).namespace!=='memory')throw Error('source_cleanup_physical_pool_required')
 const captured=claims.map(c=>({...c})),kinds=new Set(['relay_event','legacy_archive','team_collaboration','team_delivery'])
 if(!workerId||workerId.length>128||captured.length>4||!Number.isFinite(requestedDeadline)||captured.some(c=>c.workerId!==workerId||!kinds.has(c.kind)||typeof c.rootKey!=='string'||!c.rootKey||c.rootKey.length>1024||typeof c.token!=='string'||!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(c.token))||new Set(captured.map(c=>c.kind+'\0'+c.rootKey)).size!==captured.length)throw Error('source_cleanup_claims_invalid')
 const deadline=Math.min(requestedDeadline,performance.now()+5000)
 if(!captured.length||performance.now()>=deadline)return
 let client:pg.PoolClient|undefined,expired=false,released=false,connectExpired=false,commitSent=false
 let totalTimer:ReturnType<typeof setTimeout>|undefined,connectTimer:ReturnType<typeof setTimeout>|undefined
 const unavailable=()=>Error(commitSent?'source_cleanup_commit_unknown':'source_cleanup_deadline')
 const discard=(c:pg.PoolClient)=>{try{(c as unknown as{connection?:{stream?:{destroy():void}}}).connection?.stream?.destroy()}catch{}try{c.release(true)}catch{}}
 const release=(destroy=false)=>{if(!client||released)return;released=true;if(destroy)discard(client);else{try{client.release()}catch(error){discard(client);throw error}}}
 const live=()=>{if(expired||released||performance.now()>=deadline)throw unavailable()}
 const query=(sql:string,args?:unknown[])=>{live();return client!.query(sql,args)}
 const operation=(async()=>{
  try{
   const connecting=pool.connect().then(c=>{if(expired||connectExpired||performance.now()>=deadline){discard(c);throw unavailable()}return c})
   client=await Promise.race([connecting,new Promise<never>((_,reject)=>{connectTimer=setTimeout(()=>{connectExpired=true;reject(unavailable())},Math.max(0,Math.min(1000,deadline-performance.now())))})]).finally(()=>clearTimeout(connectTimer))
   for(const claim of captured){
    let begun=false
    try{
     await query('BEGIN');begun=true
     await query("SET LOCAL statement_timeout='1s';SET LOCAL lock_timeout='250ms'")
     // NULL is existing same-live-token recovery, never new-worker takeover.
     const recovery=(await query('SELECT shared.resume_memory_source_distribution($1,$2,$3,$4,NULL) AS recovery',[claim.kind,claim.rootKey,claim.token,workerId])).rows[0]?.recovery
     if(!recovery||Object.keys(recovery).join(',')!=='claimedRevision'||typeof recovery.claimedRevision!=='string'||!/^[1-9]\d{0,18}$/.test(recovery.claimedRevision)||BigInt(recovery.claimedRevision)>9223372036854775807n)throw Error('source_cleanup_recovery_invalid')
     const valid=(await query('SELECT shared.fail_memory_source_work($1,$2,$3,$4,$5,$6) AS valid',[claim.kind,claim.rootKey,claim.token,workerId,recovery.claimedRevision,'temporary_unavailable'])).rows[0]?.valid
     if(valid!==true){await query('ROLLBACK');begun=false;continue}
     commitSent=true;const end=await query('COMMIT');live();commitSent=false;begun=false
     if(end.command!=='COMMIT')throw Error('source_cleanup_commit_unproven')
    }catch(error){
     if(commitSent){release(true);throw Error('source_cleanup_commit_unknown')}
     if(begun){try{await query('ROLLBACK')}catch{release(true);throw error}}
     const code=(error as{code?:string}).code
     if(code==='55P03'||code==='P0001'&&(error as Error).message==='source_lease_lost')continue
     throw error
    }
   }
  }finally{release(expired)}
 })()
 const timeout=new Promise<never>((_,reject)=>{totalTimer=setTimeout(()=>{expired=true;release(true);reject(unavailable())},Math.max(0,deadline-performance.now()))})
 // Both losing operations remain observed; late acquisition/results cannot
 // dispatch SQL or reinterpret a lost COMMIT acknowledgement as a rollback.
 try{await Promise.race([operation,timeout])}finally{clearTimeout(totalTimer);clearTimeout(connectTimer)}
}
