import {createHash} from 'node:crypto'
import type pg from 'pg'
import {canonicalJsonString,canonicalPayloadHash,canonicalSourceClassification,parseMemorySourceProvenance,type SourceHead,type SourceScope,type SourceVersion} from '@pocketctl/session-source'
import {originalIngressEventHash,readIngressKeyIndex} from '../migrations/shared-source/ingress-key.js'
import {matchRetainedInboxEnvelopeHeader} from '../migrations/shared-source/retained-inbox-envelope.js'

type Queryable=Pick<pg.PoolClient,'query'>
interface Original {
 canonical_key:string
 source_event_id:string
 origin:string
 canonical_event_key:string|null
 session_id:string
 turn_id:string|null
 event_type:string
 payload:Record<string,unknown>
 payload_hash:Buffer
 classification:Record<string,unknown>
 source_provenance:Record<string,unknown>
 current_receipt:boolean
 native_ingress:string
 header_version:number|null
 receipt:Record<string,unknown>|null
}

const same=(a:unknown,b:unknown)=>canonicalJsonString(a)===canonicalJsonString(b)
const mappingError=(reason:string)=>Error('historical_projection_original_'+reason)

function literalIngressHash(row:Original){
 const event=originalIngressEventHash(row)
 if(event)return event
 const request=row.payload?.request_id
 if(row.payload?.event_id||typeof request!=='string'||!request||Buffer.byteLength(request)>4096)return
 // This is Relay's persisted request-id key. An exact body, subject and
 // timestamp are also required. Content-only dedup keys are insufficient.
 return createHash('md5').update(`${row.session_id}:${row.event_type}:request:${request}`).digest('hex').slice(0,16)
}

/** Rebind only a matching retained Feed UUID. The caller owns the source
 * commit fence, native row locks and installation mutex for this page. */
export async function bindHistoricalOriginals(client:Queryable,scope:SourceScope,version:SourceVersion,heads:SourceHead[],payloads:Record<string,unknown>[]){
 if(!heads.length)return 0
 const subjects=heads.map((head,index)=>({
  id:head.canonicalKey,session_id:head.sessionKey,event_type:head.eventType,turn_id:head.turnKey??null,hash:head.contentHash,
  event_key:typeof payloads[index].event_id==='string'?'event_id:'+payloads[index].event_id:null,
  request_id:!payloads[index].event_id&&typeof payloads[index].request_id==='string'?payloads[index].request_id:null,
 }))
 // Two matching originals are enough to reject an identity. The lateral
 // lookup preserves the per-event bound and locks the candidates in one query.
 const found=await client.query<Original>(`
  SELECT p.id AS canonical_key,c.*
  FROM jsonb_to_recordset($2::jsonb) AS p(id text,session_id text,event_type text,turn_id text,hash text,event_key text,request_id text)
  JOIN public.events e ON e.id=p.id::bigint
  CROSS JOIN LATERAL(
   SELECT s.source_event_id::text,s.origin,s.canonical_event_key,s.session_id,s.turn_id,s.event_type,s.payload,s.payload_hash,
    s.classification,s.source_provenance,
    f.source_id='event:'||e.id AND f.session_id=s.session_id AND f.event_type=s.event_type
     AND f.turn_id IS NOT DISTINCT FROM s.turn_id AND f.recorded_at=s.occurred_at
     AND f.projection_state='projected' AND f.error_code IS NULL AS current_receipt,
    e.event_hash AS native_ingress,e.source_header_version AS header_version,
    CASE WHEN f.feed_id IS NOT NULL THEN to_jsonb(f)||jsonb_build_object('feed_id',f.feed_id::text,'envelope_hash',encode(f.payload_hash,'hex')) END AS receipt
   FROM memory.source_events s
   LEFT JOIN memory.memory_source_delivery_facts f ON f.installation_id=s.installation_id
    AND f.feed_id=CASE WHEN s.origin_position ~ '^[1-9][0-9]{0,17}$' THEN s.origin_position::bigint END
   WHERE s.installation_id=$1 AND s.session_id=p.session_id AND s.event_type=p.event_type AND s.origin='feed'
    AND s.mapping_state IN('unproven','conflict') AND s.mapping_state='unproven'
    AND s.source_kind IS NULL AND s.canonical_key IS NULL AND s.canonical_session_key IS NULL
    AND s.source_sequence IS NULL AND s.source_version IS NULL AND s.content_hash IS NULL AND s.hash_version IS NULL
    AND s.adapter_version IS NULL AND s.body_reclaimed_at IS NULL
    AND(f.source_id='event:'||e.id OR s.canonical_event_key=p.event_key OR (p.request_id IS NOT NULL AND s.payload->>'request_id'=p.request_id))
    AND s.occurred_at>=date_trunc('milliseconds',e.created_at) AND s.occurred_at<=e.created_at
    AND (s.occurred_at=e.created_at OR s.occurred_at=date_trunc('milliseconds',e.created_at))
    AND s.turn_id IS NOT DISTINCT FROM p.turn_id AND s.payload_hash=decode(p.hash,'hex')
    AND octet_length(s.classification::text)<=32768 AND octet_length(s.source_provenance::text)<=32768
   LIMIT 2 FOR UPDATE OF s NOWAIT) c`,[scope.installationId,JSON.stringify(subjects)])
 if(!found.rowCount)return 0
 const originals=new Map(found.rows.map(row=>[row.canonical_key,row]))
 if(originals.size!==found.rows.length||new Set(found.rows.map(row=>row.source_event_id)).size!==found.rows.length)
  throw mappingError('ambiguous')
 const receiptIds=found.rows.flatMap(row=>row.receipt?[row.receipt.feed_id]:[])
 const receipts=new Map<string,unknown>()
 if(receiptIds.length){
  const locked=await client.query(`SELECT f.feed_id::text,to_jsonb(f)||jsonb_build_object('feed_id',f.feed_id::text,'envelope_hash',encode(f.payload_hash,'hex')) AS receipt
   FROM memory.memory_source_delivery_facts f WHERE installation_id=$1 AND feed_id=ANY($2::bigint[])
   ORDER BY f.feed_id FOR SHARE NOWAIT`,[scope.installationId,receiptIds])
  for(const row of locked.rows)receipts.set(row.feed_id,row.receipt)
 }
 const validIndex=found.rows.some(row=>!row.receipt)&&Boolean(await readIngressKeyIndex(client))
 for(const [index,head] of heads.entries()){
  const row=originals.get(head.canonicalKey),payload=payloads[index]
  if(!row)continue
  if(row.receipt&&!same(receipts.get(String(row.receipt.feed_id))??null,row.receipt))throw mappingError('receipt_changed')
  const retainedProof=parseMemorySourceProvenance(row.source_provenance?.memory)
  const provenanceSequence=retainedProof?.sequence??''
  const sourceSequence=row.header_version===1?head.sourceSequence??'':provenanceSequence
  const nativeClassification=row.header_version===1?head.classification:
   canonicalSourceClassification({source_kind:'canonical_event',session_id:head.sessionKey,source_seq:sourceSequence,payload})
  if(!row.payload||!Buffer.isBuffer(row.payload_hash)||row.payload_hash.toString('hex')!==head.contentHash
   ||!canonicalPayloadHash(row.payload).equals(row.payload_hash)||!same(row.payload,payload))throw mappingError('body_changed')
  if(!same(row.classification,nativeClassification))throw mappingError('classification_changed')
  // Verify existing provenance against the native header or the original
  // authenticated transport receipt. Never populate an absent lineage field.
  if(!row.source_provenance||['team','accepted_delivery'].some(field=>Object.hasOwn(row.source_provenance,field))
   ||(!same(row.source_provenance.memory??null,head.provenance.memory??null)
     &&!(row.header_version===null&&row.current_receipt&&retainedProof
       &&same(retainedProof,row.classification.memory_source)
       &&same(retainedProof,nativeClassification.memory_source))))throw mappingError('provenance_changed')
  if(row.receipt){
   if(!row.current_receipt||!matchRetainedInboxEnvelopeHeader(row.receipt,payload,row.classification))throw mappingError('receipt_changed')
  }else{
   if(!validIndex||literalIngressHash(row)!==row.native_ingress)throw mappingError('ingress_changed')
  }
 }
 const bindings=found.rows.map(row=>({id:row.source_event_id,canonical_key:row.canonical_key}))
 const changed=await client.query(`UPDATE memory.source_events s
  SET source_kind='relay_event',canonical_key=p.canonical_key,canonical_session_key=s.session_id,source_version=$3::jsonb,
   content_hash=s.payload_hash,hash_version='canonical-json-sha256-v1',mapping_state='verified',adapter_version='original-ref-v1'
  FROM jsonb_to_recordset($2::jsonb) AS p(id uuid, canonical_key text)
  WHERE s.installation_id=$1 AND s.source_event_id=p.id AND s.mapping_state='unproven' RETURNING s.source_event_id`,
  [scope.installationId,JSON.stringify(bindings),version])
 if(changed.rowCount!==bindings.length)throw mappingError('row_changed')
 return bindings.length
}
