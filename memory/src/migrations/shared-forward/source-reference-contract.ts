import {JSON_COLUMN_POLICY} from '../shared-source/json-reference-policy.js'
import {qi} from './source-maintenance-common.js'

/** One metadata reference contract for retained inventory and exact cleanup.
 * These names describe handles, never UUID-looking strings in ordinary prose.
 * Retained extraction keeps its original precedence and output semantics. */
export const SOURCE_REFERENCE_FIELDS=[
 {output:'sourceEventId',domain:'events',scalar:['source_event_id','sourceEventId'],arrays:['source_event_ids','sourceEventIds'],fold:true},
 {output:'artifactId',domain:'artifacts',scalar:['artifact_id','artifactId'],arrays:['artifact_ids','artifactIds'],fold:true},
 {output:'episodeId',domain:'episodes',scalar:['episode_id','episodeId'],arrays:['episode_ids','episodeIds'],fold:true},
 {output:'sessionId',domain:'sessions',scalar:['session_id','sessionId'],arrays:[],fold:false},
 {output:'canonicalSessionId',domain:'sessions',scalar:['canonical_session_key'],arrays:[],fold:false},
] as const
// Session arrays are unreviewed shapes: recognize them only to refuse them.
// They do not extend retained inventory or confer positive source authority.
export const UNREVIEWED_SESSION_ARRAY_KEYS=['session_ids','sessionIds','canonical_session_keys','canonicalSessionKeys','canonical_session_ids','canonicalSessionIds'] as const
export function declaredReferenceRoster(){return Object.entries(JSON_COLUMN_POLICY).filter(([,p])=>p.kind==='reference').map(([path])=>path)}
export function retainedReferenceRoster(){
 return [...declaredReferenceRoster().filter(p=>p!=='source_events.source_version'),'source_events.source_provenance','source_artifacts.details']
}
export function referenceChannelSql(table:string){
 let from='memory.'+qi(table)+' t',owner='t.installation_id'
 if(table==='memory_promotion_candidate_versions'){
  from+=' JOIN memory.memory_promotion_candidates owner ON owner.candidate_id=t.candidate_id';owner='owner.target_installation_id'
 }else if(table==='memory_promotion_evidence'){
  from+=' JOIN memory.memory_promotion_candidate_versions revision ON revision.candidate_revision_id=t.candidate_revision_id JOIN memory.memory_promotion_candidates owner ON owner.candidate_id=revision.candidate_id';owner='owner.target_installation_id'
 }
 return {from,owner}
}
export function retainedScalarReferenceSql(object:string){
 return SOURCE_REFERENCE_FIELDS.flatMap(field=>[`'${field.output}'`,field.scalar.length===1?`${object}->>'${field.scalar[0]}'`:`COALESCE(${field.scalar.map(key=>`${object}->>'${key}'`).join(',')})`]).join(',')
}
export function retainedArrayExpansionSql(object:string){
 return `jsonb_build_array(${object})`+SOURCE_REFERENCE_FIELDS.filter(field=>field.arrays.length).map(field=>{
  const array=`COALESCE(${field.arrays.map(key=>`${object}->'${key}'`).join(',')})`
  return `||COALESCE((SELECT jsonb_agg(jsonb_build_object('${field.scalar[0]}',value)) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${array})='array' THEN ${array} ELSE '[]' END)), '[]'::jsonb)`
 }).join('')
}
/** Server-side exact negative predicate. Every supported spelling participates
 * independently, even if a sibling spelling is also present or malformed.
 * Retained ->> scalar coercion is preserved (including malformed containers);
 * nested values under an explicit reference key remain negative-only.
 * No installation-wide value hash, body transfer or literal-text matching. */
export function matchesSourceReferenceSql(metadata:string,variables:string,owner:string){
 const fields=[...SOURCE_REFERENCE_FIELDS.map(field=>({...field,keys:[...field.scalar,...field.arrays]})),{domain:'sessions',keys:[...UNREVIEWED_SESSION_ARRAY_KEYS],fold:false}]
 const comparisons=fields.map(field=>{
  const value=field.fold?`lower(handle#>>'{}')`:`handle#>>'{}'`
  const equal=field.domain==='sessions'
   ?`EXISTS(SELECT 1 FROM jsonb_to_recordset(${variables}->'roots') root("installationId" text,"sessionId" text) WHERE root."installationId"=${owner}::text AND root."sessionId"=${value})`
   :`${value}=ANY(ARRAY(SELECT jsonb_array_elements_text(${variables}->'${field.domain}')))`
  return field.keys.map(key=>`EXISTS(SELECT 1 FROM jsonb_path_query(object->'${key}','strict $.**') handle WHERE ${equal})`).join(' OR ')
 }).join(' OR ')
 const keys=fields.flatMap(field=>field.keys).map(key=>"'"+key+"'").join(',')
 return `EXISTS(SELECT 1 FROM jsonb_path_query(${metadata},'strict $.** ? (@.type() == "object")') object WHERE object ?| ARRAY[${keys}] AND (${comparisons}))`
}
