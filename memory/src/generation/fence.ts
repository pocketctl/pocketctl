import type pg from 'pg'
import type { JobFence } from '../jobs/types.js'

/**
 * Generation ownership fence (ADR-P2-09): any transaction that persists
 * generation output (candidates, runs, packs) or enqueues follow-on work must
 * first re-check the owning job's `(job_id, claimed_by, claim_epoch)` triple
 * under lock. A worker whose lease was lost (epoch bumped by a reclaim) or
 * whose job was cancelled fails the assertion and its whole transaction rolls
 * back — no completion, no candidate write, no usage double-write, no
 * cascade.
 */
export class StaleJobFenceError extends Error {
  readonly code = 'stale_job_fence' as const

  constructor(fence: JobFence) {
    super(`job fence no longer owned: ${fence.jobId} epoch ${fence.claimEpoch}`)
    this.name = 'StaleJobFenceError'
  }
}

export async function assertJobFence(
  client: Pick<pg.PoolClient, 'query'>,
  fence: JobFence,
): Promise<void> {
  const result = await client.query(`
    SELECT 1 FROM memory_jobs
    WHERE job_id = $1 AND claimed_by = $2 AND claim_epoch = $3 AND state = 'running'
    FOR UPDATE
  `, [fence.jobId, fence.claimedBy, fence.claimEpoch])
  if ((result.rowCount ?? 0) === 0) throw new StaleJobFenceError(fence)
}
