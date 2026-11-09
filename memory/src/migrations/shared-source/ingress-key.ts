import {createHash} from 'node:crypto'
import {canonicalPayloadHash} from '../../inbox/canonical-json.js'
/** Frozen existing Relay ingress business-key contract. This is neither a
 * producer lineage parser nor a content search. The original Memory key and
 * body must carry the same literal ID; a valid unique index is also required. */
export function originalIngressEventHash(row:Record<string,any>):string|undefined{
 const id=row.payload?.event_id
 if(row.origin!=='feed'||typeof id!=='string'||!id||Buffer.byteLength(id)>4096||row.canonical_event_key!=='event_id:'+id
  ||typeof row.session_id!=='string'||typeof row.event_type!=='string')return
 return createHash('md5').update(`${row.session_id}:${row.event_type}:event:${id}`).digest('hex').slice(0,16)
}
export async function readIngressKeyIndex(db:{query:(sql:string)=>Promise<{rows:any[]}>}){
 const i=(await db.query(`SELECT i.indisunique,i.indisvalid,i.indisready,i.indnatts,i.indnkeyatts,
  i.indpred IS NULL AND i.indexprs IS NULL AS plain,pg_get_indexdef(i.indexrelid) AS definition
  FROM pg_index i WHERE i.indexrelid=to_regclass('public.idx_events_dedup') AND i.indrelid='public.events'::regclass`)).rows[0]
 if(!i?.indisunique||!i.indisvalid||!i.indisready||i.indnatts!==2||i.indnkeyatts!==2||!i.plain
  ||!i.definition.endsWith('USING btree (session_id, event_hash)'))return
 return {definitionHash:canonicalPayloadHash(i.definition).toString('hex')}
}
