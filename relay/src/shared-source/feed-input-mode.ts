import type pg from 'pg'
import {ExtensionApiError} from '../extensions/errors.js'
/** First-party v1 Session input only. Shared control feeds and other
 * Providers keep their existing protocol and cursor fields. */
export async function lockMemoryFeedInput(db:Pick<pg.PoolClient,'query'>,installationId:string,providerId:string):Promise<string|undefined>{
 if(providerId!=='pocketctl-memory')return undefined
 const shared=(await db.query("SELECT to_regclass('shared.memory_source_contract') IS NOT NULL AS present")).rows[0]?.present
 if(!shared)return undefined
 let policy
 try{policy=(await db.query('SELECT shared.lock_memory_feed_source_mode($1::uuid) AS policy',[installationId])).rows[0]?.policy}
 catch(error){if((error as {code?:string}).code==='55P03')throw new ExtensionApiError('stale_lease','Memory input mode is changing; retry the original request');throw error}
 if(!policy||policy.allowed!==true)throw new ExtensionApiError('installation_paused','Memory Feed input is disabled for the current source mode',{source_input_disabled:true})
 if(typeof policy.generation!=='string'||!/^[1-9][0-9]*$/.test(policy.generation)||BigInt(policy.generation)>9223372036854775807n)throw new ExtensionApiError('feature_disabled','Memory input mode contract is unavailable')
 return policy.generation
}
export function matchesMemoryFeedGeneration(original:string|undefined,current:string|undefined):boolean{
 return current===undefined||original===current||original===undefined&&current==='1'
}
