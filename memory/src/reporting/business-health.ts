import type pg from 'pg'

export const BUSINESS_HEALTH_REASONS = ['feed_stalled', 'budget_blocked', 'extraction_stalled', 'evidence_gap'] as const
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
  if (active && Number(row.evidence_gaps) > 0) reasons.push('evidence_gap')
  const integrity = row.local_status === 'integrity_error'
  const state = integrity ? 'error' : reasons.length || row.local_status === 'degraded' ? 'degraded'
    : row.local_status === 'ready' ? 'ready' : 'syncing'
  return {state, reasons, primaryError: integrity ? row.last_error_code ?? 'integrity_error'
    : reasons[0] ?? row.last_error_code ?? undefined}
}

/** No source text, identity labels or arbitrary exception messages escape this query. */
export async function loadBusinessHealth(pool: Pick<pg.Pool, 'query'>): Promise<BusinessHealthRow[]> {
  const result = await pool.query<BusinessHealthRow>(`
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
      evidence_gaps: rows.reduce((sum, row) => sum + Number(row.evidence_gaps ?? 0), 0)}}
}
