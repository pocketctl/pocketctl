import {canonicalSourceClassification} from '@pocketctl/session-source'
import {canonicalPayloadHash} from '../../inbox/canonical-json.js'
import type {Snapshot} from './database.js'
import type {Source} from './mapping.js'
import {matchRetainedInboxEnvelope} from './retained-inbox-envelope.js'
import {originalIngressEventHash} from './ingress-key.js'
const hash=(value:unknown)=>canonicalPayloadHash(value).toString('hex')
const absent=(value:any,key:string)=>value!==null&&typeof value==='object'&&!Object.hasOwn(value,key)
interface FrozenScopeFacts {local:Record<string,any>[];current:Record<string,any>[];sessions:Record<string,any>[]}
// Only metadata from the same pair of original read-only RR Snapshot objects
// is reusable. This never caches currentNativeSessionAuthority, controlled
// reader results, body IO or a runtime/commit fence. Weak keys prevent facts
// surviving into a later mapping snapshot; the finite map is bounded as well.
const frozenScopes=new WeakMap<Snapshot,WeakMap<Snapshot,Map<string,Promise<FrozenScopeFacts|undefined>>>>()
async function frozenScopeFacts(memory:Snapshot,relay:Snapshot,installationId:string,sessionId:string):Promise<FrozenScopeFacts|undefined>{
 let relays=frozenScopes.get(memory);if(!relays){relays=new WeakMap();frozenScopes.set(memory,relays)}
 let scopes=relays.get(relay);if(!scopes){scopes=new Map();relays.set(relay,scopes)}
 const key=JSON.stringify([installationId,sessionId]),found=scopes.get(key);if(found)return found
 const pending=(async()=>{
  const present=(await memory.client.query("SELECT to_regclass('public.memory_owner_scopes') IS NOT NULL AND to_regclass('public.memory_installations') IS NOT NULL AS present")).rows[0].present
  if(!present||!(await relay.client.query("SELECT to_regclass('public.sessions') IS NOT NULL AND to_regclass('public.daemons') IS NOT NULL AS present")).rows[0].present)return
  const local=(await memory.client.query(`SELECT s.owner_scope_kind,s.owner_scope_id::text,s.state,s.authorization_epoch::text,i.provider_id,i.config_version::text
   FROM public.memory_owner_scopes s JOIN public.memory_installations i USING(installation_id) WHERE installation_id=$1`,[installationId])).rows
  const current=(await relay.client.query(`SELECT i.owner_user_id::text,i.status,to_jsonb(i)->>'owner_scope_kind' AS owner_scope_kind,to_jsonb(i)->>'owner_scope_id' AS owner_scope_id,
   to_jsonb(i)->>'authorization_epoch' AS authorization_epoch,to_jsonb(i)->>'config_version' AS config_version,i.provider_id,p.status AS provider_status
   FROM public.extension_installations i JOIN public.extension_providers p USING(provider_id) WHERE installation_id=$1`,[installationId])).rows
  const sessions=(await relay.client.query(`SELECT s.user_id::text,d.user_id::text AS daemon_owner,to_jsonb(s)->>'daemon_id' AS daemon_id
   FROM public.sessions s JOIN public.daemons d ON d.daemon_id=to_jsonb(s)->>'daemon_id' WHERE s.session_id=$1`,[sessionId])).rows
  return {local,current,sessions}
 })()
 if(scopes.size<4096)scopes.set(key,pending)
 return pending
}
/** Planning proof only. An exact retained v1 transport can establish original
 * identity without establishing producer lineage or a pruned Journal order.
 * Current native routing and authorization must still be revalidated at bind. */
export async function proveRetainedFeedIdentity(memory:Snapshot,relay:Snapshot,row:Record<string,any>,source:Source,event:Record<string,any>,feed:Record<string,any>[],inbox:Record<string,any>[],ingress?:{definitionHash:string;eventHash:string;archiveVerified:boolean}){
 // A later canonical header is an independent current order. Its verified
 // hash/classification may corroborate the literal transport identity, but
 // never supplies the original unknown producer lineage or source sequence.
 const header=event.source_header_version==='1'&&typeof event.source_sequence==='string'&&/^[1-9][0-9]{0,18}$/.test(event.source_sequence)
  &&BigInt(event.source_sequence)<=9223372036854775807n&&event.canonical_payload_hash===source.hash
  &&hash(event.source_classification)===source.classificationHash
 if(source.provenance!=='unknown'||source.sequence!==undefined||source.bodyReclaimed||source.originalHashVersion!=='canonical-json-sha256-v1'
  ||row.origin!=='feed'||!/^personal-user:[1-9][0-9]*$/.test(source.ownerKey)||source.sessionId.startsWith('team_')||event.body_storage!=='hot'&&!(ingress?.archiveVerified&&event.body_storage==='cold')
  ||((event.source_header_version!=null||event.source_sequence!=null)&&!header)||!absent(row.source_provenance,'memory')||!absent(row.classification,'memory_source')
  ||event.user_id!==source.ownerKey.slice(14)||event.session_id!==source.sessionId||event.current_session_id!==source.sessionId
  ||event.event_type!==source.eventType||(event.payload?.turn_id??event.payload?.source_turn_id??null)!==source.turnId
  ||hash(event.payload)!==source.hash||hash(canonicalSourceClassification({source_kind:'canonical_event',session_id:event.session_id,source_seq:'',payload:event.payload}))!==source.classificationHash)return
 if(row.occurred_at==null||event.original_occurred_at==null)return
 const at=new Date(row.occurred_at).getTime(),canonicalAt=new Date(event.original_occurred_at).getTime()
 if(!Number.isFinite(at)||at!==canonicalAt||feed.length>1||(!ingress&&inbox.length!==1))return
 const f=feed[0],i=inbox[0],envelope=f?.payload,key='event:'+event.id,owner=event.user_id
 if(![row.source_row_version,event.canonical_row_version,...(f?[f.feed_row_version]:[]),...(i?[i.inbox_row_version]:[])].every(v=>typeof v==='string'&&/^[1-9][0-9]*$/.test(v)))return
 if(!ingress&&(i.source_kind!=='canonical_event'||i.source_id!==key||i.session_id!==source.sessionId||i.turn_id!==source.turnId||i.event_type!==source.eventType))return
 const inboxOnly=!f&&!ingress
 if(ingress){
  if(feed.length||inbox.length||!/^[a-f0-9]{64}$/.test(ingress.definitionHash)||originalIngressEventHash(row)!==ingress.eventHash||event.event_hash!==ingress.eventHash||event.payload?.event_id!==row.payload?.event_id)return
 }else if(inboxOnly){
  if(i.feed_id!==row.origin_position||!matchRetainedInboxEnvelope(i,row.payload,row.classification))return
 }else if(f.source_kind!=='canonical_event'||f.source_id!==key||f.owner_user_id!==owner||f.session_id!==source.sessionId
  ||envelope?.envelope_version!==1||envelope.source?.kind!=='canonical_event'||envelope.source?.id!==key
  ||envelope.subject?.session_id!==source.sessionId||(envelope.subject?.turn_id??null)!==source.turnId||envelope.subject?.event_type!==source.eventType
  ||hash(envelope.data)!==source.hash||hash(envelope.classification)!==source.classificationHash||!absent(envelope.classification,'memory_source')
  ||hash(i.data)!==source.hash||hash(i.classification)!==source.classificationHash)return
 const facts=await frozenScopeFacts(memory,relay,source.installationId,source.sessionId);if(!facts)return
 const {local,current,sessions}=facts
 const l=local[0],c=current[0]
 if(local.length!==1||current.length!==1||l.owner_scope_kind!=='personal'||l.state!=='active'||c.owner_scope_kind!=='personal'||c.status!=='active'||c.provider_status!=='enabled'
  ||l.owner_scope_id!==c.owner_scope_id||l.authorization_epoch!==c.authorization_epoch||c.owner_user_id!==owner||l.provider_id!=='pocketctl-memory'||c.provider_id!=='pocketctl-memory'
  ||l.config_version!==c.config_version||!/^\d*[1-9]\d*$/.test(c.authorization_epoch??'')||!/^\d*[1-9]\d*$/.test(c.config_version??''))return
 if(sessions.length!==1||sessions[0].user_id!==owner||sessions[0].daemon_owner!==owner)return
 const manifest={schemaVersion:1,kind:ingress?'retained-ingress-key-v1-original-identity':inboxOnly?'retained-inbox-v1-original-identity':'retained-feed-v1-original-identity',sourceEventId:source.id,installationId:source.installationId,canonicalKind:'relay_event',canonicalKey:String(event.id),
  sourceDatabaseFingerprint:memory.identity.databaseFingerprint,sourceSnapshotId:memory.identity.snapshotId,relayDatabaseFingerprint:relay.identity.databaseFingerprint,relaySnapshotId:relay.identity.snapshotId,
  originalOrigin:row.origin,originalOriginPosition:row.origin_position,sourceRowVersion:row.source_row_version,canonicalRowVersion:event.canonical_row_version,feedRowVersion:f?.feed_row_version??null,inboxRowVersion:i?.inbox_row_version??null,
  ...(inboxOnly?{transportEnvelopeHash:i.envelope_hash,inboxBodyReclaimed:i.inbox_body_reclaimed}:{}),
  ...(ingress?{ingressIndexHash:ingress.definitionHash,ingressEventHash:ingress.eventHash,sourceIngressKeyHash:hash(row.canonical_event_key),archiveVerified:ingress.archiveVerified}:{}),
  ownerUserId:owner,ownerScopeId:c.owner_scope_id,authorizationEpoch:c.authorization_epoch,configVersion:c.config_version,sessionId:source.sessionId,daemonId:sessions[0].daemon_id,turnId:source.turnId,eventType:source.eventType,
  occurredAt:new Date(at).toISOString(),originalSourceHash:source.originalSourceHash,originalHashVersion:source.originalHashVersion,contentHash:source.hash,classificationHash:source.classificationHash,provenanceHash:hash(row.source_provenance),
  ...(header?{canonicalHeader:{version:1,sequence:event.source_sequence,contentHash:event.canonical_payload_hash,classificationHash:hash(event.source_classification)}}:{}),
  // Literal producer-looking payload bytes are part of the exact body hash,
  // never an authenticated provenance/sequence channel for this proof.
  provenanceState:'unknown',producerPayloadMetadataPresent:Object.hasOwn(row.payload,'memory_source'),sourceSequence:null,journalOrderProven:false,bodyExported:false,runtimeAuthorizationGranted:false,deletionAuthorized:false}
 return {proof:{kind:ingress?'retained-ingress-key-v1' as const:inboxOnly?'retained-inbox-v1' as const:'retained-feed-v1' as const,manifestHash:hash(manifest)},manifest}
}
