import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest'
import Fastify from 'fastify'
import { registerSessionOrganizationRoutes } from '../session-organization/routes.js'
import type pg from 'pg'
import {
  initDB,
  advanceSessionActivity,
  restoreSessionActivity,
  withSessionMaterializationFence,
} from '../db.js'
import { admitSessionMessage } from '../session-message-admissions.js'
import { persistEventWithEffect } from '../db.js'
import { EventMaterializer } from '../materialization/event-materializer.js'
import { lifecycleTestPool } from './session-lifecycle-test-database.js'

// Authentication has its own regression suite; this fixture exercises the
// actual HTTP archive transaction against the isolated database.
vi.mock('../auth.js', () => ({
  verifyAccessTokenWithRevocation: async (token: string) =>
    token.startsWith('fixture-') ? { userId: Number(token.slice(8)) } : null,
}))

const suite =
  process.env.RUN_SESSION_LIFECYCLE_POSTGRES === '1' ? describe : describe.skip
suite('session lifecycle activity PostgreSQL', () => {
  let pool: pg.Pool, userId: number
  beforeAll(async () => {
    pool = await lifecycleTestPool()
    await initDB(pool)
  }, 30_000)
  afterAll(async () => {
    await pool?.end()
  })
  beforeEach(async () => {
    await pool.query(
      'TRUNCATE users, daemons, sessions, deleted_sessions, quota_reservations RESTART IDENTITY CASCADE',
    )
    userId = (
      await pool.query(
        "INSERT INTO users(email,password_hash) VALUES('activity@test.invalid','x') RETURNING id",
      )
    ).rows[0].id
    await pool.query(
      "INSERT INTO daemons(daemon_id,user_id) VALUES('activity-daemon',$1)",
      [userId],
    )
    await pool.query(
      `INSERT INTO sessions(session_id,user_id,daemon_id,status,last_activity_at)
      VALUES('activity-session',$1,'activity-daemon','exited','2026-01-01T00:00:00Z')`,
      [userId],
    )
  })
  const state = async () =>
    (
      await pool.query(`SELECT last_activity_at, last_business_activity_at,
    activity_epoch::text, activity_verified FROM sessions WHERE session_id='activity-session'`)
    ).rows[0]
  test('manual archive preserves intent and activity time across idempotent requests and restore', async () => {
    await pool.query(`UPDATE sessions SET archived_at='2026-03-02T00:00:00Z',archive_reason='inactivity'
      WHERE session_id='activity-session'`)
    const app = Fastify()
    registerSessionOrganizationRoutes(app, { pool, broadcast: () => {} })
    const update = (archived: boolean) =>
      app.inject({
        method: 'PUT',
        url: '/api/sessions/activity-session/archive',
        headers: { authorization: `Bearer fixture-${userId}` },
        payload: { archived },
      })
    try {
      expect((await update(true)).statusCode).toBe(200)
      const archived = (
        await pool.query(
          'SELECT archive_reason,archived_at,activity_epoch::text FROM sessions',
        )
      ).rows[0]
      expect(archived.archive_reason).toBe('manual')
      expect(archived.archived_at).toEqual(new Date('2026-03-02T00:00:00Z'))
      expect((await update(true)).statusCode).toBe(200)
      expect((await state()).activity_epoch).toBe(archived.activity_epoch)
      expect((await update(false)).statusCode).toBe(200)
      expect(
        (await pool.query('SELECT archive_reason,archived_at FROM sessions'))
          .rows[0],
      ).toEqual({ archive_reason: null, archived_at: null })
      expect((await state()).last_activity_at).toEqual(
        new Date('2026-01-01T00:00:00Z'),
      )
    } finally {
      await app.close()
    }
  })
  test('concurrent old discovery and new business activity never regress', async () => {
    await Promise.all([
      withSessionMaterializationFence(pool, 'activity-session', (db) =>
        advanceSessionActivity(
          db,
          'activity-session',
          new Date('2026-10-12T00:00:00Z'),
        ),
      ),
      withSessionMaterializationFence(pool, 'activity-session', (db) =>
        restoreSessionActivity(
          db,
          'activity-session',
          new Date('2026-01-02T00:00:00Z'),
        ),
      ),
    ])
    expect(await state()).toMatchObject({
      last_activity_at: new Date('2026-10-12T00:00:00Z'),
      activity_verified: true,
    })
    await restoreSessionActivity(
      pool,
      'activity-session',
      new Date('2026-01-03T00:00:00Z'),
    )
    expect((await state()).last_activity_at).toEqual(
      new Date('2026-10-12T00:00:00Z'),
    )
  })
  test('unknown legacy timestamp is not verified by an older snapshot', async () => {
    await restoreSessionActivity(
      pool,
      'activity-session',
      new Date('2025-12-01T00:00:00Z'),
    )
    expect(await state()).toMatchObject({
      activity_verified: false,
      activity_epoch: '0',
      last_activity_at: new Date('2026-01-01T00:00:00Z'),
    })
  })
  test('new trusted activity invalidates a scanned epoch and old snapshots cannot undo it', async () => {
    const scanned = await state()
    await advanceSessionActivity(
      pool,
      'activity-session',
      new Date('2026-10-12T00:00:00Z'),
    )
    expect((await state()).activity_epoch).not.toBe(scanned.activity_epoch)
    const epoch = (await state()).activity_epoch
    await restoreSessionActivity(
      pool,
      'activity-session',
      new Date('2026-01-01T00:00:00Z'),
    )
    expect((await state()).activity_epoch).toBe(epoch)
  })
  test.each(['running', 'exited'])(
    'new %s message admission invalidates epoch before late activity effect',
    async (status) => {
      await pool.query(
        "UPDATE sessions SET status=$1 WHERE session_id='activity-session'",
        [status],
      )
      const command = {
        type: 'user_message',
        session_id: 'activity-session',
        msg_id: 'request-1',
        content: 'hello',
      }
      const input = {
        userId,
        daemonId: 'activity-daemon',
        sessionId: 'activity-session',
        requestId: 'request-1',
        command,
        limit: null,
      }
      const old = await state()
      expect(await admitSessionMessage(pool, input)).toMatchObject({
        kind: status === 'running' ? 'continue' : 'resume',
      })
      const accepted = await state()
      expect(accepted.activity_epoch).not.toBe(old.activity_epoch)
      expect(accepted.last_activity_at).toEqual(old.last_activity_at)
      await admitSessionMessage(pool, input)
      expect((await state()).activity_epoch).toBe(accepted.activity_epoch)
    },
  )
  test('forbidden and conflicting messages do not invalidate lifecycle state', async () => {
    await admitSessionMessage(pool, {
      userId,
      daemonId: 'wrong-daemon',
      sessionId: 'activity-session',
      requestId: 'denied',
      command: {},
      limit: null,
    })
    expect((await state()).activity_epoch).toBe('0')
  })
  test('pending receipt from the old effect layout resumes its newly appended activity step', async () => {
    await pool.query(
      "UPDATE sessions SET status='running' WHERE session_id='activity-session'",
    )
    const input = {
      userId,
      daemonId: 'activity-daemon',
      sessionId: 'activity-session',
      requestId: 'old-receipt',
      command: {
        type: 'user_message',
        session_id: 'activity-session',
        msg_id: 'message',
        content: 'hello',
      },
      limit: null,
    }
    await admitSessionMessage(pool, input)
    await pool.query(`UPDATE session_message_admissions SET state='completed',outcome='accepted',
      claimed_outcome='accepted',completed_at=NOW() WHERE request_id='old-receipt'`)
    const payload = {
      type: 'user_message_receipt',
      session_id: 'activity-session',
      request_id: 'old-receipt',
      msg_id: 'message',
      status: 'accepted',
    }
    const event = await persistEventWithEffect(
      pool,
      'activity-session',
      'user_message_receipt',
      payload,
      5,
      userId,
    )
    // Legacy steps 0/1 completed admission and quota broadcast. The process
    // crashed before the overall completed marker; the new effect belongs at 2.
    await pool.query('UPDATE events SET effect_step=2 WHERE id=$1', [
      event.rowID,
    ])
    const receivedAt = new Date('2026-10-12T00:00:00Z')
    const result = await new EventMaterializer({ pool }).materialize({
      inboxId: 100,
      userId,
      daemonId: 'activity-daemon',
      sessionId: 'activity-session',
      eventType: 'user_message_receipt',
      payload,
      receivedAt,
    })
    expect(result.eventId).toBe(event.rowID)
    expect((await state()).last_activity_at).toEqual(receivedAt)
    expect(
      (
        await pool.query(
          'SELECT effect_step,effect_status FROM events WHERE id=$1',
          [event.rowID],
        )
      ).rows[0],
    ).toEqual({ effect_step: 3, effect_status: 'completed' })
  })
})
