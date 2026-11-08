import type {SourceRoot,SourceKind} from './reader.js'
import {SourceUnavailableError} from './reader.js'
export interface SourceSqlClient {query(sql:string,parameters?:any[]):Promise<{rows:any[];rowCount:number|null}>}
export interface SourceSqlPool extends SourceSqlClient {connect():Promise<SourceSqlClient&{release():void}>}
export interface SourceWorkClaim {kind:SourceKind;rootKey:string;workerId:string;token:string;claimedRevision:string}
export const SOURCE_ERROR_CODES=['source_revoked','source_deleted','source_unavailable','version_changed','temporary_unavailable','provider_result_unknown','budget_hold'] as const
export type SourceWorkError=typeof SOURCE_ERROR_CODES[number]
export async function enqueueSourceWork(db:SourceSqlClient,root:SourceRoot):Promise<string>{
 return (await db.query('SELECT shared.mark_memory_source_dirty($1,$2)::text AS revision',[root.kind,root.key])).rows[0].revision
}
export async function claimSourceWork(db:SourceSqlClient,worker:string,leaseSeconds=30,limit=1):Promise<SourceWorkClaim[]>{
 const rows=(await db.query('SELECT source_kind,root_key,lease_owner,lease_token::text,claimed_revision::text FROM shared.claim_memory_source_work($1,$2,$3)',[worker,leaseSeconds,limit])).rows
 return rows.map(r=>({kind:r.source_kind,rootKey:r.root_key,workerId:r.lease_owner,token:r.lease_token,claimedRevision:r.claimed_revision}))
}
const parameters=(c:SourceWorkClaim)=>[c.kind,c.rootKey,c.token,c.workerId,c.claimedRevision]
/** Callback must contain bounded database work only, including source/auth/job
 * fences. guardBeforeLease acquires the ordered authority/job fences before
 * the shared root lock; commit must never acquire earlier locks. Cold/model IO
 * is completed before taking this transaction. */
export async function completeSourceWork<T>(pool:SourceSqlPool,claim:SourceWorkClaim,guardBeforeLease:(db:SourceSqlClient)=>Promise<void>,commit:(db:SourceSqlClient)=>Promise<T>):Promise<T>{
 const client=await pool.connect()
 try{
  await client.query('BEGIN')
  // Acquire maintenance/Relay owner/session fences before the root row lock.
  await guardBeforeLease(client)
  if(!(await client.query('SELECT shared.assert_memory_source_lease($1,$2,$3,$4,$5) AS valid',parameters(claim))).rows[0].valid)throw new SourceUnavailableError('source_lease_lost')
  const result=await commit(client)
  if(!(await client.query('SELECT shared.ack_memory_source_work($1,$2,$3,$4,$5) AS valid',parameters(claim))).rows[0].valid)throw new SourceUnavailableError('source_lease_lost')
  await client.query('COMMIT');return result
 }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}
export async function failSourceWork(db:SourceSqlClient,claim:SourceWorkClaim,code:SourceWorkError):Promise<void>{
 if(!SOURCE_ERROR_CODES.includes(code))throw new Error('invalid_source_error_code')
 if(!(await db.query('SELECT shared.fail_memory_source_work($1,$2,$3,$4,$5,$6) AS valid',[...parameters(claim),code])).rows[0].valid)throw new SourceUnavailableError('source_lease_lost')
}
