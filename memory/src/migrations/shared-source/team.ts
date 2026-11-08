import {createHash} from 'node:crypto'
import { canonicalJsonString, canonicalPayloadHash } from '../../inbox/canonical-json.js'
import { adaptTeamSource } from '../../episodes/team-source-adapter.js'
import type { Snapshot } from './database.js'
import type { Candidate, Link } from './mapping.js'
import { relayPureModule } from './archive.js'
const hash=(value:unknown)=>canonicalPayloadHash(value).toString('hex')
const object=(v:unknown):Record<string,any>|undefined=>v && typeof v==='object' && !Array.isArray(v)?v as Record<string,any>:undefined
const integer=(v:unknown)=>Number.isSafeInteger(Number(v)) && Number(v)>0
export async function resolveTeamSource(snapshot:Snapshot,row:Record<string,any>,ownerKey:string):Promise<{
  links:Link[];candidates:Candidate[];provenance:'known'|'unknown';reason?:string;revoked?:boolean
}> {
  const empty=(reason:string)=>({links:[],candidates:[],provenance:'unknown' as const,reason})
  const p=object(row.source_provenance),scope=object(p?.read_scope)
  if(!p || !scope || ![1,2].includes(p.source_version) || !integer(scope.participant_user_id)
    || !integer(scope.participant_revision) || !integer(scope.team_memory_binding_revision)
    || canonicalJsonString(row.payload?.team_source)!==canonicalJsonString(p))return empty('team_provenance_unknown')
  const required=['team_memory_bindings','collaboration_session_participants','collaboration_team_memberships','collaboration_sessions','collaboration_teams','collaboration_calls','users']
  if(p.source_version===2)required.push('team_delivery_memory_sources','team_acceptance_decisions','team_task_submissions','team_task_specs','team_artifact_revocations')
  else required.push('collaboration_events')
  for(const table of required)if(!(await snapshot.client.query('SELECT to_regclass($1) IS NOT NULL AS present',['public.'+table])).rows[0].present)return empty('team_authority_table_missing')
  const authority=(await snapshot.client.query(`SELECT b.binding_id,b.revision::text,b.installation_id::text,b.owner_scope_kind,b.owner_scope_id::text,
      b.state AS binding_state,p.revision::text AS participant_revision,p.state AS participant_state,
      m.state AS membership_state,s.state AS session_state,t.state AS team_state,c.context_version::text,
      c.event_id AS goal_event_id,c.state AS call_state,to_jsonb(c)->>'task_id' AS call_task_id,to_jsonb(c)->>'offer_id' AS call_offer_id,i.status AS target_status,u.team_enabled
    FROM public.team_memory_bindings b
    JOIN public.collaboration_sessions s ON s.team_id=b.team_id AND s.team_session_id=$2
    JOIN public.collaboration_teams t ON t.team_id=s.team_id
    JOIN public.collaboration_calls c ON c.team_session_id=s.team_session_id AND c.call_id=$3
    JOIN public.collaboration_session_participants p ON p.team_session_id=s.team_session_id AND p.user_id=$4
    JOIN public.collaboration_team_memberships m ON m.team_id=s.team_id AND m.user_id=p.user_id
    JOIN public.users u ON u.id=p.user_id
    JOIN public.extension_installations i ON i.installation_id=b.installation_id
      AND i.owner_scope_kind=b.owner_scope_kind AND i.owner_scope_id=b.owner_scope_id AND i.provider_id='pocketctl-memory'
    JOIN public.extension_providers provider ON provider.provider_id=i.provider_id AND provider.status='enabled'
    WHERE b.binding_id=$1 AND b.team_id=$5`,[scope.team_memory_binding_id,p.team_session_id,p.team_call_id,scope.participant_user_id,p.team_id])).rows
  if(authority.length!==1)return empty('team_authority_unproven')
  const a=authority[0]
  const personal=ownerKey==='personal-user:'+scope.participant_user_id
  const shared=['team','organization'].includes(a.owner_scope_kind)&&ownerKey===a.owner_scope_kind+':'+a.owner_scope_id&&a.installation_id===row.installation_id
  if(a.revision!==String(scope.team_memory_binding_revision) || a.participant_revision!==String(scope.participant_revision)
    || a.installation_id!==scope.target_installation_id || a.owner_scope_kind!==scope.target_owner_scope_kind || a.owner_scope_id!==scope.target_owner_scope_id
    || a.context_version!==String(p.context_version) || !personal&&!shared)return empty('team_scope_or_version_mismatch')
  if(a.binding_state!=='active' || a.participant_state!=='active' || a.membership_state!=='active' || a.team_state!=='active'
    || !['active','paused'].includes(a.session_state) || a.target_status!=='active' || a.team_enabled!==true)return empty('team_current_authority_unavailable')
  if(['team','organization'].includes(a.owner_scope_kind)){
    const tables=['extension_organizations',...(a.owner_scope_kind==='team'?['extension_teams']:[]),...(shared?['extension_scope_memberships']:[])]
    for(const table of tables)if(!(await snapshot.client.query('SELECT to_regclass($1) IS NOT NULL AS present',['public.'+table])).rows[0].present)return empty('team_scope_authority_unavailable')
    const active=(await snapshot.client.query(a.owner_scope_kind==='team'
      ?`SELECT 1 FROM public.extension_teams t JOIN public.extension_organizations o USING(organization_id) WHERE t.team_id=$1 AND t.state='active' AND o.state='active'`
      :`SELECT 1 FROM public.extension_organizations WHERE organization_id=$1 AND state='active'`,[a.owner_scope_id])).rowCount
    if(!active)return empty('team_scope_authority_unavailable')
    if(shared&&!(await snapshot.client.query(`SELECT 1 FROM public.extension_scope_memberships WHERE scope_kind=$1 AND scope_id=$2 AND user_id=$3 AND state='active'
      AND roles && ARRAY['reader','contributor','reviewer','publisher','scope_administrator']::text[]`,[a.owner_scope_kind,a.owner_scope_id,scope.participant_user_id])).rowCount)return empty('team_scope_authority_unavailable')
  }
  let raw:Record<string,any>|undefined
  const role=row.event_type==='user_goal'?'goal':row.event_type==='agent_text'?'reply':row.event_type==='turn_status'?'outcome':undefined
  if(!role)return empty('team_event_type_unknown')
  if(p.source_version===2){
    if(p.team_event_ids!==undefined || p.team_event_seqs!==undefined)return empty('delivery_fabricated_event_lineage')
    const d=object(p.accepted_delivery)
    if(!d)return empty('delivery_identity_unproven')
    const accepted=(await snapshot.client.query(`SELECT r.source_session_id,r.revoked_at,r.withdrawn_at,r.binding_revision::text,r.participant_revision::text,
        d.decision_id::text,d.decision,d.created_at AS accepted_at,d.reviewer_user_id,
        s.submission_id::text,s.task_id,s.spec_revision::text,s.version::text,s.summary,s.manifest_sha256,
        s.source_call_id,s.source_offer_id,s.context_version,s.published_at,s.state,
        spec.goal,spec.acceptance,spec.created_by_user_id,spec.created_at AS spec_created_at,
        EXISTS(SELECT 1 FROM public.team_artifact_revocations x WHERE x.submission_id=s.submission_id) AS artifact_revoked
      FROM public.team_delivery_memory_sources r JOIN public.team_acceptance_decisions d ON d.decision_id=r.decision_id
      JOIN public.team_task_submissions s ON s.submission_id=r.submission_id AND d.submission_id=s.submission_id AND d.task_id=s.task_id AND d.spec_revision=s.spec_revision
      JOIN public.team_task_specs spec ON spec.task_id=s.task_id AND spec.revision=s.spec_revision AND spec.reviewer_user_id=d.reviewer_user_id
      WHERE r.source_session_id=$1 AND r.binding_id=$2 AND r.reader_user_id=$3 AND r.team_session_id=$4 AND r.team_id=$5`,
      [row.session_id,scope.team_memory_binding_id,scope.participant_user_id,p.team_session_id,p.team_id])).rows
    if(accepted.length!==1)return empty('delivery_authority_unproven')
    const x=accepted[0]
    if(x.decision_id!==d.decision_id || x.submission_id!==d.submission_id || x.binding_revision!==String(scope.team_memory_binding_revision)
      || x.participant_revision!==String(scope.participant_revision) || x.source_call_id!==p.team_call_id
      || x.task_id!==a.call_task_id || x.source_offer_id!==a.call_offer_id)return empty('delivery_identity_mismatch')
    if(x.revoked_at || x.withdrawn_at || x.artifact_revoked)return {links:[],candidates:[],provenance:'known',revoked:true}
    if(x.decision!=='accepted' || x.state!=='published')return empty('delivery_not_accepted')
    for(const key of ['spec_revision','version','context_version'])if(!Number.isSafeInteger(Number(x[key])))return empty('team_version_out_of_range')
    const {buildAcceptedDeliveryMemorySourceRecords}=await relayPureModule('delivery')
    const records=buildAcceptedDeliveryMemorySourceRecords({teamId:p.team_id,teamSessionId:p.team_session_id,callId:x.source_call_id,taskId:x.task_id,contextVersion:Number(x.context_version),
      binding:{id:a.binding_id,revision:Number(a.revision),installationId:a.installation_id,ownerScopeKind:a.owner_scope_kind,ownerScopeId:a.owner_scope_id},
      readers:[{userId:Number(scope.participant_user_id),participantRevision:Number(a.participant_revision)}],
      spec:{revision:Number(x.spec_revision),goal:x.goal,acceptance:x.acceptance,authorUserId:x.created_by_user_id,createdAt:x.spec_created_at},
      submission:{id:x.submission_id,version:Number(x.version),summary:x.summary,manifestSha256:x.manifest_sha256,authorOfferId:x.source_offer_id,publishedAt:x.published_at},
      decision:{id:x.decision_id,decision:'accepted',reviewerUserId:x.reviewer_user_id,createdAt:x.accepted_at}})
    raw=records.find((r:any)=>r.sourceId===row.origin_position)
  }else{
    if(!Array.isArray(p.team_event_ids) || !Array.isArray(p.team_event_seqs) || p.team_event_ids.length<1 || p.team_event_ids.length>512
      || p.team_event_ids.length!==p.team_event_seqs.length || new Set(p.team_event_ids).size!==p.team_event_ids.length)return empty('team_lineage_unproven')
    const events=(await snapshot.client.query(`SELECT event_id,event_seq::text,kind,author_user_id,author_offer_id,call_id,content,created_at
      FROM public.collaboration_events WHERE team_session_id=$1 AND event_id=ANY($2::text[]) ORDER BY event_seq`,[p.team_session_id,p.team_event_ids])).rows
    if(events.length!==p.team_event_ids.length || events.some((e,i)=>e.event_id!==p.team_event_ids[i] || e.event_seq!==String(p.team_event_seqs[i])))return empty('team_lineage_mismatch')
    if(events.some(e=>e.kind!==(role==='goal'?'member_message':role==='reply'?'agent_message':'status'))
      || (role==='goal' && (events.length!==1 || events[0].event_id!==a.goal_event_id))
      || (role!=='goal' && events.some(e=>e.call_id!==p.team_call_id))
      || (role==='reply' && events.some(e=>e.author_offer_id!==a.call_offer_id)))return empty('team_event_relation_mismatch')
    const canonicalSession='team_'+createHash('sha256').update(JSON.stringify(['team-source-binding-v1',p.team_session_id,a.binding_id,Number(a.revision),Number(a.participant_revision)])).digest('hex').slice(0,32)
    if(row.session_id!==canonicalSession)return empty('team_session_identity_mismatch')
    const last=events.at(-1)!,expectedId=`team:${p.team_call_id}:${role}:u${scope.participant_user_id}:b${a.revision}:v1`
    if(row.origin_position!==expectedId)return empty('team_source_id_mismatch')
    const payload={original_source_id:p.original_source_id,reader_projection_id:p.reader_projection_id,team_source_version:1,
      team_id:p.team_id,team_session_id:p.team_session_id,team_call_id:p.team_call_id,context_version:p.context_version,read_scope:scope,
      source_role:role,turn_id:'team-call:'+p.team_call_id,occurred_at:last.created_at.toISOString(),team_event_ids:p.team_event_ids,team_event_seqs:p.team_event_seqs,
      ...(role==='goal'?{text:last.content,author_user_id:last.author_user_id}:role==='reply'?{text:events.map(e=>e.content).join(''),final:true,author_offer_id:last.author_offer_id}:{status:last.content})}
    raw={sourceId:expectedId,sessionId:canonicalSession,eventType:'team_source',occurredAt:last.created_at,payload}
  }
  if(!raw)return empty('team_canonical_record_unavailable')
  let adapted
  try{adapted=adaptTeamSource({source_kind:'team_collaboration_event',source_id:raw.sourceId,session_id:raw.sessionId,turn_id:raw.payload.turn_id,
    event_type:raw.eventType,recorded_at:raw.occurredAt,classification:{},data:raw.payload})}catch{return empty('team_adapter_rejected')}
  if(!adapted || canonicalJsonString(adapted.provenance)!==canonicalJsonString(p))return empty('team_provenance_mismatch')
  const kind=p.source_version===2?'team_delivery':'team_collaboration',version=String(p.source_version)
  return {provenance:'known',links:[{kind,id:raw.sourceId,via:'producer',version}],candidates:[{kind,id:raw.sourceId,installationId:row.installation_id,ownerKey,
    sessionId:adapted.sessionId,turnId:adapted.turnId,eventType:adapted.eventType,classificationHash:hash(adapted.classification),hash:hash(adapted.payload),version,storage:'hot',authorityVerified:true,provenance:'known',teamVerified:true}]}
}
