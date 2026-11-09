import {legacyTransportRetired} from './transport-state.js'
import type pg from 'pg'
import {sourcePoolContext} from './pool-context.js'
import {guardSourceExecutionCommit} from './source-execution.js'
/** Observe before transport IO; never keep the connection or mode lock over
 * HTTP, and never recapture this generation from the returned batch. */
export async function readLegacySourceInputGeneration(pool:pg.Pool,installationId:string):Promise<string|null|undefined>{
 if(sourcePoolContext(pool).namespace==='public')return undefined
 if(await legacyTransportRetired(pool))return null
 const row=(await pool.query('SELECT mode,generation::text FROM shared.memory_source_modes WHERE installation_id=$1',[installationId])).rows[0]
 if(!row)return '1'
 if(!['legacy-feed','shared-shadow'].includes(row.mode))return null
 return row.generation
}
/** Must be called inside the transaction, before any Memory lifecycle locks.
 * The shared mode row stays locked through commit; transition waits for it.
 * Explicit public legacy operation never consults a target database.
 */
export async function lockLegacySourceInput(client:pg.PoolClient,installationId:string,expected?:string):Promise<string|null>{
 if(sourcePoolContext(client).namespace==='public')return null
 if(await legacyTransportRetired(client))throw Error('legacy_transport_retired')
 const row=(await client.query('SELECT shared.lock_memory_legacy_input($1::uuid,$2::bigint)::text AS generation',[installationId,expected??null])).rows[0]
 if(!row?.generation)throw Error('source_mode_generation_changed')
 await guardSourceExecutionCommit(client,installationId)
 return row.generation
}
export async function lockSnapshotSourceInput(client:pg.PoolClient,installationId:string,generation:number):Promise<void>{
 if(sourcePoolContext(client).namespace==='public')return
 const row=(await client.query('SELECT source_mode_generation::text FROM memory_snapshot_runs WHERE installation_id=$1 AND generation=$2 AND state=\'running\'',[installationId,generation])).rows[0]
 if(!row?.source_mode_generation)throw Error('source_mode_generation_changed')
 await lockLegacySourceInput(client,installationId,row.source_mode_generation)
}
