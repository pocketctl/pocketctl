import { describe, expect, test } from 'vitest'
import { createJobWorker, type JobWorkerOptions } from '../jobs/worker.js'
import type { JobRepository } from '../jobs/repository.js'
import type { JobClaim } from '../jobs/types.js'

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

function fakeJobs(claims: JobClaim[]): { jobs: JobRepository; renews: number[]; claims: JobClaim[] } {
  const state = { renews: [] as number[], claims }
  const jobs = {
    enqueueJob: async () => undefined,
    claimJobs: async () => {
      const batch = state.claims
      state.claims = []
      return batch
    },
    renewClaims: async (input: { workerId: string; leaseMs: number }) => {
      state.renews.push(input.leaseMs)
      return 1
    },
    completeJob: async () => true,
    rescheduleJob: async () => false,
  } as unknown as JobRepository
  return { jobs, renews: state.renews, claims: state.claims }
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

describe('job worker lease renewal', () => {
  test('renews claims while a handler runs past the lease interval', async () => {
    const { jobs, renews } = fakeJobs([claim()])
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
    // Handler still running well past leaseMs/3 → renewal must have fired.
    await new Promise(resolve => setTimeout(resolve, 400))
    release()
    const outcome = await worker.stop()
    expect(outcome).toBe('drained')
    expect(renews.length).toBeGreaterThanOrEqual(1)
    expect(renews.every(leaseMs => leaseMs === 150)).toBe(true)
  })

  test('stops renewing after stop() and does not renew while idle', async () => {
    const { jobs, renews } = fakeJobs([])
    const options = workerOptions({ jobs })
    const worker = createJobWorker(options)
    worker.register('compile_episode', async () => undefined)
    worker.start()
    await new Promise(resolve => setTimeout(resolve, 100))
    await worker.stop()
    const count = renews.length
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(renews.length).toBe(count)
  })
})
