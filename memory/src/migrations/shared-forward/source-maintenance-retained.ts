import type pg from 'pg'
import {retainedReferenceRoster,referenceChannelSql,retainedScalarReferenceSql,retainedArrayExpansionSql} from './source-reference-contract.js'
import {hash,qi} from './source-maintenance-common.js'
export interface RetainedRoot {installationId:string;sessionId:string}
export interface RetainedDelivery {installationId:string;teamId:string;teamSessionId:string;submissionId:string;decisionId:string;independent:boolean}
export interface RetainedReference {installationId:string;table:string;column:string;rowKey:unknown;metadataFingerprint?:string;sourceEventId?:string;artifactId?:string;episodeId?:string;sessionId?:string;canonicalSessionId?:string;independent:boolean;provenance?:Record<string,string|null>}
export interface RetainedClosure {roots:RetainedRoot[];deliveries:RetainedDelivery[];capsules:unknown[];references:RetainedReference[];unresolved:RetainedReference[];fingerprint:string}
const globalUuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
/** Server-side allowlist extraction: arbitrary locator/manifest text never
 * leaves PostgreSQL. Only explicitly named reference/provenance fields count;
 * content, excerpts, statements and UUID-looking strings are never searched. */
export async function collectRetainedClosure(c:pg.Client,ids:string[]):Promise<RetainedClosure>{
 const roots=new Map<string,RetainedRoot>(),references:RetainedReference[]=[],deliveries:RetainedDelivery[]=[],unresolved:RetainedReference[]=[]
 const root=(installationId:string,sessionId:string)=>{if(!sessionId||sessionId.length>512)throw Error('retained_session_identity_invalid');roots.set(installationId+':'+sessionId,{installationId,sessionId})}
 const native=(await c.query(`SELECT installation_id::text,COALESCE(canonical_session_key,session_id) AS session_id FROM memory.source_events WHERE installation_id=ANY($1::uuid[])
  UNION SELECT installation_id::text,session_id FROM memory.source_sessions WHERE installation_id=ANY($1::uuid[])
  UNION SELECT installation_id::text,session_id FROM memory.work_episodes WHERE installation_id=ANY($1::uuid[])
  UNION SELECT installation_id::text,session_id FROM memory.source_artifacts WHERE installation_id=ANY($1::uuid[])
  UNION SELECT installation_id::text,session_id FROM memory.memory_task_bundles WHERE installation_id=ANY($1::uuid[])
  UNION SELECT installation_id::text,session_id FROM memory.memory_context_packs WHERE installation_id=ANY($1::uuid[]) LIMIT 4097`,[ids])).rows
 if(native.length>4096)throw Error('retained_closure_limit')
 for(const row of native)root(row.installation_id,row.session_id)
 const roster=retainedReferenceRoster()
 for(const path of roster){
  const [table,column]=path.split('.')
  const keyColumns=(await c.query(`SELECT a.attname FROM pg_index i JOIN LATERAL unnest(i.indkey) WITH ORDINALITY key(attnum,ordinal) ON true JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=key.attnum WHERE i.indrelid=to_regclass($1) AND i.indisprimary ORDER BY key.ordinal`,['memory.'+table])).rows.map(r=>r.attname as string)
  if(!keyColumns.length)throw Error('retained_metadata_primary_key_required')
  const {from,owner:scope}=referenceChannelSql(table)
  const rowKey=`jsonb_build_object(${keyColumns.flatMap(key=>["'"+key+"'",'t.'+qi(key)+'::text']).join(',')})`
  const independent=table==='knowledge_evidence'?`t.evidence_kind='accepted_excerpt' AND EXISTS(SELECT 1 FROM memory.knowledge_evidence_capsules capsule WHERE capsule.installation_id=t.installation_id AND capsule.capsule_id=t.capsule_id AND capsule.version_id=t.version_id AND capsule.retention_basis='user_accepted')`:'false'
  let metadata='t.'+qi(column)
  if(table==='knowledge_evidence')metadata="jsonb_build_object('locator',t.locator,'typed',jsonb_strip_nulls(jsonb_build_object('source_event_id',t.source_event_id::text,'artifact_id',t.artifact_id::text,'episode_id',t.episode_id::text)))"
  if(table==='source_artifacts')metadata="jsonb_build_object('details',t.details,'typed',jsonb_strip_nulls(jsonb_build_object('source_event_id',t.source_event_id::text,'session_id',t.session_id)))"
  // Empty provenance carries no explicit retained references. Personal source
  // roots are enumerated independently above; do not enumerate every raw row
  // merely to discover that its provenance object is empty. Artifact typed
  // links may be omitted only when the FK target proves exact same ownership.
  const metadataFilter=table==='source_events'?` AND COALESCE(t.${qi(column)},'{}'::jsonb)<>'{}'::jsonb`:table==='source_artifacts'?` AND (COALESCE(t.details,'{}'::jsonb)<>'{}'::jsonb OR NOT EXISTS(SELECT 1 FROM memory.source_events exact WHERE exact.source_event_id=t.source_event_id AND exact.installation_id=t.installation_id AND exact.session_id=t.session_id))`:''
  const query=`WITH selected AS(SELECT ${scope}::text AS installation_id,${rowKey} AS row_key,${independent} AS independent,count(*) OVER() AS total_rows,${metadata} AS metadata FROM ${from} WHERE ${scope}=ANY($1::uuid[])${metadataFilter} LIMIT 4097),
   bounded AS(SELECT *,encode(sha256(convert_to(COALESCE(metadata::text,''),'UTF8')),'hex') AS metadata_hash,sum(octet_length(metadata::text)) OVER() AS total_bytes FROM selected),
   objects AS(SELECT installation_id,row_key,independent,metadata_hash,object FROM bounded CROSS JOIN LATERAL jsonb_path_query(CASE WHEN total_rows<=4096 AND COALESCE(total_bytes,0)<=8388608 THEN metadata ELSE '{"_maintenance_overflow":true}'::jsonb END,'strict $.** ? (@.type() == "object")') object),
   expanded AS(SELECT installation_id,row_key,independent,metadata_hash,value AS object FROM objects CROSS JOIN LATERAL jsonb_array_elements(${retainedArrayExpansionSql('object')}) value),
   extracted AS(SELECT installation_id,row_key,independent,metadata_hash,jsonb_strip_nulls(jsonb_build_object(
    ${retainedScalarReferenceSql('object')},
    'overflow',object->>'_maintenance_overflow',
    'provenance',CASE WHEN object->>'source_kind'='team_session' THEN jsonb_build_object('version',object->>'source_version','teamId',object->>'team_id','teamSessionId',object->>'team_session_id','callId',object->>'team_call_id',
      'submissionId',object#>>'{accepted_delivery,submission_id}','decisionId',object#>>'{accepted_delivery,decision_id}',
      'principal',object#>>'{read_scope,participant_user_id}','participantRevision',object#>>'{read_scope,participant_revision}',
      'bindingId',object#>>'{read_scope,team_memory_binding_id}','bindingRevision',object#>>'{read_scope,team_memory_binding_revision}',
      'targetInstallationId',object#>>'{read_scope,target_installation_id}','targetOwnerScopeKind',object#>>'{read_scope,target_owner_scope_kind}','targetOwnerScopeId',object#>>'{read_scope,target_owner_scope_id}') END)) AS refs FROM expanded)
   SELECT * FROM extracted WHERE refs<>'{}'::jsonb ORDER BY installation_id,row_key::text,refs::text LIMIT 4097`
  const rows=(await c.query(query,[ids])).rows
  if(rows.length>4096)throw Error('retained_closure_limit')
  for(const row of rows){
   if(row.refs.overflow)throw Error('retained_metadata_byte_limit')
   for(const key of ['sourceEventId','artifactId','episodeId'])if(row.refs[key]&&!uuid.test(row.refs[key]))row.refs[key]='invalid_uuid'
   const ref:RetainedReference={metadataFingerprint:row.metadata_hash,installationId:row.installation_id,table,column,rowKey:row.row_key,independent:row.independent,...row.refs}
   references.push(ref)
   if(references.length>4096)throw Error('retained_closure_limit')
   let unknown=false,globalUnknown=false
   for(const [key,relation,idColumn] of [['sourceEventId','source_events','source_event_id'],['artifactId','source_artifacts','artifact_id'],['episodeId','work_episodes','episode_id']] as const){
    const id=ref[key];if(!id)continue
    if(!uuid.test(id)){unknown=true;continue}
    const source=(await c.query(`SELECT session_id FROM memory.${qi(relation)} WHERE installation_id=$1::uuid AND ${qi(idColumn)}=$2::uuid`,[ref.installationId,id])).rows
    if(source.length!==1){unknown=true;continue}root(ref.installationId,source[0].session_id)
   }
   if(ref.sessionId)root(ref.installationId,ref.sessionId)
   if(ref.canonicalSessionId)root(ref.installationId,ref.canonicalSessionId)
   const p=ref.provenance
   if(p){
    for(const key of ['submissionId','decisionId','targetInstallationId','targetOwnerScopeId'])if(p[key]&&!globalUuid.test(p[key]!))p[key]='invalid_uuid'
    for(const key of ['principal','bindingRevision','participantRevision'])if(p[key]&&!/^[1-9][0-9]{0,18}$/.test(p[key]!))p[key]='invalid_decimal'
    for(const key of ['teamId','teamSessionId','callId','bindingId'])if(p[key]&&(!p[key]!.trim()||p[key]!.length>512))p[key]='invalid_identifier'
    if(p.version==='2'&&p.teamId&&p.teamId!=='invalid_identifier'&&p.teamSessionId&&p.teamSessionId!=='invalid_identifier'&&globalUuid.test(p.submissionId??'')&&globalUuid.test(p.decisionId??''))deliveries.push({installationId:ref.installationId,teamId:p.teamId,teamSessionId:p.teamSessionId,submissionId:p.submissionId!,decisionId:p.decisionId!,independent:ref.independent})
    else if(p.version!=='1')globalUnknown=true
   }
   // Independent personal acceptance severs ordinary Session ownership. It
   // never severs Team v2's global submission/decision withdrawal identity.
   if(globalUnknown||unknown&&!ref.independent)unresolved.push(ref)
  }
 }
 const capsules=(await c.query("SELECT installation_id::text,capsule_id::text,version_id::text,retention_basis,xmin::text AS row_version,encode(source_content_hash,'hex') AS source_content_hash FROM memory.knowledge_evidence_capsules WHERE installation_id=ANY($1::uuid[]) ORDER BY installation_id,capsule_id LIMIT 4097",[ids])).rows
 if(capsules.length>4096)throw Error('retained_closure_limit')
 const result={capsules,roots:[...roots.values()].sort((a,b)=>(a.installationId+':'+a.sessionId).localeCompare(b.installationId+':'+b.sessionId)),deliveries:[...new Map(deliveries.map(d=>[JSON.stringify(d),d])).values()],references,unresolved}
 return {...result,fingerprint:hash(result)}
}
