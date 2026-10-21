import {queryHealth,type HealthPool} from './health-query.js'

export const BUSINESS_HEALTH_REASONS = ['feed_stalled', 'budget_blocked', 'extraction_stalled', 'extraction_failed', 'evidence_gap'] as const
export type BusinessHealthReason = typeof BUSINESS_HEALTH_REASONS[number]
export interface BusinessHealthRow {
  installation_id: string
  local_status: string
  relay_status: string
  last_error_code: string | null
  feed_enabled: boolean
  feed_lag_seconds: number | string | null
  extraction_mode: string
  budget_deferred: number | string
  oldest_extract_seconds: number | string | null
  last_extract_seconds: number | string | null
  evidence_gaps: number | string
  last_extract_at?: Date | string | null
  last_feed_id?: string | null
  pending_jobs?: string
  failed_jobs_24h?: string
  failed_extractions_24h?: string | number
  quarantined_extractions_24h?: string | number
  uncertain_extractions_24h?: string | number
  unresolved_extractions?: string | number
}

/** Pure, bounded decision shared by readiness, Relay heartbeat and metrics. */
export function evaluateBusinessHealth(row: BusinessHealthRow, enabled = true) {
  const active = enabled && ['pending', 'active'].includes(row.relay_status)
    && !['purging', 'purged'].includes(row.local_status)
  const extraction = active && ['enabled', 'shadow'].includes(row.extraction_mode)
  const reasons: BusinessHealthReason[] = []
  if (active && row.feed_enabled && Number(row.feed_lag_seconds ?? 0) > 300) reasons.push('feed_stalled')
  if (extraction && Number(row.budget_deferred) > 0) reasons.push('budget_blocked')
  if (extraction && row.oldest_extract_seconds != null && Number(row.oldest_extract_seconds) > 3600
    && (row.last_extract_seconds == null || Number(row.last_extract_seconds) > 3600)) reasons.push('extraction_stalled')
  if (extraction && Number(row.unresolved_extractions ?? 0) > 0) reasons.push('extraction_failed')
  if (active && Number(row.evidence_gaps) > 0) reasons.push('evidence_gap')
  const integrity = row.local_status === 'integrity_error'
  const state = integrity ? 'error' : reasons.length || row.local_status === 'degraded' ? 'degraded'
    : row.local_status === 'ready' ? 'ready' : 'syncing'
  return {state, reasons, primaryError: integrity ? row.last_error_code ?? 'integrity_error'
    : reasons[0] ?? row.last_error_code ?? undefined}
}

/** No source text, identity labels or arbitrary exception messages escape this query. */
export async function loadBusinessHealth(pool: HealthPool): Promise<BusinessHealthRow[]> {
  const result = await queryHealth<BusinessHealthRow>(pool,`
    SELECT i.installation_id, i.local_status, i.relay_status, i.last_error_code,
      i.last_feed_id::text,
      NOT i.snapshot_required AS feed_enabled,
      EXTRACT(EPOCH FROM (NOW() - COALESCE(i.last_ack_at, i.created_at))) AS feed_lag_seconds,
      COALESCE(f.extraction_mode, 'off') AS extraction_mode,
      (SELECT COUNT(*) FROM memory_jobs j WHERE j.installation_id=i.installation_id
        AND j.state='pending' AND j.job_type IN ('extract_candidates','extract_skill_candidate')
        AND j.last_error_code IN ('budget_exceeded','budget_unavailable')) AS budget_deferred,
      (SELECT MAX(EXTRACT(EPOCH FROM (NOW()-j.created_at))) FROM memory_jobs j
        WHERE j.installation_id=i.installation_id AND j.job_type='extract_candidates'
        AND j.state IN ('pending','running') AND j.available_at<=NOW()
        AND COALESCE(j.last_error_code,'') NOT IN ('source_not_ready','budget_exceeded','budget_unavailable')) AS oldest_extract_seconds,
      outcomes.failed_extractions_24h, outcomes.quarantined_extractions_24h, outcomes.uncertain_extractions_24h,
      unresolved.unresolved_extractions,
      runs.last_extract_at,
      EXTRACT(EPOCH FROM (NOW()-runs.last_extract_at)) AS last_extract_seconds,
      (SELECT COUNT(*) FROM memory_feed_inbox inbox WHERE inbox.installation_id=i.installation_id
        AND inbox.projection_state='quarantined' AND inbox.error_code='oversized_content') AS evidence_gaps,
      (SELECT COUNT(*)::text FROM memory_jobs j WHERE j.installation_id=i.installation_id AND j.state='pending') AS pending_jobs,
      (SELECT COUNT(*)::text FROM memory_jobs j WHERE j.installation_id=i.installation_id AND j.state='dead'
        AND j.created_at>NOW()-INTERVAL '24 hours') AS failed_jobs_24h
    FROM memory_installations i
    LEFT JOIN memory_feature_settings f ON f.installation_id=i.installation_id
    LEFT JOIN LATERAL (SELECT MAX(completed_at) AS last_extract_at FROM memory_extraction_runs r
      WHERE r.installation_id=i.installation_id AND r.state='succeeded') runs ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*) FILTER(WHERE r.state='failed')::text AS failed_extractions_24h,
        COUNT(*) FILTER(WHERE r.state='quarantined')::text AS quarantined_extractions_24h,
        COUNT(*) FILTER(WHERE r.error_code='provider_result_unknown')::text AS uncertain_extractions_24h
      FROM memory_extraction_runs r WHERE r.installation_id=i.installation_id AND r.started_at>NOW()-INTERVAL '24 hours'
    ) outcomes ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::text AS unresolved_extractions FROM (
        -- Start from failed runs, not every historical episode. Cap the diagnostic
        -- count at 1001; detection stays active even beyond the display limit.
        SELECT r.episode_id FROM memory_extraction_runs r
        JOIN work_episodes e ON e.installation_id=r.installation_id AND e.episode_id=r.episode_id AND e.source_digest=r.episode_source_digest
        JOIN source_sessions s ON s.installation_id=e.installation_id AND s.session_id=e.session_id
        WHERE r.installation_id=i.installation_id AND r.state IN('failed','quarantined')
          AND r.completed_at<NOW()-INTERVAL '5 minutes' AND s.deleted_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM memory_session_tombstones t WHERE t.installation_id=e.installation_id AND t.session_id=e.session_id)
          AND NOT EXISTS(SELECT 1 FROM memory_extraction_runs newer WHERE newer.installation_id=r.installation_id
            AND newer.episode_id=r.episode_id AND newer.episode_source_digest=r.episode_source_digest
            AND (newer.started_at,newer.run_id)>(r.started_at,r.run_id))
        LIMIT 1001
      ) current_failures
    ) unresolved ON TRUE
    WHERE i.relay_status IN ('pending', 'active', 'paused')
  `)
  return result.rows
}

export function summarizeBusinessHealth(rows: BusinessHealthRow[], enabled = true) {
  const health = rows.map(row => evaluateBusinessHealth(row, enabled))
  const reasons = BUSINESS_HEALTH_REASONS.filter(reason => health.some(item => item.reasons.includes(reason)))
  const degraded = health.some(item => ['error', 'degraded'].includes(item.state))
  return {status: degraded ? 'degraded' : 'ready', readiness: 'ready',
    operational: {status: degraded ? 'degraded' : 'healthy', reasons,
      evidence_gaps: rows.reduce((sum, row) => sum + Number(row.evidence_gaps ?? 0), 0),
      failed_extractions_24h: rows.reduce((sum,row)=>sum+Number(row.failed_extractions_24h??0),0),
      quarantined_extractions_24h: rows.reduce((sum,row)=>sum+Number(row.quarantined_extractions_24h??0),0),
      uncertain_extractions_24h: rows.reduce((sum,row)=>sum+Number(row.uncertain_extractions_24h??0),0),
      unresolved_count_capped: rows.some(row=>Number(row.unresolved_extractions??0)>=1001),
      unresolved_extractions: rows.reduce((sum,row)=>sum+Number(row.unresolved_extractions??0),0)}}
}


/** Reservations lack installation ownership: report once for the provider pool,
 * never copy these counters onto each installation. Ignore active requests and
 * previous daily windows; retained uncertain reservations still occupy today's cap. */
export async function loadBudgetUncertainty(pool: HealthPool) {
  const result=await queryHealth(pool,`SELECT COUNT(*)::text requests,
    COALESCE(SUM(reserved_input_tokens),0)::text input_tokens,
    COALESCE(SUM(reserved_output_tokens),0)::text output_tokens
    FROM memory_provider_budget_reservations WHERE provider_kind='text' AND state='reserved'
      AND created_at >= date_trunc('day',NOW() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
      AND created_at < NOW()-INTERVAL '5 minutes'`)
  const row=result.rows[0]
  return {scope:'provider_pool' as const,window:'current_shanghai_day' as const,
    aged_reserved_requests:Number(row?.requests??0),reserved_input_tokens:Number(row?.input_tokens??0),reserved_output_tokens:Number(row?.output_tokens??0)}
}
