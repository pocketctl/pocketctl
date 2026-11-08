import type pg from 'pg'
import {canonicalPayloadHash,canonicalSourceClassification,createPostgresSharedSourceReader,type SourceScope,type SourceRoot} from '@pocketctl/session-source'
import {originalIngressEventHash,readIngressKeyIndex} from '../shared-source/ingress-key.js'
import {matchRetainedInboxEnvelope} from '../shared-source/retained-inbox-envelope.js'
const digest=(v:unknown)=>canonicalPayloadHash(v).toString('hex')
/** A recurring discovery ID can retain several historical observations. A
 * current canonical witness proves their literal relationship, never equality
 * or replacement. Original cells remain the only authority for these bytes. */
export async function prepareOriginalDiscoveryObservation(source:pg.Client,target:pg.Client,scope:SourceScope,root:SourceRoot,row:Record<string,any>,payload:Record<string,any>,canonicalKey:string,archive?:Parameters<typeof createPostgresSharedSourceReader>[1]){
 const fail=()=>{throw Error('necessary_original_discovery_unproven')}
 const eventHash=originalIngressEventHash({...row,payload}),index=await readIngressKeyIndex(target)
 if(!eventHash||!index||row.event_type!=='session_discovered'||row.turn_id!==null||Object.hasOwn(payload,'memory_source'))fail()
 const reader=createPostgresSharedSourceReader({query:(sql,args)=>target.query(sql,args),async connect(){throw Error('necessary_original_external_io_forbidden')}},archive)
 const page=await reader.getHeads(scope,root,[canonicalKey]),bodies=await reader.resolveBodies(scope,root,page.heads,page.version),body=bodies[0]
 if(bodies.length!==1||!body)fail()
 const h=body.head,p=body.payload as Record<string,any>,e=(await target.query('SELECT xmin::text AS row_version,user_id::text,session_id,event_hash FROM public.events WHERE id=$1',[canonicalKey])).rows[0]
 if(!e||e.user_id!==scope.principalUserId||e.session_id!==row.session_id||e.event_hash!==eventHash||h.sessionKey!==row.session_id||h.eventType!=='session_discovered'
  ||!['hot','cold'].includes(h.storage)||h.provenance.state!=='unknown'||h.sourceSequence!==undefined||h.turnKey!==undefined
  ||p.event_id!==payload.event_id||(p.turn_id??p.source_turn_id??null)!==null||Object.hasOwn(p,'memory_source')
  ||digest(canonicalSourceClassification({source_kind:'canonical_event',session_id:row.session_id,source_seq:'',payload:p}))!==digest(row.classification)
  ||digest(p)===digest(payload)||!h.occurredAt||!Number.isFinite(new Date(row.occurred_at).getTime())||!(new Date(row.occurred_at).getTime()>new Date(h.occurredAt).getTime()))fail()
 const inbox=(await source.query(`SELECT xmin::text AS row_version,feed_id::text,envelope_version,topic,source_kind,source_id,session_id,turn_id,event_type,recorded_at,
  encode(payload_hash,'hex') AS envelope_hash,body_reclaimed_at IS NOT NULL AS inbox_body_reclaimed,classification,
  CASE WHEN octet_length(data::text)<=33554432 THEN data ELSE NULL END AS data FROM public.memory_feed_inbox WHERE installation_id=$1 AND feed_id=$2`,[scope.installationId,row.origin_position])).rows
 const feedSql=`SELECT xmin::text AS row_version,feed_id::text,owner_user_id::text,topic,source_kind,source_id,session_id,turn_id,envelope_version,
  CASE WHEN octet_length(payload::text)<=33554432 THEN payload ELSE NULL END AS payload FROM public.extension_feed WHERE feed_id=$1`
 const feed=(await target.query(feedSql,[row.origin_position])).rows
 if(inbox.length>1||feed.length>1)fail()
 const i=inbox[0],f=feed[0],key='event:'+canonicalKey
 if(i&&(i.source_id!==key||i.source_kind!=='canonical_event'||i.session_id!==row.session_id||i.turn_id!==null||i.event_type!==row.event_type
  ||!matchRetainedInboxEnvelope(i,payload,row.classification)))fail()
 if(f){
  const env=f.payload
  if(f.owner_user_id!==scope.principalUserId||f.source_kind!=='canonical_event'||f.source_id!==key||f.session_id!==row.session_id||f.turn_id!==null||f.envelope_version!==1
   ||!env||env.envelope_version!==1||env.topic!==f.topic||env.source?.kind!=='canonical_event'||env.source?.id!==key||env.subject?.session_id!==row.session_id
   ||(env.subject?.turn_id??null)!==null||env.subject?.event_type!==row.event_type||digest(env.data)!==digest(payload)||digest(env.classification)!==digest(row.classification))fail()
  // Both independent retained transport rows must agree when both survive.
  if(i&&!matchRetainedInboxEnvelope(i,env.data,env.classification))fail()
 }
 const feedFacts=feed.map(({payload,...metadata})=>({...metadata,envelopeHash:digest(payload)}))
 const manifest={schemaVersion:1,kind:'original-session-discovery-observation',canonicalKey,canonicalRowVersion:e.row_version,canonicalSourceVersion:page.version,
  ingressIndexHash:index!.definitionHash,ingressEventHash:eventHash,sourceIngressKeyHash:digest(row.canonical_event_key),canonicalContentHash:h.contentHash,
  canonicalOccurredAt:h.occurredAt,originalOccurredAt:new Date(row.occurred_at).toISOString(),canonicalStorage:h.storage,
  inbox:inbox.map(({data,classification,...metadata})=>({...metadata,classificationHash:digest(classification)})),feed:feedFacts,
  canonicalWitnessIsReplacement:false,canonicalIdentityResolved:false,canonicalAbsenceProven:false,sourceSequence:null,provenanceState:'unknown'}
 return {manifest,async assertCurrent(){
  const current=await reader.checkCurrent(scope,root,page.version),freshIndex=await readIngressKeyIndex(target)
  const fresh=(await target.query('SELECT xmin::text AS row_version,user_id::text,session_id,event_hash FROM public.events WHERE id=$1 FOR SHARE NOWAIT',[canonicalKey])).rows[0]
  const freshFeed=(await target.query(feedSql+' FOR SHARE NOWAIT',[row.origin_position])).rows.map(({payload,...metadata})=>({...metadata,envelopeHash:digest(payload)}))
  if(current.state!=='current'||freshIndex?.definitionHash!==index!.definitionHash||digest(fresh??null)!==digest(e)||digest(freshFeed)!==digest(feedFacts))throw Error('necessary_original_discovery_changed')
 }}
}
