import type pg from 'pg'
export class SourceProcessingPurgeBlocked extends Error {
 constructor(){super('source_processing_pin_active');this.name='SourceProcessingPurgeBlocked'}
}
/** Called only after the ordinary lifecycle executor's complete component
 * fence. An absent independent-mode contract is inert; installed unknown or
 * inaccessible contracts fail closed. Privacy deletion never calls this. */
export async function assertNoSourceProcessingPins(db:Pick<pg.PoolClient,'query'>,owner:number,sessionIds:string[]):Promise<void>{
 const exists=(await db.query("SELECT to_regclass('shared.memory_source_contract') IS NOT NULL AS installed")).rows[0]?.installed
 if(!exists)return
 const contract=(await db.query('SELECT to_jsonb(c)->>\'processing_pin_version\' AS version FROM shared.memory_source_contract c')).rows
 if(contract.length!==1||contract[0].version!=='1')throw Error('source_processing_pin_contract_unavailable')
 const blocked=(await db.query('SELECT shared.memory_source_processing_blocks_purge($1,$2::text[]) AS blocked',[owner,sessionIds])).rows[0]?.blocked
 if(blocked===true)throw new SourceProcessingPurgeBlocked()
 if(blocked!==false)throw Error('source_processing_pin_contract_unavailable')
}
