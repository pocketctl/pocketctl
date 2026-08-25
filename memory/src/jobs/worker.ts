import type pg from 'pg'
import type { JobClaim, JobType } from './types.js'
import type { JobRepository } from './repository.js'

export type JobHandler = (job: JobClaim, signal: AbortSignal) => Promise<void>

export interface JobWorkerOptions {
  pool: pg.Pool
  jobs: JobRepository
  workerId: string
  signal: AbortSignal
  pollIntervalMs?: number
  claimLimit?: number
  leaseMs?: number
  /** Bounded wait for in-flight handlers after abort (plan: 20s). */
  drainDeadlineMs?: number
  onError?(error: unknown, job?: JobClaim): void
}

const DEFAULT_CLAIM_LIMIT = 8
const DEFAULT_POLL_INTERVAL_MS = 500
const DEFAULT_DRAIN_MS = 20_000

/**
 * Claim/dispatch loop over the fenced job queue. On shutdown it stops
 * claiming immediately, waits up to the drain deadline for the in-flight
 * handler, then exits non-zero so the supervisor surfaces the interrupted
 * batch (the database stays consistent: unfinished claims expire and are
 * reclaimed with a bumped epoch).
 */
export function createJobWorker(options: JobWorkerOptions) {
  const handlers = new Map<JobType, JobHandler>()
  const claimLimit = options.claimLimit ?? DEFAULT_CLAIM_LIMIT
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
  const leaseMs = options.leaseMs ?? 30_000
  const drainDeadlineMs = options.drainDeadlineMs ?? DEFAULT_DRAIN_MS

  let timer: ReturnType<typeof setTimeout> | undefined
  let renewTimer: ReturnType<typeof setInterval> | undefined
  let stopped = false
  let inFlight: Array<Promise<void>> = []

  async function dispatch(claims: JobClaim[]): Promise<void> {
    await Promise.all(claims.map(async claim => {
      const handler = handlers.get(claim.job_type)
      if (!handler) {
        options.onError?.(new Error(`no handler for ${claim.job_type}`), claim)
        await options.jobs.rescheduleJob({
          jobId: claim.job_id,
          claimedBy: options.workerId,
          claimEpoch: claim.claim_epoch,
          errorCode: 'no_handler',
        })
        return
      }
      const controller = new AbortController()
      const abort = () => controller.abort()
      options.signal.addEventListener('abort', abort, { once: true })
      const run = (async () => {
        try {
          await handler(claim, controller.signal)
          await options.jobs.completeJob({
            jobId: claim.job_id, claimedBy: options.workerId, claimEpoch: claim.claim_epoch,
          })
        } catch (error) {
          options.onError?.(error, claim)
          await options.jobs.rescheduleJob({
            jobId: claim.job_id,
            claimedBy: options.workerId,
            claimEpoch: claim.claim_epoch,
            errorCode: boundedErrorCode(error),
          }).catch(() => undefined)
        } finally {
          options.signal.removeEventListener('abort', abort)
        }
      })()
      inFlight.push(run)
      try {
        await run
      } finally {
        inFlight = inFlight.filter(entry => entry !== run)
      }
    }))
  }

  function boundedErrorCode(error: unknown): string {
    const name = error instanceof Error ? error.name : 'unknown'
    return `handler_failed_${name}`.slice(0, 64)
  }

  async function tick(): Promise<void> {
    if (stopped || options.signal.aborted) return
    const claims = await options.jobs.claimJobs({
      workerId: options.workerId,
      limit: claimLimit,
      leaseMs,
    })
    if (claims.length > 0) await dispatch(claims)
  }

  function schedule(): void {
    if (stopped) return
    timer = setTimeout(() => {
      timer = undefined
      void tick()
        .catch(error => options.onError?.(error))
        .finally(() => schedule())
    }, pollIntervalMs)
    timer.unref?.()
  }

  /**
   * Lease renewal: without it, a handler that outlives its lease gets its job
   * reset to pending by the next claim pass and re-executed concurrently.
   * Renewal only runs while claims are actually in flight.
   */
  function startRenewal(): void {
    if (renewTimer) return
    renewTimer = setInterval(() => {
      if (stopped || options.signal.aborted || inFlight.length === 0) return
      void options.jobs.renewClaims({ workerId: options.workerId, leaseMs })
        .catch(error => options.onError?.(error))
    }, Math.max(250, Math.floor(leaseMs / 3)))
    renewTimer.unref?.()
  }

  return {
    register(jobType: JobType, handler: JobHandler): void {
      handlers.set(jobType, handler)
    },
    start(): void {
      if (stopped || options.signal.aborted) return
      schedule()
      startRenewal()
    },
    /** Stop claiming, wait (bounded) for in-flight handlers, report outcome. */
    async stop(): Promise<'drained' | 'deadline'> {
      stopped = true
      if (timer) clearTimeout(timer)
      if (renewTimer) clearInterval(renewTimer)
      renewTimer = undefined
      const deadline = Date.now() + drainDeadlineMs
      while (inFlight.length > 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      return inFlight.length === 0 ? 'drained' : 'deadline'
    },
    tick,
  }
}

export type JobWorker = ReturnType<typeof createJobWorker>
