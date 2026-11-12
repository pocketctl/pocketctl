import {canonicalPayloadHash} from '../../inbox/canonical-json.js'
const hash=(value:unknown)=>canonicalPayloadHash(value).toString('hex')
/** Exact original wire hash only. Grants no access, producer lineage or order.
 * A reclaimed transport must have both cleared fields and the retained marker;
 * an unmarked empty body is never substituted with a guessed original body. */
export function matchRetainedInboxEnvelope(i:Record<string,any>,payload:unknown,classification:unknown){
 if(typeof i.inbox_body_reclaimed!=='boolean')return false
 if(i.inbox_body_reclaimed?hash(i.data)!==hash({})||hash(i.classification)!==hash({}):hash(i.data)!==hash(payload)||hash(i.classification)!==hash(classification))return false
 return matchRetainedInboxEnvelopeHeader(i,payload,classification)
}
/** Rebuild the stored envelope hash from its body-free header and exact
 * source payload/classification. The source body hash is a separate proof. */
export function matchRetainedInboxEnvelopeHeader(i:Record<string,any>,payload:unknown,classification:unknown){
 if(i.envelope_version!==1||!['session.event.v1','session.lifecycle.v1','turn.lifecycle.v1','session.deleted.v1','session.access.revoked.v1'].includes(i.topic)
  ||typeof i.feed_id!=='string'||!/^[1-9][0-9]*$/.test(i.feed_id)||!/^event:[1-9][0-9]*$/.test(i.source_id??'')||i.source_kind!=='canonical_event'
  ||!/^[a-f0-9]{64}$/.test(i.envelope_hash??''))return false
 const date=new Date(i.recorded_at);if(!Number.isFinite(date.getTime()))return false
 const at=date.toISOString(),times=[at,...(at.endsWith('.000Z')?[at.replace('.000Z','Z')]:[])]
 for(const recorded_at of times)for(const optionalTurn of [false,true]){
  const subject={session_id:i.session_id,...(i.turn_id!==null?{turn_id:i.turn_id}:optionalTurn?{turn_id:null}:{}),event_type:i.event_type}
  if(hash({envelope_version:1,feed_id:i.feed_id,topic:i.topic,source:{kind:i.source_kind,id:i.source_id,recorded_at},subject,classification,data:payload})===i.envelope_hash)return true
 }
 return false
}
