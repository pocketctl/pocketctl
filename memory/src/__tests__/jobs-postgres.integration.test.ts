import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import {
  createJobRepository,
  retryDelayMs,
} from '../jobs/repository.js'
import { insertWikiCandidateFixture } from './helpers/phase4-wiki-fixture.js'

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

  // Task13 contract: budget waits use pending/available_at and do not spend
  // the ordinary failure retry allowance.
  async function deferBudget(input: {
    jobId: string; claimedBy: string; claimEpoch: number
    reason: 'budget_exceeded' | 'budget_unavailable'; availableAt: Date
  }): Promise<boolean> {
    const repository = jobs as unknown as {
      deferJob?: (request: typeof input) => Promise<boolean>
    }
    expect(repository.deferJob).toBeTypeOf('function')
    return repository.deferJob!(input)
  }

  test('budget deferral preserves failure attempts and gates the next claim', async () => {
    await jobs.enqueueJob({ installationId: INSTALLATION, jobType: 'extract_candidates', idempotencyKey: 'budget-wait' })
    await pool.query("UPDATE memory_jobs SET attempts=11 WHERE idempotency_key='budget-wait'")
    const [claim] = await jobs.claimJobs({ workerId: 'budget-worker', limit: 1, leaseMs: 60_000 })
    const availableAt = new Date(Date.now() + 3_600_000)
    await expect(deferBudget({ jobId: claim.job_id, claimedBy: 'budget-worker', claimEpoch: claim.claim_epoch,
      reason: 'budget_exceeded', availableAt })).resolves.toBe(true)
    const row = (await pool.query('SELECT state,attempts,available_at,last_error_code,claimed_by,completed_at FROM memory_jobs WHERE job_id=$1', [claim.job_id])).rows[0]
    expect(row).toMatchObject({ state: 'pending', attempts: 11, last_error_code: 'budget_exceeded', claimed_by: null, completed_at: null })
    expect(row.available_at.getTime()).toBe(availableAt.getTime())
    expect(await jobs.claimJobs({ workerId: 'next', limit: 1, leaseMs: 60_000 })).toEqual([])
    expect((await pool.query('SELECT count(*)::int n FROM memory_dead_letters')).rows[0].n).toBe(0)
    await pool.query('UPDATE memory_jobs SET available_at=NOW() WHERE job_id=$1', [claim.job_id])
    const [resumed] = await jobs.claimJobs({ workerId: 'next', limit: 1, leaseMs: 60_000 })
    expect(resumed.attempts).toBe(12)
    await expect(jobs.rescheduleJob({ jobId: resumed.job_id, claimedBy: 'next', claimEpoch: resumed.claim_epoch,
      errorCode: 'ordinary_failure' })).resolves.toBe(true)
  })

  test('a stale owner cannot defer a budget-wait job reclaimed by another worker', async () => {
    await jobs.enqueueJob({ installationId: INSTALLATION, jobType: 'extract_candidates', idempotencyKey: 'budget-stale' })
    const [first] = await jobs.claimJobs({ workerId: 'old', limit: 1, leaseMs: 60_000 })
    await pool.query("UPDATE memory_jobs SET claim_expires_at=NOW()-interval '1 second' WHERE job_id=$1", [first.job_id])
    const [current] = await jobs.claimJobs({ workerId: 'current', limit: 1, leaseMs: 60_000 })
    await expect(deferBudget({ jobId: first.job_id, claimedBy: 'old', claimEpoch: first.claim_epoch,
      reason: 'budget_exceeded', availableAt: new Date(Date.now() + 3_600_000) })).resolves.toBe(false)
    expect((await pool.query('SELECT state,claimed_by,claim_epoch FROM memory_jobs WHERE job_id=$1', [first.job_id])).rows[0])
      .toMatchObject({ state: 'running', claimed_by: 'current', claim_epoch: String(current.claim_epoch) })
  })

  test('replaying one budget deferral does not decrement the retry allowance twice', async () => {
    await jobs.enqueueJob({ installationId: INSTALLATION, jobType: 'extract_candidates', idempotencyKey: 'budget-replay' })
    const [claim] = await jobs.claimJobs({ workerId: 'worker', limit: 1, leaseMs: 60_000 })
    const request = { jobId: claim.job_id, claimedBy: 'worker', claimEpoch: claim.claim_epoch,
      reason: 'budget_unavailable' as const, availableAt: new Date(Date.now() + 60_000) }
    await expect(deferBudget(request)).resolves.toBe(true)
    await expect(deferBudget(request)).resolves.toBe(false)
    expect((await pool.query('SELECT attempts,state FROM memory_jobs WHERE job_id=$1', [claim.job_id])).rows[0])
      .toEqual({ attempts: 0, state: 'pending' })
  })

  test('rerun_required abandons an obsolete budget wait without spending the new revision retry allowance',async()=>{
    await jobs.enqueueJob({installationId:INSTALLATION,jobType:'extract_candidates',idempotencyKey:'budget-new-source'})
    await pool.query("UPDATE memory_jobs SET attempts=5 WHERE idempotency_key='budget-new-source'")
    const [claim]=await jobs.claimJobs({workerId:'worker',limit:1,leaseMs:60000})
    await pool.query("UPDATE memory_jobs SET last_error_code='rerun_required' WHERE job_id=$1",[claim.job_id])
    await deferBudget({jobId:claim.job_id,claimedBy:'worker',claimEpoch:claim.claim_epoch,reason:'budget_exceeded',availableAt:new Date(Date.now()+86400000)})
    const row=(await pool.query("SELECT state,attempts,last_error_code,available_at<clock_timestamp()+interval '5 seconds' AS soon FROM memory_jobs WHERE job_id=$1",[claim.job_id])).rows[0]
    expect(row).toMatchObject({state:'pending',attempts:0,last_error_code:'rerun_required',soon:true})
  })

  test('renewClaim is fenced per job and a reclaimed neighbour cannot renew', async () => {
    await jobs.enqueueJob({
      installationId: INSTALLATION, jobType: 'project_feed', idempotencyKey: 'fence:a',
    })
    await jobs.enqueueJob({
      installationId: INSTALLATION, jobType: 'project_feed', idempotencyKey: 'fence:b',
    })
    const claims = await jobs.claimJobs({ workerId: 'worker-a', limit: 2, leaseMs: 60_000 })
    expect(claims).toHaveLength(2)
    const jobA = claims.find(c => c.idempotency_key === 'fence:a')!
    const jobB = claims.find(c => c.idempotency_key === 'fence:b')!

    // The owned job renews under its own fence.
    await expect(jobs.renewClaim({
      jobId: jobA.job_id, claimedBy: 'worker-a', claimEpoch: jobA.claim_epoch, leaseMs: 60_000,
    })).resolves.toBe(true)

    // Expire B's lease; worker-b reclaims it under a bumped epoch.
    await pool.query(`UPDATE memory_jobs SET claim_expires_at = NOW() - INTERVAL '1 second' WHERE job_id = $1`, [jobB.job_id])
    const reclaimed = await jobs.claimJobs({ workerId: 'worker-b', limit: 1, leaseMs: 60_000 })
    expect(reclaimed).toHaveLength(1)
    expect(reclaimed[0].job_id).toBe(jobB.job_id)
    expect(reclaimed[0].claim_epoch).toBe(jobB.claim_epoch + 1)

    // The stale owner cannot renew its lost claim, but its other claim is unaffected.
    await expect(jobs.renewClaim({
      jobId: jobB.job_id, claimedBy: 'worker-a', claimEpoch: jobB.claim_epoch, leaseMs: 60_000,
    })).resolves.toBe(false)
    await expect(jobs.renewClaim({
      jobId: jobA.job_id, claimedBy: 'worker-a', claimEpoch: jobA.claim_epoch, leaseMs: 60_000,
    })).resolves.toBe(true)
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

  test('concurrent workers share the global and job-type claim ceilings',async()=>{
    for(let n=0;n<4;n++)await jobs.enqueueJob({installationId:INSTALLATION,jobType:'compile_episode',idempotencyKey:`bounded:${n}`})
    const input={limit:4,leaseMs:60000,globalLimit:2,typeLimits:{compile_episode:1},perInstallationLimit:2}
    const results=await Promise.all([jobs.claimJobs({...input,workerId:'one'}),jobs.claimJobs({...input,workerId:'two'})])
    expect(results.flat()).toHaveLength(1)
  })

  test('equal-priority installations share a claim batch instead of one old tenant taking it all',async()=>{
    const other='22222222-2222-4222-8222-222222222222'
    await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[other])
    for(let n=0;n<4;n++)await jobs.enqueueJob({installationId:INSTALLATION,jobType:'compile_episode',idempotencyKey:`first:${n}`})
    await jobs.enqueueJob({installationId:other,jobType:'compile_episode',idempotencyKey:'second:0'})
    const input={workerId:'fair',limit:2,leaseMs:60000,globalLimit:2,perInstallationLimit:2}
    const claims=await jobs.claimJobs(input)
    expect(new Set(claims.map(c=>c.installation_id))).toEqual(new Set([INSTALLATION,other]))
  })

  test('an expired lease without a new owner cannot complete or renew',async()=>{
    await jobs.enqueueJob({installationId:INSTALLATION,jobType:'compile_episode',idempotencyKey:'expired-unreclaimed'})
    const [c]=await jobs.claimJobs({workerId:'old',limit:1,leaseMs:60000})
    await pool.query("UPDATE memory_jobs SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",[c.job_id])
    expect(await jobs.completeJob({jobId:c.job_id,claimedBy:'old',claimEpoch:c.claim_epoch})).toBe(false)
    expect(await jobs.renewClaim({jobId:c.job_id,claimedBy:'old',claimEpoch:c.claim_epoch,leaseMs:60000})).toBe(false)
  })
  test('completion rechecks the lease clock after waiting for a job lock',async()=>{
    await jobs.enqueueJob({installationId:INSTALLATION,jobType:'compile_episode',idempotencyKey:'expiry-lock-wait'})
    const [c]=await jobs.claimJobs({workerId:'old',limit:1,leaseMs:300})
    const blocker=await pool.connect()
    await blocker.query('BEGIN');await blocker.query('SELECT 1 FROM memory_jobs WHERE job_id=$1 FOR UPDATE',[c.job_id])
    const completing=jobs.completeJob({jobId:c.job_id,claimedBy:'old',claimEpoch:c.claim_epoch})
    await new Promise(resolve=>setTimeout(resolve,350));await blocker.query('ROLLBACK');blocker.release()
    expect(await completing).toBe(false)
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

  test('renewClaim extends the lease of the caller only', async () => {
    await jobs.enqueueJob({
      installationId: INSTALLATION, jobType: 'project_feed', idempotencyKey: 'feed:2', priority: 50,
    })
    await jobs.enqueueJob({
      installationId: INSTALLATION, jobType: 'project_feed', idempotencyKey: 'feed:3', priority: 50,
    })
    const claims = await jobs.claimJobs({ workerId: 'w1', limit: 2, leaseMs: 60_000 })
    for (const claim of claims) {
      await expect(jobs.renewClaim({
        jobId: claim.job_id, claimedBy: 'w1', claimEpoch: claim.claim_epoch, leaseMs: 60_000,
      })).resolves.toBe(true)
    }
    // Another worker's claim cannot be renewed through this fence.
    await expect(jobs.renewClaim({
      jobId: claims[0].job_id, claimedBy: 'someone-else', claimEpoch: claims[0].claim_epoch, leaseMs: 60_000,
    })).resolves.toBe(false)
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

  test('dead-lettering a Wiki build closes the run instead of blocking future builds', async () => {
    const fixture = await insertWikiCandidateFixture(pool, 'dead-wiki-build')
    await pool.query(`
      UPDATE memory_wiki_build_runs SET state = 'running', completed_at = NULL WHERE run_id = $1
    `, [fixture.runId])
    await jobs.enqueueJob({
      installationId: fixture.installationId,
      jobType: 'build_wiki', idempotencyKey: 'build-dead',
      payload: { run_id: fixture.runId, wiki_id: fixture.wikiId, generation: 1 },
    })
    await pool.query(`UPDATE memory_jobs SET attempts = 11 WHERE idempotency_key = 'build-dead'`)
    const [claim] = await jobs.claimJobs({ workerId: 'w1', limit: 1, leaseMs: 60_000 })
    await expect(jobs.rescheduleJob({
      jobId: claim.job_id, claimedBy: 'w1', claimEpoch: claim.claim_epoch,
      errorCode: 'handler_failed_Error',
    })).resolves.toBe(true)
    const run = await pool.query<{ state: string; error_code: string }>(`
      SELECT state, error_code FROM memory_wiki_build_runs WHERE run_id = $1
    `, [fixture.runId])
    expect(run.rows[0]).toEqual({ state: 'failed', error_code: 'handler_failed_Error' })
  })

  test('dead-lettering a parser marks its snapshot failed', async () => {
    const fixture = await insertWikiCandidateFixture(pool, 'dead-codegraph-build')
    await pool.query(`UPDATE memory_source_snapshots SET state = 'parsing' WHERE snapshot_id = $1`, [fixture.snapshotId])
    await jobs.enqueueJob({
      installationId: fixture.installationId,
      jobType: 'parse_code_snapshot', idempotencyKey: 'parse-dead',
      payload: { snapshot_id: fixture.snapshotId },
    })
    await pool.query(`UPDATE memory_jobs SET attempts = 11 WHERE idempotency_key = 'parse-dead'`)
    const [claim] = await jobs.claimJobs({ workerId: 'w1', limit: 1, leaseMs: 60_000 })
    await expect(jobs.rescheduleJob({
      jobId: claim.job_id, claimedBy: 'w1', claimEpoch: claim.claim_epoch,
      errorCode: 'handler_failed_Error',
    })).resolves.toBe(true)
    const snapshot = await pool.query<{ state: string }>(`
      SELECT state FROM memory_source_snapshots WHERE snapshot_id = $1
    `, [fixture.snapshotId])
    expect(snapshot.rows[0]!.state).toBe('failed')
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
