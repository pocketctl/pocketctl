import type pg from 'pg'
import {isSourceFailureDetail} from '../sources/diagnostics.js'
import {isKnownSourceUnavailableCode} from '../jobs/worker-diagnostics.js'

/** Public diagnostics are a closed vocabulary. Never serialize provider errors,
 * source paths, task keys, session IDs, prompts or model output into this view. */
export const LIFECYCLE_REASONS = ['provider_circuit_open','local_recovery_exhausted','external_result_unconfirmed','new_logical_identity','target_unavailable','independent_conditions','plan_not_current_fact','protected_target','equivalent_value_independent_evidence','late_historical_fact','same_condition_conflict','updated_plan','confirmed_change','insufficient_change_evidence','legacy_identity_unproven','semantic_deadline','scene_unknown','lease_expired','budget_exceeded','budget_unavailable','invalid_json','empty_content','invalid_usage','http_error','aborted','curation_source_changed','curation_source_unavailable','curation_lease_lost','scene_changed','task_binding_changed','curation_finalize_failed','conclusion_invalid','predicate_unresolved','not_confirmed','future_not_observed','invalid_fact_interval','evidence_unavailable','verification_unavailable','user_authority_unavailable','observation_unavailable','time_unsupported','value_unsupported','subject_unsupported','condition_unsupported','statement_unsupported',
  'provider_response_received','provider_response_uncertain','provider_uncertain_at_expiry','publication_interrupted','source_reference_changed','source_execution_generation_changed','source_execution_scope_mismatch',
  'source_shadow_provider_forbidden','source_execution_required','source_processing_pin_unavailable','source_not_sent',
  'none', 'unknown', 'skill_provenance_unknown', 'skill_excluded', 'late_source_event', 'evidence_already_linked', 'predicate_unsupported',
  'source_unavailable', 'no_durable_conclusion', 'provenance_unknown', 'policy_off', 'budget_exhausted',
  'provider_result_unknown', 'extraction_failed', 'invalid_output', 'invalid_evidence', 'scene_unresolved',
  'identity_unresolved', 'semantic_conflict', 'semantic_deadline_elapsed', 'insufficient_evidence',
  'stale_source', 'stale_revision', 'equivalent', 'created', 'replaced', 'merged', 'complementary',
  'explicit_constraint', 'verified_outcome', 'user_asserted', 'decided', 'planned', 'protected',
  'no_change', 'source_changed', 'claim_changed', 'policy_changed', 'scope_unavailable', 'logical_identity_deleted'] as const
export function lifecycleReason(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'none'
  return typeof value === 'string' && ((LIFECYCLE_REASONS as readonly string[]).includes(value) || isKnownSourceUnavailableCode(value)) ? value : 'unknown'
}
const BUNDLE_STATES = ['pending', 'running', 'completed', 'deferred_semantic', 'blocked', 'failed', 'skipped_unresolved'] as const
const RUN_STATES = ['running', 'completed', 'blocked', 'failed', 'provider_result_unknown'] as const
const ACTIONS = ['create', 'link_evidence', 'merge', 'replace', 'create_variant', 'noop', 'skip', 'defer'] as const
const DISPOSITIONS = ['concluded', 'skipped_policy', 'no_durable_conclusion', 'provenance_unknown'] as const
function counters(keys: readonly string[], rows: Array<{key: string; count: string | number}>): Record<string, number> {
  const result = Object.fromEntries(keys.map(key => [key, 0]))
  for (const row of rows) if (Object.hasOwn(result, row.key)) result[row.key] = Number(row.count)
  return result
}

function readCurationReason(value:unknown){
  const [code,stage,reason,...extra]=typeof value==='string'?value.split('/'):[]
  if(stage&&code&&(code==='source_unavailable'||isKnownSourceUnavailableCode(code))&&reason&&!extra.length&&isSourceFailureDetail(stage,reason)){
    return {code,source_stage:stage,source_reason:reason}
  }
  return {code:lifecycleReason(value),source_stage:null,source_reason:null}
}

function runDiagnostics(r:pg.QueryResultRow){
  const reason=readCurationReason(r.run_reason)
  const usageRecorded=Boolean(r.usage_id)
  const usageObserved=Number(r.input_tokens)>0||Number(r.output_tokens)>0
  const budgetRefused=['budget_exceeded','budget_unavailable'].includes(reason.code)
  let accounting='unknown'
  if(r.usage_reported_at)accounting='reported'
  else if(r.usage_dead_lettered_at)accounting='delivery_failed'
  else if(usageRecorded)accounting='recorded'
  else if(usageObserved)accounting='usage_observed'
  else if(r.parent_run_id)accounting='not_applicable'
  else if(r.run_state==='blocked'&&(budgetRefused||reason.code==='source_not_sent'))accounting='not_sent'
  const unknownProvider=r.run_state==='provider_result_unknown'
  const terminal=unknownProvider||r.run_state==='failed'||r.run_state==='blocked'
  // Historical expiry did not record a source rejection. The outbox proves
  // this charge even if the original response or precise cause is unavailable.
  const legacyExpiry=unknownProvider&&reason.code==='lease_expired'&&usageRecorded
  const noRetry=usageRecorded||usageObserved||unknownProvider||r.run_state==='failed'||r.run_state==='blocked'&&!budgetRefused
  const runResult=r.run_state==='completed'?'committed':terminal?'not_committed':r.run_state==='running'?'pending':'unknown'
  const publication=r.knowledge_published?'published':r.run_state?'not_published':'unknown'
  return {run_id:r.run_id??null,run_reason:reason.code,source_stage:reason.source_stage,source_reason:reason.source_reason,
    input_tokens:Number(r.usage_input_tokens??r.input_tokens??0),output_tokens:Number(r.usage_output_tokens??r.output_tokens??0),
    accounting_state:accounting,run_result_state:runResult,publication_state:publication,publication_reason:unknownProvider&&reason.code==='lease_expired'?'unknown':reason.code==='provider_uncertain_at_expiry'?'lease_expired':terminal?reason.code:null,
    waiting_for:legacyExpiry||r.run_state==='failed'&&usageRecorded?'publication_reconciliation':unknownProvider?'provider_reconciliation':
      r.state==='deferred_semantic'?'new_evidence_or_semantic_deadline':null,
    automatic_model_retry:noRetry?false:null}
}

/** Caller owns a consistent, authorized read transaction. All predicates are
 * installation-bound, including aggregates; record output is bounded to 50. */
export async function lifecycleStatus(db: Pick<pg.Pool, 'query'>, installationId: string, configuredMode: 'off' | 'shadow' | 'enabled' = 'off') {
  const policy = (await db.query(`SELECT p.mode,p.consume_mode,p.cold_mode,p.reclaim_mode,
    p.revision,p.policy_version,s.owner_scope_kind FROM memory_owner_scopes s
    LEFT JOIN memory_curation_policies p USING(installation_id) WHERE s.installation_id=$1`, [installationId])).rows[0]
  const bundles = (await db.query(`SELECT state AS key,count(*)::text AS count FROM memory_task_bundles WHERE installation_id=$1 GROUP BY state`, [installationId])).rows
  const runs = (await db.query(`SELECT state AS key,count(*)::text AS count FROM memory_curation_runs WHERE installation_id=$1 GROUP BY state`, [installationId])).rows
  const decisions = (await db.query(`SELECT action AS key,count(*)::text AS count FROM memory_curation_decisions WHERE installation_id=$1 AND state='committed' GROUP BY action`, [installationId])).rows
  const receipts = (await db.query(`SELECT disposition AS key,count(*)::text AS count FROM memory_source_processing_receipts WHERE installation_id=$1 GROUP BY disposition`, [installationId])).rows
  const age = (await db.query(`SELECT GREATEST(0,EXTRACT(EPOCH FROM clock_timestamp()-min(created_at)))::float8 AS seconds
    FROM memory_task_bundles WHERE installation_id=$1 AND state IN('pending','running','blocked','deferred_semantic')`, [installationId])).rows[0]?.seconds ?? null
  const usage = (await db.query(`SELECT COALESCE(sum(input_tokens),0)::text AS input_tokens,COALESCE(sum(output_tokens),0)::text AS output_tokens
    FROM memory_curation_runs WHERE installation_id=$1`, [installationId])).rows[0]
  const jobs = (await db.query(`SELECT job_type,state,count(*)::text AS count,
    CASE WHEN state IN('pending','running') THEN GREATEST(0,EXTRACT(EPOCH FROM clock_timestamp()-min(created_at)))::float8 ELSE NULL END AS oldest_seconds
    FROM memory_jobs WHERE installation_id=$1 AND job_type IN('project_feed','consolidate_task','curate_conclusions','compile_context_shadow','record_context_delivery','evaluate_claim_lifecycle','reclaim_claim_history')
    GROUP BY job_type,state ORDER BY job_type,state`, [installationId])).rows
  const rejected = (await db.query(`SELECT rejection #>> '{}' AS key,count(*)::text AS count FROM memory_curation_runs r
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.result)='array' THEN r.result ELSE '[]'::jsonb END) task
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(task->'rejections')='array' THEN task->'rejections' ELSE '[]'::jsonb END) rejection
    WHERE r.installation_id=$1 GROUP BY rejection`, [installationId])).rows
  const validationRejections:Record<string,number>={}
  for(const row of rejected){const reason=lifecycleReason(row.key);validationRejections[reason]=(validationRejections[reason]??0)+Number(row.count)}
  const assessments=(await db.query(`SELECT state AS key,count(*)::text AS count,COALESCE(sum(input_tokens),0)::text AS input_tokens,COALESCE(sum(output_tokens),0)::text AS output_tokens
    FROM memory_lifecycle_assessment_runs WHERE installation_id=$1 GROUP BY state`,[installationId])).rows
  const assessmentUsage=assessments.reduce((sum,row)=>({input_tokens:sum.input_tokens+Number(row.input_tokens),output_tokens:sum.output_tokens+Number(row.output_tokens)}),{input_tokens:0,output_tokens:0})
  const records = (await db.query(`WITH page AS MATERIALIZED (
    SELECT b.bundle_id,b.state,b.reason_code,b.updated_at,b.next_evaluate_at,b.semantic_deadline,
     r.run_id,r.state AS run_state,r.error_code AS run_reason,r.mode AS run_mode,r.policy_revision AS run_policy_revision,
     r.parent_run_id,r.input_tokens,r.output_tokens,windows.saved_windows,windows.uncertain_windows,items.published_items,items.binding_gaps,u.usage_id,u.input_tokens AS usage_input_tokens,u.output_tokens AS usage_output_tokens,
     u.reported_at AS usage_reported_at,u.dead_lettered_at AS usage_dead_lettered_at,d.action,d.state AS decision_state,d.reason_code AS decision_reason
    FROM (SELECT installation_id,bundle_id,revision,source_digest,state,reason_code,updated_at,next_evaluate_at,semantic_deadline
     FROM memory_task_bundles WHERE installation_id=$1 ORDER BY updated_at DESC,bundle_id DESC LIMIT 51) b
    LEFT JOIN LATERAL(SELECT run_id,state,error_code,mode,policy_revision,parent_run_id,input_tokens,output_tokens FROM memory_curation_runs r WHERE r.installation_id=b.installation_id AND r.bundle_id=b.bundle_id
     AND r.bundle_revision=b.revision AND r.source_digest=b.source_digest ORDER BY started_at DESC,run_id DESC LIMIT 1)r ON true
    LEFT JOIN LATERAL(SELECT count(*) FILTER(WHERE state='saved')::int saved_windows,
      count(*) FILTER(WHERE state IN('unknown','possible','conflict'))::int uncertain_windows
      FROM memory_curation_calls WHERE installation_id=b.installation_id AND run_id=r.run_id) windows ON true
    LEFT JOIN LATERAL(SELECT count(*) FILTER(WHERE state='published')::int published_items,
      count(*) FILTER(WHERE state='binding_pending')::int binding_gaps FROM memory_curation_items WHERE installation_id=b.installation_id AND run_id=r.run_id) items ON true
    LEFT JOIN LATERAL(SELECT max(usage_id) usage_id,sum(u.input_tokens) input_tokens,sum(u.output_tokens) output_tokens,
      CASE WHEN count(*)=count(u.reported_at) THEN max(u.reported_at) END reported_at,max(u.dead_lettered_at) dead_lettered_at
      FROM memory_usage_outbox u WHERE u.installation_id=b.installation_id AND u.operation='curation' AND u.usage_id IN (
        SELECT 'curation:'||r.run_id::text UNION ALL SELECT 'curation:'||r.run_id::text||':window:'||mc.window_index
        FROM memory_curation_calls mc WHERE mc.installation_id=b.installation_id AND mc.run_id=r.run_id AND mc.window_index>0 AND mc.usage IS NOT NULL)) u ON true
    LEFT JOIN LATERAL(SELECT action,state,reason_code FROM memory_curation_decisions d WHERE d.installation_id=b.installation_id AND d.run_id=r.run_id ORDER BY created_at DESC,decision_id DESC LIMIT 1)d ON true
   ), published AS (
    SELECT DISTINCT unnest(ARRAY[writer.run_id,writer.parent_run_id]) AS run_id
    FROM memory_curation_runs writer JOIN memory_curation_decisions d USING(installation_id,run_id)
    JOIN knowledge_versions v ON v.installation_id=d.installation_id AND v.version_id=d.version_id AND v.claim_id=d.claim_id
    WHERE writer.installation_id=$1 AND writer.mode='enabled' AND writer.state='completed'
     AND (writer.run_id IN(SELECT run_id FROM page) OR writer.parent_run_id IN(SELECT run_id FROM page))
     AND d.state='committed' AND d.action IN('create','create_variant','replace','merge','link_evidence')
   )
   SELECT page.*,published.run_id IS NOT NULL AS knowledge_published FROM page LEFT JOIN published USING(run_id)
   ORDER BY page.updated_at DESC,page.bundle_id DESC`, [installationId])).rows
  const effective = (value: string | undefined) => configuredMode === 'off' || !value || value === 'off' ? 'off' : configuredMode === 'shadow' || value === 'shadow' ? 'shadow' : 'enabled'
  return {
    configured_mode: configuredMode, policy_mode: policy?.mode ?? 'off',
    mode: effective(policy?.mode), consume_mode: effective(policy?.consume_mode), cold_mode: effective(policy?.cold_mode), reclaim_mode: effective(policy?.reclaim_mode),
    personal: policy?.owner_scope_kind === 'personal', revision: Number(policy?.revision ?? 0),
    bundles: counters(BUNDLE_STATES, bundles), runs: counters(RUN_STATES, runs), decisions: counters(ACTIONS, decisions), receipts: counters(DISPOSITIONS, receipts),
    validation_rejections: validationRejections,
    assessments:counters(['running','completed','blocked','provider_result_unknown','stale'],assessments),assessment_usage:assessmentUsage,
    stage_jobs: jobs.map(r=>({stage:r.job_type,state:r.state,count:Number(r.count),oldest_seconds:r.oldest_seconds})),
    oldest_pending_seconds: age, usage: {input_tokens: Number(usage?.input_tokens ?? 0)+assessmentUsage.input_tokens, output_tokens: Number(usage?.output_tokens ?? 0)+assessmentUsage.output_tokens},
    records: records.slice(0, 50).map(r => ({bundle_id: r.bundle_id, state: r.state, reason: readCurationReason(r.reason_code).code, updated_at: r.updated_at,
      next_evaluate_at:r.next_evaluate_at??null, semantic_deadline:r.semantic_deadline??null,
      run_state:r.run_state,run_mode:r.run_mode,run_policy_revision:r.run_policy_revision?Number(r.run_policy_revision):null,
      run_matches_current_policy:r.run_id?Number(r.run_policy_revision)===Number(policy?.revision)&&r.run_mode===effective(policy?.mode):null,
      ...runDiagnostics(r),
      saved_windows:r.saved_windows,uncertain_windows:r.uncertain_windows,published_items:r.published_items,binding_gaps:r.binding_gaps,
      action: r.action, decision_state: r.decision_state, decision_reason: lifecycleReason(r.decision_reason)})), has_more: records.length > 50,
  }
}

export async function claimLifecycle(db: Pick<pg.Pool, 'query'>, installationId: string, claimId: string) {
  const row = (await db.query(`SELECT c.claim_id,c.revision,c.state,v.authority,
    l.kind,l.assertion_mode,l.storage_tier,l.body_state,l.protection,l.observation_state,l.cold_since,l.next_evaluate_at,
    EXISTS(SELECT 1 FROM knowledge_evidence e WHERE e.installation_id=c.installation_id AND e.version_id=c.current_version_id
      AND NOT memory_delivery_source_available(e.locator->'source_provenance')) AS source_withdrawn
    FROM knowledge_claims c LEFT JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.version_id=c.current_version_id
    LEFT JOIN memory_claim_lifecycle l ON l.installation_id=c.installation_id AND l.claim_id=c.claim_id
    WHERE c.installation_id=$1 AND c.claim_id=$2`, [installationId, claimId])).rows[0]
  if (!row) return null
  return {...row, revision: Number(row.revision), managed: row.kind !== null, source_status: row.source_withdrawn ? 'withdrawn' : 'unknown'}
}

/** Management catalog deliberately includes non-consumable records. UUID paging
 * reveals no content and cannot escape the authenticated installation. */
export async function lifecycleCatalog(db: Pick<pg.Pool,'query'>,installationId:string,view:'cold'|'history',cursor:string|null) {
  const predicate=view==='cold'?"l.storage_tier='cold'":"c.state<>'active'"
  const rows=(await db.query(`SELECT c.claim_id,c.claim_type,c.scope_kind,c.scope_key,c.state,c.revision::text,c.current_version_id,
    c.created_at,c.updated_at,v.authority,v.repository_id,v.repo_snapshot_id,v.branch,v.freshness_at,v.created_at AS version_created_at,
    CASE WHEN COALESCE(to_jsonb(v)->>'body_state','present')='reclaimed' THEN '' ELSE v.statement END AS statement,
    COALESCE(to_jsonb(v)->>'body_state','present') AS body_state,l.storage_tier,
    count(*) OVER()::int AS remaining_count
    FROM knowledge_claims c JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.version_id=c.current_version_id
    LEFT JOIN memory_claim_lifecycle l ON l.installation_id=c.installation_id AND l.claim_id=c.claim_id
    WHERE c.installation_id=$1 AND ${predicate} AND($2::uuid IS NULL OR c.claim_id>$2)
    ORDER BY c.claim_id LIMIT 51`,[installationId,cursor])).rows
  const page=rows.slice(0,50)
  const total=(await db.query(`SELECT count(*)::int n FROM knowledge_claims c
    LEFT JOIN memory_claim_lifecycle l ON l.installation_id=c.installation_id AND l.claim_id=c.claim_id
    WHERE c.installation_id=$1 AND c.current_version_id IS NOT NULL AND ${predicate}`,[installationId])).rows[0]?.n??0
  return {claims:page.map(({remaining_count:_,...row})=>row),next_cursor:rows.length>50?page.at(-1)?.claim_id??null:null,total_count:total}
}
