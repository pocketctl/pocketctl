import type pg from 'pg'
import {canonicalPayloadHash,canonicalJsonString,parseMemorySourceProvenance,verifyOriginalSourceHash} from '@pocketctl/session-source'
import type {PagedCleanupRecord,PagedCleanupHeader} from './paged-cleanup-manifest.js'
import {pagedRelation} from './paged-cleanup-receipts.js'
/** An exact native row-version witness survives deletion of the Memory parent.
 * This is a deletion proof only; it never permits a source read or replay. */
const nativeStamp=(alias:string)=>`encode(sha256(convert_to(jsonb_build_array(${alias}.id::text,${alias}.xmin::text)::text,'UTF8')),'hex')`
const nativeHeader=(alias:string)=>`encode(sha256(convert_to(jsonb_build_object('id',${alias}.id::text,'owner',${alias}.user_id::text,'session',${alias}.session_id,'logical',${alias}.logical_source_session_id,'retired',${alias}.owner_retired,'effectStatus',${alias}.effect_status,'type',${alias}.event_type,'at',${alias}.created_at::text,'version',${alias}.source_header_version::text,'sequence',${alias}.source_sequence::text,'hash',${alias}.canonical_payload_hash::text,'classification',${alias}.source_classification)::text,'UTF8')),'hex')`
export async function bindPagedOriginalSources(c:pg.Client,records:PagedCleanupRecord[]){
 const selected=records.filter(r=>r.table==='source_events');if(!selected.length)return
 if(selected.length>1024||selected.reduce((n,r)=>n+BigInt(r.bytes),0n)>8388608n)throw Error('paged_source_capacity')
 const rows=(await c.query(`WITH selected AS MATERIALIZED(SELECT s.*,e.id::text AS native_id,${nativeStamp('e')} AS native_hash,${nativeHeader('e')} AS native_header_hash,e.user_id::text AS native_owner,
  e.session_id AS native_session,e.logical_source_session_id AS native_logical,e.owner_retired,
  e.source_header_version::text AS native_header,e.source_sequence::text AS native_sequence,
  e.canonical_payload_hash::text AS native_content_hash,e.source_classification AS native_classification,
  shared.memory_event_capture_eligible(jsonb_build_object('effect_status',e.effect_status,'user_id',e.user_id,'session_id',e.session_id)) AND ss.source IS DISTINCT FROM 'app_review_demo' AS capture_eligible,e.event_type AS native_type,e.created_at::text AS native_at,i.owner_user_id::text AS installation_owner,
  ss.user_id::text AS session_owner,d.user_id::text AS daemon_owner
  FROM memory.source_events s JOIN public.extension_installations i USING(installation_id)
  LEFT JOIN public.events e ON e.id=CASE WHEN s.canonical_key ~ '^[1-9][0-9]{0,18}$' AND s.canonical_key::numeric<=9223372036854775807 THEN s.canonical_key::bigint END
  LEFT JOIN public.sessions ss ON ss.session_id=s.session_id LEFT JOIN public.daemons d ON d.daemon_id=ss.daemon_id
  WHERE s.source_event_id=ANY($1::uuid[]))
  SELECT selected.* FROM selected WHERE(SELECT COALESCE(sum(octet_length(to_jsonb(bounded)::text)),0)<=8388608 FROM selected bounded)`,[selected.map(r=>r.key.source_event_id)])).rows
 // The complete Memory row plus every native auxiliary projection is guarded
 // in SQL before any JSON reaches the client decoder. A smaller independent
 // page may fit; a single oversized native projection precisely refuses.
 if(rows.length!==selected.length)throw Error('paged_source_capacity')
 for(const row of rows){
  const proof=parseMemorySourceProvenance(row.source_provenance?.memory),nativeProof=row.native_classification?.memory_source
  if(!row.capture_eligible||row.mapping_state!=='verified'||row.source_kind!=='relay_event'||!row.canonical_key||row.canonical_session_key!==row.session_id||row.native_session!==row.session_id||row.native_logical!==row.session_id||row.owner_retired||row.native_owner!==row.installation_owner||row.session_owner!==row.installation_owner||row.daemon_owner!==row.installation_owner||row.native_header!=='1'||row.native_type!==row.event_type||!row.native_at||new Date(row.native_at).getTime()!==new Date(row.occurred_at).getTime()
   ||!proof||proof.session_id!==row.session_id||proof.turn_id!==row.turn_id||proof.sequence!==row.native_sequence||String(row.source_sequence)!==proof.sequence
   ||canonicalJsonString(proof)!==canonicalJsonString(nativeProof)||canonicalJsonString(proof)!==canonicalJsonString(row.source_provenance.memory)
   ||Object.keys(row.source_provenance).some(k=>!['state','memory'].includes(k))||row.source_provenance.state!==undefined&&row.source_provenance.state!=='known'
   ||canonicalJsonString(row.classification)!==canonicalJsonString(row.native_classification)||!Buffer.isBuffer(row.content_hash)||row.content_hash.toString('hex')!==row.native_content_hash)throw Error('paged_original_source_unproved')
  if(row.payload!==null){if(!verifyOriginalSourceHash({origin:row.origin,originPosition:row.origin_position,eventType:row.event_type,occurredAt:row.occurred_at,payload:row.payload,payloadHash:row.payload_hash})||canonicalPayloadHash(row.payload).toString('hex')!==row.native_content_hash)throw Error('paged_original_source_hash_unproved')}
  else if(row.origin!=='canonical'||row.adapter_version!=='canonical-ref-v1'||!row.payload_hash.equals(row.content_hash))throw Error('paged_original_source_hash_unproved')
  const frozen=selected.find(r=>r.key.source_event_id===row.source_event_id)!
  frozen.references.native_event_id=row.native_id;frozen.references.native_owner_id=row.native_owner;frozen.references.native_row_hash=row.native_hash;frozen.references.native_header_hash=row.native_header_hash;frozen.references.original_payload_hash=row.payload_hash.toString('hex');frozen.references.native_content_hash=row.native_content_hash
 }
}
export async function assertPagedNativeOriginals(c:pg.Client,header:PagedCleanupHeader){
 if((await c.query(`SELECT 1 FROM ${pagedRelation('items')} i LEFT JOIN public.events e ON e.id=(i.original->'references'->>'native_event_id')::bigint
  WHERE i.plan_hash=$1 AND i.table_name='source_events' AND(e.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.sessions ss WHERE ss.session_id=e.session_id AND ss.source IS DISTINCT FROM 'app_review_demo') OR NOT COALESCE(shared.memory_event_capture_eligible(jsonb_build_object('effect_status',e.effect_status,'user_id',e.user_id,'session_id',e.session_id)),false) OR ${nativeStamp('e')} IS DISTINCT FROM i.original->'references'->>'native_row_hash' OR ${nativeHeader('e')} IS DISTINCT FROM i.original->'references'->>'native_header_hash' OR e.user_id::text IS DISTINCT FROM i.original->'references'->>'native_owner_id') LIMIT 1`,[header.manifestHash])).rowCount)throw Error('paged_original_native_source_drift')
}
