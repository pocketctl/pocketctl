import { randomUUID } from 'node:crypto'
import type pg from 'pg'

export interface ScanLease {
  policyVersion: string
  token: string
  afterRowId: number
}

/** Shared across process IDs. A lost/expired page may be repeated; enqueue is
 * idempotent and final execution still checks the session's epoch and fences. */
export class LifecycleScanProgress {
  constructor(private readonly db: Pick<pg.Pool, 'query'>) {}

  async claim(policyVersion: string, leaseMs: number, force = false): Promise<ScanLease | null> {
    const token = randomUUID()
    const result = await this.db.query(`INSERT INTO session_lifecycle_scan_state AS s
      (policy_version,lease_token,lease_until) VALUES($1,$2,NOW()+($3::int*interval '1 millisecond'))
      ON CONFLICT(policy_version) DO UPDATE SET lease_token=EXCLUDED.lease_token,
        lease_until=EXCLUDED.lease_until,updated_at=NOW()
      WHERE (s.lease_until IS NULL OR s.lease_until<=NOW()) AND ($4::boolean OR s.next_scan_at<=NOW())
      RETURNING after_row_id::text`, [policyVersion, token, leaseMs, force])
    return result.rows[0] ? { policyVersion, token, afterRowId: Number(result.rows[0].after_row_id) } : null
  }

  async finish(lease: ScanLease, afterRowId: number, delayMs: number): Promise<boolean> {
    const result = await this.db.query(`UPDATE session_lifecycle_scan_state
      SET after_row_id=$3,next_scan_at=NOW()+($4::int*interval '1 millisecond'),
        lease_token=NULL,lease_until=NULL,updated_at=NOW()
      WHERE policy_version=$1 AND lease_token=$2 AND lease_until>NOW() RETURNING policy_version`,
    [lease.policyVersion, lease.token, afterRowId, delayMs])
    return Boolean(result.rows[0])
  }

  /** Wake for either another scan page or durable work becoming retryable.
   * Backlog never spins: every pass has a minimum delay and its own budgets. */
  async nextDelay(policyVersion: string, minimumMs: number, sweepIntervalMs: number): Promise<number> {
    const result = await this.db.query(`SELECT EXTRACT(EPOCH FROM (LEAST(
      (SELECT GREATEST(next_scan_at,COALESCE(lease_until,NOW())) FROM session_lifecycle_scan_state WHERE policy_version=$1),
      (SELECT min(CASE WHEN state='running' THEN lease_until ELSE next_attempt_at END)
        FROM session_lifecycle_jobs WHERE policy_version=$1 AND state IN ('queued','failed','partial','running')
          AND NOT EXISTS(SELECT 1 FROM session_lifecycle_deletions d WHERE d.operation_id=session_lifecycle_jobs.operation_id))
      )-NOW()))*1000 AS delay_ms`, [policyVersion])
    const delay = result.rows[0]?.delay_ms
    return Math.min(sweepIntervalMs, Math.max(minimumMs, delay === null ? sweepIntervalMs : Number(delay)))
  }
}
