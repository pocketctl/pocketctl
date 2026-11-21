export {enqueueSourceWork,completeSourceWork,failSourceWork} from '@pocketctl/session-source'
export type {SourceWorkClaim,SourceWorkError} from '@pocketctl/session-source'

import type pg from 'pg'
import {claimSourceWork as claimOldest, type SourceWorkClaim} from '@pocketctl/session-source'

export async function claimSourceWork(db:Pick<pg.Pool,'query'>,worker:string,seconds=30,limit=1,preferAppend?:boolean):Promise<SourceWorkClaim[]> {
 if(preferAppend===undefined)return claimOldest(db,worker,seconds,limit)
 const {rows}=await db.query(`SELECT source_kind,root_key,lease_owner,lease_token::text,claimed_revision::text
   FROM shared.claim_memory_source_work($1,$2,$3,$4)`,[worker,seconds,limit,preferAppend])
 return rows.map(row=>({kind:row.source_kind,rootKey:row.root_key,workerId:row.lease_owner,token:row.lease_token,claimedRevision:row.claimed_revision}))
}
