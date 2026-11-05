import {queryHealth,type HealthPool} from './health-query.js'

export type LifecycleMode='off'|'shadow'|'enabled'
export interface LifecycleHealthRow {
 installation_id:string;relay_status:string;local_status:string;owner_scope_kind:string;owner_state:string;policy_mode:string
 consume_mode:string;cold_mode:string;reclaim_mode:string;turns:number;receipt_turns:number;complete_turns:number
 provenance_unknown_turns:number;missing_receipt_turns:number;consolidation_completed:number;consolidation_failed:number;consolidation_stalled:number
 committed_decisions:number;proposed_decisions:number;context_delivered:number;context_modes:string[];counts_capped:boolean;observation_window_start?:Date|string|null
}
export const LIFECYCLE_HEALTH_REASONS=['consolidation_failed','consolidation_stalled','source_provenance_unknown','coverage_incomplete','counts_capped'] as const
export type LifecycleHealthReason=typeof LIFECYCLE_HEALTH_REASONS[number]
export function evaluateLifecycleHealth(row:LifecycleHealthRow,configuredMode:LifecycleMode='off') {
 const active=['pending','active'].includes(row.relay_status)&&!['purging','purged'].includes(row.local_status)&&row.owner_scope_kind==='personal'&&row.owner_state==='active'
 const effective=(policy:string):LifecycleMode=>!active||configuredMode==='off'||!['shadow','enabled'].includes(policy)?'off':configuredMode==='shadow'||policy==='shadow'?'shadow':'enabled'
 const mode=effective(row.policy_mode),reasons:LifecycleHealthReason[]=[]
 if(mode!=='off'){
  if(row.consolidation_failed>0)reasons.push('consolidation_failed')
  if(row.consolidation_stalled>0)reasons.push('consolidation_stalled')
  if(row.provenance_unknown_turns>0)reasons.push('source_provenance_unknown')
  if(row.missing_receipt_turns>0||row.complete_turns+row.provenance_unknown_turns<row.turns)reasons.push('coverage_incomplete')
  if(row.counts_capped)reasons.push('counts_capped')
 }
 return {mode,consume_mode:mode==='off'?'off':effective(row.consume_mode),cold_mode:mode==='off'?'off':effective(row.cold_mode),reclaim_mode:mode==='off'?'off':effective(row.reclaim_mode),
  formal_writes_enabled:mode==='enabled',
  execution:mode==='off'?'disabled':row.consolidation_failed||row.consolidation_stalled?'degraded':row.turns||row.consolidation_completed?'healthy':'idle',
  coverage:mode==='off'?'disabled':!row.turns?'idle':row.complete_turns<row.turns||row.counts_capped?'limited':'complete',reasons}
}

/** Aggregate capability counts, never installation IDs or source identifiers.
 * Coverage describes latest recorded receipts, not a revalidation of source bodies. */
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
  coverage:{status:(installationCapped&&active.length>0)||health.some(item=>item.coverage==='limited')?'limited':health.some(item=>item.coverage==='complete')?'complete':active.length?'idle':'disabled',
   basis:'latest_recorded_per_retained_turn',observation_window_basis:'per_installation_policy_updated_at',observation_window_start:windowStarts[0]??null,observation_window_latest_start:windowStarts.at(-1)??null,sample_limit_per_installation:1000,installation_limit:100,
   counts_capped:installationCapped||active.some(row=>row.counts_capped),turns:sum('turns'),receipt_turns:sum('receipt_turns'),complete_turns:sum('complete_turns'),provenance_unknown_turns:sum('provenance_unknown_turns'),missing_receipt_turns:sum('missing_receipt_turns')},
  consolidation:{completed:sum('consolidation_completed'),failed:sum('consolidation_failed'),stalled:sum('consolidation_stalled')},
  decisions:{committed:sum('committed_decisions'),proposed:sum('proposed_decisions')},
  context:{delivered:sum('context_delivered'),setting_modes:Object.fromEntries(['off','shadow','enabled'].map(mode=>[mode,active.reduce((n,row)=>n+row.context_modes.filter(item=>item===mode).length,0)])),delivery_required:false}}
}
/** Bounded metadata-only sample. Primary-key traversal caps each installation
 * at 1000 turns/bundles/decisions/settings/deliveries plus one sentinel. Receipt
 * lookup uses the installation/turn/created_at index. No event/body hydration,
 * historical GROUP BY, provider result JSON, or source digest computation. */
export async function loadLifecycleHealth(pool:HealthPool,configuredMode:LifecycleMode='off'):Promise<LifecycleHealthRow[]> {
 const mode=['shadow','enabled'].includes(configuredMode)?configuredMode:'off'
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
 SELECT i.*,t.turns,t.receipt_turns,t.complete_turns,t.provenance_unknown_turns,t.missing_receipt_turns,
  b.consolidation_completed,b.consolidation_failed,b.consolidation_stalled,d.committed_decisions,d.proposed_decisions,
  c.context_delivered,m.context_modes,(t.capped OR b.capped OR d.capped OR c.capped OR m.capped) counts_capped
 FROM installations i
 CROSS JOIN LATERAL (
  SELECT count(*) FILTER(WHERE n<=1000)::int turns,count(disposition) FILTER(WHERE n<=1000)::int receipt_turns,
   count(*) FILTER(WHERE n<=1000 AND complete)::int complete_turns,
   count(*) FILTER(WHERE n<=1000 AND disposition='provenance_unknown')::int provenance_unknown_turns,
   count(*) FILTER(WHERE n<=1000 AND disposition IS NULL)::int missing_receipt_turns,COALESCE(bool_or(n>1000),false) capped
  FROM (SELECT turn_id,session_id,row_number() OVER() n FROM
   (SELECT turn_id,session_id FROM source_turns WHERE installation_id=i.installation_id AND i.active
    AND state IN('completed','interrupted','failed','abandoned') AND updated_at>=i.observation_window_start
    ORDER BY updated_at DESC,turn_id LIMIT 1001) sample) turns
  LEFT JOIN LATERAL (SELECT disposition,complete FROM memory_source_processing_receipts r
   WHERE r.installation_id=i.installation_id AND r.turn_id=turns.turn_id AND r.session_id=turns.session_id
   ORDER BY created_at DESC,source_digest,policy_version LIMIT 1) receipt ON true
 ) t
 CROSS JOIN LATERAL (
  SELECT count(*) FILTER(WHERE n<=1000 AND run_state='completed')::int consolidation_completed,
   count(*) FILTER(WHERE n<=1000 AND run_state IN('failed','provider_result_unknown'))::int consolidation_failed,
   count(*) FILTER(WHERE n<=1000 AND state IN('pending','running','blocked') AND next_evaluate_at<=NOW()
    AND updated_at<NOW()-interval '1 hour' AND COALESCE(run_state,'')<>'completed')::int consolidation_stalled,
   COALESCE(bool_or(n>1000),false) capped
  FROM (SELECT sample.*,row_number() OVER() n FROM
   (SELECT bundle_id,revision,state,updated_at,next_evaluate_at FROM memory_task_bundles
    WHERE installation_id=i.installation_id AND i.active AND bundle_kind='intake' ORDER BY bundle_id LIMIT 1001) sample) bundles
  LEFT JOIN LATERAL (SELECT r.state run_state FROM memory_curation_runs r
   WHERE r.installation_id=i.installation_id AND r.bundle_id=bundles.bundle_id AND r.bundle_revision=bundles.revision
    AND r.policy_revision=i.policy_revision AND r.mode=i.effective_mode
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
