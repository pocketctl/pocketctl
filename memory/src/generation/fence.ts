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
  // Acquire ownership first, then read the wall clock after any row-lock wait.
  await client.query(`SELECT 1 FROM memory_jobs
    WHERE job_id=$1 AND claimed_by=$2 AND claim_epoch=$3 AND state='running' FOR UPDATE`,
    [fence.jobId,fence.claimedBy,fence.claimEpoch])
  const result=await client.query<{lease_until:string}>(`SELECT claim_expires_at::text AS lease_until
    FROM memory_jobs WHERE job_id=$1 AND claimed_by=$2 AND claim_epoch=$3
      AND state='running' AND claim_expires_at>clock_timestamp()`,
    [fence.jobId,fence.claimedBy,fence.claimEpoch])
  if(!result.rows[0])throw new StaleJobFenceError(fence)
  await client.query("SELECT set_config('pocketctl.job_fence',$1,true)",
    [JSON.stringify({...fence,leaseUntil:result.rows[0].lease_until})])
}

/** Explicit owned retry/cancel transition, still bounded by the original lease. */
export async function releaseJobFence(client:Pick<pg.PoolClient,'query'>,fence:JobFence,state:'pending'|'dead'):Promise<void>{
 const stamp=(await client.query("SELECT NULLIF(current_setting('pocketctl.job_fence',true),'')::jsonb stamp")).rows[0]?.stamp
 if(!stamp||stamp.jobId!==fence.jobId||stamp.claimedBy!==fence.claimedBy||String(stamp.claimEpoch)!==String(fence.claimEpoch))throw new StaleJobFenceError(fence)
 await client.query("SELECT set_config('pocketctl.job_fence',$1,true)",[JSON.stringify({...stamp,releaseState:state})])
}
