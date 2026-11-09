import type pg from 'pg'
import {canonicalPayloadHash,canonicalSourceClassification,createPostgresSharedSourceReader,parseMemorySourceProvenance,verifyOriginalSourceHash,type SourceScope,type SourceRoot} from '@pocketctl/session-source'
import type {MappingResult} from '../shared-source/mapping.js'
import {matchRetainedInboxEnvelope} from '../shared-source/retained-inbox-envelope.js'
import {originalIngressEventHash,readIngressKeyIndex} from '../shared-source/ingress-key.js'
import {assertFrozenMemorySource} from '../shared-source/maintenance.js'
import {assertTargetMemoryWritersFenced} from './source-maintenance-capabilities.js'
import {qi} from './source-maintenance-common.js'
import {assertOriginalCopiedSource,type OriginalBindingCopyReceipt} from './original-copy-proof.js'
export type {OriginalBindingCopyReceipt} from './original-copy-proof.js'
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v)
const digest=(value:unknown)=>canonicalPayloadHash(value).toString('hex')
const derived=new Set(['source_kind','canonical_key','canonical_session_key','source_version','source_sequence','content_hash','hash_version','mapping_state','adapter_version','canonical_projected_at'])
/** Explicit finite offline operation, after verified copy and privacy overlay.
 * The supplied receipt is the retained operator input, not an access grant.
 * Every old row is independently compared with the still-fenced original DB;
 * current controlled reader + physical commit fence grant the actual access.
 * Dedicated clients only. No app startup, body removal, UUID/provenance rewrite,
 * guessed sequence, new accounting state, or Team semantic activation. */
export async function bindOriginalPersonalReferencePage(source:pg.Client,target:pg.Client,input:{copy:OriginalBindingCopyReceipt;scope:SourceScope;root:SourceRoot;mappings:MappingResult[]},options:{signal?:AbortSignal;beforeCommit?:()=>Promise<void>;archive?:Parameters<typeof createPostgresSharedSourceReader>[1]}={}){
 const {copy,scope,root,mappings}=structuredClone(input)
 const abort=()=>{if(options.signal?.aborted)throw Error('original_binding_aborted')}
 if(copy?.schemaVersion!==1||copy.kind!=='memory-forward-verification'||copy.verified!==true||!hex(copy.manifestHash)||!uuid(copy.migrationId)
  ||!hex(copy.sourceIdentity)||!hex(copy.targetIdentity)||!copy.sourceEvents||!hex(copy.sourceEvents.hash)||!/^\d+$/.test(copy.sourceEvents.rows)
  ||!Array.isArray(copy.sourceEvents.sourceColumns)||!copy.sourceEvents.sourceColumns.length||new Set(copy.sourceEvents.sourceColumns).size!==copy.sourceEvents.sourceColumns.length
  ||copy.sourceEvents.sourceColumns.some(c=>typeof c!=='string'||!c)||root?.kind!=='relay_event'||scope?.ownerScopeKind!=='personal'||!uuid(scope.installationId)
  ||!/^\d*[1-9]\d*$/.test(scope.principalUserId)||!root.key.startsWith(scope.principalUserId+':')||!Array.isArray(mappings)||mappings.length<1||mappings.length>256
  ||new Set(mappings.map(m=>m.sourceEventId)).size!==mappings.length||new Set(mappings.map(m=>m.canonicalId)).size!==mappings.length)throw Error('original_binding_input_invalid')
 for(const m of mappings)if(!uuid(m.sourceEventId)||m.installationId!==scope.installationId||!['unique-hot','unique-cold'].includes(m.state)||!m.replacementProven||m.deletionEligible!==false
  ||m.sourceKind!=='relay_event'||!/^\d*[1-9]\d*$/.test(m.canonicalId??'')||!hex(m.contentHash)||!hex(m.originalSourceHash)||!hex(m.classificationHash)
  ||!['canonical-json-sha256-v1','snapshot-envelope-sha256-v1'].includes(m.originalHashVersion)||!m.identityRelations.some(l=>l.kind==='relay_event'&&l.id===m.canonicalId)
  ||m.provenanceState==='unknown'&&(!m.originalIdentityManifest||!hex(m.originalIdentityManifestHash)||digest(m.originalIdentityManifest)!==m.originalIdentityManifestHash||m.sourceSequence!==undefined||m.sourceVersion!==undefined))throw Error('original_binding_mapping_unproven')
 abort();const columns=await assertOriginalCopiedSource(source,target,copy)
 const originalColumns=columns.filter(c=>!derived.has(c)),project=originalColumns.map(c=>'s.'+qi(c)).join(',')
 // Original row bytes stay inside PostgreSQL. JSON numeric values are never
 // parsed/reserialized to compare the copied row; xmin is local to each DB.
 const rowSql=(schema:string)=>`SELECT s.source_event_id::text,s.xmin::text AS row_version,s.installation_id::text,s.origin,s.origin_position,s.session_id,s.turn_id,s.event_type,s.occurred_at,
  encode(s.payload_hash,'hex') AS original_hash,s.classification,s.source_provenance,s.canonical_event_key,
  CASE WHEN jsonb_typeof(s.payload->'event_id')='string' AND octet_length(s.payload->>'event_id')<=4096 THEN s.payload->>'event_id' ELSE NULL END AS original_ingress_id,
  encode(sha256(convert_to(row_to_json(original)::text,'UTF8')),'hex') AS original_row_hash
  ${schema==='memory'?',s.mapping_state,s.source_kind,s.canonical_key,s.canonical_session_key,encode(s.content_hash,\'hex\') AS content_hash,s.source_sequence::text,s.hash_version,s.adapter_version':''}
  FROM ${schema}.source_events s CROSS JOIN LATERAL(SELECT ${project}) original WHERE s.source_event_id=ANY($1::uuid[])
  AND pg_column_size(s.classification)<=32768 AND pg_column_size(s.source_provenance)<=32768 ORDER BY s.source_event_id`
 const ids=mappings.map(m=>m.sourceEventId)
 await source.query("SET TIME ZONE 'UTC'");await target.query("SET TIME ZONE 'UTC'")
 const originals=(await source.query(rowSql('public'),[ids])).rows,old=(await target.query(rowSql('memory'),[ids])).rows
 if(originals.length!==ids.length||old.length!==ids.length)throw Error('original_binding_row_missing')
 const originalInbox=new Map<string,Record<string,any>>()
 const originalIngress=new Map<string,{definitionHash:string;eventHash:string;sessionId:string;businessId:string}>()
 for(const m of mappings){
  const a=originals.find(r=>r.source_event_id===m.sourceEventId)!,b=old.find(r=>r.source_event_id===m.sourceEventId)!
  if(a.original_row_hash!==b.original_row_hash||a.installation_id!==scope.installationId||!['feed','snapshot'].includes(a.origin)||a.session_id!==root.key.slice(scope.principalUserId.length+1)
   ||a.original_hash!==m.originalSourceHash||digest(a.classification)!==m.classificationHash)throw Error('original_binding_original_changed')
  if(m.provenanceState==='unknown'){
   const p=m.originalIdentityManifest!
   if(!['retained-feed-v1-original-identity','retained-inbox-v1-original-identity','retained-ingress-key-v1-original-identity'].includes(String(p.kind))||p.sourceEventId!==a.source_event_id||p.installationId!==a.installation_id||p.canonicalKey!==m.canonicalId
    ||p.sourceRowVersion!==a.row_version||p.originalOrigin!==a.origin||p.originalOriginPosition!==a.origin_position||p.ownerUserId!==scope.principalUserId||p.ownerScopeId!==scope.ownerScopeId
    ||p.sessionId!==a.session_id||p.turnId!==a.turn_id||p.eventType!==a.event_type||p.occurredAt!==new Date(a.occurred_at).toISOString()
    ||p.provenanceHash!==digest(a.source_provenance)||p.classificationHash!==m.classificationHash||p.contentHash!==m.contentHash||p.originalSourceHash!==m.originalSourceHash
   ||p.sourceSequence!==null||p.journalOrderProven!==false||p.provenanceState!=='unknown'||Object.hasOwn(a.source_provenance,'memory')||Object.hasOwn(a.classification,'memory_source'))throw Error('original_binding_identity_manifest_changed')
   if(p.kind==='retained-inbox-v1-original-identity'){
    if(a.origin!=='feed'||!/^\d*[1-9]\d*$/.test(a.origin_position)||p.feedRowVersion!==null||!hex(p.transportEnvelopeHash)||typeof p.inboxBodyReclaimed!=='boolean')throw Error('original_binding_transport_changed')
    const inbox=(await source.query(`SELECT xmin::text AS inbox_row_version,feed_id::text,envelope_version,topic,source_kind,source_id,session_id,turn_id,event_type,recorded_at,
     encode(payload_hash,'hex') AS envelope_hash,body_reclaimed_at IS NOT NULL AS inbox_body_reclaimed,classification,
     CASE WHEN octet_length(data::text)<=33554432 THEN data ELSE NULL END AS data FROM public.memory_feed_inbox WHERE installation_id=$1 AND feed_id=$2`,[a.installation_id,a.origin_position])).rows
    const i=inbox[0]
    if(inbox.length!==1||i.inbox_row_version!==p.inboxRowVersion||i.envelope_hash!==p.transportEnvelopeHash||i.inbox_body_reclaimed!==p.inboxBodyReclaimed
     ||i.source_kind!=='canonical_event'||i.source_id!=='event:'+m.canonicalId||i.session_id!==a.session_id||i.turn_id!==a.turn_id||i.event_type!==a.event_type)throw Error('original_binding_transport_changed')
    originalInbox.set(m.sourceEventId,i)
   }
   if(p.kind==='retained-ingress-key-v1-original-identity'){
    const eventHash=originalIngressEventHash({...a,payload:{event_id:a.original_ingress_id}}),index=await readIngressKeyIndex(target)
    if(!eventHash||!index||index.definitionHash!==p.ingressIndexHash||p.ingressEventHash!==eventHash||p.sourceIngressKeyHash!==digest(a.canonical_event_key)
     ||p.feedRowVersion!==null||p.inboxRowVersion!==null||p.archiveVerified!==(m.state==='unique-cold')
     ||!m.identityRelations.some(l=>l.kind==='relay_event'&&l.id===m.canonicalId&&l.via==='ingress'&&l.version===undefined))throw Error('original_binding_ingress_changed')
    originalIngress.set(m.sourceEventId,{definitionHash:index.definitionHash,eventHash,sessionId:a.session_id,businessId:a.original_ingress_id})
   }
  }else{
   const proof=parseMemorySourceProvenance(a.source_provenance?.memory)
   if(!proof||proof.session_id!==a.session_id||proof.turn_id!==a.turn_id)throw Error('original_binding_provenance_changed')
  }
 }
 // The adapter owns all authoritative body IO before BEGIN. The M0 Journal
 // version string is deliberately never used as SourceVersion{c,a,s}.
 const reader=createPostgresSharedSourceReader({query:(sql,args)=>target.query(sql,args),async connect(){throw Error('original_binding_reader_transaction_forbidden')}},options.archive)
 const page=await reader.getHeads(scope,root,mappings.map(m=>m.canonicalId!)),bodies=await reader.resolveBodies(scope,root,page.heads,page.version)
 for(const m of mappings){
  const row=old.find(r=>r.source_event_id===m.sourceEventId)!,body=bodies.find(b=>b.head.canonicalKey===m.canonicalId)!,h=body.head,p=body.payload as Record<string,unknown>
  const classification=canonicalSourceClassification({source_kind:'canonical_event',session_id:row.session_id,source_seq:m.sourceSequence??'',payload:p})
  const transport=originalInbox.get(m.sourceEventId)
  if(transport&&!matchRetainedInboxEnvelope(transport,p,classification))throw Error('original_binding_transport_changed')
  const ingress=originalIngress.get(m.sourceEventId)
  if(ingress&&p.event_id!==ingress.businessId)throw Error('original_binding_ingress_changed')
  // Neither a new canonical order nor a reclaimed Journal rewrites the
  // independently proved original order. Reject conflicting known orders.
  if(h.storage!==(m.state==='unique-cold'?'cold':'hot')||h.sessionKey!==row.session_id||h.eventType!==row.event_type||h.contentHash!==m.contentHash||!h.occurredAt||new Date(h.occurredAt).getTime()!==new Date(row.occurred_at).getTime()
   ||(p.turn_id??p.source_turn_id??null)!==row.turn_id||digest(classification)!==m.classificationHash
   ||m.sourceSequence!==undefined&&h.sourceSequence!==undefined&&h.sourceSequence!==m.sourceSequence||verifyOriginalSourceHash({origin:row.origin,originPosition:row.origin_position,eventType:row.event_type,occurredAt:new Date(row.occurred_at).toISOString(),payload:p,payloadHash:row.original_hash})!==m.originalHashVersion)throw Error('original_binding_current_source_conflict')
 }
 abort();await options.beforeCommit?.();abort()
 let changed=0,alreadyBound=0
 try{
  await target.query('BEGIN');await target.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'")
  await assertTargetMemoryWritersFenced(target)
  if(!(await target.query('SELECT shared.lock_memory_personal_source_commit($1::jsonb,$2,$3,$4::jsonb,FALSE) AS locked',[JSON.stringify(scope),root.kind,root.key,JSON.stringify(page.version)])).rows[0]?.locked)throw Error('original_binding_authority_changed')
  if(!(await target.query("SELECT pg_try_advisory_xact_lock(hashtextextended('canonical-projection:'||$1,0)) AS locked",[scope.installationId])).rows[0].locked)throw Error('original_binding_busy')
  for(const m of mappings){
   const ingress=originalIngress.get(m.sourceEventId);if(!ingress)continue
   const index=await readIngressKeyIndex(target)
   const e=(await target.query('SELECT session_id,event_hash FROM public.events WHERE id=$1 FOR SHARE NOWAIT',[m.canonicalId])).rows[0]
   if(index?.definitionHash!==ingress.definitionHash||e?.session_id!==ingress.sessionId||e?.event_hash!==ingress.eventHash)throw Error('original_binding_ingress_changed')
  }
  for(const m of mappings){
   abort();const row=old.find(r=>r.source_event_id===m.sourceEventId)!
   if(row.mapping_state==='verified'){
    if(row.source_kind!=='relay_event'||row.canonical_key!==m.canonicalId||row.canonical_session_key!==row.session_id||row.content_hash!==m.contentHash||row.source_sequence!==(m.sourceSequence??null)||row.hash_version!=='canonical-json-sha256-v1'||row.adapter_version!=='original-ref-v1')throw Error('original_binding_existing_conflict')
    if(!(await target.query('SELECT 1 FROM memory.source_events WHERE source_event_id=$1 AND xmin::text=$2 FOR UPDATE NOWAIT',[m.sourceEventId,row.row_version])).rowCount)throw Error('original_binding_row_changed')
    alreadyBound++;continue
   }
   if(row.mapping_state!=='unproven'||row.source_kind!==null||row.canonical_key!==null||row.canonical_session_key!==null||row.content_hash!==null||row.source_sequence!==null)throw Error('original_binding_existing_conflict')
   const result=await target.query(`UPDATE memory.source_events SET source_kind='relay_event',canonical_key=$3,canonical_session_key=session_id,source_version=$4::jsonb,
    source_sequence=$5::bigint,content_hash=decode($6,'hex'),hash_version='canonical-json-sha256-v1',mapping_state='verified',adapter_version='original-ref-v1'
    WHERE source_event_id=$1 AND xmin::text=$2 AND mapping_state='unproven'`,[m.sourceEventId,row.row_version,m.canonicalId,JSON.stringify(page.version),m.sourceSequence??null,m.contentHash])
   if(result.rowCount!==1)throw Error('original_binding_row_changed');changed++
  }
  abort();await assertFrozenMemorySource(source);await target.query('COMMIT')
  return {kind:'original-personal-reference-binding',manifestHash:copy.manifestHash,mappingHash:digest(mappings),installationId:scope.installationId,rootKey:root.key,changed,alreadyBound,sourceVersion:page.version,sourceBodiesChanged:false,originalIdsPreserved:true,provenanceRewritten:false,deletionAuthorized:false}
 }catch(error){await target.query('ROLLBACK').catch(()=>{});throw error}
}
