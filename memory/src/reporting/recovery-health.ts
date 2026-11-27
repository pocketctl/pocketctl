// Keep historical coverage visible after an isolated job releases its lease.
// The current failure rate uses distinct admitted jobs, never their retry count.
export interface RecoveryStageHealth {
  stage:string
  admitted:number
  failed:number
  overdue:number
  unresolved:number
  oldest_gap_seconds:number|null
  capped:boolean
}

export function recoveryStageDegraded(stage:RecoveryStageHealth) {
  return stage.overdue>=3 || stage.failed>=3 && stage.failed*5>=stage.admitted
}

export const recoveryStagesSql=`SELECT jsonb_agg(to_jsonb(sample)) AS stages FROM (
  SELECT stage, recent.admitted, recent.failed, overdue.n AS overdue, gaps.unresolved, gaps.oldest_gap_seconds,
    (recent.capped OR gaps.capped OR overdue.n>1000) AS capped
  FROM unnest(ARRAY['curate_conclusions','project_shared_source','index_claim_version','index_shared_claim','rebuild_claim_index']) stage
  CROSS JOIN LATERAL (
    SELECT count(*) AS admitted,count(*) FILTER (WHERE d.status='isolated') AS failed,count(*)>1000 AS capped
    FROM (SELECT j.job_id FROM memory_jobs j WHERE j.installation_id=i.installation_id AND j.job_type=stage
      AND j.created_at>=statement_timestamp()-interval '1 hour' ORDER BY j.created_at DESC,j.job_id LIMIT 1001) cohort
    LEFT JOIN memory_stage_dispositions d USING(job_id)
  ) recent
  CROSS JOIN LATERAL (
    SELECT count(*) AS unresolved,ROUND(EXTRACT(EPOCH FROM statement_timestamp()-min(first_failed_at))) AS oldest_gap_seconds,
      count(*)>1000 AS capped FROM (SELECT first_failed_at FROM memory_stage_dispositions d
      WHERE d.installation_id=i.installation_id AND d.job_type=stage AND d.status<>'resolved'
      ORDER BY first_failed_at LIMIT 1001) retained
  ) gaps
  CROSS JOIN LATERAL (
    SELECT count(*) AS n FROM (SELECT 1 FROM memory_jobs j WHERE j.installation_id=i.installation_id AND j.job_type=stage
      AND j.state IN('pending','running') AND j.available_at<statement_timestamp()-interval '1 hour' LIMIT 1001) stalled
  ) overdue
) sample`

export function summarizeRecoveryStages(stages:RecoveryStageHealth[]) {
  const totals=new Map<string,RecoveryStageHealth & {affected_installations:number}>()
  for(const row of stages){
    const total=totals.get(row.stage)??{stage:row.stage,admitted:0,failed:0,overdue:0,unresolved:0,
      oldest_gap_seconds:null,capped:false,affected_installations:0}
    for(const key of ['admitted','failed','overdue','unresolved'] as const)total[key]+=row[key]
    if(row.oldest_gap_seconds!=null)total.oldest_gap_seconds=Math.max(total.oldest_gap_seconds??0,row.oldest_gap_seconds)
    total.capped||=row.capped
    if(recoveryStageDegraded(row))total.affected_installations++
    totals.set(row.stage,total)
  }
  return [...totals.values()]
}
