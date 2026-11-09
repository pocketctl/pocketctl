import type pg from 'pg'
import {hash} from './source-maintenance-common.js'
import type {RetainedReference} from './source-maintenance-retained.js'
export interface TeamAuthorityFact {installationId:string;rowKey:unknown;root:string|null;state:'current'|'revoked'|'unproven';factHash:string}
/** Current metadata-only counterpart of the existing Team reader policy.
 * Principal/binding/participant revisions come only from persisted allowlisted
 * provenance. No arbitrary principal, body fetch or open mode is synthesized. */
export async function inspectTeamAuthority(c:pg.Client,reference:RetainedReference):Promise<TeamAuthorityFact>{
 const p=reference.provenance!,base={installationId:reference.installationId,rowKey:reference.rowKey,root:reference.canonicalSessionId??reference.sessionId??null}
 if(reference.table==='source_events'&&reference.rowKey&&typeof reference.rowKey==='object'){
  const id=(reference.rowKey as Record<string,unknown>).source_event_id
  if(typeof id==='string')base.root=(await c.query('SELECT COALESCE(canonical_session_key,session_id) AS root FROM memory.source_events WHERE installation_id=$1::uuid AND source_event_id=$2::uuid',[reference.installationId,id])).rows[0]?.root??null
 }
 const required=['team_memory_bindings','collaboration_sessions','collaboration_teams','collaboration_calls','collaboration_session_participants','collaboration_team_memberships','team_agent_offers']
 if(p?.version==='2')required.push('team_acceptance_decisions','team_task_submissions','team_task_specs','team_delivery_memory_sources','team_artifact_revocations','team_delivery_memory_withdrawals')
 const present=(await c.query('SELECT count(*)::text AS n FROM unnest($1::text[]) t WHERE to_regclass(\'public.\'||t) IS NOT NULL',[required])).rows[0].n
 const valid=p&&['1','2'].includes(p.version??'')&&['teamId','teamSessionId','callId','principal','bindingId','bindingRevision','participantRevision','targetInstallationId','targetOwnerScopeKind','targetOwnerScopeId'].every(k=>typeof p[k]==='string'&&p[k]!.length>0)
  &&['principal','bindingRevision','participantRevision'].every(k=>/^[1-9][0-9]{0,18}$/.test(p[k]!))
 if(!valid||present!==String(required.length))return {...base,state:'unproven',factHash:hash({present,provenance:p})}
 const row=(await c.query(`SELECT b.binding_id,b.revision::text AS binding_revision,b.installation_id::text AS target_installation,b.owner_scope_kind,b.owner_scope_id::text,b.state AS binding_state,
   s.state AS session_state,t.state AS team_state,c.state AS call_state,c.offer_id,c.task_id,c.context_version::text,
   participant.revision::text AS participant_revision,participant.state AS participant_state,member.state AS member_state,u.team_enabled,
   target.status AS target_status,target.owner_scope_kind AS current_target_kind,target.owner_scope_id::text AS current_target_scope,
   offer.daemon_id,local.owner_scope_kind AS local_kind,local.owner_scope_id::text AS local_scope,local.owner_user_id::text AS local_owner,
   local.event_filter,local.granted_scopes,local.enabled_services,local.status AS local_status,
   (local.owner_scope_kind='personal' OR EXISTS(SELECT 1 FROM public.extension_scope_memberships sm WHERE sm.scope_kind=local.owner_scope_kind AND sm.scope_id=local.owner_scope_id AND sm.user_id=$4::int AND sm.state='active' AND sm.roles && ARRAY['reader','contributor','reviewer','publisher','scope_administrator']::text[])) AS local_member_active,
   CASE b.owner_scope_kind WHEN 'team' THEN EXISTS(SELECT 1 FROM public.extension_teams et JOIN public.extension_organizations org USING(organization_id) WHERE et.team_id=b.owner_scope_id AND et.state='active' AND org.state='active')
     WHEN 'organization' THEN EXISTS(SELECT 1 FROM public.extension_organizations org WHERE org.organization_id=b.owner_scope_id AND org.state='active') ELSE true END AS target_scope_active
   FROM public.team_memory_bindings b JOIN public.collaboration_sessions s ON s.team_id=b.team_id AND s.team_session_id=$2
   JOIN public.collaboration_teams t ON t.team_id=s.team_id JOIN public.collaboration_calls c ON c.team_session_id=s.team_session_id AND c.call_id=$3
   LEFT JOIN public.collaboration_session_participants participant ON participant.team_session_id=s.team_session_id AND participant.user_id=$4::int
   LEFT JOIN public.collaboration_team_memberships member ON member.team_id=s.team_id AND member.user_id=$4::int
   LEFT JOIN public.users u ON u.id=$4::int LEFT JOIN public.team_agent_offers offer ON offer.offer_id=c.offer_id
   JOIN public.extension_installations target ON target.installation_id=b.installation_id AND target.provider_id='pocketctl-memory'
   JOIN public.extension_installations local ON local.installation_id=$6::uuid AND local.provider_id='pocketctl-memory'
   WHERE b.binding_id=$1 AND b.team_id=$5`,[p.bindingId,p.teamSessionId,p.callId,p.principal,p.teamId,reference.installationId])).rows
 if(row.length!==1)return {...base,state:'revoked',factHash:hash(row)}
 const a=row[0],filter=a.event_filter
 const filterValid=filter&&typeof filter==='object'&&!Array.isArray(filter)&&Object.keys(filter).every(k=>['daemon_ids','agent_types'].includes(k))&&['daemon_ids','agent_types'].every(k=>filter[k]===undefined||Array.isArray(filter[k])&&filter[k].every((v:unknown)=>typeof v==='string'))
 const scopeValid=a.local_kind==='personal'?a.local_owner===p.principal:a.target_installation===reference.installationId&&a.local_kind===a.owner_scope_kind&&a.local_scope===a.owner_scope_id
 let current=a.binding_revision===p.bindingRevision&&a.participant_revision===p.participantRevision&&a.target_installation===p.targetInstallationId&&a.owner_scope_kind===p.targetOwnerScopeKind&&a.owner_scope_id===p.targetOwnerScopeId
  &&a.current_target_kind===a.owner_scope_kind&&a.current_target_scope===a.owner_scope_id&&a.binding_state==='active'&&a.participant_state==='active'&&a.member_state==='active'&&a.team_state==='active'&&['active','paused'].includes(a.session_state)&&a.team_enabled===true&&a.target_status==='active'&&a.target_scope_active===true&&scopeValid&&a.local_status==='active'&&a.local_member_active===true
  &&a.granted_scopes?.includes('session:events:read')&&a.enabled_services?.includes('memory.manage')&&filterValid&&(!filter.daemon_ids?.length||filter.daemon_ids.includes(a.daemon_id))&&(!filter.agent_types?.length||filter.agent_types.includes('team_collaboration'))
 if(p.version==='1'&&!['completed','failed','cancelled','blocked'].includes(a.call_state))current=false
 let deliveryFacts:unknown=null
 if(p.version==='2'){
  if(!base.root||!p.submissionId||!p.decisionId)return {...base,state:'unproven',factHash:hash(a)}
  const delivery=(await c.query(`SELECT receipt.binding_id,receipt.binding_revision::text,receipt.participant_revision::text,receipt.team_id,receipt.team_session_id,
    receipt.revoked_at IS NOT NULL AS access_revoked,receipt.withdrawn_at IS NOT NULL OR EXISTS(SELECT 1 FROM public.team_artifact_revocations ar WHERE ar.submission_id=receipt.submission_id)
     OR EXISTS(SELECT 1 FROM public.team_delivery_memory_withdrawals w WHERE(w.team_id,w.team_session_id,w.submission_id,w.decision_id)=(receipt.team_id,receipt.team_session_id,receipt.submission_id,receipt.decision_id))
     OR EXISTS(SELECT 1 FROM memory.memory_team_delivery_withdrawals w WHERE(w.team_id,w.team_session_id,w.submission_id,w.decision_id)=(receipt.team_id,receipt.team_session_id,receipt.submission_id,receipt.decision_id)) AS withdrawn,
    decision.decision,decision.task_id,decision.spec_revision::text,decision.reviewer_user_id::text,submission.state AS submission_state,submission.source_call_id,submission.source_offer_id,submission.context_version::text,
    submission.task_id AS submission_task_id,submission.spec_revision::text AS submission_spec_revision,spec.reviewer_user_id::text AS spec_reviewer
    FROM public.team_delivery_memory_sources receipt JOIN public.team_task_submissions submission USING(submission_id)
    JOIN public.team_acceptance_decisions decision ON decision.decision_id=receipt.decision_id AND decision.submission_id=receipt.submission_id
    JOIN public.team_task_specs spec ON spec.task_id=submission.task_id AND spec.revision=submission.spec_revision
    WHERE receipt.source_session_id=$1 AND receipt.submission_id=$2::uuid AND receipt.decision_id=$3::uuid AND receipt.reader_user_id=$4::int`,[base.root,p.submissionId,p.decisionId,p.principal])).rows
  deliveryFacts=delivery
  const d=delivery[0]
  current=Boolean(current&&delivery.length===1&&!d.access_revoked&&!d.withdrawn&&d.binding_id===p.bindingId&&d.binding_revision===p.bindingRevision&&d.participant_revision===p.participantRevision
    &&d.team_id===p.teamId&&d.team_session_id===p.teamSessionId&&d.decision==='accepted'&&d.submission_state==='published'&&d.source_call_id===p.callId&&d.source_offer_id===a.offer_id&&d.context_version===a.context_version
    &&d.task_id===d.submission_task_id&&d.submission_task_id===a.task_id&&d.spec_revision===d.submission_spec_revision&&d.reviewer_user_id===d.spec_reviewer)
 }
 return {...base,state:current?'current':'revoked',factHash:hash({authority:a,delivery:deliveryFacts})}
}
