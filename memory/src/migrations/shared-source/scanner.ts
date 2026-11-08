import {parseTeamSemanticSourceVersion} from '../../sources/team-semantic.js'
import {canonicalSourceClassification,verifyOriginalSourceHash} from '@pocketctl/session-source'
import { canonicalPayloadHash, canonicalJsonString } from '../../inbox/canonical-json.js'
import { parseMemorySourceProvenance } from '../../episodes/skill-provenance.js'
import { assertMappingSnapshots, type Snapshot } from './database.js'
import { ArchiveVerifier, type ArchiveOptions } from './archive.js'
import { mapSource,MAPPING_STATES, type Candidate, type Link, type MappingResult, type Source } from './mapping.js'
import {proveInPlaceLegacyCustody} from './legacy-custody.js'
import {proveRetainedFeedIdentity} from './retained-feed-identity.js'
import {originalIngressEventHash,readIngressKeyIndex} from './ingress-key.js'
import { resolveTeamSource } from './team.js'
const MAX_BODY=32*1024*1024
const hash=(v:unknown)=>canonicalPayloadHash(v).toString('hex')
const numeric=(v:unknown)=>typeof v==='string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v)<=9223372036854775807n
export interface ScanOptions {preNativeLogicalPreparation?:boolean;legacyInPlace?:boolean;pageSize?:number;maxRows?:number;sourceIds?:readonly string[];archive?:ArchiveOptions;signal?:AbortSignal;onDetail:(row:MappingResult)=>Promise<void>}
export function parseSourceSelection(value:unknown):string[]{
 if(!Array.isArray(value)||value.length<1||value.length>4096||value.some(id=>typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))||new Set(value).size!==value.length)throw Error('invalid_source_selection')
 return [...value].sort()
}
/** Exact count on the same RR snapshot. Keep each statement on a bounded PK
 * range instead of a whole-heap COUNT that can exceed the maintenance timeout. */
export async function countSourceRows(snapshot:Pick<Snapshot,'client'>,options:{pageSize?:number;signal?:AbortSignal}={}):Promise<bigint>{
 const size=options.pageSize??8192
 if(!Number.isSafeInteger(size)||size<1||size>8192)throw Error('invalid_scan_limit')
 let after:string|null=null,total=0n
 for(;;){
  options.signal?.throwIfAborted()
  const row:{n:string;last:string|null}=(await snapshot.client.query(`SELECT count(*)::text AS n,max(source_event_id::text COLLATE "C") AS last
   FROM (SELECT source_event_id FROM public.source_events ${after===null?'':'WHERE source_event_id>$2::uuid'}
    ORDER BY source_event_id LIMIT $1) page`,after===null?[size]:[size,after])).rows[0]
  const count=BigInt(row.n);total+=count
  if(count<BigInt(size))return total
  after=row.last
 }
}
async function requireColumns(snapshot:Snapshot,contracts:Record<string,string[]>) {
  for(const [table,columns] of Object.entries(contracts)){
    const actual=(await snapshot.client.query(`SELECT a.attname FROM pg_catalog.pg_attribute a
      WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped`,['public.'+table])).rows.map(r=>r.attname)
    if(columns.some(c=>!actual.includes(c)))throw new Error('schema_contract_missing')
  }
}
function trustedProof(row:Record<string,any>){
 const proof=parseMemorySourceProvenance(row.source_provenance?.memory)
 return proof && proof.session_id===row.session_id && proof.turn_id===row.turn_id?proof:null
}
/** Exhaustive traversal means all rows were evaluated, not all identities proved.
 * Active dependency closure and cutover gates remain separate, always blocking. */
export async function scanMapping(memory:Snapshot,relay:Snapshot,options:ScanOptions) {
  assertMappingSnapshots(memory,relay)
  const pageSize=options.pageSize??256
  const selected=options.sourceIds===undefined?undefined:parseSourceSelection(options.sourceIds)
  if(options.legacyInPlace!==undefined&&typeof options.legacyInPlace!=='boolean')throw Error('invalid_legacy_in_place_mode')
  if(options.preNativeLogicalPreparation!==undefined&&typeof options.preNativeLogicalPreparation!=='boolean')throw Error('pre_native_preparation_state_required')
  if(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>256 || (options.maxRows!==undefined && (!Number.isSafeInteger(options.maxRows)||options.maxRows<1)))throw new Error('invalid_scan_limit')
  await requireColumns(memory,{source_events:['source_event_id','installation_id','origin','origin_position','session_id','turn_id','event_type','payload','payload_hash','source_provenance','classification','body_reclaimed_at'],
    memory_feed_inbox:['installation_id','feed_id','source_kind','source_id','session_id','turn_id','event_type','data','classification'],
    memory_snapshot_events:['installation_id','session_id','relay_event_id','event_type','payload']})
  await requireColumns(relay,{events:['id','session_id','event_type','payload','user_id'],extension_installations:['installation_id','owner_user_id','status','provider_id'],extension_providers:['provider_id','status'],
    extension_source_outbox:['source_seq','source_kind','source_id','owner_user_id','session_id','event_type','payload'],
    extension_feed:['feed_id','source_kind','source_id','owner_user_id','session_id','payload'],deleted_sessions:['session_id']})
  const total=await countSourceRows(memory,{signal:options.signal})
  const scanTotal=selected?BigInt((await memory.client.query('SELECT count(*)::text AS n FROM public.source_events WHERE source_event_id=ANY($1::uuid[])',[selected])).rows[0].n):total
  const eventColumns=new Set((await relay.client.query("SELECT attname FROM pg_attribute WHERE attrelid='public.events'::regclass AND attnum>0 AND NOT attisdropped")).rows.map(r=>r.attname))
  const inboxColumns=new Set((await memory.client.query("SELECT attname FROM pg_attribute WHERE attrelid='public.memory_feed_inbox'::regclass AND attnum>0 AND NOT attisdropped")).rows.map(r=>r.attname))
  const inboxExtra=['envelope_version','topic','recorded_at'].map(n=>inboxColumns.has(n)?n:`NULL AS ${n}`).join(',')
   +','+(inboxColumns.has('payload_hash')?"encode(payload_hash,'hex')":"NULL::text")+' AS envelope_hash,'
   +(inboxColumns.has('body_reclaimed_at')?'body_reclaimed_at IS NOT NULL':'NULL::boolean')+' AS inbox_body_reclaimed'
  const eventText=(name:string,fallback='NULL::text')=>eventColumns.has(name)?`e.${name}::text`:fallback
  const ingressIndex=eventColumns.has('event_hash')?await readIngressKeyIndex(relay.client):undefined
  if(options.preNativeLogicalPreparation){
    const p=(await relay.client.query(`SELECT a.atttypid::text AS type_oid,a.atttypmod,a.attnotnull,a.atthasdef,a.attidentity,a.attgenerated,
     to_regprocedure('public.native_session_authority(text,integer,text)') IS NOT NULL AS native_ready,to_regclass('public.session_aliases') IS NOT NULL AS aliases
     FROM pg_attribute a WHERE a.attrelid='public.events'::regclass AND a.attname='logical_source_session_id' AND NOT a.attisdropped`)).rows[0]
    if(!p||p.type_oid!=='1043'||p.atttypmod!==132||p.attnotnull||p.atthasdef||p.attidentity||p.attgenerated||p.native_ready||p.aliases)throw Error('pre_native_preparation_state_required')
  }
  const nativeIdentity=eventColumns.has('logical_source_session_id')&&!options.preNativeLogicalPreparation
  const logicalSession=options.preNativeLogicalPreparation?'e.session_id':eventText('logical_source_session_id','e.session_id')
  const eventClassification=eventColumns.has('source_classification')?'e.source_classification':'NULL::jsonb'
  const verifier=new ArchiveVerifier(relay,options.archive)
  const counts:Record<string,bigint>=Object.fromEntries(MAPPING_STATES.map(state=>[state,0n])),reasons:Record<string,bigint>={}
  let after:string|null=null,scanned=0n,unknownProvenance=0n,pages=0
  while(scanned<scanTotal && (options.maxRows===undefined || scanned<BigInt(options.maxRows))){
    options.signal?.throwIfAborted()
    const limit=options.maxRows===undefined?pageSize:Math.min(pageSize,options.maxRows-Number(scanned))
    const rows:Record<string,any>[]=(await memory.client.query(`SELECT xmin::text AS source_row_version,source_event_id::text,installation_id::text,origin,origin_position,session_id,turn_id,event_type,occurred_at,
      to_jsonb(s)->'source_version' AS source_version,to_jsonb(s)->>'source_kind' AS source_kind,to_jsonb(s)->>'canonical_key' AS canonical_key,to_jsonb(s)->>'canonical_event_key' AS canonical_event_key,source_provenance,classification,encode(payload_hash,'hex') AS stored_hash,
      CASE WHEN octet_length(payload::text)<=$3 THEN payload ELSE NULL END AS payload,
      s.body_reclaimed_at IS NOT NULL AS reclaimed
      FROM public.source_events s WHERE ${after===null?'$1::uuid IS NULL':'s.source_event_id>$1::uuid'}${selected?' AND s.source_event_id=ANY($4::uuid[])':''} ORDER BY s.source_event_id LIMIT $2`,[after,limit,MAX_BODY,...(selected?[selected]:[])])).rows
    if(!rows.length)break
    pages++
    // Snapshot metadata only: never cache the fresh native authority around IO.
    // Presence pages avoid one absent transport lookup per historical source;
    // bodies, hashes and exact witnesses still use the original per-row proof.
    const installations=(await relay.client.query(`SELECT i.installation_id::text,i.owner_user_id::text,i.status,i.provider_id,p.status AS provider_status,to_jsonb(i)->>'owner_scope_kind' AS owner_kind,to_jsonb(i)->>'owner_scope_id' AS owner_id
      FROM public.extension_installations i LEFT JOIN public.extension_providers p USING(provider_id) WHERE installation_id=ANY($1::uuid[])`,[[...new Set(rows.map(r=>r.installation_id))]])).rows
    const feedRows=rows.filter(r=>r.origin==='feed'&&numeric(r.origin_position))
    const inboxKeys=new Set<string>(),feedKeys=new Set<string>()
    if(feedRows.length){
      const pairs=feedRows.map(r=>({installation_id:r.installation_id,feed_id:r.origin_position}))
      const present=(await memory.client.query(`SELECT i.installation_id::text,i.feed_id::text FROM public.memory_feed_inbox i
       JOIN jsonb_to_recordset($1::jsonb) k(installation_id uuid,feed_id bigint) USING(installation_id,feed_id)`,[JSON.stringify(pairs)])).rows
      for(const i of present)inboxKeys.add(i.installation_id+':'+i.feed_id)
      const feeds=(await relay.client.query('SELECT feed_id::text FROM public.extension_feed WHERE feed_id=ANY($1::bigint[])',[[...new Set(feedRows.map(r=>r.origin_position))]])).rows
      for(const f of feeds)feedKeys.add(f.feed_id)
    }
    const deletedSessions=new Set((await relay.client.query('SELECT session_id FROM public.deleted_sessions WHERE session_id=ANY($1::text[])',[[...new Set(rows.map(r=>r.session_id??''))]])).rows.map(r=>r.session_id))
    for(const row of rows){
      options.signal?.throwIfAborted()
      const install=installations.filter(i=>i.installation_id===row.installation_id)
      const owner=install.length===1?install[0]:undefined
      const ownerKey=owner?.owner_id&&['team','organization'].includes(owner.owner_kind)?owner.owner_kind+':'+owner.owner_id:owner?.owner_user_id?'personal-user:'+owner.owner_user_id:owner?.owner_kind&&owner?.owner_id?owner.owner_kind+':'+owner.owner_id:''
      const proof=trustedProof(row)
      const originalHashVersion=row.payload===null?null:verifyOriginalSourceHash({origin:row.origin,originPosition:row.origin_position,eventType:row.event_type,occurredAt:row.occurred_at,payload:row.payload,payloadHash:row.stored_hash})
      const source:Source={id:row.source_event_id,installationId:row.installation_id,ownerKey,sessionId:row.session_id??'',turnId:row.turn_id,
        eventType:row.event_type,classificationHash:hash(row.classification),hash:originalHashVersion?hash(row.payload):row.stored_hash,actualHash:row.payload===null?'':hash(row.payload),links:[],provenance:proof?'known':'unknown',
        originalSourceHash:row.stored_hash,...(originalHashVersion?{originalHashVersion}:{}),
        ...(proof?{sequence:proof.sequence}:{}),bodyReclaimed:row.reclaimed}
      let candidates:Candidate[]=[], forcedReason:string|undefined
      const identityManifests=new Map<string,Record<string,unknown>>()
      if(!owner)forcedReason='installation_owner_unproven'
      else if(owner.provider_id!=='pocketctl-memory')forcedReason='installation_provider_mismatch'
      else if(owner.provider_status!=='enabled')forcedReason='installation_provider_unavailable'
      else if(!['active','pending'].includes(owner.status))forcedReason='installation_not_active'
      else if(row.source_kind==='team_semantic')forcedReason=parseTeamSemanticSourceVersion(row.source_version)?'team_semantic_native_publication_proof_required':'team_semantic_descriptor_invalid'
      else if(row.payload===null)forcedReason='source_body_unavailable_or_limit'
      else if(row.origin==='team'){
        const team=await resolveTeamSource(relay,row,ownerKey)
        source.links=team.links;source.provenance=team.provenance
        candidates=team.candidates;forcedReason=team.reason
        if(team.revoked)source.tombstone={verified:true,ownerKey,sessionId:source.sessionId,revoked:true}
      }else{
        const version=proof?.sequence
        const links:Link[]=[]
        let retainedFeed:Record<string,any>[]=[],retainedInbox:Record<string,any>[]=[]
        let retainedIngress:{definitionHash:string;eventHash:string}|undefined
        const feedSequences=new Map<string,Set<string>>()
        const link=(id:string,via:Link['via'])=>{if(numeric(id))links.push({kind:'relay_event',id,via,...(version?{version}: {})})}
        if(row.origin==='snapshot' && numeric(row.origin_position)){
          const snapshots=(await memory.client.query(`SELECT relay_event_id::text,CASE WHEN octet_length(payload::text)<=33554432 THEN payload ELSE NULL END AS payload,event_type FROM public.memory_snapshot_events WHERE installation_id=$1 AND session_id=$2 AND relay_event_id=$3`,[row.installation_id,row.session_id,row.origin_position])).rows
          if(snapshots.length===1 && snapshots[0].event_type===row.event_type && hash(snapshots[0].payload)===source.hash)link(row.origin_position,'snapshot')
          else forcedReason='snapshot_relation_unproven'
        }
        if(row.origin==='feed' && numeric(row.origin_position)){
          const inbox=inboxKeys.has(row.installation_id+':'+row.origin_position)?(await memory.client.query(`SELECT xmin::text AS inbox_row_version,feed_id::text,${inboxExtra},source_kind,source_id,session_id,turn_id,event_type,CASE WHEN octet_length(data::text)<=33554432 THEN data ELSE NULL END AS data,classification FROM public.memory_feed_inbox WHERE installation_id=$1 AND feed_id=$2`,[row.installation_id,row.origin_position])).rows:[]
          retainedInbox=inbox
          for(const i of inbox){
            if(i.source_kind!=='canonical_event')continue
            const transportCleared=i.inbox_body_reclaimed===true&&hash(i.data)===hash({})&&hash(i.classification)===hash({})
            if(i.session_id!==row.session_id || i.turn_id!==row.turn_id || i.event_type!==row.event_type || hash(i.data)!==source.hash&&!transportCleared){forcedReason='inbox_identity_or_hash_mismatch';break}
            if(i.source_id.startsWith('event:'))link(i.source_id.slice(6),'inbox')
          }
          const feed=feedKeys.has(row.origin_position)?(await relay.client.query(`SELECT xmin::text AS feed_row_version,source_kind,source_id,owner_user_id::text,session_id,CASE WHEN octet_length(payload::text)<=33554432 THEN payload ELSE NULL END AS payload FROM public.extension_feed WHERE feed_id=$1`,[row.origin_position])).rows:[]
          retainedFeed=feed
          for(const f of feed){
            // Feed.payload is the versioned envelope; never equate feed id to event id.
            const data=f.payload?.data??f.payload
            if(f.source_kind==='canonical_event' && f.owner_user_id===owner.owner_user_id && f.session_id===row.session_id && hash(data)===source.hash && f.source_id.startsWith('event:')){
              const id=f.source_id.slice(6);link(id,'feed')
              const envelope=f.payload,storedProof=parseMemorySourceProvenance(envelope?.classification?.memory_source)
              // Journal retention does not erase the original server-owned v1
              // Feed witness. Its exact envelope identity/classification and
              // canonical body must all agree; producer sequence is not used
              // as the Journal sequence and unknown provenance stays unknown.
              if(numeric(id)&&envelope?.envelope_version===1&&envelope.source?.kind==='canonical_event'&&envelope.source?.id===f.source_id
                &&envelope.subject?.session_id===row.session_id&&envelope.subject?.turn_id===row.turn_id&&envelope.subject?.event_type===row.event_type
                &&storedProof&&numeric(storedProof.sequence)&&hash(envelope.classification)===source.classificationHash
                &&canonicalJsonString(envelope.classification)===canonicalJsonString(canonicalSourceClassification({source_kind:'canonical_event',session_id:f.session_id,source_seq:storedProof.sequence,payload:data}))){
                const sequences=feedSequences.get(id)??new Set<string>();sequences.add(storedProof.sequence);feedSequences.set(id,sequences)
              }
            }
          }
        }
        if(proof && proof.session_id===row.session_id && proof.turn_id===row.turn_id){
          // A trusted persisted producer ID is a relation; text/hash alone is never searched.
          const journal=(await relay.client.query(`SELECT source_id,source_seq::text FROM public.extension_source_outbox
            WHERE owner_user_id=$1 AND session_id=$2 AND source_kind='canonical_event'
              AND payload->'memory_source'->>'event_id'=$3 LIMIT 3`,[owner.owner_user_id,row.session_id,proof.event_id])).rows
          for(const j of journal){
            if(j.source_id.startsWith('event:'))link(j.source_id.slice(6),'journal')
          }
          if(!links.length){
            const producer=(await relay.client.query(`SELECT id::text FROM public.events e WHERE user_id=$1 AND ${logicalSession}=$2
              AND (payload->'memory_source'->>'event_id'=$3 OR (${eventText('source_header_version')}='1' AND ${eventClassification}->'memory_source'->>'event_id'=$3)) LIMIT 3`,[owner.owner_user_id,row.session_id,proof.event_id])).rows
            for(const e of producer)link(e.id,'producer')
          }
        }
        // Recover only the original persisted business key through the actual
        // unique ingress index. Never search canonical bodies or infer IDs
        // from Feed positions, equal text or hashes alone.
        const ingressHash=originalIngressEventHash(row)
        if(ingressIndex&&ingressHash&&source.provenance==='unknown'&&!links.length&&!retainedFeed.length&&!retainedInbox.length&&!forcedReason){
          const hits=(await relay.client.query('SELECT id::text FROM public.events WHERE session_id=$1 AND event_hash=$2 LIMIT 2',[row.session_id,ingressHash])).rows
          if(hits.length===1){link(hits[0].id,'ingress');retainedIngress={...ingressIndex,eventHash:ingressHash}}
        }
        source.links=links
        for(const id of new Set(links.map(l=>l.id))){
          const events=(await relay.client.query(`SELECT xmin::text AS canonical_row_version,id::text,user_id::text,${logicalSession} AS session_id,e.session_id AS current_session_id,${nativeIdentity} AS native_identity_contract,${eventText('owner_retired')} AS owner_retired,event_type,
            ${options.preNativeLogicalPreparation?'e.logical_source_session_id':'NULL::text'} AS preparation_logical_session_id,
            ${eventColumns.has('created_at')?"date_trunc('milliseconds',e.created_at)::text":'NULL::text'} AS original_occurred_at,
            CASE WHEN octet_length(payload::text)<=$2 THEN payload ELSE NULL END AS payload,
            COALESCE(${eventText('body_storage')},'hot') AS body_storage,
            ${eventText('body_manifest_id')} AS body_manifest_id,${eventText('body_chunk_ordinal')} AS body_chunk_ordinal,
            ${eventText('body_session_id')} AS body_session_id,${eventText('body_activity_epoch')} AS body_activity_epoch,${eventText('body_owner_user_id')} AS body_owner_user_id,
            ${eventText('source_header_version')} AS source_header_version,${eventText('source_sequence')} AS source_sequence,${eventText('event_hash')} AS event_hash,
            ${eventText('canonical_payload_hash')} AS canonical_payload_hash,${eventClassification} AS source_classification
            FROM public.events e WHERE id=$1`,[id,MAX_BODY])).rows
          for(const e of events){
            let payload=e.payload,archiveVerified=false
            if(options.preNativeLogicalPreparation&&e.preparation_logical_session_id!==null&&e.preparation_logical_session_id!==e.current_session_id){forcedReason='pre_native_original_identity_conflict';continue}
            let currentNative:Record<string,any>|undefined
            if(e.native_identity_contract){
              if(e.owner_retired!=='false'){forcedReason='native_original_owner_retired_or_unknown';continue}
              if(!relay.currentNativeSessionAuthority){forcedReason='native_current_authority_unavailable';continue}
              currentNative=await relay.currentNativeSessionAuthority(e.session_id,Number(e.user_id),String(e.id))
              if(currentNative.state!=='current'||currentNative.sessionId!==e.current_session_id){forcedReason='native_current_authority_denied';continue}
            }
            if(e.body_storage==='cold'){
              try{payload=await verifier.body(e);archiveVerified=true}catch{forcedReason='archive_unverified';continue}
            }
            if(e.source_header_version!=null && e.source_header_version!=='1'){forcedReason='source_header_version_unsupported';continue}
            const header=e.source_header_version==='1'
            const journal=(await relay.client.query(`SELECT source_seq::text FROM public.extension_source_outbox WHERE source_kind='canonical_event' AND source_id=$1 AND owner_user_id=$2 AND session_id=$3 AND event_type=$4`,['event:'+id,e.user_id,e.session_id,e.event_type])).rows
            const witnesses=feedSequences.get(id)??new Set<string>()
            const sequence=header?e.source_sequence:journal.length===1?journal[0].source_seq:witnesses.size===1?[...witnesses][0]:undefined
            if(header&&!numeric(sequence)||journal.length>1||journal.some(j=>j.source_seq!==sequence)||witnesses.size>1||[...witnesses].some(s=>s!==sequence)){forcedReason='source_sequence_mismatch';continue}
            const classification=canonicalSourceClassification({source_kind:'canonical_event',session_id:e.session_id,source_seq:sequence??'',payload})
            if(header&&(e.canonical_payload_hash!==hash(payload)||canonicalJsonString(e.source_classification)!==canonicalJsonString(classification))){forcedReason='source_header_body_or_classification_mismatch';continue}
            const canonicalProof=parseMemorySourceProvenance(header?e.source_classification?.memory_source:payload?.memory_source)
            const proofEqual=!!proof && !!canonicalProof && canonicalProof.session_id===e.session_id && canonicalProof.turn_id===(payload?.turn_id??payload?.source_turn_id) && canonicalJsonString({...proof,sequence:'0'})===canonicalJsonString({...canonicalProof,sequence:'0'})
            const identity=sequence===undefined&&journal.length===0?await proveRetainedFeedIdentity(memory,relay,row,source,{...e,payload},retainedFeed,retainedInbox,retainedIngress?{...retainedIngress,archiveVerified}:undefined):undefined
            if(identity)identityManifests.set(identity.proof.manifestHash,identity.manifest)
            if(currentNative && canonicalJsonString(await relay.currentNativeSessionAuthority!(e.session_id,Number(e.user_id),String(e.id)))!==canonicalJsonString(currentNative)){
              forcedReason='native_current_authority_changed';continue
            }
            candidates.push({kind:'relay_event',id:e.id,installationId:row.installation_id,ownerKey:'personal-user:'+e.user_id,
              sessionId:e.session_id,turnId:payload?.turn_id??payload?.source_turn_id??null,eventType:e.event_type,classificationHash:hash(classification),hash:hash(payload),
              version:sequence??'',sequence,storage:e.body_storage==='cold'?'cold':'hot',archiveVerified,
              authorityVerified:(proofEqual||!!identity) && e.user_id===owner.owner_user_id,provenance:proofEqual?'known':'unknown',...(identity?{originalIdentityProof:identity.proof}:{})})
          }
        }
        // Relay tombstones carry session identity only. They prove deletion only
        // when an explicit event relation and owner have already been verified.
        const deleted=deletedSessions.has(source.sessionId)
        if(deleted && candidates.some(c=>c.authorityVerified && c.ownerKey===source.ownerKey))source.tombstone={verified:true,ownerKey,sessionId:source.sessionId}
        else if(deleted)forcedReason='deletion_owner_unproven'
      }
      let legacyCustody:Record<string,unknown>|undefined
      if(options.legacyInPlace&&['feed','snapshot'].includes(row.origin)&&!source.tombstone?.verified&&candidates.length===0&&(!forcedReason||forcedReason==='deletion_owner_unproven')){
        const custody=await proveInPlaceLegacyCustody(memory,relay,row,source)
        if(custody.deleted){source.tombstone={verified:true,ownerKey:source.ownerKey,sessionId:source.sessionId};forcedReason=undefined}
        else if(custody.proof){source.legacyProof=custody.proof;legacyCustody=custody.manifest}
        else if(custody.reason)forcedReason=custody.reason
      }
      let mapped=mapSource(source,candidates)
      if(mapped.originalIdentityManifestHash)mapped={...mapped,originalIdentityManifest:identityManifests.get(mapped.originalIdentityManifestHash)}
      if(mapped.state==='verified-legacy-only'&&legacyCustody)mapped={...mapped,legacyCustody}
      if(forcedReason)mapped={...mapped,state:mapped.state==='conflict'||forcedReason.includes('mismatch')?'conflict':'unproven',replacementProven:false,reasons:[...mapped.reasons,forcedReason]}
      // A bodyless semantic row is never remapped through a raw Team alias or
      // treated as a corrupt body merely because this legacy public-schema
      // scanner has no controlled semantic publication proof.
      if(row.source_kind==='team_semantic')mapped={...mapped,state:forcedReason?.includes('invalid')?'conflict':'unproven',sourceKind:'team_semantic',canonicalId:row.canonical_key,replacementProven:false,reasons:[forcedReason??'team_semantic_native_publication_proof_required']}
      counts[mapped.state]=(counts[mapped.state]??0n)+1n
      if(source.provenance==='unknown')unknownProvenance++
      for(const reason of mapped.reasons)reasons[reason]=(reasons[reason]??0n)+1n
      await options.onDetail(mapped)
      scanned++
    }
    after=rows.at(-1)!.source_event_id
  }
  const fullMappingExecuted=selected===undefined&&scanned===total
  const unresolvedMappingRows=counts.conflict+counts.ambiguous+counts.unproven
  const selectedMappingExecuted=!!selected&&scanned===BigInt(selected.length)
  return {schemaVersion:1,reportType:'mapping-summary',memorySnapshot:memory.identity,relaySnapshot:relay.identity,crossDatabaseAtomic:false,
    total:total.toString(),scanned:scanned.toString(),pages:String(pages),counts:Object.fromEntries(Object.entries(counts).map(([k,v])=>[k,v.toString()])),
    ...(selected?{selectedSourceIdsHash:hash(selected),selectedRequestedRows:String(selected.length),selectedMissingRows:String(BigInt(selected.length)-scanTotal),selectedMappingExecuted,selectedProofsComplete:selectedMappingExecuted&&unresolvedMappingRows===0n}:{}),
    reasons:Object.fromEntries(Object.entries(reasons).map(([k,v])=>[k,v.toString()])),mappingStates:MAPPING_STATES,unresolvedMappingRows:unresolvedMappingRows.toString(),mappingProofsComplete:fullMappingExecuted&&unresolvedMappingRows===0n,
    unknownProvenanceRows:unknownProvenance.toString(),legacyBodiesToRetain:counts['verified-legacy-only'].toString(),fullMappingExecuted,legacyInPlacePlanning:options.legacyInPlace===true,preNativeLogicalPreparation:options.preNativeLogicalPreparation===true,migrationReady:false,deletionAuthorized:false,
    backupRequired:false,rollbackSupported:false,waivedChecks:['memory_backup','memory_restore','memory_rollback'],
    blockers:[...(!fullMappingExecuted?['full_mapping_not_executed']:[]),...(selected&&scanTotal<BigInt(selected.length)?['selected_sources_missing']:[]),...(unresolvedMappingRows>0n?['source_identity_proofs_incomplete']:[]),'active_dependency_closure_not_executed','source_switch_and_forward_repair_gates_not_met'],
    limitations:['Independent database snapshots do not establish current production authorization; revalidate current Relay controls at apply/commit.','No body, canonical payload, grant, DSN, or model output is exported.','No legacy identity is inferred from absence or equal text; explicit original identity, owner custody and an in-place manifest are required. Necessary legacy bodies are retained, not deleted.']}
}
