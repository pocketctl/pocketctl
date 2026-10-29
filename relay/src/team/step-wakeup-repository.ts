import { randomUUID } from 'node:crypto'
import type pg from 'pg'

export interface StepWakeupClaim {
  task_id: string
  generation: string
  lease_token: string
  lease_owner: string
}

export class StepWakeupLeaseLost extends Error {
  constructor() { super('step wakeup lease lost') }
}

/** Internal scheduler primitive, not a public authorization boundary or a second
 * dispatch channel. No worker is started by constructing this repository. */
export class StepWakeupRepository {
  constructor(private readonly pool: pg.Pool) {}

  async claim(teamIds: string[], leaseMs = 30_000): Promise<StepWakeupClaim | null> {
    if (!Array.isArray(teamIds) || teamIds.length > 100 || teamIds.some(id => !/^[a-zA-Z0-9_-]{1,128}$/.test(id))) throw new Error('invalid wakeup Team allowlist')
    if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 60_000) throw new Error('invalid wakeup lease duration')
    if (!teamIds.length) return null
    const result = await this.pool.query<StepWakeupClaim>(`WITH candidate AS (
        SELECT q.task_id FROM team_step_wakeups q
        JOIN team_tasks t ON t.task_id=q.task_id AND t.state IN ('open','in_progress')
        JOIN collaboration_teams team ON team.team_id=t.team_id AND team.state='active'
        WHERE t.team_id=ANY($1::text[]) AND q.generation>q.acknowledged_generation
          AND q.available_at<=clock_timestamp() AND (q.lease_until IS NULL OR q.lease_until<=clock_timestamp())
        ORDER BY q.available_at,q.task_id LIMIT 1 FOR UPDATE OF q SKIP LOCKED
      ) UPDATE team_step_wakeups q SET lease_owner=$2,lease_token=lease_token+1,
        lease_until=clock_timestamp()+$3*interval '1 millisecond',updated_at=clock_timestamp()
      FROM candidate c WHERE q.task_id=c.task_id RETURNING q.task_id,q.generation,q.lease_token,q.lease_owner`, [teamIds, randomUUID(), leaseMs])
    return result.rows[0] ?? null
  }

  /** The callback must reauthorize/recheck plan, pause, dependencies and budgets,
   * lock domain rows in their existing order, and write ONLY database effects
   * through this client. Existing dispatch sends committed intents later.
   * Fence is checked again in the same commit; stale work rolls back completely.
   * Do not lock the queue before domain rows: producers lock Call/Task first. */
  async processClaim<T>(claim: StepWakeupClaim, apply: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const valid = (await client.query(`SELECT 1 FROM team_step_wakeups WHERE task_id=$1 AND lease_owner=$2 AND lease_token=$3
        AND generation>=$4 AND acknowledged_generation<$4 AND lease_until>clock_timestamp()`, this.parameters(claim))).rows[0]
      if (!valid) throw new StepWakeupLeaseLost()
      const result = await apply(client)
      const settled = await client.query(`UPDATE team_step_wakeups SET acknowledged_generation=$4,lease_owner=NULL,lease_until=NULL,
        last_error_code=NULL,updated_at=clock_timestamp() WHERE task_id=$1 AND lease_owner=$2 AND lease_token=$3
        AND generation>=$4 AND acknowledged_generation<$4 AND lease_until>clock_timestamp()`, this.parameters(claim))
      if (settled.rowCount !== 1) throw new StepWakeupLeaseLost()
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
  }

  async retry(claim: StepWakeupClaim, errorCode: 'retry_pending' | 'authorization_changed' | 'dependency_unavailable' | 'budget_exhausted', delayMs = 1000): Promise<boolean> {
    if (!['retry_pending','authorization_changed','dependency_unavailable','budget_exhausted'].includes(errorCode)
      || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) throw new Error('invalid wakeup retry')
    const result = await this.pool.query(`UPDATE team_step_wakeups SET lease_owner=NULL,lease_until=NULL,last_error_code=$5,
      available_at=CASE WHEN generation>$4 THEN clock_timestamp() ELSE clock_timestamp()+$6*interval '1 millisecond' END,
      updated_at=clock_timestamp() WHERE task_id=$1 AND lease_owner=$2 AND lease_token=$3 AND acknowledged_generation<$4
        AND lease_until>clock_timestamp()`, [...this.parameters(claim), errorCode, delayMs])
    return result.rowCount === 1
  }

  private parameters(claim: StepWakeupClaim): [string, string, string, string] {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(claim.task_id) || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(claim.lease_owner)
      || !/^[1-9][0-9]{0,18}$/.test(claim.lease_token) || !/^[1-9][0-9]{0,18}$/.test(claim.generation)) throw new Error('invalid wakeup claim')
    return [claim.task_id, claim.lease_owner, claim.lease_token, claim.generation]
  }
}
