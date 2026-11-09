import {canonicalPayloadHash} from '../canonical-json.js'
import type {TeamSourceProvenance} from './adapter.js'
import {parseAcceptedDeliveryProvenance} from './accepted-adapter.js'
import {acceptedDeliverySourceSessionId} from './delivery.js'
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=1024
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0
/** Internal typed identity. External Provider Feed source IDs stay unchanged.
 * Full access-projection identity prevents a later participant/binding proof
 * from silently inheriting an earlier reference UUID. No body hash is used. */
export function teamReaderProjectionKey(wireId:string,p:TeamSourceProvenance):string{
 const bad=():never=>{throw Error('invalid_team_projection_proof')}
 if(!p||p.source_kind!=='team_session'||![1,2].includes(p.source_version)||!text(wireId)||!p.read_scope)return bad()
 const s=p.read_scope
 if(![p.team_id,p.team_session_id,p.team_call_id,s.team_memory_binding_id,s.target_installation_id,s.target_owner_scope_id].every(text)
  ||s.kind!=='team_session'||s.team_id!==p.team_id||s.team_session_id!==p.team_session_id
  ||!['personal','team','organization'].includes(s.target_owner_scope_kind)||!positive(s.team_memory_binding_revision)||!positive(s.participant_user_id)||!positive(s.participant_revision)
  ||p.reader_projection_id!==`${s.team_memory_binding_id}:${s.team_memory_binding_revision}:${s.participant_user_id}:${s.participant_revision}`)return bad()
 let allowed:string[]
 if(p.source_version===1){
  if(p.original_source_id!==`team:${p.team_id}:${p.team_session_id}:${p.team_call_id}`)return bad()
  allowed=['goal','reply','outcome'].map(role=>`team:${p.team_call_id}:${role}:u${s.participant_user_id}:b${s.team_memory_binding_revision}:v1`)
 }else{
  const d=parseAcceptedDeliveryProvenance(p.accepted_delivery);if(!d)return bad()
  const original=`team-delivery:${d.submission_id}:${d.decision_id}`
  if(p.original_source_id!==original)return bad()
  const session=acceptedDeliverySourceSessionId({teamSessionId:p.team_session_id,submissionId:d.submission_id,decisionId:d.decision_id,bindingId:s.team_memory_binding_id,bindingRevision:s.team_memory_binding_revision,userId:s.participant_user_id,participantRevision:s.participant_revision})
  allowed=['goal','reply','outcome'].map(role=>`${original}:${role}:${session}:v2`)
 }
 if(!allowed.includes(wireId))return bad()
 return 'team_projection_'+canonicalPayloadHash(['team-native-projection-v1',wireId,p.source_version,s.team_memory_binding_id,String(s.team_memory_binding_revision),s.target_installation_id,s.target_owner_scope_kind,s.target_owner_scope_id,String(s.participant_user_id),String(s.participant_revision)]).toString('hex')
}
