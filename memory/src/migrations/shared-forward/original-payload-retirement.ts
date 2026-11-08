import type pg from 'pg'
import {canonicalPayloadHash,canonicalJsonString,createPostgresSharedSourceReader,verifyOriginalSourceHash,type SourceScope,type SourceRoot,type SourceVersion} from '@pocketctl/session-source'
import {assertOriginalCopiedSource,type OriginalBindingCopyReceipt} from './original-copy-proof.js'
import {assertTargetMemoryWritersFenced} from './source-maintenance-capabilities.js'
import {assertFrozenMemorySource} from '../shared-source/maintenance.js'
import {qi} from './source-maintenance-common.js'

const derived=new Set(['source_kind','canonical_key','canonical_session_key','source_version','source_sequence','content_hash','hash_version','mapping_state','adapter_version','canonical_projected_at'])
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v)
const digest=(v:unknown)=>canonicalPayloadHash(v).toString('hex')
type Archive=Parameters<typeof createPostgresSharedSourceReader>[1]
interface Prepared {source:pg.Client;target:pg.Client;copy:OriginalBindingCopyReceipt;scope:SourceScope;root:SourceRoot;version:SourceVersion;rows:{id:string;xmin:string;body:string;already:boolean}[];proofHash:string}
const preparedPages=new WeakMap<object,Prepared>()
export interface OriginalPayloadRetirementPage {readonly token:object;readonly kind:'proved-original-payload-retirement';readonly rows:number;readonly proofHash:string;readonly manifestHash:string}

/** Explicit finite maintenance operation. Binding alone grants no deletion.
 * Re-prove exact original JSONB equivalence through the current controlled
 * hot/cold reader, preserve every metadata column and UUID, and require the
 * complete Session to be admitted before issuing an opaque retirement token.
 * No payload is returned in the plan or receipt; original source remains frozen.
 */
export async function prepareOriginalPayloadRetirement(source:pg.Client,target:pg.Client,input:{copy:OriginalBindingCopyReceipt;scope:SourceScope;root:SourceRoot;sourceEventIds:string[]},options:{archive?:Archive;signal?:AbortSignal}={}):Promise<OriginalPayloadRetirementPage>{
 const {copy,scope,root,sourceEventIds:ids}=structuredClone(input)
 const abort=()=>{if(options.signal?.aborted)throw Error('original_retirement_aborted')};abort()
 if(root?.kind!=='relay_event'||scope?.ownerScopeKind!=='personal'||!uuid(scope.installationId)||!/^\d*[1-9]\d*$/.test(scope.principalUserId)||!root.key.startsWith(scope.principalUserId+':')
  ||!Array.isArray(ids)||ids.length<1||ids.length>128||ids.some(id=>!uuid(id))||new Set(ids).size!==ids.length)throw Error('original_retirement_input_invalid')
 const columns=(await assertOriginalCopiedSource(source,target,copy)).filter(c=>c!=='payload'&&!derived.has(c))
 await source.query("SET TIME ZONE 'UTC'");await target.query("SET TIME ZONE 'UTC'")
 const mode=(await target.query('SELECT mode,generation::text FROM shared.memory_source_modes JOIN shared.memory_source_contract ON singleton WHERE installation_id=$1 AND activation_ready',[scope.installationId])).rows[0]
 if(mode?.mode!=='shared-shadow'||mode.generation!==scope.modeGeneration)throw Error('original_retirement_offline_mode_required')
 const session=root.key.slice(scope.principalUserId.length+1)
 if((await target.query("SELECT 1 FROM memory.source_events WHERE installation_id=$1 AND session_id=$2 AND(mapping_state IS DISTINCT FROM 'verified' OR source_kind IS NULL OR source_kind NOT IN('relay_event','legacy_archive')) LIMIT 1",[scope.installationId,session])).rowCount)throw Error('original_retirement_session_unresolved')
 const rowSql=(schema:string)=>`SELECT s.source_event_id::text,s.xmin::text AS row_version,s.installation_id::text,s.session_id,s.turn_id,s.origin,s.origin_position,s.event_type,s.occurred_at,s.classification,
  encode(s.payload_hash,'hex') AS original_hash,s.body_reclaimed_at,encode(sha256(convert_to(row_to_json(original)::text,'UTF8')),'hex') AS original_metadata_hash
  ${schema==='memory'?",s.mapping_state,s.source_kind,s.canonical_key,s.canonical_session_key,s.adapter_version,encode(s.content_hash,'hex') AS content_hash,s.payload IS NULL AS already_retired":''}
  FROM ${schema}.source_events s CROSS JOIN LATERAL(SELECT ${columns.map(c=>'s.'+qi(c)).join(',')}) original WHERE s.source_event_id=ANY($1::uuid[]) ORDER BY s.source_event_id`
 const originals=(await source.query(rowSql('public'),[ids])).rows,rows=(await target.query(rowSql('memory'),[ids])).rows
 if(originals.length!==ids.length||rows.length!==ids.length)throw Error('original_retirement_row_missing')
 for(const row of rows){const old=originals.find(r=>r.source_event_id===row.source_event_id)
  if(!old||row.original_metadata_hash!==old.original_metadata_hash||row.installation_id!==scope.installationId||row.session_id!==session||row.body_reclaimed_at||!['feed','snapshot'].includes(row.origin)
   ||row.mapping_state!=='verified'||row.source_kind!=='relay_event'||row.adapter_version!=='original-ref-v1'||row.canonical_session_key!==session||!/^\d*[1-9]\d*$/.test(row.canonical_key??''))throw Error('original_retirement_original_changed')
 }
 if(new Set(rows.map(r=>r.canonical_key)).size!==rows.length)throw Error('original_retirement_duplicate_identity')
 const reader=createPostgresSharedSourceReader({query:(sql,args)=>target.query(sql,args),async connect(){throw Error('original_retirement_reader_transaction_forbidden')}},options.archive)
 const heads=await reader.getHeads(scope,root,rows.map(r=>r.canonical_key)),bodies=await reader.resolveBodies(scope,root,heads.heads,heads.version),prepared:Prepared['rows']=[]
 let bytes=0
 for(const row of rows){abort();const resolved=bodies.find(b=>b.head.canonicalKey===row.canonical_key),body=resolved?.payload as Record<string,unknown>|undefined,h=resolved?.head
  if(!body||!h||h.sessionKey!==session||h.eventType!==row.event_type||h.contentHash!==row.content_hash||canonicalJsonString(row.classification)!==canonicalJsonString(h.classification)
   ||!h.occurredAt||new Date(h.occurredAt).getTime()!==new Date(row.occurred_at).getTime()||(body.turn_id??body.source_turn_id??null)!==row.turn_id
   ||!verifyOriginalSourceHash({origin:row.origin,originPosition:row.origin_position,eventType:row.event_type,occurredAt:row.occurred_at,payload:body,payloadHash:row.original_hash}))throw Error('original_retirement_body_not_equivalent')
  const json=canonicalJsonString(body);bytes+=Buffer.byteLength(json);if(bytes>32*1024*1024)throw Error('original_retirement_page_byte_limit')
  if(!(await source.query('SELECT 1 FROM public.source_events WHERE source_event_id=$1 AND payload=$2::jsonb',[row.source_event_id,json])).rowCount
   ||!(await target.query('SELECT 1 FROM memory.source_events WHERE source_event_id=$1 AND(payload=$2::jsonb OR payload IS NULL)',[row.source_event_id,json])).rowCount)throw Error('original_retirement_body_not_equivalent')
  prepared.push({id:row.source_event_id,xmin:row.row_version,body:json,already:row.already_retired})
 }
 abort();await assertFrozenMemorySource(source);await assertTargetMemoryWritersFenced(target)
 const proofHash=digest({manifestHash:copy.manifestHash,scope,root,version:heads.version,rows:rows.map(r=>({id:r.source_event_id,xmin:r.row_version,original:r.original_metadata_hash,content:r.content_hash,canonical:r.canonical_key,already:r.already_retired}))})
 const token=Object.freeze({});preparedPages.set(token,{source,target,copy,scope,root,version:heads.version,rows:prepared,proofHash})
 return Object.freeze({token,kind:'proved-original-payload-retirement',rows:rows.length,proofHash,manifestHash:copy.manifestHash})
}

export async function applyOriginalPayloadRetirement(source:pg.Client,target:pg.Client,page:OriginalPayloadRetirementPage,options:{beforeCommit?:()=>Promise<void>;signal?:AbortSignal}={}){
 const p=preparedPages.get(page?.token)
 if(!p||p.source!==source||p.target!==target||p.proofHash!==page.proofHash)throw Error('original_retirement_token_invalid')
 const abort=()=>{if(options.signal?.aborted)throw Error('original_retirement_aborted')};abort();await options.beforeCommit?.();abort()
 let changed=0,alreadyRetired=0
 try{
  await target.query('BEGIN');await target.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'")
  await assertTargetMemoryWritersFenced(target)
  const mode=(await target.query('SELECT mode,generation::text FROM shared.memory_source_modes JOIN shared.memory_source_contract ON singleton WHERE installation_id=$1 AND activation_ready',[p.scope.installationId])).rows[0]
  if(mode?.mode!=='shared-shadow'||mode.generation!==p.scope.modeGeneration)throw Error('original_retirement_authority_changed')
  if(!(await target.query('SELECT shared.lock_memory_personal_source_commit($1::jsonb,$2,$3,$4::jsonb,FALSE) AS locked',[JSON.stringify(p.scope),p.root.kind,p.root.key,JSON.stringify(p.version)])).rows[0]?.locked)throw Error('original_retirement_authority_changed')
  if(!(await target.query("SELECT pg_try_advisory_xact_lock(hashtextextended('canonical-projection:'||$1,0)) AS locked",[p.scope.installationId])).rows[0].locked)throw Error('original_retirement_busy')
  for(const row of p.rows){abort()
   const result=await target.query(row.already?'SELECT 1 FROM memory.source_events WHERE source_event_id=$1 AND xmin::text=$2 AND payload IS NULL FOR UPDATE NOWAIT':'UPDATE memory.source_events SET payload=NULL WHERE source_event_id=$1 AND xmin::text=$2 AND payload=$3::jsonb',[row.id,row.xmin,...(row.already?[]:[row.body])])
   if(result.rowCount!==1)throw Error('original_retirement_row_changed')
   if(row.already)alreadyRetired++;else changed++
  }
  abort();await assertFrozenMemorySource(source);await target.query('COMMIT');preparedPages.delete(page.token)
  return {kind:'original-personal-payload-retirement',manifestHash:p.copy.manifestHash,proofHash:p.proofHash,changed,alreadyRetired,originalIdsPreserved:true,provenanceRewritten:false,bodyReclaimedAtChanged:false,canonicalBodiesRemoved:false}
 }catch(e){await target.query('ROLLBACK').catch(()=>{});throw e}
}
