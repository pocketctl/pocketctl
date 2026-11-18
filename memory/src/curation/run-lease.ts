import type pg from 'pg'
import type {JobFence} from '../jobs/types.js'
import {createMemoryLogger} from '../logging.js'

const logger = createMemoryLogger('info')

// The job heartbeat fences the queue claim. A curation run also has its own
// epoch because a definite budget refusal can reopen that run under a new claim.
export function startCurationLeaseRenewal(pool: pg.Pool, installationId: string, runId: string,
  runEpoch: number, fence: JobFence, signal: AbortSignal) {
  let inFlight: Promise<void> | undefined
  const timer = setInterval(() => {
    if (signal.aborted || inFlight) return
    // Skip busy rows instead of waiting behind the result transaction. A later
    // tick can renew a live lease, but never revive one that already expired.
    inFlight = pool.query(`
      WITH owner AS MATERIALIZED (
        SELECT job_id FROM memory_jobs
        WHERE job_id=$1 AND installation_id=$4 AND job_type='consolidate_task'
          AND state='running' AND claimed_by=$2 AND claim_epoch=$3 AND claim_expires_at>clock_timestamp()
        FOR SHARE SKIP LOCKED
      ), owned_run AS MATERIALIZED (
        SELECT r.run_id FROM memory_curation_runs r JOIN owner ON owner.job_id::text=r.claimed_by
        WHERE r.installation_id=$4 AND r.run_id=$5 AND r.claim_epoch=$6 AND r.state='running'
        FOR UPDATE OF r SKIP LOCKED
      )
      UPDATE memory_curation_runs r SET claim_expires_at=clock_timestamp()+interval '5 minutes'
      FROM owned_run WHERE r.installation_id=$4 AND r.run_id=owned_run.run_id
        AND r.claim_expires_at>clock_timestamp()`,
      [fence.jobId, fence.claimedBy, fence.claimEpoch, installationId, runId, runEpoch])
      .then(() => {})
      .catch(() => logger.log('warn', 'curation_lease_renewal_failed', {}))
      .finally(() => { inFlight = undefined })
  }, 60_000)
  timer.unref()
  return async () => {
    clearInterval(timer)
    await inFlight
  }
}
