import {canonicalSourceClassification} from '@pocketctl/session-source'
import {canonicalPayloadHash} from '../../inbox/canonical-json.js'
import type {Snapshot} from './database.js'
import type {Source} from './mapping.js'
const hash=(value:unknown)=>canonicalPayloadHash(value).toString('hex')
const positive=(value:string)=>/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n
/** A proposed in-place authority, not a backup, copy, binding write or deletion
 * permit. It needs an independent original identity witness and scope custody.
 * PK absence searches the entire canonical identity, including cold metadata;
 * equal text and unbound archive bytes never provide another identity. */
export async function proveInPlaceLegacyCustody(memory:Snapshot,relay:Snapshot,row:Record<string,any>,source:Source):Promise<{
 proof?:{identityVerified:true;completeTargetSearch:true;archiveVerified:true;manifestHash:string}
 manifest?:Record<string,unknown>;deleted?:boolean;reason?:string
}>{
 if(!['feed','snapshot'].includes(row.origin)||source.sessionId.startsWith('team_')||row.source_provenance?.team||row.source_provenance?.accepted_delivery)return {reason:'legacy_personal_identity_required'}
 if(source.bodyReclaimed||!source.originalHashVersion||source.hash!==source.actualHash)return {reason:'legacy_original_body_unverified'}
 const links=source.links.filter(l=>l.kind==='relay_event'&&['inbox','feed','journal','snapshot'].includes(l.via))
 const keys=[...new Set(links.map(l=>l.id))]
 if(!links.length||links.length>16||keys.length!==1||!positive(keys[0]))return {reason:'legacy_explicit_identity_unproven'}
 if(!/^personal-user:[1-9][0-9]*$/.test(source.ownerKey))return {reason:'legacy_owner_unproven'}
 const owner=source.ownerKey.slice('personal-user:'.length)
 if(!(await memory.client.query("SELECT to_regclass('public.memory_owner_scopes') IS NOT NULL AND to_regclass('public.memory_installations') IS NOT NULL AS present")).rows[0].present)return {reason:'legacy_scope_custody_unavailable'}
 const local=(await memory.client.query(`SELECT s.owner_scope_kind,s.owner_scope_id::text,s.state,s.authorization_epoch::text,i.provider_id,i.config_version::text
  FROM public.memory_owner_scopes s JOIN public.memory_installations i USING(installation_id) WHERE installation_id=$1`,[source.installationId])).rows
 const current=(await relay.client.query(`SELECT owner_user_id::text,status,to_jsonb(i)->>'owner_scope_kind' AS owner_scope_kind,to_jsonb(i)->>'owner_scope_id' AS owner_scope_id,
  to_jsonb(i)->>'authorization_epoch' AS authorization_epoch,to_jsonb(i)->>'config_version' AS config_version,to_jsonb(i)->>'provider_id' AS provider_id FROM public.extension_installations i WHERE installation_id=$1`,[source.installationId])).rows
 const l=local[0],i=current[0]
 if(local.length!==1||current.length!==1||l.owner_scope_kind!=='personal'||l.state!=='active'||i.owner_scope_kind!=='personal'||i.status!=='active'
  ||l.owner_scope_id!==i.owner_scope_id||l.authorization_epoch!==i.authorization_epoch||i.owner_user_id!==owner||l.provider_id!=='pocketctl-memory'||i.provider_id!=='pocketctl-memory'
  ||l.config_version!==i.config_version||!positive(i.authorization_epoch??'')||!positive(i.config_version??''))return {reason:'legacy_scope_custody_mismatch'}
 let witnessed=false
 for(const link of links){
  if(link.via==='inbox'){
   const rows=(await memory.client.query(`SELECT source_kind,source_id,session_id,turn_id,event_type,CASE WHEN octet_length(data::text)<=33554432 THEN data ELSE NULL END AS data,classification FROM public.memory_feed_inbox WHERE installation_id=$1 AND feed_id=$2`,[source.installationId,row.origin_position])).rows
   witnessed ||= rows.length===1&&rows[0].source_kind==='canonical_event'&&rows[0].source_id==='event:'+link.id&&rows[0].session_id===source.sessionId&&rows[0].turn_id===source.turnId&&rows[0].event_type===source.eventType&&hash(rows[0].data)===source.hash&&hash(rows[0].classification)===source.classificationHash
  }else if(link.via==='snapshot'){
   const rows=(await memory.client.query('SELECT event_type,CASE WHEN octet_length(payload::text)<=33554432 THEN payload ELSE NULL END AS payload FROM public.memory_snapshot_events WHERE installation_id=$1 AND session_id=$2 AND relay_event_id=$3',[source.installationId,source.sessionId,link.id])).rows
   witnessed ||= rows.length===1&&rows[0].event_type===source.eventType&&hash(rows[0].payload)===source.hash
  }else if(link.via==='journal'){
   const rows=(await relay.client.query(`SELECT source_seq::text,CASE WHEN octet_length(payload::text)<=33554432 THEN payload ELSE NULL END AS payload FROM public.extension_source_outbox WHERE source_kind='canonical_event' AND source_id=$1 AND owner_user_id=$2 AND session_id=$3 AND event_type=$4`,['event:'+link.id,owner,source.sessionId,source.eventType])).rows
   witnessed ||= rows.length===1&&hash(rows[0].payload)===source.hash&&rows[0].source_seq===source.sequence&&hash(canonicalSourceClassification({source_kind:'canonical_event',session_id:source.sessionId,source_seq:rows[0].source_seq,payload:rows[0].payload}))===source.classificationHash
  }else{
   const rows=(await relay.client.query(`SELECT CASE WHEN octet_length(payload::text)<=33554432 THEN payload ELSE NULL END AS payload FROM public.extension_feed WHERE feed_id=$1 AND source_kind='canonical_event' AND source_id=$2 AND owner_user_id=$3 AND session_id=$4`,[row.origin_position,'event:'+link.id,owner,source.sessionId])).rows
   witnessed ||= rows.length===1&&rows[0].payload?.data!==undefined&&rows[0].payload?.classification!==undefined&&hash(rows[0].payload.data)===source.hash&&hash(rows[0].payload.classification)===source.classificationHash
  }
 }
 if(!witnessed)return {reason:'legacy_original_identity_witness_unproven'}
 if(!(await relay.client.query("SELECT to_regclass('public.sessions') IS NOT NULL AS present")).rows[0].present)return {reason:'legacy_session_custody_unavailable'}
 const sessions=(await relay.client.query('SELECT user_id::text FROM public.sessions WHERE session_id=$1',[source.sessionId])).rows
 if(sessions.length>1||sessions.length===1&&sessions[0].user_id!==owner)return {reason:'legacy_current_session_owner_mismatch'}
 if((await relay.client.query('SELECT 1 FROM public.deleted_sessions WHERE session_id=$1',[source.sessionId])).rowCount)return {deleted:true}
 if((await relay.client.query('SELECT 1 FROM public.events WHERE id=$1',[keys[0]])).rowCount)return {reason:'legacy_canonical_identity_still_present'}
 const manifest={schemaVersion:1,kind:'memory-legacy-in-place-custody',bodyDisposition:'retain-in-place',
  sourceDatabaseFingerprint:memory.identity.databaseFingerprint,sourceSnapshotId:memory.identity.snapshotId,relayDatabaseFingerprint:relay.identity.databaseFingerprint,relaySnapshotId:relay.identity.snapshotId,
  sourceEventId:source.id,installationId:source.installationId,providerId:'pocketctl-memory',ownerScopeKind:'personal',ownerScopeId:i.owner_scope_id,ownerUserId:owner,authorizationEpoch:i.authorization_epoch,configVersion:i.config_version,
  originalCanonicalKind:'relay_event',originalCanonicalKey:keys[0],identityRelations:links,canonicalIdentitySearch:'exact-key-all-storage',canonicalIdentityAbsent:true,
  sessionId:source.sessionId,turnId:source.turnId,eventType:source.eventType,originalOrigin:row.origin,originalOriginPosition:row.origin_position,sourceRowVersion:row.source_row_version,
  originalSourceHash:source.originalSourceHash,originalHashVersion:source.originalHashVersion,contentHash:source.hash,hashVersion:'canonical-json-sha256-v1',
  classificationHash:source.classificationHash,provenanceHash:hash(row.source_provenance),provenanceState:source.provenance,sourceSequence:source.sequence??null,
  bodyExported:false,migrationAuthorized:false,deletionAuthorized:false}
 const manifestHash=hash(manifest)
 return {proof:{identityVerified:true,completeTargetSearch:true,archiveVerified:true,manifestHash},manifest}
}
