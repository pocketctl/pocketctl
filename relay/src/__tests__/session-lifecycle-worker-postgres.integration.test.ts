import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import type pg from 'pg'
import { writeFileSync } from 'node:fs'
import { initDB } from '../db.js'
import { lifecycleTestPool } from './session-lifecycle-test-database.js'
import { sessionLifecycleConfig } from '../session-lifecycle/config.js'
import { createSessionLifecycleWorker } from '../session-lifecycle/worker.js'
import { maintenanceSlot } from '../session-lifecycle/schedule.js'
import { DailyMaintenanceSchedule } from '../session-lifecycle/schedule.js'
import { LifecycleScanProgress } from '../session-lifecycle/scan-progress.js'
import { LifecycleJobRepository } from '../session-lifecycle/repository.js'
import * as eligibility from '../session-lifecycle/eligibility.js'
import type { ArchiveStorage } from '../session-archive/storage.js'

const suite = process.env.RUN_SESSION_LIFECYCLE_POSTGRES === '1' ? describe : describe.skip
suite('bounded lifecycle backlog scheduling and durable scan progress PostgreSQL', () => {
  let pool: pg.Pool, userId: number
  const config = sessionLifecycleConfig({ SESSION_LIFECYCLE_EFFECTIVE_AT: '2026-01-01T00:00:00Z', SESSION_LIFECYCLE_TRANSITION_DEADLINE: '2026-01-01T00:00:00Z' })
  const storage: ArchiveStorage = {
    namespace: 'lifecycle-scan-fixture',
    put: async () => { throw new Error('unexpected transfer') },
    read: async () => { throw new Error('unexpected read') },
    delete: async () => { throw new Error('unexpected deletion') },
  }
  beforeAll(async () => { pool = await lifecycleTestPool(); await initDB(pool) })
  beforeEach(async () => {
    await pool.query('TRUNCATE users,daemons,sessions,events,subagents,deleted_sessions,extension_source_outbox,extension_feed RESTART IDENTITY CASCADE')
    // Old code has no checkpoint table; retain a meaningful red test first.
    if ((await pool.query("SELECT to_regclass('session_lifecycle_scan_state') AS relation")).rows[0].relation)
      await pool.query('TRUNCATE session_lifecycle_scan_state,session_lifecycle_daily_runs')
    userId = (await pool.query("INSERT INTO users(email,password_hash) VALUES('scan-progress@test.invalid','x') RETURNING id")).rows[0].id
    await pool.query("INSERT INTO daemons(daemon_id,user_id) VALUES('scan-host',$1)", [userId])
    // These backlog tests isolate the archive phase; the independent purge
    // phase has already completed for the current real-clock day.
    await pool.query("INSERT INTO session_lifecycle_daily_runs(policy_version,action,scheduled_at,completed_at) VALUES($1,'purge',$2,NOW())",
      [config.policyVersion,maintenanceSlot('purge',new Date())])
  })
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => { await pool?.end() })
  async function seed(n: number) {
    await pool.query(`INSERT INTO sessions(session_id,user_id,daemon_id,status,last_activity_at,activity_verified)
      SELECT 'scan-'||i,$1,'scan-host','idle',NOW()-interval '40 days',false FROM generate_series(1,$2) i`, [userId, n])
  }
  function worker(overrides = {}) {
    let report: Record<string, any> = {}
    const instance = createSessionLifecycleWorker(pool, { ...config, ...overrides }, storage, 'scan-fixture-secret', {
      workerId: 'scan-fixture', onReport: value => { report = value },
    })
    return { ...instance, report: () => report }
  }
  async function run(overrides = {}) {
    const instance = worker(overrides)
    await instance.runOnce()
    return instance.report()
  }
  test('new worker processes resume the next page; only a completed sweep finishes its daily run', async () => {
    await seed(45)
    const first = await run(), second = await run(), last = await run()
    expect([first.scanned, second.scanned, last.scanned]).toEqual([20, 20, 5])
    expect([first.scanCursor, second.scanCursor, last.scanCursor]).toEqual([20, 40, 45])
    expect(first.nextDelayMs).toBeLessThanOrEqual(5000)
    expect(second.nextDelayMs).toBeLessThanOrEqual(5000)
    expect(last.nextDelayMs).toBe(60_000)
    expect((await pool.query('SELECT count(*)::int n FROM session_lifecycle_jobs')).rows[0].n).toBe(0)
  })
  test('time budget checkpoints the last inspected row rather than skipping the fetched page', async () => {
    await seed(45)
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(2)
    const partial = await run({ runBudgetMs: 1 })
    vi.restoreAllMocks()
    expect(partial).toMatchObject({ scanned: 1, scanCursor: 1 })
    expect(await run()).toMatchObject({ scanned: 20, scanCursor: 21 })
  })
  test('inspection failure preserves completed rows and retries the failed row after restart', async () => {
    await seed(45)
    const original = eligibility.inspectLifecycleEligibility
    vi.spyOn(eligibility, 'inspectLifecycleEligibility').mockImplementationOnce(original).mockRejectedValueOnce(new Error('fixture inspection interruption'))
    await expect(run()).rejects.toThrow('fixture inspection interruption')
    vi.restoreAllMocks()
    expect((await pool.query("SELECT after_row_id::int FROM session_lifecycle_daily_runs WHERE action='archive'")).rows[0].after_row_id).toBe(1)
    expect(await run()).toMatchObject({ scanned: 20, scanCursor: 21 })
  })
  test('a full page at the end does not schedule an unnecessary continuation', async () => {
    await seed(20)
    const report = await run()
    expect(report).toMatchObject({ scanned: 20, scanCursor: 20 })
    expect(report.nextDelayMs).toBe(60_000)
  })
  test('background scheduling actually continues the next page without waiting for the daily run', async () => {
    await seed(21)
    const instance = worker({ continuationDelayMs: 10 })
    try {
      instance.start()
      await vi.waitFor(() => expect(instance.report()).toMatchObject({ scanned: 1, scanComplete: true }), { timeout: 5000 })
      expect(instance.report().nextDelayMs).toBe(60_000)
    } finally { await instance.stop() }
  })
  test('observe remains read-only with no durable checkpoint', async () => {
    await seed(21)
    const instance = worker({ mode: 'observe' })
    await instance.runOnce()
    expect(instance.report().observe.nextRowId).toBe(20)
    expect(instance.report().nextDelayMs).toBeLessThanOrEqual(5000)
    expect((await pool.query('SELECT count(*)::int n FROM session_lifecycle_scan_state')).rows[0].n).toBe(0)
  })
  test('competing workers share one page lease; stale owners cannot overwrite recovered progress', async () => {
    const progress = new LifecycleScanProgress(pool)
    const leases = await Promise.all([progress.claim(config.policyVersion, 60_000), progress.claim(config.policyVersion, 60_000)])
    expect(leases.filter(Boolean)).toHaveLength(1)
    const old = leases.find(Boolean)!
    await pool.query("UPDATE session_lifecycle_scan_state SET lease_until=NOW()-interval '1 second'")
    const recovered = (await progress.claim(config.policyVersion, 60_000))!
    expect(recovered.afterRowId).toBe(0)
    expect(await progress.finish(recovered, 20, 5000)).toBe(true)
    expect(await progress.finish(old, 99, 5000)).toBe(false)
    expect((await pool.query('SELECT after_row_id::int FROM session_lifecycle_scan_state')).rows[0].after_row_id).toBe(20)
    expect(await progress.claim(config.policyVersion, 60_000)).toBeNull()
  })
  test('restart honors the completed sweep delay; queued retries wake sooner than the next sweep', async () => {
    await seed(1)
    const jobs = new LifecycleJobRepository(pool)
    await jobs.enqueue({ userId, sessionId: 'scan-1', activityEpoch: '0', action: 'archive', policyVersion: config.policyVersion })
    await pool.query("UPDATE session_lifecycle_jobs SET state='partial',next_attempt_at=NOW()+interval '1 minute'")
    const report = await run()
    expect(report).toMatchObject({ scanned: 1, executed: 0, scanComplete: true })
    expect(report.nextDelayMs).toBeGreaterThan(50_000)
    expect(report.nextDelayMs).toBeLessThanOrEqual(60_000)
    expect((await pool.query("SELECT completed_at IS NOT NULL AS done FROM session_lifecycle_daily_runs WHERE action='archive'")).rows[0].done).toBe(true)
  })
  test('budget continuations survive restart in the same daily run and wait for their retry time', async () => {
    await seed(1)
    await new LifecycleJobRepository(pool).enqueue({ userId, sessionId: 'scan-1', activityEpoch: '0', action: 'archive', policyVersion: config.policyVersion })
    await pool.query(`UPDATE session_lifecycle_jobs SET state='partial',result='{"reason":"transfer_budget_reached"}',next_attempt_at=NOW()+interval '1 minute'`)
    const first = await run()
    expect(first).toMatchObject({ scanned: 1, executed: 0, scanComplete: true, dailyRunComplete: false })
    expect(first.nextDelayMs).toBeGreaterThan(50_000)
    expect(first.nextDelayMs).toBeLessThanOrEqual(60_000)
    // Recover a batch the previous release completed before its retry time.
    await pool.query("UPDATE session_lifecycle_daily_runs SET completed_at=NOW() WHERE action='archive'")
    expect(await run()).toMatchObject({ scanned: 0, executed: 0, scanComplete: true, dailyRunComplete: false })
    expect((await pool.query("SELECT completed_at FROM session_lifecycle_daily_runs WHERE action='archive'")).rows[0].completed_at).toBeNull()
    await pool.query("UPDATE session_lifecycle_jobs SET state='succeeded'")
    expect(await run()).toMatchObject({ scanned: 0, scanComplete: true, dailyRunComplete: true })
  })
  test('a future storage-failure retry does not reopen a completed daily run', async () => {
    await seed(1)
    await new LifecycleJobRepository(pool).enqueue({ userId, sessionId: 'scan-1', activityEpoch: '0', action: 'archive', policyVersion: config.policyVersion })
    await pool.query(`UPDATE session_lifecycle_jobs SET state='partial',result='{"reason":"cold_transfer_failed"}',next_attempt_at=NOW()+interval '1 minute'`)
    expect(await run()).toMatchObject({ dailyRunComplete: true })
    expect(await run()).not.toHaveProperty('scheduledAction')
  })
  test('another worker active lease keeps the daily run open without rapid polling', async () => {
    await seed(1)
    const jobs = new LifecycleJobRepository(pool)
    await jobs.enqueue({ userId, sessionId: 'scan-1', activityEpoch: '0', action: 'archive', policyVersion: config.policyVersion })
    expect(await jobs.claim('other-worker', 300_000)).not.toBeNull()
    expect(await run()).toMatchObject({ scanned: 1, executed: 0, dailyRunComplete: false, nextDelayMs: 60_000 })
  })
  test('all event-reference foreign keys have usable leading-column indexes for deletion', async () => {
    const missing = await pool.query(`SELECT c.conname FROM pg_constraint c
      WHERE c.contype='f' AND c.confrelid='events'::regclass AND NOT EXISTS(
        SELECT 1 FROM pg_index i WHERE i.indrelid=c.conrelid AND i.indisvalid AND i.indpred IS NULL
        AND (i.indkey::smallint[])[0:array_length(c.conkey,1)-1] @> c.conkey)`)
    expect(missing.rows).toEqual([])
  })
  test('indexed outbox cascade removes only deliveries referencing the deleted session events', async () => {
    await seed(2)
    await pool.query(`INSERT INTO events(session_id,event_type,payload)
      SELECT CASE WHEN i<=20 THEN 'scan-1' ELSE 'scan-2' END,'agent_text','{}'::jsonb FROM generate_series(1,5000) i`)
    const inbox = (await pool.query(`INSERT INTO event_inbox(daemon_id,daemon_generation,seq,dedup_key,event_type,priority_class,payload)
      VALUES('scan-host',1,1,'index-fixture','agent_text',0,'{}') RETURNING inbox_id`)).rows[0].inbox_id
    await pool.query(`INSERT INTO realtime_outbox(inbox_id,delivery_key,event_id,session_id,event_type,audience,payload,delivered_at)
      SELECT $1,'index-fixture:'||id,id,session_id,'agent_text','user','{}',NOW() FROM events`, [inbox])
    await pool.query('ANALYZE realtime_outbox')
    const plan = await pool.query('EXPLAIN(FORMAT JSON) SELECT 1 FROM realtime_outbox WHERE event_id=1')
    expect(JSON.stringify(plan.rows)).toContain('idx_realtime_outbox_event_id')
    expect((await pool.query("DELETE FROM events WHERE session_id='scan-1'")).rowCount).toBe(20)
    expect((await pool.query('SELECT session_id,count(*)::int n FROM realtime_outbox GROUP BY session_id')).rows)
      .toEqual([{ session_id: 'scan-2', n: 4980 }])
  })
  test.runIf(process.env.RUN_SESSION_LIFECYCLE_CAPACITY === '1')('measures a 935-candidate protected backlog without bypassing any eligibility guard', async () => {
    await seed(935)
    let scanned = 0, pages = 0, continuationWaitMs = 0
    const begin = performance.now()
    while (pages < 50) {
      const report = await run()
      scanned += report.scanned; pages++
      expect(report.executed).toBe(0)
      if (report.scanComplete) break
      continuationWaitMs += report.nextDelayMs
    }
    const processingMs = Math.round(performance.now() - begin)
    expect(scanned).toBe(935)
    expect(pages).toBe(47)
    expect((await pool.query('SELECT count(*)::int n FROM session_lifecycle_jobs')).rows[0].n).toBe(0)
    const benchmark = { benchmark: 'lifecycle-protected-935', scanned, pages, processingMs,
      continuationWaitMs: Math.round(continuationWaitMs), estimatedSweepMs: Math.round(processingMs + continuationWaitMs),
      scope: 'isolated PostgreSQL synthetic unverified sessions; not production capacity or transfer throughput' }
    if (process.env.SESSION_LIFECYCLE_BENCHMARK_REPORT)
      writeFileSync(process.env.SESSION_LIFECYCLE_BENCHMARK_REPORT, JSON.stringify(benchmark, null, 2)+'\n')
  }, 60_000)
  test('03:00 archive and purge share one durable daily slot and survive restart',async()=>{
    await pool.query('TRUNCATE session_lifecycle_daily_runs')
    const daily=new DailyMaintenanceSchedule(pool),cfg={...config,effectiveAt:'2026-10-30T00:00:00+08:00'}
    expect(await daily.claim(cfg,new Date('2026-10-30T02:59:59+08:00'))).toBeNull()
    const archive=(await daily.claim(cfg,new Date('2026-10-30T03:00:00+08:00')))!
    expect(archive.action).toBe('archive')
    await daily.finish(archive,10,true,true)
    const purge=(await new DailyMaintenanceSchedule(pool).claim(cfg,new Date('2026-10-30T03:00:01+08:00')))!
    expect(purge.action).toBe('purge');expect(purge.scheduledAt).toEqual(archive.scheduledAt)
    await daily.finish(purge,10,true,true)
    expect(await daily.claim(cfg,new Date('2026-10-30T23:00:00+08:00'))).toBeNull()
    expect((await daily.claim(cfg,new Date('2026-10-31T03:00:00+08:00')))?.action).toBe('archive')
  })
})
