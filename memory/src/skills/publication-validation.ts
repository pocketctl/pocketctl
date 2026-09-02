import type pg from 'pg'
import { createScopeAuthorization, type V2GrantFacts } from '../governance/authorization.js'
import { createTransactionBoundPool } from '../api/transaction-bound-pool.js'
import { currentReviewDecisions,evaluateQuorum } from '../governance/authority.js'
import { canonicalJsonString } from '../inbox/canonical-json.js'
import { EPISODE_COMPILER_VERSION } from '../episodes/compiler.js'
import { EPISODE_PACKET_COMPILER_VERSION } from '../episodes/packet.js'
import { resolveSkillSource,SkillWorkError,type SkillSourceContext } from './source-resolver.js'
import { archiveSourceRequest,findSkillArchive,type SkillVersionRow } from './version-repository.js'
import { loadSkillReviewPolicySnapshot } from './review-policy-binding.js'
import { loadSkillPublicationPolicy } from './policy-service.js'
import { assessSkillRisk } from './risk-policy.js'
import { skillDocumentHash } from './types.js'
import type { SkillAuditInput } from './audit-repository.js'
import type { SkillReplayCaseRegistry } from './replay-service.js'
import { ReplayCaseSchema,replayCaseHash,replayTextHash,SKILL_REPLAY_RUNNER_VERSION } from './replay-runner.js'

export type SkillPublicationIdentity={installationId:string;grant:V2GrantFacts}
export type SkillPublicationErrorCode=Exclude<SkillAuditInput['code'],'ok'>
export class SkillPublicationError extends Error {
  readonly statusCode:number
  constructor(readonly code:SkillPublicationErrorCode){super(code);this.name='SkillPublicationError';this.statusCode=code==='invalid_request'?400:code==='not_found'?404:['forbidden','self_publish_denied'].includes(code)?403:code==='feature_disabled'?503:409}
}
export function publicationFailure(code:SkillPublicationErrorCode):never{throw new SkillPublicationError(code)}
export function publicationDomainError(error:unknown):SkillPublicationError {
  return error instanceof SkillPublicationError?error:error instanceof SkillWorkError
    ?new SkillPublicationError(error.code==='skill_forbidden'?'forbidden':error.code==='skill_disabled'?'feature_disabled':'source_invalid')
    :new SkillPublicationError('publication_failed')
}
export interface SkillPublicationValidationDeps {context:SkillSourceContext;cases:SkillReplayCaseRegistry}
export interface SkillPublicationTarget {
  skillId:string;versionId:string;expectedRevision:number;mode:'manual'|'auto'|'execution'
  allowHistoricalVersion?:boolean;additionalSessionIds?:readonly string[]
}
type ReplayRow={run_id:string;head_revision:string;document_hash:string;source_digest:string;policy_hash:string;input_hash:string;runner_version:string;state:string}
type CaseRow={case_id:string;kind:'historical_session'|'golden_task';provenance:string;reference_id:string;input_hash:string;state:string}

/** Caller owns BEGIN/COMMIT. Acquire session/scope/source locks before task/head, then publication/rollout locks. */
export async function validateSkillPublicationTarget(client:pg.PoolClient,identity:SkillPublicationIdentity,request:SkillPublicationTarget,deps:SkillPublicationValidationDeps){
  const permission=request.mode==='execution'?'read':'publish'
  const auth=createScopeAuthorization(createTransactionBoundPool(client)),early=await auth.validateV2Grant(identity.grant)
  if(!early||!auth.hasPermission(early,identity.installationId,permission))publicationFailure('forbidden')
  const observed=(await client.query<SkillVersionRow>(`SELECT v.*,h.revision::text,h.state FROM memory_skill_versions v
    JOIN memory_skill_heads h USING(installation_id,skill_id) WHERE v.installation_id=$1 AND v.skill_id=$2 AND v.version_id=$3`,[identity.installationId,request.skillId,request.versionId])).rows[0]
  if(!observed)publicationFailure('not_found')
  const archive=await findSkillArchive(client,identity.installationId,observed.candidate_id)
  if(!archive)publicationFailure('source_invalid')
  const observedRun=(await client.query<ReplayRow>(`SELECT * FROM memory_skill_replay_runs WHERE installation_id=$1 AND version_id=$2 ORDER BY sequence DESC LIMIT 1`,[identity.installationId,request.versionId])).rows[0]
  const caseRows=observedRun?(await client.query<CaseRow>(`SELECT * FROM memory_skill_replay_cases WHERE installation_id=$1 AND run_id=$2 ORDER BY case_id`,[identity.installationId,observedRun.run_id])).rows:[]
  const history=caseRows.filter(c=>c.kind==='historical_session').map(c=>c.reference_id)
  const source=await resolveSkillSource(client,{...identity,source:archiveSourceRequest(archive),requiredPermission:permission,
    additionalSessionIds:[...history,...(request.additionalSessionIds??[])]},deps.context)
  if(source.sourceDigest!==archive.source_digest||source.inputDigest!==archive.input_digest)publicationFailure('source_invalid')
  const grant=await auth.validateV2Grant(identity.grant),binding=grant?.scopeBindings.find(b=>b.installation_id===identity.installationId)
  if(!binding||!binding.permissions.includes(permission))publicationFailure('forbidden')
  const actor=binding.owner_scope_kind==='personal'?{actorKind:'personal' as const,actorId:binding.owner_scope_id}:{actorKind:'membership' as const,actorId:binding.membership_id!}
  const policy=await loadSkillReviewPolicySnapshot(client,identity.installationId,binding,{ensure:false})
  const publicationPolicy=await loadSkillPublicationPolicy(client,identity.installationId)
  // Lock reviewer facts before task/head, matching the authorization order of source resolution.
  const decisions=(await client.query<{decision_id:string;actor_kind:string;actor_id:string;membership_revision:string;decision:'approve'|'reject'|'request_changes'}>(`
    SELECT decision_id,actor_kind,actor_id,membership_revision::text,decision FROM memory_skill_review_decisions
    WHERE installation_id=$1 AND version_id=$2 AND authorization_epoch=$3 AND policy_hash=$4 AND document_hash=$5 AND source_digest=$6`,
  [identity.installationId,request.versionId,binding.authorization_epoch,policy.hash,observed.document_hash,source.sourceDigest])).rows
  let publisher=actor
  let publisherRevision:string|null=null
  if(request.mode==='execution'){
    const event=(await client.query<{actor_kind:'personal'|'membership';actor_id:string;membership_revision:string|null;authorization_epoch:string}>(`SELECT e.actor_kind,e.actor_id,e.membership_revision::text,e.authorization_epoch::text FROM memory_skill_publication_heads h
      JOIN memory_skill_publication_events e ON e.installation_id=h.installation_id AND e.event_id=h.publication_event_id
      WHERE h.installation_id=$1 AND h.skill_id=$2 AND h.current_version_id=$3 AND h.state='active'`,[identity.installationId,request.skillId,request.versionId])).rows[0]
    if(!event)publicationFailure('state_conflict')
    if(event.authorization_epoch!==binding.authorization_epoch)publicationFailure('forbidden')
    publisher={actorKind:event.actor_kind,actorId:event.actor_id}
    publisherRevision=event.membership_revision
  }
  const members=(await client.query<{membership_id:string;membership_revision:string;state:string;roles:string[]}>(`
    SELECT membership_id,membership_revision::text,state,roles FROM memory_scope_memberships
    WHERE installation_id=$1 AND membership_id=ANY($2::uuid[]) ORDER BY membership_id FOR SHARE`,
  [identity.installationId,[...decisions.filter(d=>d.actor_kind==='membership').map(d=>d.actor_id),...(publisher.actorKind==='membership'?[publisher.actorId]:[])]] )).rows
  if(publisher.actorKind==='membership'&&!members.some(m=>m.membership_id===publisher.actorId&&m.state==='active'&&(!publisherRevision||m.membership_revision===publisherRevision)&&m.roles.some(r=>r==='publisher'||r==='scope_administrator')))publicationFailure('forbidden')
  const task=(await client.query<{current_generation:string;state:string}>(`SELECT current_generation::text,state FROM memory_skill_tasks WHERE installation_id=$1 AND task_id=$2 FOR UPDATE`,[identity.installationId,archive.task_id])).rows[0]
  const head=(await client.query<{current_version_id:string;revision:string;state:string}>(`SELECT current_version_id,revision::text,state FROM memory_skill_heads WHERE installation_id=$1 AND skill_id=$2 FOR UPDATE`,[identity.installationId,request.skillId])).rows[0]
  if(!head||Number(head.revision)!==request.expectedRevision)publicationFailure('revision_conflict')
  if(head.state==='revoked'||(await client.query(`SELECT 1 FROM memory_skill_version_revocations WHERE installation_id=$1 AND version_id=$2`,[identity.installationId,request.versionId])).rowCount)publicationFailure('target_revoked')
  if(!request.allowHistoricalVersion&&(head.current_version_id!==request.versionId||head.state!=='reviewed'))publicationFailure('review_required')
  if(!task||['cancelled','dead'].includes(task.state)||(!request.allowHistoricalVersion&&task.current_generation!==archive.generation))publicationFailure('generation_invalid')
  const generation=(await client.query<{budget_reservation_id:string|null}>(`SELECT r.budget_reservation_id FROM memory_skill_task_runs r
    JOIN memory_skill_candidates c USING(installation_id,task_id,generation)
    JOIN memory_generation_runs g ON g.installation_id=r.installation_id AND g.run_id=r.generation_run_id
    WHERE r.installation_id=$1 AND r.task_id=$2 AND r.generation=$3 AND r.state='candidate'
      AND c.candidate_id=$4 AND c.state<>'revoked' AND g.state='succeeded' AND g.output_id=c.candidate_id
      AND r.source_digest=$5 AND r.authorization_epoch=$6 FOR SHARE OF r,c,g`,[identity.installationId,archive.task_id,archive.generation,observed.candidate_id,source.sourceDigest,binding.authorization_epoch])).rows[0]
  if(!generation)publicationFailure('generation_invalid')
  if(deps.context.config.providerBudget){
    const budget=deps.context.config.providerBudget
    const reservation=await client.query(`SELECT 1 FROM memory_provider_budget_reservations WHERE reservation_id=$1 AND budget_key=$2
      AND provider_kind='text' AND state='settled' AND actual_input_tokens<=reserved_input_tokens AND actual_output_tokens<=reserved_output_tokens FOR SHARE`,[generation.budget_reservation_id,budget.key])
    if(!reservation.rowCount)publicationFailure('budget_invalid')
  }
  if(policy.hash!==observed.policy_hash)publicationFailure('policy_changed')
  if(skillDocumentHash(observed.document)!==observed.document_hash)publicationFailure('version_conflict')
  const risk=assessSkillRisk(observed.document)
  if(risk.secretDetected)publicationFailure('secret_detected')
  if(!observed.document.rollback.some(s=>s.trim().length>0))publicationFailure('source_invalid')
  if(request.mode==='auto'&&risk.risk!=='low')publicationFailure('risk_denied')
  // An author never publishes their own high/unknown-risk version; independent reviewer and publisher are distinct.
  if(risk.risk!=='low'&&publisher.actorKind===observed.author_kind&&publisher.actorId===observed.author_id)publicationFailure('self_publish_denied')
  const counted=binding.owner_scope_kind==='personal'?decisions.filter(d=>d.actor_kind==='personal'&&d.actor_id===binding.owner_scope_id).map(d=>({membershipId:d.actor_id,decision:d.decision}))
    :currentReviewDecisions(decisions.filter(d=>d.actor_kind==='membership').map(d=>({decisionId:d.decision_id,membershipId:d.actor_id,membershipRevision:d.membership_revision,decision:d.decision})),
      members.filter(m=>(policy.snapshot.policy.publisher_may_count_as_reviewer||!m.roles.includes('publisher'))&&(risk.risk==='low'||m.membership_id!==publisher.actorId))
        .map(m=>({membershipId:m.membership_id,membershipRevision:m.membership_revision,state:m.state,roles:m.roles})))
  if(!evaluateQuorum({decisions:counted,policy:policy.snapshot.policy,proposerMembershipId:observed.author_id,publisherMembershipId:publisher.actorId}).ok)publicationFailure('review_required')
  const latest=(await client.query<ReplayRow>(`SELECT * FROM memory_skill_replay_runs WHERE installation_id=$1 AND version_id=$2 ORDER BY sequence DESC LIMIT 1 FOR SHARE`,[identity.installationId,request.versionId])).rows[0]
  if(!latest||latest.run_id!==observedRun?.run_id||latest.state!=='passed'||latest.document_hash!==observed.document_hash||latest.source_digest!==source.sourceDigest||latest.policy_hash!==policy.hash||latest.runner_version!==SKILL_REPLAY_RUNNER_VERSION)publicationFailure('replay_failed')
  if(!request.allowHistoricalVersion&&Number(latest.head_revision)!==request.expectedRevision)publicationFailure('replay_failed')
  if(!['historical_session','golden_task'].every(k=>caseRows.some(c=>c.kind===k))||caseRows.some(c=>c.state!=='passed'))publicationFailure('replay_failed')
  for(const sessionId of history){
    const valid=await client.query(`SELECT 1 FROM source_sessions s JOIN work_episodes e USING(installation_id,session_id)
      WHERE s.installation_id=$1 AND s.session_id=$2 AND s.deleted_at IS NULL AND e.repository_id=$3 AND e.repo_snapshot_id=$4 AND e.state='ready' AND e.outcome='completed'
      AND NOT EXISTS(SELECT 1 FROM memory_session_tombstones t WHERE t.installation_id=s.installation_id AND t.session_id=s.session_id) FOR SHARE OF s,e`,[identity.installationId,sessionId,archive.repository_id,archive.repo_snapshot_id])
    if(!valid.rowCount)publicationFailure('source_invalid')
  }
  const raw=await deps.cases.loadCases({installationId:identity.installationId,repositoryId:archive.repository_id,repoSnapshotId:archive.repo_snapshot_id,versionId:request.versionId,documentHash:observed.document_hash,policyHash:policy.hash,caseIds:caseRows.map(c=>c.case_id)})
  const parsed=ReplayCaseSchema.array().max(32).safeParse(raw)
  if(!parsed.success||parsed.data.length!==caseRows.length||new Set(parsed.data.map(c=>c.case_id)).size!==caseRows.length)publicationFailure('case_invalid')
  const cases=parsed.data.sort((a,b)=>a.case_id.localeCompare(b.case_id))
  if(cases.some(c=>c.installation_id!==identity.installationId||c.repository_id!==archive.repository_id||c.repo_snapshot_id!==archive.repo_snapshot_id||c.version_id!==request.versionId||c.document_hash!==observed.document_hash||c.policy_hash!==policy.hash||caseRows.find(r=>r.case_id===c.case_id)?.input_hash!==replayCaseHash(c)))publicationFailure('case_invalid')
  const inputHash=replayTextHash(canonicalJsonString({skillId:request.skillId,versionId:request.versionId,expectedRevision:Number(latest.head_revision),sourceDigest:source.sourceDigest,policyHash:policy.hash,runnerVersion:SKILL_REPLAY_RUNNER_VERSION,cases:cases.map(c=>[c.case_id,replayCaseHash(c)])}))
  if(inputHash!==latest.input_hash)publicationFailure('case_invalid')
  // Natural facts only from exact archive source lineage, never from Replay cases or caller labels.
  const natural=(await client.query<{session_id:string}>(`SELECT DISTINCT e.session_id FROM work_episodes e JOIN source_sessions s USING(installation_id,session_id)
    WHERE e.installation_id=$1 AND e.state='ready' AND e.outcome='completed' AND s.deleted_at IS NULL
      AND e.repository_id=$2 AND e.repo_snapshot_id=$3 AND e.source_digest IS NOT NULL AND e.compiled_at IS NOT NULL
      AND e.compiler_version=$6 AND e.document_compiler_version=$7 AND e.session_id<>'shared-governance'
      AND (e.episode_id=$4 OR EXISTS(SELECT 1 FROM knowledge_evidence k JOIN memory_skill_archive_sources a ON a.installation_id=k.installation_id AND a.evidence_id=k.evidence_id
        WHERE a.installation_id=e.installation_id AND a.archive_id=$5 AND k.episode_id=e.episode_id))
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(e.document->'tests','[]')) t WHERE t->>'status'='passed'
        AND e.evidence_manifest ? (t->>'evidence_handle') AND COALESCE((e.evidence_manifest->(t->>'evidence_handle')->>'omitted')::boolean,false)=false
        AND COALESCE((e.evidence_manifest->(t->>'evidence_handle')->>'excerpt_length')::int,0)>0
        AND COALESCE((e.evidence_manifest->(t->>'evidence_handle')->>'truncated')::boolean,false)=false)
      AND NOT EXISTS(SELECT 1 FROM memory_session_tombstones t WHERE t.installation_id=e.installation_id AND t.session_id=e.session_id)`,[identity.installationId,archive.repository_id,archive.repo_snapshot_id,archive.episode_id,archive.archive_id,EPISODE_COMPILER_VERSION,EPISODE_PACKET_COMPILER_VERSION])).rows
  const independentSuccesses=natural.length
  if(request.mode==='auto'&&independentSuccesses<publicationPolicy.policy.minimumIndependentSuccesses)publicationFailure('independent_successes_required')
  return {version:observed,archive,actor,binding,replayRunId:latest.run_id,independentSuccesses,policyHash:policy.hash,requiredIndependentSuccesses:publicationPolicy.policy.minimumIndependentSuccesses}
}
