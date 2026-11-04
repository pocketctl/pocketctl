import type pg from 'pg'
import type { SessionLifecycleConfig } from './types.js'
import { maintenanceSlot, nextMaintenanceAt } from './schedule.js'

const ALERT_SECONDS = 2 * 3600
/** Ledger-only diagnostics. Global scan timing is public policy metadata;
 * job and delivery counts are strictly scoped to the authenticated user. */
export async function lifecycleOperationalStatus(
  db: Pick<pg.Pool, 'query'>, config: SessionLifecycleConfig, userId: number, now = new Date(),
) {
  const scans = []
  for (const action of ['archive', 'purge'] as const) {
    const expected = maintenanceSlot(action, now)
    const enabled = config.mode === 'enforce' && config.effectiveAt !== null && new Date(config.effectiveAt) <= expected
    const rows = (await db.query(`SELECT scheduled_at,started_at,completed_at,scan_complete
      FROM session_lifecycle_daily_runs WHERE policy_version=$1 AND action=$2
      AND (scheduled_at=$3 OR (completed_at IS NULL AND scheduled_at<=$3))
      ORDER BY scheduled_at LIMIT 1`, [config.policyVersion, action, expected])).rows
    const row = rows[0]
    const overdue = enabled && (!row?.completed_at) &&
      now.getTime() - new Date(row?.scheduled_at ?? expected).getTime() >= ALERT_SECONDS * 1000
    scans.push({ action, expected_at: expected.toISOString(), next_at: nextMaintenanceAt(action, now).toISOString(),
      scheduled_at: row?.scheduled_at ?? null, started_at: row?.started_at ?? null,
      scan_complete: row?.scan_complete ?? false, completed_at: row?.completed_at ?? null,
      state: !enabled ? 'not_scheduled' : !row ? 'awaiting_start' : row.completed_at ? 'completed' : 'in_progress', overdue })
  }
  const jobs = (await db.query(`SELECT count(*)::int AS pending,
    count(*) FILTER(WHERE state='failed')::int AS failed,
    count(*) FILTER(WHERE state='partial')::int AS partial,
    EXTRACT(EPOCH FROM ($2::timestamptz-min(created_at)))::int AS oldest_age_seconds
    FROM session_lifecycle_jobs WHERE user_id=$1 AND state IN ('queued','running','partial','failed')`, [userId, now])).rows[0]
  const notifications = (await db.query(`SELECT count(*)::int AS pending,
    EXTRACT(EPOCH FROM ($2::timestamptz-min(o.created_at)))::int AS oldest_age_seconds
    FROM notification_delivery_outbox o JOIN attention_notifications n USING(notification_id)
    WHERE o.user_id=$1 AND n.user_id=$1 AND n.maintenance_day IS NOT NULL AND o.delivered_at IS NULL`, [userId, now])).rows[0]
  const summaries = (await db.query(`SELECT count(*)::int AS pending,
    EXTRACT(EPOCH FROM ($2::timestamptz-min(created_at)))::int AS oldest_age_seconds
    FROM attention_notifications WHERE user_id=$1 AND maintenance_day IS NOT NULL AND expires_at>$2
      AND (published_at IS NULL OR maintenance_summary->>'state'='partial')`, [userId, now])).rows[0]
  const alerts: string[] = []
  if (scans.some(scan => scan.overdue)) alerts.push('scheduled_scan_overdue')
  if (Number(jobs?.oldest_age_seconds ?? 0) >= ALERT_SECONDS) alerts.push('job_backlog_overdue')
  if (Number(notifications?.oldest_age_seconds ?? 0) >= ALERT_SECONDS) alerts.push('notification_delivery_overdue')
  if (Number(summaries?.oldest_age_seconds ?? 0) >= ALERT_SECONDS) alerts.push('maintenance_summary_overdue')
  return { scope: 'global_scan_and_current_user_backlogs', alert_after_seconds: ALERT_SECONDS,
    scans, jobs, summaries, notification_delivery: notifications, alerts }
}
