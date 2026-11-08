import type {SourceCommitOptions} from './prepared-sources.js'
import type pg from 'pg'
import {sourceConnectionKey,sourcePoolContext} from './pool-context.js'
export interface SourcePreparation {assertCurrent(client:Pick<pg.PoolClient,'query'>,options?:SourceCommitOptions):Promise<void>;readonly bodyBytes?:number}
export type SourcePreparationCache=Map<string,SourcePreparation>
const attached=new WeakMap<object,SourcePreparationCache>()
export const attachSourcePreparationCache=(client:object,cache:SourcePreparationCache)=>attached.set(sourceConnectionKey(client),cache)
export const detachSourcePreparationCache=(client:object)=>attached.delete(sourceConnectionKey(client))
/** Internal control transfer only. It cannot authorize a model call or a write. */
export class DeferredSourcePreparation extends Error {
 constructor(readonly key:string,readonly prepare:(pool:pg.Pool)=>Promise<SourcePreparation>){super('source_io_deferred');this.name='DeferredSourcePreparation'}
}
/** A nested service must release its outer transaction before canonical IO.
 * The owning idempotency transaction prepares once outside locks and reruns all
 * discovery/authorization/reservation checks. A plain worker Pool prepares inline
 * before its own BEGIN. Cached objects still require current-version checks. */
export function deferredSourcePreparation<T extends SourcePreparation>(pool:pg.Pool,key:string,prepare:(pool:pg.Pool)=>Promise<T>):T|undefined{
 if(sourcePoolContext(pool).namespace!=='memory'||sourceConnectionKey(pool)===pool)return undefined
 const cache=attached.get(sourceConnectionKey(pool))
 if(cache?.has(key))return cache.get(key) as T
 throw new DeferredSourcePreparation(key,prepare)
}
export async function verifySourcePreparationCache(client:Pick<pg.PoolClient,'query'>,cache:SourcePreparationCache):Promise<void>{
 for(const preparation of cache.values())await preparation.assertCurrent(client,{forCommit:true})
}
