import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { SessionLifecycleConfig } from './types.js'

export type MaintenanceAction = 'archive' | 'purge'
const DAY = 86_400_000
const OFFSET = 8 * 3_600_000
export const maintenanceHours = { archive: 3, purge: 3 } as const

/** Fixed Asia/Shanghai civil time; each action has one durable run per day. */
export function maintenanceSlot(action: MaintenanceAction, now: Date): Date {
  const local = new Date(now.getTime() + OFFSET)
  let slot = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), maintenanceHours[action]) - OFFSET
  if (slot > now.getTime()) slot -= DAY
  return new Date(slot)
}
export function nextMaintenanceAt(action: MaintenanceAction, now: Date): Date {
  return new Date(maintenanceSlot(action, now).getTime() + DAY)
}
export interface MaintenanceRun {
  policyVersion: string
  action: MaintenanceAction
  scheduledAt: Date
  token: string
  afterRowId: number
  scanComplete: boolean
}
export class DailyMaintenanceSchedule {
  constructor(private readonly db: Pick<pg.Pool, 'query'>) {}
  async claim(config: SessionLifecycleConfig, now = new Date()): Promise<MaintenanceRun | null> {
    for (const action of ['archive', 'purge'] as const) {
      const slot = maintenanceSlot(action, now)
      if (config.effectiveAt && slot.getTime() < new Date(config.effectiveAt).getTime()) continue
      await this.db.query(`INSERT INTO session_lifecycle_daily_runs(policy_version,action,scheduled_at)
        VALUES($1,$2,$3) ON CONFLICT(policy_version,action,scheduled_at) DO UPDATE
        SET completed_at=NULL,updated_at=NOW()
        WHERE $2='archive' AND session_lifecycle_daily_runs.completed_at IS NOT NULL
          AND EXISTS(SELECT 1 FROM session_lifecycle_jobs j WHERE j.policy_version=$1
            AND j.action IN ('archive','cool') AND j.state='partial'
            AND j.result->>'reason'='transfer_budget_reached'
            AND j.created_at<=session_lifecycle_daily_runs.completed_at)`, [config.policyVersion, action, slot])
    }
    const token = randomUUID()
    const row = (await this.db.query(`WITH candidate AS (
      SELECT policy_version,action,scheduled_at FROM session_lifecycle_daily_runs r
      WHERE policy_version=$1 AND completed_at IS NULL AND scheduled_at<=$2
        AND (lease_until IS NULL OR lease_until<=NOW())
      ORDER BY scheduled_at,CASE WHEN action='archive' THEN 0 ELSE 1 END FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE session_lifecycle_daily_runs r SET started_at=COALESCE(r.started_at,NOW()),lease_token=$3,lease_until=NOW()+($4::int*interval '1 millisecond'),updated_at=NOW()
      FROM candidate c WHERE r.policy_version=c.policy_version AND r.action=c.action AND r.scheduled_at=c.scheduled_at
      RETURNING r.*`, [config.policyVersion, now, token, config.runBudgetMs + 120_000])).rows[0]
    return row ? { policyVersion: row.policy_version, action: row.action, scheduledAt: row.scheduled_at,
      token, afterRowId: Number(row.after_row_id), scanComplete: row.scan_complete } : null
  }
  async finish(run: MaintenanceRun, afterRowId: number, scanComplete: boolean, completed: boolean): Promise<boolean> {
    return Boolean((await this.db.query(`UPDATE session_lifecycle_daily_runs
      SET after_row_id=$5,scan_complete=$6,completed_at=CASE WHEN $7 THEN NOW() ELSE NULL END,
        lease_token=NULL,lease_until=NULL,updated_at=NOW()
      WHERE policy_version=$1 AND action=$2 AND scheduled_at=$3 AND lease_token=$4 AND lease_until>NOW()
      RETURNING action`, [run.policyVersion, run.action, run.scheduledAt, run.token, afterRowId, scanComplete, completed])).rows[0])
  }
}
