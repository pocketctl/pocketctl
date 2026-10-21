import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import type pg from 'pg'
import { cleanStaleSessions, initDB, reconcileDaemonSessions, upsertSession } from '../db.js'
import { lifecycleTestPool } from './session-lifecycle-test-database.js'

const suite = process.env.RUN_SESSION_LIFECYCLE_POSTGRES === '1' ? describe : describe.skip
suite('terminal session turn reconciliation', () => {
  let pool: pg.Pool, userId: number
  const turn = new Date('2026-08-01T00:00:00Z')
  beforeAll(async () => { pool = await lifecycleTestPool(); await initDB(pool) }, 30_000)
  afterAll(async () => { await pool?.end() })
  beforeEach(async () => {
    await pool.query('TRUNCATE users,daemons,sessions RESTART IDENTITY CASCADE')
    userId = (await pool.query("INSERT INTO users(email,password_hash) VALUES('terminal@test.invalid','x') RETURNING id")).rows[0].id
    await pool.query("INSERT INTO daemons(daemon_id,user_id,status,registration_id,last_heartbeat) VALUES('terminal-daemon',$1,'online','current',NOW())", [userId])
    await pool.query(`INSERT INTO sessions(session_id,user_id,daemon_id,status,turn_started_at,last_activity_at,activity_verified)
      VALUES('ended',$1,'terminal-daemon','running',$2,$2,true),('live',$1,'terminal-daemon','running',$2,$2,true)`, [userId, turn])
  })
  const state = async (id = 'ended') => (await pool.query('SELECT status,turn_started_at,last_activity_at FROM sessions WHERE session_id=$1', [id])).rows[0]
  test('discovery of an inactive session clears its old turn without changing activity', async () => {
    await upsertSession(pool, 'ended', 'terminal-daemon', 'codex', '/test', 'exited', undefined, 'terminal', undefined, userId)
    expect(await state()).toEqual({ status: 'exited', turn_started_at: null, last_activity_at: turn })
    await upsertSession(pool, 'live', 'terminal-daemon', 'codex', '/test', 'busy', undefined, 'terminal', undefined, userId)
    expect((await state('live')).turn_started_at).toEqual(turn)
  })
  test('offline cleanup clears the ended turn', async () => {
    await pool.query("UPDATE daemons SET status='offline',last_heartbeat=NOW()-interval '1 hour'")
    await cleanStaleSessions(pool)
    expect(await state()).toEqual({ status: 'completed', turn_started_at: null, last_activity_at: turn })
  })
  test('current registration reconciliation clears only absent sessions', async () => {
    expect(await reconcileDaemonSessions(pool, 'terminal-daemon', ['live'], 'stale')).toEqual([])
    expect((await state()).turn_started_at).toEqual(turn)
    expect(await reconcileDaemonSessions(pool, 'terminal-daemon', ['live'], 'current')).toEqual(['ended'])
    expect(await state()).toEqual({ status: 'completed', turn_started_at: null, last_activity_at: turn })
    expect(await state('live')).toEqual({ status: 'running', turn_started_at: turn, last_activity_at: turn })
  })
})
