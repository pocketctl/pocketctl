import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { initDB, getSessionAllEvents } from '../db.js'
import { lifecycleTestPool } from './session-lifecycle-test-database.js'
import { releasedConfig } from './session-lifecycle-release-fixture.js'
import { sessionLifecycleConfig } from '../session-lifecycle/config.js'
import { createSessionLifecycleWorker } from '../session-lifecycle/worker.js'
import { SessionLifecycleExecutor } from '../session-lifecycle/executor.js'
import { enableSessionColdBodies } from '../session-lifecycle/cold-schema.js'
import { configuredArchiveStorage, installConfiguredHistoryReader } from '../session-history/runtime.js'
import { withSessionHistoryScope } from '../session-history/postgres-reader.js'
import type { ArchiveStorage } from '../session-archive/storage.js'

const suite = process.env.RUN_SESSION_LIFECYCLE_POSTGRES === '1' ? describe : describe.skip
suite('production lifecycle with actual private disk and dedicated PostgreSQL', () => {
  let pool: pg.Pool, directory: string, userId: number, storage: ArchiveStorage, env: Record<string, string>
  beforeAll(async () => { pool = await lifecycleTestPool(); await initDB(pool); await enableSessionColdBodies(pool) }, 30_000)
  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'production')
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'pocketctl-lifecycle-disk-pg-')))
    env = { NODE_ENV: 'production', SESSION_LIFECYCLE_STORAGE_DRIVER: 'filesystem', SESSION_LIFECYCLE_OBJECT_DIRECTORY: join(directory, 'archive'),
      SESSION_LIFECYCLE_EFFECTIVE_AT: '2026-01-01T00:00:00Z', SESSION_LIFECYCLE_TRANSITION_DEADLINE: '2026-02-01T00:00:00Z' }
    installConfiguredHistoryReader(pool, sessionLifecycleConfig(env), env)
    storage = configuredArchiveStorage(pool)!
    await pool.query('TRUNCATE users,daemons,sessions,events,subagents,deleted_sessions,extension_source_outbox,extension_feed RESTART IDENTITY CASCADE')
    await pool.query('TRUNCATE session_lifecycle_deletions,extension_session_deletions,session_archive_object_deletions')
    userId = (await pool.query("INSERT INTO users(email,password_hash) VALUES('disk-release@test.invalid','x') RETURNING id")).rows[0].id
    await pool.query("INSERT INTO daemons(daemon_id,user_id,alias) VALUES('host',$1,'Disk fixture host')", [userId])
    await pool.query(`INSERT INTO sessions(session_id,user_id,daemon_id,status,title,last_activity_at,last_business_activity_at,activity_verified)
      VALUES('root',$1,'host','idle','Production disk fixture',NOW()-interval '70 days',NOW()-interval '70 days',true)`, [userId])
    await pool.query(`INSERT INTO events(session_id,event_type,payload,effect_status) VALUES
      ('root','user_text','{"text":"exact original 中文"}','completed'),('root','agent_text','{"text":"exact original response"}','completed')`)
    await pool.query('UPDATE attention_projection_cursor SET last_event_id=(SELECT max(id) FROM events)')
  })
  afterEach(() => { vi.unstubAllEnvs(); if (directory) rmSync(directory, { recursive: true, force: true }) })
  afterAll(async () => {
    if (!pool) return
    await pool.query('TRUNCATE users,daemons,sessions,events,subagents,deleted_sessions RESTART IDENTITY CASCADE')
    await pool.query('ALTER TABLE events ALTER COLUMN payload SET NOT NULL')
    await pool.query('ALTER TABLE session_document_versions ALTER COLUMN content_bytes SET NOT NULL')
    await pool.end()
  })
  async function run(config = releasedConfig(storage.namespace!, {}, env)) {
    let report: Record<string, unknown> = {}
    await createSessionLifecycleWorker(pool, config, storage, 'disk-test-secret', { workerId: 'disk-production-fixture', onReport: value => { report = value } }).runOnce()
    return report
  }
  test('complete production release archives to disk and reads exact history after reader restart', async () => {
    const report = await run()
    expect(report).toMatchObject({ scanned: 1, executed: 1 })
    expect((await pool.query("SELECT archive_reason,content_state FROM sessions WHERE session_id='root'")).rows[0])
      .toEqual({ archive_reason: 'inactivity', content_state: 'cold' })
    expect((await pool.query('SELECT payload FROM events')).rows.every(row => row.payload === null)).toBe(true)
    installConfiguredHistoryReader(pool, sessionLifecycleConfig(env), env)
    const rows = await withSessionHistoryScope({ userId }, () => getSessionAllEvents(pool, 'root'))
    expect(rows.map(row => row.payload.text)).toEqual(['exact original 中文', 'exact original response'])
  })
  test('production purge commits deletion and disk compensation completes with enforcement off', async () => {
    await run()
    const keys = (await pool.query('SELECT object_key FROM session_archive_chunks')).rows.map(row => row.object_key)
    expect(keys.length).toBeGreaterThan(0)
    await pool.query("UPDATE sessions SET last_activity_at=NOW()-interval '100 days'")
    expect(await run()).toMatchObject({ executed: 1 })
    expect((await pool.query("SELECT count(*)::int AS n FROM sessions WHERE session_id='root'")).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int AS n FROM session_lifecycle_deletions')).rows[0].n).toBe(1)
    await pool.query('UPDATE session_archive_object_deletions SET next_attempt_at=NOW()')
    await run({ ...sessionLifecycleConfig(env), mode: 'off' })
    for (const key of keys) await expect(storage.read(key)).rejects.toThrow()
    expect((await pool.query("SELECT state FROM session_lifecycle_results WHERE action='purge'")).rows[0].state).toBe('succeeded')
  })
  test('incomplete production release reports all blockers and creates no automatic jobs', async () => {
    const report = await run({ ...sessionLifecycleConfig(env), effectiveAt: null, transitionDeadline: null })
    expect(report.readinessBlockers).toEqual(['policy_not_effective', 'historical_transition_not_configured', 'production_release_not_ready'])
    expect(report).toMatchObject({ executed: 0, scanned: 0 })
    expect((await pool.query('SELECT count(*)::int AS n FROM session_lifecycle_jobs')).rows[0].n).toBe(0)
  })
  test('executor independently rejects missing release evidence before mutating a session', async () => {
    const executor = new SessionLifecycleExecutor(pool, sessionLifecycleConfig(env), storage, 'disk-test-secret')
    await executor.jobs.enqueue({ userId, sessionId: 'root', activityEpoch: '0', action: 'archive', policyVersion: 'session-lifecycle-v1' })
    const lease = (await executor.jobs.claim('direct-fixture', 300_000))!
    await expect(executor.execute(lease)).rejects.toThrow('production_release_not_ready')
    expect((await pool.query("SELECT archive_reason,content_state FROM sessions WHERE session_id='root'")).rows[0])
      .toEqual({ archive_reason: null, content_state: 'hot' })
  })
  test('future effective dates block both scheduling and direct execution', async () => {
    const config = releasedConfig(storage.namespace!, { effectiveAt: '2099-01-01T00:00:00Z', transitionDeadline: '2099-02-01T00:00:00Z' },
      { ...env, SESSION_LIFECYCLE_EFFECTIVE_AT: '2099-01-01T00:00:00Z', SESSION_LIFECYCLE_TRANSITION_DEADLINE: '2099-02-01T00:00:00Z' })
    expect(await run(config)).toMatchObject({ executed: 0, readinessBlockers: ['policy_not_effective'] })
    expect((await pool.query('SELECT count(*)::int AS n FROM session_lifecycle_jobs')).rows[0].n).toBe(0)
    const executor = new SessionLifecycleExecutor(pool, config, storage, 'disk-test-secret')
    await executor.jobs.enqueue({ userId, sessionId: 'root', activityEpoch: '0', action: 'archive', policyVersion: 'session-lifecycle-v1' })
    await expect(executor.execute((await executor.jobs.claim('future-direct', 300_000))!)).rejects.toThrow('policy_not_effective')
  })
  test('a historical session past 90 days is not purged before the transition deadline', async () => {
    await pool.query("UPDATE sessions SET created_at='2025-01-01',last_activity_at='2025-12-01'")
    const config = releasedConfig(storage.namespace!, { transitionDeadline: '2099-02-01T00:00:00Z' }, { ...env, SESSION_LIFECYCLE_TRANSITION_DEADLINE: '2099-02-01T00:00:00Z' })
    expect(await run(config)).toMatchObject({ executed: 1 })
    expect((await pool.query("SELECT content_state FROM sessions WHERE session_id='root'")).rows[0].content_state).toBe('cold')
    expect((await pool.query('SELECT count(*)::int AS n FROM session_lifecycle_deletions')).rows[0].n).toBe(0)
  })
  test('disk-space refusal leaves original hot bodies readable and records a retryable partial result', async () => {
    env.SESSION_LIFECYCLE_FILESYSTEM_MIN_FREE_BYTES = String(Number.MAX_SAFE_INTEGER)
    const config = sessionLifecycleConfig(env)
    installConfiguredHistoryReader(pool, config, env)
    storage = configuredArchiveStorage(pool)!
    expect(await run()).toMatchObject({ executed: 1 })
    expect((await pool.query("SELECT content_state FROM sessions WHERE session_id='root'")).rows[0].content_state).toBe('hot')
    expect((await withSessionHistoryScope({ userId }, () => getSessionAllEvents(pool, 'root'))).map(row => row.payload.text))
      .toEqual(['exact original 中文', 'exact original response'])
    expect((await pool.query('SELECT state FROM session_lifecycle_jobs')).rows[0].state).toBe('partial')
  })
})
