import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import type pg from 'pg'
import { initDB } from '../db.js'
import { SessionLifecycleScanner } from '../session-lifecycle/scanner.js'
import { sessionLifecycleConfig } from '../session-lifecycle/config.js'
import { lifecycleTestPool } from './session-lifecycle-test-database.js'
import { ensureAppReviewDemoData } from '../config/app-review-demo.js'

const suite =
  process.env.RUN_SESSION_LIFECYCLE_POSTGRES === '1' ? describe : describe.skip
suite('session lifecycle read-only observe scanner PostgreSQL', () => {
  let pool: pg.Pool, userId: number, scanner: SessionLifecycleScanner
  const config = sessionLifecycleConfig({ SESSION_LIFECYCLE_MODE: 'observe' })
  beforeAll(async () => {
    pool = await lifecycleTestPool()
    await initDB(pool)
    scanner = new SessionLifecycleScanner(pool, config)
  }, 30_000)
  afterAll(async () => {
    await pool?.end()
  })
  beforeEach(async () => {
    await pool.query(
      'TRUNCATE users,daemons,sessions,events,deleted_sessions RESTART IDENTITY CASCADE',
    )
    userId = (
      await pool.query(
        "INSERT INTO users(email,password_hash) VALUES('scan@test.invalid','x') RETURNING id",
      )
    ).rows[0].id
    await pool.query(
      "INSERT INTO daemons(daemon_id,user_id) VALUES('scan-host',$1)",
      [userId],
    )
  })
  async function add(
    id: string,
    activity: string | null,
    parent: string | null = null,
  ) {
    await pool.query(
      `INSERT INTO sessions(session_id,user_id,daemon_id,status,last_activity_at,activity_verified,parent_session_id)
      VALUES($1,$2,'scan-host','exited',$3,true,$4)`,
      [id, userId, activity, parent],
    )
  }
  test('off does not issue any database calls', async () => {
    const off = new SessionLifecycleScanner(
      {
        query: () => {
          throw new Error('must not scan')
        },
      } as any,
      sessionLifecycleConfig({SESSION_LIFECYCLE_MODE:'off'}),
    )
    expect((await off.scanPage({ limit: 20 })).candidates).toEqual([])
  })
  test('seeded demo fixtures are classified separately from real unverified sessions without writes', async () => {
    await ensureAppReviewDemoData(pool, userId)
    await add('real-unverified', '2026-01-01T00:00:00Z')
    await pool.query("UPDATE sessions SET last_activity_at='2026-01-01',activity_verified=false")
    const before = (await pool.query('SELECT * FROM sessions ORDER BY id')).rows
    const report = await scanner.scanPage({ limit: 20, now: '2026-06-01T00:00:00Z' })
    const demos = report.candidates.filter(candidate => candidate.sessionId !== 'real-unverified')
    expect(demos).toHaveLength(3)
    for (const demo of demos) expect(demo.prediction).toMatchObject({ action: null, blockedReasons: ['demo_excluded'] })
    expect(report.candidates.find(candidate => candidate.sessionId === 'real-unverified')!.prediction.blockedReasons)
      .toContain('activity_unverified')
    expect(report.eligibleCount).toBe(0)
    expect((await pool.query('SELECT * FROM sessions ORDER BY id')).rows).toEqual(before)
  })
  test('UTC microsecond boundary and unknown activity are explicit; no writes occur', async () => {
    await add('exact', '2026-01-01T00:00:00Z')
    await add('unknown', null)
    const before = (await pool.query('SELECT * FROM sessions ORDER BY id')).rows
    const atBoundary = await scanner.scanPage({
      limit: 20,
      now: '2026-01-31T00:00:00.000000Z',
    })
    expect(atBoundary.candidates.map((c) => c.sessionId)).toEqual(['unknown'])
    const overdue = await scanner.scanPage({
      limit: 20,
      now: '2026-01-31T00:00:00.000001Z',
    })
    expect(
      overdue.candidates.find((c) => c.sessionId === 'exact')?.prediction
        .action,
    ).toBe('archive')
    expect(
      overdue.candidates.find((c) => c.sessionId === 'unknown')?.prediction
        .blockedReasons,
    ).toContain('activity_future')
    expect(
      (await pool.query('SELECT * FROM sessions ORDER BY id')).rows,
    ).toEqual(before)
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM session_lifecycle_jobs',
        )
      ).rows[0].n,
    ).toBe(0)
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM attention_notifications',
        )
      ).rows[0].n,
    ).toBe(0)
  })
  test('grandchild activity protects root through recursive closure', async () => {
    await add('root', '2026-01-01T00:00:00Z')
    await add('child', '2026-01-01T00:00:00Z', 'root')
    await add('grandchild', '2026-05-31T00:00:00Z', 'child')
    const report = await scanner.scanPage({
      limit: 20,
      now: '2026-06-01T00:00:00Z',
    })
    const root = report.candidates.find((c) => c.sessionId === 'root')!
    expect(root.dependencyCount).toBe(3)
    expect(root.prediction.activityAt).toBe('2026-05-31T00:00:00.000000Z')
    expect(root.projectedAction).toBeNull()
  })
  test('issued admission protects before activity materialization', async () => {
    await add('pending', '2026-01-01T00:00:00Z')
    await pool.query(
      `INSERT INTO session_message_admissions(id,user_id,daemon_id,session_id,request_id,command_hash,expires_at)
      VALUES('00000000-0000-4000-8000-000000000001',$1,'scan-host','pending','request','hash',NOW()+interval '1 hour')`,
      [userId],
    )
    const report = await scanner.scanPage({
      limit: 20,
      now: '2026-06-01T00:00:00Z',
    })
    expect(report.candidates[0].prediction.blockedReasons).toContain(
      'admission_pending',
    )
  })
  test('stable pages and cyclic mappings are bounded and excluded', async () => {
    await add('cycle-a', '2026-01-01T00:00:00Z', 'cycle-b')
    await add('cycle-b', '2026-01-01T00:00:00Z', 'cycle-a')
    const first = await scanner.scanPage({
      limit: 1,
      now: '2026-06-01T00:00:00Z',
    })
    const second = await scanner.scanPage({
      limit: 1,
      afterRowId: first.nextRowId!,
      now: '2026-06-01T00:00:00Z',
    })
    expect(second.candidates).toEqual([])
    expect(first.candidates[0].prediction.blockedReasons).toContain(
      'dependency_unknown',
    )
    expect(first.candidates[0].projectedAction).toBeNull()
  })
})
