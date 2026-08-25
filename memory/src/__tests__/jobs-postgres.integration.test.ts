import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import {
  createJobRepository,
  retryDelayMs,
} from '../jobs/repository.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = '11111111-1111-1111-1111-111111111111'

describe('job retry ladder (unit)', () => {
  test('matches the frozen 1s/5s/15s/45s/5min ladder', () => {
    expect(retryDelayMs(1)).toBe(1_000)
    expect(retryDelayMs(2)).toBe(5_000)
    expect(retryDelayMs(3)).toBe(15_000)
    expect(retryDelayMs(4)).toBe(45_000)
    expect(retryDelayMs(5)).toBe(300_000)
    expect(retryDelayMs(11)).toBe(300_000)
  })
})

describeWithDatabase('fenced background jobs (PostgreSQL)', () => {
  let pool: pg.Pool
  let jobs: ReturnType<typeof createJobRepository>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    jobs = createJobRepository(pool)
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_jobs, memory_dead_letters, memory_installations RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
    `, [INSTALLATION])
  })

  test('enqueue is idempotent on installation, type and key', async () => {
    await jobs.enqueueJob({
      installationId: INSTALLATION, jobType: 'project_feed', idempotencyKey: 'feed:101', priority: 50,
    })
    await jobs.enqueueJob({
      installationId: INSTALLATION, jobType: 'project_feed', idempotencyKey: 'feed:101', priority: 50,
    })
    const count = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM memory_jobs`)
    expect(Number(count.rows[0].count)).toBe(1)
  })

  test('phase one job types enqueue with their frozen default priorities', async () => {
    await jobs.enqueueJob({
      installationId: INSTALLATION, jobType: 'extract_candidates', idempotencyKey: 'extract:1',
    })
    await jobs.enqueueJob({
      installationId: INSTALLATION, jobType: 'index_claim_version', idempotencyKey: 'index:1',
    })
    await jobs.enqueueJob({
      installationId: INSTALLATION, jobType: 'rebuild_claim_index', idempotencyKey: 'rebuild:1',
    })
    await jobs.enqueueJob({
      installationId: INSTALLATION, jobType: 'expire_claims', idempotencyKey: 'expire:1',
    })
    const priorities = await pool.query<{ job_type: string; priority: number }>(`
      SELECT job_type, priority FROM memory_jobs
      WHERE job_type IN ('extract_candidates','index_claim_version','rebuild_claim_index','expire_claims')
      ORDER BY job_type
    `)
    expect(Object.fromEntries(priorities.rows.map(row => [row.job_type, row.priority]))).toEqual({
      extract_candidates: 85,
      index_claim_version: 90,
      rebuild_claim_index: 95,
      expire_claims: 95,
    })
  })

  test('claims respect priority order with SKIP LOCKED across connections', async () => {
    await jobs.enqueueJob({
      installationId: INSTALLATION, jobType: 'project_feed', idempotencyKey: 'projection', priority: 50,
    })
    await jobs.enqueueJob({
      installationId: INSTALLATION, jobType: 'installation_purge', idempotencyKey: 'purge', priority: 0,
    })
    await jobs.enqueueJob({
      installationId: INSTALLATION, jobType: 'compile_episode', idempotencyKey: 'episode', priority: 80,
    })

    const first = await jobs.claimJobs({ workerId: 'w1', limit: 1, leaseMs: 60_000 })
    expect(first).toHaveLength(1)
    expect(first[0].job_type).toBe('installation_purge')

    // A concurrent connection sees the locked row skipped, not blocked.
    const second = await jobs.claimJobs({ workerId: 'w2', limit: 1, leaseMs: 60_000 })
    expect(second).toHaveLength(1)
    expect(second[0].job_type).toBe('project_feed')
  })

  test('expired running jobs are reclaimed with a bumped claim epoch', async () => {
    await jobs.enqueueJob({
      installationId: INSTALLATION, jobType: 'project_feed', idempotencyKey: 'feed:1', priority: 50,
    })
    const first = await jobs.claimJobs({ workerId: 'w1', limit: 1, leaseMs: 10 })
    expect(first).toHaveLength(1)
    const originalEpoch = first[0].claim_epoch

    await new Promise(resolve => setTimeout(resolve, 30))

    const reclaimed = await jobs.claimJobs({ workerId: 'w2', limit: 1, leaseMs: 60_000 })
    expect(reclaimed).toHaveLength(1)
    expect(reclaimed[0].job_id).toBe(first[0].job_id)
    expect(reclaimed[0].claim_epoch).toBeGreaterThan(originalEpoch)

    // The stale worker cannot complete a job the new worker owns.
    const stale = await jobs.completeJob({
      jobId: first[0].job_id, claimedBy: 'w1', claimEpoch: originalEpoch,
    })
    expect(stale).toBe(false)
    const state = await pool.query<{ state: string; claimed_by: string | null }>(
      `SELECT state, claimed_by FROM memory_jobs WHERE job_id = $1`,
      [first[0].job_id],
    )
    expect(state.rows[0].state).toBe('running')
    expect(state.rows[0].claimed_by).toBe('w2')
  })

  test('renewClaims extends the lease of the caller only', async () => {
    await jobs.enqueueJob({
      installationId: INSTALLATION, jobType: 'project_feed', idempotencyKey: 'feed:2', priority: 50,
    })
    await jobs.enqueueJob({
      installationId: INSTALLATION, jobType: 'project_feed', idempotencyKey: 'feed:3', priority: 50,
    })
    await jobs.claimJobs({ workerId: 'w1', limit: 2, leaseMs: 60_000 })
    const renewed = await jobs.renewClaims({ workerId: 'w1', leaseMs: 60_000 })
    expect(renewed).toBe(2)
  })

  test('reschedules with the bounded ladder and dead-letters at attempt 12', async () => {
    await jobs.enqueueJob({
      installationId: INSTALLATION, jobType: 'project_feed', idempotencyKey: 'feed:poison', priority: 50,
    })
    let claimEpoch = 0
    let jobId = ''
    // Fail the job eleven times: attempts 1..11 reschedule, attempt 12 dies.
    for (let attempt = 1; attempt <= 11; attempt++) {
      const [claimed] = await jobs.claimJobs({ workerId: 'w1', limit: 1, leaseMs: 60_000 })
      expect(claimed).toBeDefined()
      jobId = claimed.job_id
      claimEpoch = claimed.claim_epoch
      await jobs.rescheduleJob({
        jobId, claimedBy: 'w1', claimEpoch, errorCode: 'projection_backlog',
      })
      // Make the retry immediately available for the next loop iteration.
      await pool.query(`UPDATE memory_jobs SET available_at = NOW() WHERE job_id = $1`, [jobId])
    }
    const pending = await pool.query<{ attempts: number; state: string }>(
      `SELECT attempts, state FROM memory_jobs WHERE job_id = $1`, [jobId],
    )
    expect(pending.rows[0].attempts).toBe(11)
    expect(pending.rows[0].state).toBe('pending')

    const [final] = await jobs.claimJobs({ workerId: 'w1', limit: 1, leaseMs: 60_000 })
    const dead = await jobs.rescheduleJob({
      jobId: final.job_id, claimedBy: 'w1', claimEpoch: final.claim_epoch, errorCode: 'projection_backlog',
    })
    expect(dead).toBe(true)

    const job = await pool.query<{ state: string }>(`SELECT state FROM memory_jobs WHERE job_id = $1`, [jobId])
    expect(job.rows[0].state).toBe('dead')

    const letters = await pool.query<{
      job_type: string
      attempts: number
      error_code: string
      payload_hash: Buffer
      payload_present: boolean
    }>(`
      SELECT d.job_type, d.attempts, d.error_code, d.payload_hash,
             (SELECT COUNT(*)::int FROM information_schema.columns
              WHERE table_name = 'memory_dead_letters' AND column_name = 'payload') > 0 AS payload_present
      FROM memory_dead_letters d WHERE d.job_id = $1
    `, [jobId])
    expect(letters.rows).toHaveLength(1)
    expect(letters.rows[0].job_type).toBe('project_feed')
    expect(letters.rows[0].attempts).toBe(12)
    expect(letters.rows[0].error_code).toBe('projection_backlog')
    expect(letters.rows[0].payload_hash.length).toBeGreaterThan(0)
    // The DLQ never carries the payload itself.
    expect(letters.rows[0].payload_present).toBe(false)
  })

  test('available_at gates claiming until the retry delay elapses', async () => {
    await jobs.enqueueJob({
      installationId: INSTALLATION, jobType: 'project_feed', idempotencyKey: 'feed:delayed', priority: 50,
      // Backdated so the first claim cannot race a client-vs-server clock
      // skew; the gating semantics are asserted below via the reschedule.
      availableAt: new Date(Date.now() - 60_000),
    })
    const [claimed] = await jobs.claimJobs({ workerId: 'w1', limit: 1, leaseMs: 60_000 })
    await jobs.rescheduleJob({
      jobId: claimed.job_id, claimedBy: 'w1', claimEpoch: claimed.claim_epoch, errorCode: 'projection_backlog',
    })
    // Attempt 1 backs off one second; an immediate claim finds nothing.
    const immediate = await jobs.claimJobs({ workerId: 'w2', limit: 5, leaseMs: 60_000 })
    expect(immediate).toHaveLength(0)
    await pool.query(`UPDATE memory_jobs SET available_at = NOW() - INTERVAL '1 second'`)
    const ready = await jobs.claimJobs({ workerId: 'w2', limit: 5, leaseMs: 60_000 })
    expect(ready).toHaveLength(1)
  })
})
