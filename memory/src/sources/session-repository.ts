import type pg from 'pg'
import {canonicalJsonString} from '@pocketctl/session-source'
import {prepareSourceReferences,preparedSourceUnavailable} from './prepared-sources.js'
// Managed Relay producers attach Git identity to lifecycle observations.
// Retained archive rows and older copied observations keep their existing
// lookup contract. A compatibility payload can only nominate a UUID: the
// verified source reader still supplies and validates the actual fact.
const references = `SELECT source_event_id::text FROM source_events
 WHERE installation_id=$1 AND session_id=$2
  AND (event_type IN ('session_created','session_discovered') OR source_kind='legacy_archive'
    OR (origin IN ('feed','snapshot','team') AND payload ? 'repository_id'))
 ORDER BY occurred_at DESC,source_event_id DESC LIMIT 4097`
/** Applicability discovery, never a grant. Resolve exact stored source UUIDs
 * before BEGIN and fail closed when a bounded current observation is unprovable. */
export async function sharedSessionRepository(pool:pg.Pool,installationId:string,sessionId:string):Promise<string|null>{
 const ids=(await pool.query(references,[installationId,sessionId])).rows.map(r=>r.source_event_id)
 if(!ids.length||ids.length>4096)return null
 try{
  const prepared=await prepareSourceReferences(pool,installationId,ids)
  const byId=new Map(prepared.events.map(e=>[e.source_event_id,e]))
  const keys=ids.map(id=>byId.get(id)?.payload.repository_id).filter((key):key is string=>typeof key==='string'&&key.length>0&&key.length<=2048)
  const client=await pool.connect()
  try{
   // PostgreSQL requires a regular transaction for metadata FOR SHARE.
   // This path executes no DML; canonical bodies were already resolved.
   await client.query('BEGIN')
   await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='1s'")
   await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:session:'||$1||':'||$2,0))",[installationId,sessionId])
   await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))",[installationId])
   await prepared.assertCurrent(client)
   const current=(await client.query(references,[installationId,sessionId])).rows.map(r=>r.source_event_id)
   if(canonicalJsonString(current)!==canonicalJsonString(ids))throw Error('source_reference_changed')
   const repositories=(await client.query<{repository_id:string;repository_key:string}>(`SELECT repository_id::text,repository_key FROM repositories WHERE installation_id=$1 AND repository_key=ANY($2::text[])`,[installationId,keys])).rows
   const match=keys.map(key=>repositories.find(r=>r.repository_key===key)).find(Boolean)?.repository_id??null
   await prepared.assertCurrent(client,{forCommit:true})
   await client.query('COMMIT');return match
  }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error}finally{client.release()}
 }catch(error){if(preparedSourceUnavailable(error))return null;throw error}
}
