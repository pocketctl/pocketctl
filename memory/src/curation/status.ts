import type pg from 'pg'

/** Public diagnostics are a closed vocabulary. Never serialize provider errors,
 * source paths, task keys, session IDs, prompts or model output into this view. */
export const LIFECYCLE_REASONS = ['new_logical_identity','target_unavailable','independent_conditions','plan_not_current_fact','protected_target','equivalent_value_independent_evidence','late_historical_fact','same_condition_conflict','updated_plan','confirmed_change','insufficient_change_evidence','legacy_identity_unproven','semantic_deadline','scene_unknown','lease_expired','budget_exceeded','budget_unavailable','invalid_json','empty_content','invalid_usage','http_error','aborted','curation_source_changed','curation_source_unavailable','curation_lease_lost','scene_changed','task_binding_changed','curation_finalize_failed','conclusion_invalid','predicate_unresolved','not_confirmed','future_not_observed','invalid_fact_interval','evidence_unavailable','verification_unavailable','user_authority_unavailable','observation_unavailable','time_unsupported','value_unsupported','subject_unsupported','condition_unsupported','statement_unsupported',
  'none', 'unknown', 'skill_provenance_unknown', 'skill_excluded', 'late_source_event', 'evidence_already_linked', 'predicate_unsupported',
  'source_unavailable', 'no_durable_conclusion', 'provenance_unknown', 'policy_off', 'budget_exhausted',
  'provider_result_unknown', 'extraction_failed', 'invalid_output', 'invalid_evidence', 'scene_unresolved',
  'identity_unresolved', 'semantic_conflict', 'semantic_deadline_elapsed', 'insufficient_evidence',
  'stale_source', 'stale_revision', 'equivalent', 'created', 'replaced', 'merged', 'complementary',
  'explicit_constraint', 'verified_outcome', 'user_asserted', 'decided', 'planned', 'protected',
  'no_change', 'source_changed', 'claim_changed', 'policy_changed', 'scope_unavailable', 'logical_identity_deleted'] as const
export function lifecycleReason(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'none'
  return typeof value === 'string' && (LIFECYCLE_REASONS as readonly string[]).includes(value) ? value : 'unknown'
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
  const records = (await db.query(`SELECT b.bundle_id,b.state,b.reason_code,b.updated_at,
    r.state AS run_state,r.error_code AS run_reason,r.mode AS run_mode,
    d.action,d.state AS decision_state,d.reason_code AS decision_reason
    FROM memory_task_bundles b
    LEFT JOIN LATERAL(SELECT state,error_code,mode,run_id FROM memory_curation_runs r WHERE r.installation_id=b.installation_id AND r.bundle_id=b.bundle_id ORDER BY started_at DESC,run_id DESC LIMIT 1)r ON true
    LEFT JOIN LATERAL(SELECT action,state,reason_code FROM memory_curation_decisions d WHERE d.installation_id=b.installation_id AND d.run_id=r.run_id ORDER BY created_at DESC,decision_id DESC LIMIT 1)d ON true
    WHERE b.installation_id=$1 ORDER BY b.updated_at DESC,b.bundle_id DESC LIMIT 51`, [installationId])).rows
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
    records: records.slice(0, 50).map(r => ({bundle_id: r.bundle_id, state: r.state, reason: lifecycleReason(r.reason_code), updated_at: r.updated_at,
      run_state: r.run_state, run_reason: lifecycleReason(r.run_reason), run_mode: r.run_mode,
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
