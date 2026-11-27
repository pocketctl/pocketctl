import {LIFECYCLE_SOURCE_POLICY} from '../episodes/source-admission.js'

/** Each sample is a distinct admitted input generation, even if it produced no knowledge. */
export interface StageProgress {
  inputs: number
  processed: number
  no_output: number
  partial: number
  failed: number
  waiting: number
  late: number
  p95_seconds: number | null
  oldest_wait_seconds: number | null
  overdue: number
  capped: boolean
}

export function stageAvailability(progress: StageProgress) {
  if (progress.overdue >= 3) return 'degraded'
  if (!progress.inputs) return 'idle'
  // A single isolated gap is visible in the counters. Three independent misses
  // affecting at least a fifth of the cohort indicate a stage-wide incident.
  return progress.failed >= 3 && progress.failed * 5 >= progress.inputs ||
    progress.late >= 3 && progress.late * 5 >= progress.inputs ? 'degraded' : 'healthy'
}

function stageSample(inputs: string, overdue: string) {
  return `WITH inputs AS MATERIALIZED (${inputs}), sample AS (
    SELECT *,GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(finished_at,statement_timestamp())-received_at))) latency
    FROM inputs ORDER BY received_at DESC LIMIT 1000
  )
  SELECT jsonb_build_object(
    'inputs',count(*),'processed',count(*) FILTER (WHERE outcome='processed'),
    'no_output',count(*) FILTER (WHERE outcome='no_output'),'partial',count(*) FILTER (WHERE outcome='partial'),'failed',count(*) FILTER (WHERE outcome='failed'),
    'waiting',count(*) FILTER (WHERE outcome='waiting'),'late',count(*) FILTER (WHERE latency>600),
    'oldest_wait_seconds',max(ROUND(latency)) FILTER (WHERE outcome='waiting'),
    'p95_seconds',ROUND((percentile_disc(0.95) WITHIN GROUP (ORDER BY latency))::numeric),
    'overdue',(SELECT count(*) FROM (${overdue} LIMIT 1001) past_due),
    'capped',(SELECT count(*)>1000 FROM inputs)) progress FROM sample`
}

export const dialogueProgressSql = stageSample(`
  SELECT t.requested_at received_at,
    CASE WHEN r.status IN ('published','not_admitted','input_gap','failed') THEN r.updated_at END finished_at,
    CASE WHEN r.status='published' THEN 'processed'
         WHEN r.status='not_admitted' THEN 'no_output'
         WHEN r.status IN ('failed','input_gap') THEN 'failed' ELSE 'waiting' END outcome
  FROM memory_dialogue_turns t LEFT JOIN memory_dialogue_compile_receipts r
    ON r.installation_id=t.installation_id AND r.session_id=t.session_id AND r.turn_id=t.turn_id
    AND r.generation=t.requested_generation
  WHERE t.installation_id=i.installation_id AND t.requested_at>=statement_timestamp()-interval '1 hour'
  ORDER BY t.requested_at DESC LIMIT 1001`, `
  SELECT j.job_id FROM memory_jobs j WHERE j.installation_id=i.installation_id
    AND j.job_type='compile_episode' AND j.payload ?& ARRAY['dialogue_session','turn']
    AND j.state IN ('pending','running') AND j.available_at<statement_timestamp()-interval '1 hour'`)

export const curationProgressSql = stageSample(`
  SELECT COALESCE(b.intake_received_at,b.created_at) received_at,
    CASE WHEN r.state='completed' AND b.state='completed' AND receipt.created_at IS NOT NULL THEN receipt.created_at
         WHEN r.state IN ('failed','provider_result_unknown') THEN r.completed_at END finished_at,
    CASE WHEN r.state='completed' AND b.state='completed' AND receipt.created_at IS NOT NULL
         THEN CASE WHEN receipt.disposition='provenance_unknown' OR NOT receipt.complete THEN 'partial'
           WHEN receipt.disposition='no_durable_conclusion' THEN 'no_output' ELSE 'processed' END
         WHEN b.state='skipped_unresolved' AND EXISTS(SELECT 1 FROM memory_curation_items item
           WHERE item.installation_id=b.installation_id AND item.run_id=r.run_id AND item.state='published') THEN 'partial'
         WHEN r.state IN ('failed','provider_result_unknown') OR b.state IN ('blocked','skipped_unresolved','failed')
         THEN 'failed' ELSE 'waiting' END outcome
  FROM memory_task_bundles b LEFT JOIN LATERAL (
    SELECT run_id,state,started_at,completed_at FROM memory_curation_runs r
    WHERE r.installation_id=b.installation_id AND r.bundle_id=b.bundle_id AND r.bundle_revision=b.revision
      AND r.source_digest=b.source_digest AND r.policy_revision=i.policy_revision AND r.mode=i.effective_mode
    ORDER BY started_at DESC,run_id DESC LIMIT 1
  ) r ON true
  LEFT JOIN memory_source_processing_receipts receipt ON receipt.installation_id=b.installation_id
    AND receipt.session_id=b.session_id AND receipt.turn_id=substring(b.task_key FROM position(':' IN b.task_key)+1)
    AND receipt.policy_version='${LIFECYCLE_SOURCE_POLICY}' AND receipt.source_digest=b.source_digest
    AND receipt.created_at>=r.started_at
  WHERE b.installation_id=i.installation_id AND b.bundle_kind='intake' AND i.active AND b.body_state='present'
    AND COALESCE(b.intake_received_at,b.created_at)>=statement_timestamp()-interval '1 hour'
  ORDER BY COALESCE(b.intake_received_at,b.created_at) DESC LIMIT 1001`, `
  SELECT b.bundle_id FROM memory_task_bundles b WHERE b.installation_id=i.installation_id AND i.active
    AND b.bundle_kind='intake' AND b.body_state='present' AND b.state IN ('pending','running')
    AND b.next_evaluate_at<statement_timestamp()-interval '1 hour'
    AND COALESCE(b.intake_received_at,b.created_at)<statement_timestamp()-interval '1 hour'`)

export const usageProgressSql = stageSample(`
  SELECT COALESCE(u.received_at,u.occurred_at) received_at,CASE WHEN reported_at IS NOT NULL THEN reported_at
    WHEN delivery_state IN ('legacy','rejected') THEN dead_lettered_at END finished_at,
    CASE WHEN reported_at IS NOT NULL THEN 'processed' WHEN delivery_state IN ('legacy','rejected') THEN 'failed' ELSE 'waiting' END outcome
  FROM memory_usage_outbox u WHERE installation_id=i.installation_id AND COALESCE(u.received_at,u.occurred_at)>=statement_timestamp()-interval '1 hour'
  ORDER BY COALESCE(u.received_at,u.occurred_at) DESC LIMIT 1001`, `
  SELECT usage_id FROM memory_usage_outbox WHERE installation_id=i.installation_id AND reported_at IS NULL
    AND delivery_state NOT IN ('legacy','rejected') AND COALESCE(received_at,occurred_at)<statement_timestamp()-interval '1 hour'
    AND available_at<=statement_timestamp()`)

export const INTAKE_PROGRESS_MIGRATION = {version:109, statements:[
  'ALTER TABLE memory_task_bundles ADD COLUMN intake_received_at TIMESTAMPTZ',
  `CREATE INDEX memory_intake_progress_window ON memory_task_bundles
    (installation_id,COALESCE(intake_received_at,created_at) DESC) WHERE bundle_kind='intake' AND body_state='present'`,
]}

export function summarizeStage(rows: StageProgress[]) {
  const count=(key:'inputs'|'processed'|'no_output'|'partial'|'failed'|'waiting'|'late'|'overdue')=>rows.reduce((sum,row)=>sum+Number(row[key]??0),0)
  const maximum=(key:'p95_seconds'|'oldest_wait_seconds')=>{
    const values=rows.flatMap(row=>row[key]===null?[]:[row[key]])
    return values.length?Math.max(...values):null
  }
  return {window_seconds:3600,deadline_seconds:600,inputs:count('inputs'),overdue:count('overdue'),processed:count('processed'),
    no_output:count('no_output'),partial:count('partial'),failed:count('failed'),waiting:count('waiting'),late:count('late'),
    worst_installation_p95_seconds:maximum('p95_seconds'),oldest_wait_seconds:maximum('oldest_wait_seconds'),
    capped:rows.some(row=>row.capped),affected_installations:rows.filter(row=>stageAvailability(row)==='degraded').length}
}
