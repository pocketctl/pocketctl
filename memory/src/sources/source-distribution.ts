import type pg from 'pg'
import type {SourceWorkClaim} from '@pocketctl/session-source'
import {sourceConnectionKey,sourcePoolContext} from './pool-context.js'
export interface DistributionPage {scanId:string;state:'scanning'|'sealed';cursor:string;reset:boolean;controlRevision:string;workRevision:string;pageCount?:number}
export interface DistributionDispatch {scanId:string;cursor:string;complete:boolean;pageCount:number;workRevision:string}
export interface DistributionCheckpoint extends DistributionPage {dispatchCursor:string;dispatchComplete:boolean}
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
 }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
}
export function stepSourceDistribution(pool:pg.Pool,claim:SourceWorkClaim,previous?:DistributionPage,limit=64):Promise<DistributionPage>{
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
