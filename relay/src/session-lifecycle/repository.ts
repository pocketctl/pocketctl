import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { LifecycleAction, LifecycleJobState } from './types.js'

export interface LifecycleJob {
  operationId: string
  userId: number
  sessionId: string
  action: LifecycleAction
  policyVersion: string
  activityEpoch: string
  state: LifecycleJobState
  attempt: number
  leaseOwner: string | null
  leaseToken: string | null
}
function job(row: any): LifecycleJob {
  return {
    operationId: row.operation_id,
    userId: row.user_id,
    sessionId: row.session_id,
    action: row.action,
    policyVersion: row.policy_version,
    activityEpoch: String(row.activity_epoch),
    state: row.state,
    attempt: row.attempt,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
  }
}
function milliseconds(value: number, maximum = 600_000): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new Error('invalid lifecycle duration')
  return value
}

/** Durable scheduling primitives; callers still must fence/re-authorize execution. */
export class LifecycleJobRepository {
  constructor(private readonly pool: Pick<pg.Pool, 'query'>) {}

  async enqueue(input: {
    userId: number
    sessionId: string
    action: LifecycleAction
    policyVersion: string
    activityEpoch: string
  }): Promise<LifecycleJob> {
    if (!/^\d+$/.test(input.activityEpoch))
      throw new Error('invalid lifecycle epoch')
    const result = await this.pool.query(
      `
      INSERT INTO session_lifecycle_jobs(operation_id,user_id,session_id,action,policy_version,activity_epoch)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(user_id,session_id,action,activity_epoch,policy_version)
      DO UPDATE SET operation_id=session_lifecycle_jobs.operation_id
      RETURNING *`,
      [
        randomUUID(),
        input.userId,
        input.sessionId,
        input.action,
        input.policyVersion,
        input.activityEpoch,
      ],
    )
    return job(result.rows[0])
  }

  async claim(owner: string, leaseMs: number): Promise<LifecycleJob | null> {
    if (!owner || owner.length > 128 || milliseconds(leaseMs) === 0)
      throw new Error('invalid lifecycle lease')
    const result = await this.pool.query(
      `
      WITH candidate AS (
        SELECT operation_id FROM session_lifecycle_jobs
        WHERE (state IN ('queued','failed','partial') AND next_attempt_at <= NOW()
          AND NOT EXISTS(SELECT 1 FROM session_lifecycle_deletions d WHERE d.operation_id=session_lifecycle_jobs.operation_id))
           OR (state='running' AND lease_until <= NOW())
        ORDER BY next_attempt_at, created_at, operation_id
        FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE session_lifecycle_jobs j
      SET state='running', lease_owner=$1, lease_token=$2,
          lease_until=NOW()+($3::bigint * interval '1 millisecond'),
          attempt=attempt+1, updated_at=NOW()
      FROM candidate WHERE j.operation_id=candidate.operation_id RETURNING j.*`,
      [owner, randomUUID(), leaseMs],
    )
    return result.rows[0] ? job(result.rows[0]) : null
  }

  async renew(lease: LifecycleJob, leaseMs: number): Promise<boolean> {
    if (milliseconds(leaseMs) === 0) throw new Error('invalid lifecycle lease')
    const result = await this.pool.query(
      `UPDATE session_lifecycle_jobs
      SET lease_until=NOW()+($5::bigint * interval '1 millisecond'),updated_at=NOW()
      WHERE operation_id=$1 AND state='running' AND lease_owner=$2 AND lease_token=$3
        AND attempt=$4 AND lease_until>NOW() RETURNING operation_id`,
      [
        lease.operationId,
        lease.leaseOwner,
        lease.leaseToken,
        lease.attempt,
        leaseMs,
      ],
    )
    return Boolean(result.rows[0])
  }

  /** Use a transaction-bound repository when coupling business results/notifications. */
  async finish(
    lease: LifecycleJob,
    state: Exclude<LifecycleJobState, 'queued' | 'running'>,
    result: Record<string, unknown>,
    retryMs = 60_000,
  ): Promise<boolean> {
    milliseconds(retryMs, 86_400_000)
    // Result is diagnostic metadata, never a copy of event/document payloads.
    const serialized = JSON.stringify(result)
    if (Buffer.byteLength(serialized) > 16_384)
      throw new Error('lifecycle result metadata too large')
    const updated = await this.pool.query(
      `UPDATE session_lifecycle_jobs
      SET state=$5,result=$6::jsonb,lease_owner=NULL,lease_token=NULL,lease_until=NULL,
          next_attempt_at=NOW()+($7::bigint * interval '1 millisecond'),updated_at=NOW()
      WHERE operation_id=$1 AND state='running' AND lease_owner=$2 AND lease_token=$3
        AND attempt=$4 AND lease_until>NOW() RETURNING operation_id`,
      [
        lease.operationId,
        lease.leaseOwner,
        lease.leaseToken,
        lease.attempt,
        state,
        serialized,
        retryMs,
      ],
    )
    return Boolean(updated.rows[0])
  }
}
