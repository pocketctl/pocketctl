import type pg from 'pg'
import type {SourceWorkClaim} from '@pocketctl/session-source'
import {sourceConnectionKey,sourcePoolContext} from './pool-context.js'
export interface DistributionPage {scanId:string;state:'scanning'|'sealed';cursor:string;reset:boolean;controlRevision:string;workRevision:string;pageCount?:number}
export interface DistributionDispatch {scanId:string;cursor:string;complete:boolean;pageCount:number;workRevision:string}
export interface DistributionCheckpoint extends DistributionPage {dispatchCursor:string;dispatchComplete:boolean}
export interface DistributionWaiting {waiting:true;scanId:string;workRevision:string;claimedRevision:string}
export interface SourceClaimRecovery {claimedRevision:string}
/** Transport loss can leave a committed frontier reply unknown. Keep only the
 * exact token for read-only recovery; never classify a SQL policy denial here. */
export function sourceDistributionTransportLost(error:unknown):boolean{
 const e=error as {code?:unknown;message?:unknown}|null
 return ['ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT','57P01','57P02','57P03'].includes(String(e?.code))
  ||e?.code===undefined&&typeof e?.message==='string'&&/connection (?:terminated|closed)|socket hang up/i.test(e.message)
}
/** One page per short physical transaction. The database enumerates scopes;
 * callers cannot inject a principal, scope, body, version, or job payload. */
async function page<T>(pool:pg.Pool,fn:'step_memory_source_distribution'|'dispatch_memory_source_distribution',claim:SourceWorkClaim,scanId:string|null,cursor:string,limit:number):Promise<T>{
 if(sourceConnectionKey(pool)!==pool||sourcePoolContext(pool).namespace!=='memory')throw Error('source_distribution_requires_physical_pool')
 if(!Number.isInteger(limit)||limit<1||limit>128)throw Error('invalid_source_distribution_page')
 const client=await pool.connect()
 try{
  await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'")
  const result=(await client.query(`SELECT shared.${fn}($1,$2,$3,$4,$5,$6,$7,$8) AS result`,[claim.kind,claim.rootKey,claim.token,claim.workerId,claim.claimedRevision,scanId,cursor,limit])).rows[0].result
  await client.query('COMMIT');return result as T
 }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error}finally{client.release()}
}
export function stepSourceDistribution(pool:pg.Pool,claim:SourceWorkClaim,previous?:DistributionPage,limit=64):Promise<DistributionPage|DistributionWaiting>{
 return page(pool,'step_memory_source_distribution',claim,previous?.scanId??null,previous?.cursor??'',limit)
}
export function dispatchSourceDistribution(pool:pg.Pool,claim:SourceWorkClaim,sealed:DistributionPage,previous?:Pick<DistributionDispatch,'cursor'>,limit=64):Promise<DistributionDispatch>{
 if(sealed.state!=='sealed')throw Error('source_context_set_not_ready')
 return page(pool,'dispatch_memory_source_distribution',claim,sealed.scanId,previous?.cursor??'',limit)
}
/** Recover from a successful COMMIT whose response was lost. This must read
 * durable state using the current lease, never a caller-retained cursor. */
export async function resumeSourceDistribution(pool:pg.Pool,claim:SourceWorkClaim):Promise<DistributionCheckpoint|null>{
 if(sourceConnectionKey(pool)!==pool||sourcePoolContext(pool).namespace!=='memory')throw Error('source_distribution_requires_physical_pool')
 return (await pool.query('SELECT shared.resume_memory_source_distribution($1,$2,$3,$4,$5) AS checkpoint',
  [claim.kind,claim.rootKey,claim.token,claim.workerId,claim.claimedRevision])).rows[0].checkpoint
}
/** Separate from checkpoint resume: return only a committed, exact-token claim
 * observation. NULL revision is an explicit SQL recovery mode, not a wildcard
 * for any page/dispatch/ACK or for ordinary non-NULL resume callers. */
export async function recoverSourceDistributionClaim(pool:pg.Pool,claim:SourceWorkClaim):Promise<SourceClaimRecovery>{
 if(sourceConnectionKey(pool)!==pool||sourcePoolContext(pool).namespace!=='memory')throw Error('source_distribution_requires_physical_pool')
 const client=await pool.connect()
 try{
  await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'")
  const result=(await client.query('SELECT shared.resume_memory_source_distribution($1,$2,$3,$4,NULL) AS recovery',
   [claim.kind,claim.rootKey,claim.token,claim.workerId])).rows[0]?.recovery
  if(!result||Object.keys(result).join(',')!=='claimedRevision'||typeof result.claimedRevision!=='string'||!/^[1-9]\d{0,18}$/.test(result.claimedRevision)||BigInt(result.claimedRevision)>9223372036854775807n)throw Error('source_claim_recovery_invalid')
  await client.query('COMMIT');return result
 }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error}finally{client.release()}
}

/** Renew, resume and admit one metadata page on the same physical Client.
 * All existing SQL authority/lease/page/commit fences still run. No result is
 * observable until COMMIT is acknowledged; uncertain replies require the
 * scheduler's original exact-token recovery before this can be called again. */
export type PersonalDistributionAdvance={valid:false}|{valid:true;step:DistributionPage|DistributionWaiting}|{valid:true;dispatched:DistributionDispatch}
export async function advancePersonalSourceDistribution(pool:pg.Pool,claim:SourceWorkClaim,limit=64,active:()=>boolean=()=>true):Promise<PersonalDistributionAdvance>{
 if(sourceConnectionKey(pool)!==pool||sourcePoolContext(pool).namespace!=='memory')throw Error('source_distribution_requires_physical_pool')
 if(claim.kind!=='relay_event')throw Error('personal_distribution_requires_relay_root')
 if(!Number.isInteger(limit)||limit<1||limit>128)throw Error('invalid_source_distribution_page')
 if(!active())return {valid:false}
 const client=await pool.connect(),args=[claim.kind,claim.rootKey,claim.token,claim.workerId,claim.claimedRevision]
 try{
  if(!active())return {valid:false}
  await client.query('BEGIN')
  if(!active()){await client.query('COMMIT');return {valid:false}}
  await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'")
  if(!active()){await client.query('COMMIT');return {valid:false}}
  const valid=(await client.query('SELECT shared.renew_memory_source_lease($1,$2,$3,$4,$5,30) AS valid',args)).rows[0].valid
  let result:PersonalDistributionAdvance={valid:false}
  if(valid===true&&active()){
   const checkpoint=(await client.query('SELECT shared.resume_memory_source_distribution($1,$2,$3,$4,$5) AS checkpoint',args)).rows[0].checkpoint as DistributionCheckpoint|null
   if(!active()){await client.query('COMMIT');return {valid:false}}
   if(!checkpoint||checkpoint.state==='scanning'){
    const step=(await client.query('SELECT shared.step_memory_source_distribution($1,$2,$3,$4,$5,$6,$7,$8) AS result',[...args,checkpoint?.scanId??null,checkpoint?.cursor??'',limit])).rows[0].result as DistributionPage|DistributionWaiting
    result={valid:true,step}
   }else{
    const dispatched=(await client.query('SELECT shared.dispatch_memory_source_distribution($1,$2,$3,$4,$5,$6,$7,$8) AS result',[...args,checkpoint.scanId,checkpoint.dispatchCursor,limit])).rows[0].result as DistributionDispatch
    result={valid:true,dispatched}
   }
  }
  await client.query('COMMIT');return result
 }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error}finally{client.release()}
}
