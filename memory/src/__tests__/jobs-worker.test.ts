import { describe, expect, test } from 'vitest'
import { createJobWorker, type JobWorkerOptions } from '../jobs/worker.js'
import type { JobRepository } from '../jobs/repository.js'
import type { JobClaim, JobFence } from '../jobs/types.js'

function claim(overrides: Partial<JobClaim> = {}): JobClaim {
  return {
    job_id: 'job-1',
    installation_id: '11111111-1111-1111-1111-111111111111',
    job_type: 'compile_episode',
    idempotency_key: 'compile_episode:turn-1',
    payload: {},
    attempts: 1,
    claim_epoch: 1,
    ...overrides,
  }
}

interface RenewCall { jobId: string; claimedBy: string; claimEpoch: number; leaseMs: number }

function fakeJobs(claims: JobClaim[], behavior: {
  renewResult?: (call: RenewCall) => boolean | Error
} = {}): { jobs: JobRepository; renewCalls: RenewCall[] } {
  const renewCalls: RenewCall[] = []
  const jobs = {
    enqueueJob: async () => undefined,
    claimJobs: async () => {
      const batch = claims
      claims = []
      return batch
    },
    renewClaim: async (input: { jobId: string; claimedBy: string; claimEpoch: number; leaseMs: number }) => {
      const call: RenewCall = { ...input }
      renewCalls.push(call)
      const result = behavior.renewResult?.(call) ?? true
      if (result instanceof Error) throw result
      return result
    },
    completeJob: async () => true,
    rescheduleJob: async () => false,
  } as unknown as JobRepository
  return { jobs, renewCalls }
}

function workerOptions(overrides: Partial<JobWorkerOptions> = {}): JobWorkerOptions {
  const signal = new AbortController().signal
  return {
    pool: {} as JobWorkerOptions['pool'],
    jobs: undefined as unknown as JobRepository,
    workerId: 'worker-1',
    signal,
    pollIntervalMs: 20,
    leaseMs: 150,
    ...overrides,
  }
}

describe('job worker per-claim lease renewal', () => {
  test('renews each in-flight claim individually with its own fence', async () => {
    const first = claim({ job_id: 'job-a', claim_epoch: 3 })
    const { jobs, renewCalls } = fakeJobs([first])
    const options = workerOptions({ jobs })
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const worker = createJobWorker(options)
    worker.register('compile_episode', async () => {
      await gate
    })
    worker.start()
    await new Promise(resolve => setTimeout(resolve, 400))
    release()
    const outcome = await worker.stop()
    expect(outcome).toBe('drained')
    expect(renewCalls.length).toBeGreaterThanOrEqual(1)
    for (const call of renewCalls) {
      expect(call.jobId).toBe('job-a')
      expect(call.claimedBy).toBe('worker-1')
      expect(call.claimEpoch).toBe(3)
      expect(call.leaseMs).toBe(150)
    }
  })

  test('stops renewing after stop() and does not renew while idle', async () => {
    const { jobs, renewCalls } = fakeJobs([])
    const options = workerOptions({ jobs })
    const worker = createJobWorker(options)
    worker.register('compile_episode', async () => undefined)
    worker.start()
    await new Promise(resolve => setTimeout(resolve, 100))
    await worker.stop()
    const count = renewCalls.length
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(renewCalls.length).toBe(count)
  })

  test('renewal loss aborts only the affected claim, not its neighbours', async () => {
    const lost = claim({ job_id: 'job-lost', claim_epoch: 1 })
    const kept = claim({ job_id: 'job-kept', claim_epoch: 7 })
    const { jobs } = fakeJobs([lost, kept], {
      renewResult: call => call.jobId !== 'job-lost',
    })
    const options = workerOptions({ jobs })
    const signals = new Map<string, AbortSignal>()
    let releaseKept!: () => void
    const keptGate = new Promise<void>(resolve => {
      releaseKept = resolve
    })
    const worker = createJobWorker(options)
    worker.register('compile_episode', async (job, signal) => {
      signals.set(job.job_id, signal)
      // Both handlers stay in flight so the renewal tick observes both.
      if (job.job_id === 'job-kept') await keptGate
      else await new Promise<void>(resolve => {
        if (signal.aborted) resolve()
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    })
    worker.start()
    // Wait for a renewal tick to observe the loss and abort job-lost.
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(signals.get('job-lost')?.aborted).toBe(true)
    expect(signals.get('job-kept')?.aborted).toBe(false)
    releaseKept()
    const outcome = await worker.stop()
    expect(outcome).toBe('drained')
  })

  test('a renewal error aborts that claim immediately', async () => {
    const only = claim({ job_id: 'job-x', claim_epoch: 2 })
    const { jobs } = fakeJobs([only], {
      renewResult: () => new Error('connection refused'),
    })
    const options = workerOptions({ jobs })
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const worker = createJobWorker(options)
    let observedAbort = false
    worker.register('compile_episode', async (_job, signal) => {
      await new Promise<void>(resolve => {
        if (signal.aborted) {
          observedAbort = true
          resolve()
        } else {
          signal.addEventListener('abort', () => {
            observedAbort = true
            resolve()
          }, { once: true })
        }
      })
      await gate
    })
    worker.start()
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(observedAbort).toBe(true)
    release()
    await worker.stop()
  })

  test('handlers receive a job fence bound to claim epoch and worker id', async () => {
    const target = claim({ job_id: 'job-f', claim_epoch: 9 })
    const { jobs } = fakeJobs([target])
    const options = workerOptions({ jobs })
    const fences: JobFence[] = []
    const worker = createJobWorker(options)
    worker.register('compile_episode', async (_job, _signal, ctx) => {
      if (ctx) fences.push(ctx.fence)
    })
    worker.start()
    // Let the first poll tick dispatch before stopping.
    await new Promise(resolve => setTimeout(resolve, 60))
    await worker.stop()
    expect(fences).toEqual([{ jobId: 'job-f', claimedBy: 'worker-1', claimEpoch: 9 }])
  })
})
