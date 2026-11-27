import {curationProgressSql,stageAvailability,summarizeStage,type StageProgress} from './stage-progress.js'
import {nativeTurnCoverage,projectedTurnCoverage} from './lifecycle-turn-coverage.js'
import {sourcePoolContext} from '../sources/pool-context.js'
import {queryHealth,type HealthPool} from './health-query.js'

export type LifecycleMode='off'|'shadow'|'enabled'
export interface LifecycleHealthRow {
 uncertain_calls?:number; unpriced_calls?:number; recorded_uncertain_cost_micros?:string; uncertain_calls_capped?:boolean
 curation_progress?:StageProgress
 installation_id:string;relay_status:string;local_status:string;owner_scope_kind:string;owner_state:string;policy_mode:string
 consume_mode:string;cold_mode:string;reclaim_mode:string;turns:number;receipt_turns:number;complete_turns:number
 coverage_basis:'current_native_input'|'current_projection_intake';trusted_input_turns:number;unknown_input_turns:number;policy_skipped_input_turns:number
 recorded_projection_turns:number;recorded_projection_complete_turns:number;recorded_projection_unknown_turns:number
 with_trusted_input_turns:number;partially_trusted_turns:number;blocked_turns:number;provenance_unknown_turns:number;missing_receipt_turns:number;consolidation_completed:number;consolidation_failed:number;consolidation_stalled:number
 committed_decisions:number;proposed_decisions:number;context_delivered:number;context_modes:string[];counts_capped:boolean;observation_window_start?:Date|string|null
}
export const LIFECYCLE_HEALTH_REASONS=['consolidation_failed','consolidation_stalled','source_provenance_unknown','coverage_incomplete','counts_capped'] as const
export type LifecycleHealthReason=typeof LIFECYCLE_HEALTH_REASONS[number]
export function evaluateLifecycleHealth(row:LifecycleHealthRow,configuredMode:LifecycleMode='off') {
 const active=['pending','active'].includes(row.relay_status)&&!['purging','purged'].includes(row.local_status)&&row.owner_scope_kind==='personal'&&row.owner_state==='active'
 const effective=(policy:string):LifecycleMode=>!active||configuredMode==='off'||!['shadow','enabled'].includes(policy)?'off':configuredMode==='shadow'||policy==='shadow'?'shadow':'enabled'
 const mode=effective(row.policy_mode),reasons:LifecycleHealthReason[]=[]
 const affected=row.curation_progress ? stageAvailability(row.curation_progress)==='degraded' : Boolean(row.consolidation_failed||row.consolidation_stalled)
 if(mode!=='off'){
  if(affected&&(row.consolidation_failed>0||Number(row.curation_progress?.failed)>0))reasons.push('consolidation_failed')
  if(affected&&(row.consolidation_stalled>0||Number(row.curation_progress?.late)>0||Number(row.curation_progress?.overdue)>=3))reasons.push('consolidation_stalled')
  if(row.provenance_unknown_turns>0||row.unknown_input_turns>0)reasons.push('source_provenance_unknown')
  if(row.missing_receipt_turns>0||row.complete_turns+row.provenance_unknown_turns<row.turns)reasons.push('coverage_incomplete')
  if(row.counts_capped)reasons.push('counts_capped')
 }
 return {mode,consume_mode:mode==='off'?'off':effective(row.consume_mode),cold_mode:mode==='off'?'off':effective(row.cold_mode),reclaim_mode:mode==='off'?'off':effective(row.reclaim_mode),
  formal_writes_enabled:mode==='enabled',
  execution:mode==='off'?'disabled':affected?'degraded':row.curation_progress?stageAvailability(row.curation_progress):row.turns||row.consolidation_completed?'healthy':'idle',
  coverage:mode==='off'?'disabled':!row.turns?'idle':row.complete_turns<row.turns||row.counts_capped?'limited':'complete',reasons}
}

/**
 * Trusted, unknown, policy-skipped and unverified partition the sample by whole-turn
 * provenance. An unknown turn can still have admitted members: with_trusted_input_turns
 * and partially_trusted_turns count that evidence independently of processing.
 */
export function summarizeLifecycleHealth(rows:LifecycleHealthRow[],configuredMode:LifecycleMode='off') {
 const installationCapped=rows.length>100
 rows=rows.slice(0,100)
 const health=rows.map(row=>evaluateLifecycleHealth(row,configuredMode))
 const active=rows.filter((_,i)=>health[i].mode!=='off')
 const windowStarts=active.flatMap(row=>row.observation_window_start?[new Date(row.observation_window_start).toISOString()]:[]).sort()
 const sum=(key:keyof LifecycleHealthRow)=>active.reduce((n,row)=>n+Number(row[key]),0)
 const modes=(key:'mode'|'consume_mode'|'cold_mode'|'reclaim_mode')=>Object.fromEntries(['off','shadow','enabled'].map(mode=>[mode,health.filter(item=>item[key]===mode).length]))
 const reasons=LIFECYCLE_HEALTH_REASONS.filter(reason=>health.some(item=>item.reasons.includes(reason))||(reason==='counts_capped'&&installationCapped&&active.length>0))
 return {configured_mode:configuredMode,modes:modes('mode'),consume_modes:modes('consume_mode'),cold_modes:modes('cold_mode'),reclaim_modes:modes('reclaim_mode'),
  formal_writes_enabled:health.some(item=>item.formal_writes_enabled),reasons,
  execution:{status:health.some(item=>item.execution==='degraded')?'degraded':health.some(item=>item.execution==='healthy')?'healthy':active.length?'idle':'disabled'},
  input_coverage:{with_trusted_input_turns:sum('with_trusted_input_turns'),partially_trusted_turns:sum('partially_trusted_turns'),
   trusted_turns:sum('trusted_input_turns'),unknown_turns:sum('unknown_input_turns'),
   policy_skipped_turns:sum('policy_skipped_input_turns'),unverified_turns:sum('turns')-sum('trusted_input_turns')-sum('unknown_input_turns')-sum('policy_skipped_input_turns')},
  coverage:{status:(installationCapped&&active.length>0)||health.some(item=>item.coverage==='limited')?'limited':health.some(item=>item.coverage==='complete')?'complete':active.length?'idle':'disabled',
   basis:rows[0]?.coverage_basis??null,observation_window_basis:'per_installation_policy_updated_at',observation_window_start:windowStarts[0]??null,observation_window_latest_start:windowStarts.at(-1)??null,sample_limit_per_installation:1000,installation_limit:100,
   blocked_turns:sum('blocked_turns'),counts_capped:installationCapped||active.some(row=>row.counts_capped),turns:sum('turns'),receipt_turns:sum('receipt_turns'),complete_turns:sum('complete_turns'),provenance_unknown_turns:sum('provenance_unknown_turns'),missing_receipt_turns:sum('missing_receipt_turns')},
  ...(rows[0]?.coverage_basis==='current_projection_intake'&&{latest_recorded_projection_receipts:{
   receipt_turns:sum('recorded_projection_turns'),complete_turns:sum('recorded_projection_complete_turns'),
   provenance_unknown_turns:sum('recorded_projection_unknown_turns')}}),
  consolidation:{external_uncertainty:{
    calls:active.reduce((n,row)=>n+Number(row.uncertain_calls??0),0),
    calls_without_recorded_price:active.reduce((n,row)=>n+Number(row.unpriced_calls??0),0),
    recorded_cost_micros:active.reduce((n,row)=>n+BigInt(row.recorded_uncertain_cost_micros??0),0n).toString(),
    capped:active.some(row=>row.uncertain_calls_capped)},recent:summarizeStage(active.flatMap(row=>row.curation_progress?[row.curation_progress]:[])),completed:sum('consolidation_completed'),failed:sum('consolidation_failed'),stalled:sum('consolidation_stalled')},
  decisions:{committed:sum('committed_decisions'),proposed:sum('proposed_decisions')},
  context:{delivered:sum('context_delivered'),setting_modes:Object.fromEntries(['off','shadow','enabled'].map(mode=>[mode,active.reduce((n,row)=>n+row.context_modes.filter(item=>item===mode).length,0)])),delivery_required:false}}
}
/** Bounded metadata-only sample. Primary-key traversal caps each installation
 * at 1000 turns/bundles/decisions/settings/deliveries plus one sentinel. Receipt
 * lookup uses the exact key for current processing and a timestamp index for projection history. No event/body hydration,
 * historical GROUP BY, provider result JSON, or source digest computation. */
export async function loadLifecycleHealth(pool:HealthPool,configuredMode:LifecycleMode='off'):Promise<LifecycleHealthRow[]> {
 const mode=['shadow','enabled'].includes(configuredMode)?configuredMode:'off'
 const native=sourcePoolContext(pool).namespace==='memory'
 const result=await queryHealth<LifecycleHealthRow>(pool,`
 WITH installations AS MATERIALIZED (
  SELECT i.installation_id,i.relay_status,i.local_status,COALESCE(s.owner_scope_kind,'unknown') owner_scope_kind,
   COALESCE(s.state,'unknown') owner_state,COALESCE(p.mode,'off') policy_mode,
   COALESCE(p.consume_mode,'off') consume_mode,COALESCE(p.cold_mode,'off') cold_mode,COALESCE(p.reclaim_mode,'off') reclaim_mode,
   p.revision policy_revision,p.updated_at observation_window_start,
   CASE WHEN '${mode}'='shadow' OR p.mode='shadow' THEN 'shadow' ELSE 'enabled' END effective_mode,
   '${mode}'<>'off' AND p.mode IN('enabled','shadow') AND s.owner_scope_kind='personal' AND s.state='active'
    AND i.relay_status IN('pending','active') AND i.local_status NOT IN('purging','purged') AS active
  FROM memory_installations i LEFT JOIN memory_owner_scopes s USING(installation_id)
  LEFT JOIN memory_curation_policies p USING(installation_id)
  WHERE i.relay_status IN('pending','active','paused') ORDER BY i.installation_id LIMIT 101
 )
 SELECT i.*,uncertain.*,recent.progress curation_progress,t.turns,t.receipt_turns,t.complete_turns,t.provenance_unknown_turns,t.missing_receipt_turns,t.blocked_turns,
  t.recorded_projection_turns,t.recorded_projection_complete_turns,t.recorded_projection_unknown_turns,
  t.trusted_input_turns,t.unknown_input_turns,t.policy_skipped_input_turns,t.with_trusted_input_turns,t.partially_trusted_turns,
  '${native?'current_native_input':'current_projection_intake'}'::text AS coverage_basis,
  b.consolidation_completed,b.consolidation_failed,b.consolidation_stalled,d.committed_decisions,d.proposed_decisions,
  c.context_delivered,m.context_modes,(t.capped OR b.capped OR d.capped OR c.capped OR m.capped) counts_capped
 FROM installations i
 CROSS JOIN LATERAL (${curationProgressSql}) recent
 CROSS JOIN LATERAL (
  SELECT count(*) FILTER(WHERE n<=1000)::int turns,
   count(disposition) FILTER(WHERE n<=1000)::int receipt_turns,
   count(*) FILTER(WHERE n<=1000 AND complete)::int complete_turns,
   count(*) FILTER(WHERE n<=1000 AND disposition='provenance_unknown')::int provenance_unknown_turns,
   count(*) FILTER(WHERE n<=1000 AND disposition IS NULL)::int missing_receipt_turns,
   count(*) FILTER(WHERE n<=1000 AND blocked)::int blocked_turns,
   count(recorded_projection_disposition) FILTER(WHERE n<=1000)::int recorded_projection_turns,
   count(*) FILTER(WHERE n<=1000 AND recorded_projection_complete)::int recorded_projection_complete_turns,
   count(*) FILTER(WHERE n<=1000 AND recorded_projection_disposition='provenance_unknown')::int recorded_projection_unknown_turns,
   count(*) FILTER(WHERE n<=1000 AND has_trusted_input)::int with_trusted_input_turns,
   count(*) FILTER(WHERE n<=1000 AND partially_trusted)::int partially_trusted_turns,
   count(*) FILTER(WHERE n<=1000 AND input_provenance='trusted')::int trusted_input_turns,
   count(*) FILTER(WHERE n<=1000 AND input_provenance='unknown')::int unknown_input_turns,
   count(*) FILTER(WHERE n<=1000 AND input_provenance='skipped_policy')::int policy_skipped_input_turns,
   COALESCE(bool_or(n>1000),false) capped
  FROM (${native?nativeTurnCoverage:projectedTurnCoverage}) turns
 ) t
 CROSS JOIN LATERAL (
  SELECT count(*)::int uncertain_calls,count(*) FILTER(WHERE cost IS NULL)::int unpriced_calls,
    COALESCE(sum(cost),0)::text recorded_uncertain_cost_micros,count(*)>1000 AS uncertain_calls_capped
  FROM (
    (SELECT (k.usage->>'costMicros')::numeric AS cost FROM memory_curation_calls k
      WHERE k.installation_id=i.installation_id AND i.active AND
       (k.state IN ('unknown','conflict') OR k.state='possible' AND k.updated_at<statement_timestamp()-interval '5 minutes')
      ORDER BY k.updated_at DESC,k.call_id LIMIT 1001)
    UNION ALL
    (SELECT u.cost_micros FROM memory_curation_runs r LEFT JOIN memory_usage_outbox u ON u.installation_id=r.installation_id
       AND u.usage_id='curation:'||r.run_id WHERE r.installation_id=i.installation_id AND i.active AND r.checkpoint_protocol IS NULL
       AND (r.state='provider_result_unknown' OR r.reconciliation_code='external_result_unconfirmed')
       ORDER BY r.started_at DESC,r.run_id LIMIT 1001)
    LIMIT 1001
  ) external_calls
 ) uncertain
 CROSS JOIN LATERAL (
  SELECT count(*) FILTER(WHERE n<=1000 AND run_state='completed')::int consolidation_completed,
   count(*) FILTER(WHERE n<=1000 AND run_state IN('failed','provider_result_unknown'))::int consolidation_failed,
   count(*) FILTER(WHERE n<=1000 AND state IN('pending','running','blocked') AND next_evaluate_at<=NOW()
    AND updated_at<NOW()-interval '1 hour' AND COALESCE(run_state,'')<>'completed')::int consolidation_stalled,
   COALESCE(bool_or(n>1000),false) capped
  FROM (SELECT sample.*,row_number() OVER() n FROM
   (SELECT bundle_id,revision,source_digest,state,updated_at,next_evaluate_at FROM memory_task_bundles
    WHERE installation_id=i.installation_id AND i.active AND bundle_kind='intake' ORDER BY bundle_id LIMIT 1001) sample) bundles
  LEFT JOIN LATERAL (SELECT r.state run_state FROM memory_curation_runs r
   WHERE r.installation_id=i.installation_id AND r.bundle_id=bundles.bundle_id AND r.bundle_revision=bundles.revision
    AND r.source_digest=bundles.source_digest AND r.policy_revision=i.policy_revision AND r.mode=i.effective_mode
   ORDER BY started_at DESC,run_id DESC LIMIT 1) run ON true
 ) b
 CROSS JOIN LATERAL (
  SELECT count(*) FILTER(WHERE n<=1000 AND state='committed')::int committed_decisions,
   count(*) FILTER(WHERE n<=1000 AND state='proposed')::int proposed_decisions,COALESCE(bool_or(n>1000),false) capped
  FROM (SELECT state,row_number() OVER() n FROM
   (SELECT state FROM memory_curation_decisions WHERE installation_id=i.installation_id AND i.active ORDER BY decision_id LIMIT 1001) sample) decisions
 ) d
 CROSS JOIN LATERAL (
  SELECT count(*) FILTER(WHERE n<=1000 AND state='delivered')::int context_delivered,COALESCE(bool_or(n>1000),false) capped
  FROM (SELECT state,row_number() OVER() n FROM
   (SELECT state FROM memory_context_injections WHERE installation_id=i.installation_id AND i.active
    ORDER BY session_id,client_request_id,pack_id LIMIT 1001) sample) injections
 ) c
 CROSS JOIN LATERAL (
  SELECT COALESCE(array_agg(mode) FILTER(WHERE n<=1000),ARRAY[]::text[]) context_modes,COALESCE(bool_or(n>1000),false) capped
  FROM (SELECT mode,row_number() OVER() n FROM
   (SELECT mode FROM memory_context_settings WHERE installation_id=i.installation_id AND i.active
    ORDER BY scope_kind,scope_key,agent LIMIT 1001) sample) settings
 ) m
 `)
 return result.rows
}
