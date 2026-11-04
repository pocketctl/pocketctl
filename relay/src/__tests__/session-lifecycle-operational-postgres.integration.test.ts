import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import type pg from 'pg'
import Fastify from 'fastify'
import { initDB } from '../db.js'
import { lifecycleTestPool } from './session-lifecycle-test-database.js'
import { lifecycleOperationalStatus } from '../session-lifecycle/operational.js'
import { registerSessionLifecycleStatusRoutes } from '../session-lifecycle/readiness.js'
import { sessionLifecycleConfig } from '../session-lifecycle/config.js'
import { SessionLifecycleScanner } from '../session-lifecycle/scanner.js'

const suite = process.env.RUN_SESSION_LIFECYCLE_POSTGRES === '1' ? describe : describe.skip
suite('lifecycle operational diagnostics PostgreSQL', () => {
  let pool: pg.Pool, userId: number, other: number
  const now = new Date('2026-11-04T02:00:00Z') // 10:00 Beijing
  const slot = '2026-11-03T19:00:00Z'
  const config = sessionLifecycleConfig({ SESSION_LIFECYCLE_EFFECTIVE_AT: '2026-10-30T14:00:00Z',
    SESSION_LIFECYCLE_TRANSITION_DEADLINE: '2026-10-30T14:00:00Z' })
  beforeAll(async () => { pool = await lifecycleTestPool(); await initDB(pool) }, 30000)
  afterAll(async () => { await pool?.end() })
  beforeEach(async () => {
    await pool.query('TRUNCATE users,daemons,sessions,events,deleted_sessions,session_lifecycle_daily_runs RESTART IDENTITY CASCADE')
    const users = (await pool.query("INSERT INTO users(email,password_hash) VALUES('ops@test.invalid','x'),('other@test.invalid','x') RETURNING id")).rows
    userId = users[0].id; other = users[1].id
    await pool.query("INSERT INTO daemons(daemon_id,user_id) VALUES('ops-host',$1)", [userId])
  })
  async function completeScans() {
    await pool.query(`INSERT INTO session_lifecycle_daily_runs(policy_version,action,scheduled_at,started_at,scan_complete,completed_at)
      VALUES($1,'archive',$2,$2,true,$2::timestamptz+interval '5 minutes'),($1,'purge',$2,$2,true,$2::timestamptz+interval '6 minutes')`, [config.policyVersion, slot])
  }
  test('missing or old unfinished batch is visible; activation and observe do not invent missed slots', async () => {
    expect((await lifecycleOperationalStatus(pool, config, userId, now)).alerts).toContain('scheduled_scan_overdue')
    expect((await lifecycleOperationalStatus(pool, config, userId, new Date('2026-11-03T19:01:00Z'))).alerts).toEqual([])
    expect((await lifecycleOperationalStatus(pool, { ...config, mode: 'observe' }, userId, now)).alerts).toEqual([])
    expect((await lifecycleOperationalStatus(pool, { ...config, effectiveAt: now.toISOString() }, userId, now)).alerts).toEqual([])
    await completeScans()
    await pool.query("INSERT INTO session_lifecycle_daily_runs(policy_version,action,scheduled_at) VALUES($1,'archive',$2::timestamptz-interval '1 day')", [config.policyVersion, slot])
    const result = await lifecycleOperationalStatus(pool, config, userId, now)
    expect(result.scans.find(s => s.action === 'archive')?.overdue).toBe(true)
    expect(result.scans.find(s => s.action === 'purge')?.state).toBe('completed')
  })
  test('scan completion does not hide user cleanup backlog, nor leak another user jobs', async () => {
    await completeScans()
    await pool.query(`INSERT INTO session_lifecycle_jobs(operation_id,user_id,session_id,action,policy_version,activity_epoch,state,created_at)
      VALUES(gen_random_uuid(),$1,'pending','purge',$3,0,'partial',$4),
      (gen_random_uuid(),$2,'private','purge',$3,0,'failed',$4)`, [userId, other, config.policyVersion, slot])
    const result = await lifecycleOperationalStatus(pool, config, userId, now)
    expect(result.scans.every(s => s.state === 'completed')).toBe(true)
    expect(result.jobs).toMatchObject({ pending: 1, partial: 1, failed: 0 })
    expect(result.alerts).toContain('job_backlog_overdue')
    await pool.query("UPDATE session_lifecycle_jobs SET state='succeeded' WHERE user_id=$1", [userId])
    expect((await lifecycleOperationalStatus(pool, config, userId, now)).alerts).toEqual([])
  })
  test('short backlog is pending without premature alert; unpublished summaries and undelivered notices are distinct', async () => {
    await completeScans()
    const notice = (await pool.query(`INSERT INTO attention_notifications(notification_id,user_id,maintenance_day,created_at,expires_at,published_at)
      VALUES(gen_random_uuid(),$1,'2026-11-04',$2,$2::timestamptz+interval '90 days',NULL) RETURNING notification_id`, [userId, slot])).rows[0].notification_id
    await pool.query(`INSERT INTO notification_delivery_outbox(user_id,notification_id,revision,operation,created_at)
      VALUES($1,$2,1,'changed',$3::timestamptz-interval '1 minute')`, [userId, notice, now])
    let result = await lifecycleOperationalStatus(pool, config, userId, now)
    expect(result.notification_delivery.pending).toBe(1)
    expect(result.alerts).not.toContain('notification_delivery_overdue')
    expect(result.alerts).toContain('maintenance_summary_overdue')
    await pool.query("UPDATE notification_delivery_outbox SET created_at=$1", [slot])
    result = await lifecycleOperationalStatus(pool, config, userId, now)
    expect(result.alerts).toContain('notification_delivery_overdue')
    expect((await lifecycleOperationalStatus(pool, config, other, now)).notification_delivery.pending).toBe(0)
  })
  test('authenticated endpoint uses token identity and rejects anonymous access', async () => {
    const app = Fastify()
    registerSessionLifecycleStatusRoutes(app, { pool, config, verifyAccessToken: async token => token === 'test' ? { userId } : null })
    try {
      expect((await app.inject('/api/session-lifecycle/status')).statusCode).toBe(401)
      const response = await app.inject({ url: '/api/session-lifecycle/status', headers: { authorization: 'Bearer test' } })
      expect(response.statusCode).toBe(200)
      expect(response.headers['cache-control']).toBe('no-store, private')
      expect(response.json().operational.maintenance.jobs.pending).toBe(0)
    } finally { await app.close() }
  })
  test('default diagnostics avoid payload aggregates, explicit statistics work in read-only transactions', async () => {
    await pool.query(`INSERT INTO sessions(session_id,user_id,daemon_id,status,last_activity_at,activity_verified)
      VALUES('diagnostic',$1,'ops-host','completed','2026-09-01',true)`, [userId])
    const client = await pool.connect()
    try {
      await client.query('BEGIN READ ONLY')
      const scanner = new SessionLifecycleScanner(client, { ...config, mode: 'observe' })
      const fast = await scanner.scanPage({ limit: 1, now: now.toISOString() })
      expect(fast.candidates[0]).toMatchObject({ eventCount: null, logicalPayloadBytes: null })
      const detailed = await scanner.scanPage({ limit: 1, now: now.toISOString(), includeStatistics: true })
      expect(detailed.candidates[0]).toMatchObject({ eventCount: '0', logicalPayloadBytes: '0' })
      expect(detailed.candidates[0].prediction).toEqual(fast.candidates[0].prediction)
      expect((await client.query('SELECT count(*)::int n FROM session_lifecycle_jobs')).rows[0].n).toBe(0)
    } finally { await client.query('ROLLBACK'); client.release() }
  })
})
