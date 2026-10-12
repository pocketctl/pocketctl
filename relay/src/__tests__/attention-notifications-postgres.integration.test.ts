import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import type pg from 'pg'
import Fastify from 'fastify'
import { registerAttentionNotificationRoutes } from '../attention-inbox/notification-routes.js'
import { initDB } from '../db.js'
import { AttentionNotificationRepository } from '../attention-inbox/notification-repository.js'
import { LifecycleJobRepository } from '../session-lifecycle/repository.js'
import { lifecycleTestPool } from './session-lifecycle-test-database.js'

const suite =
  process.env.RUN_SESSION_LIFECYCLE_POSTGRES === '1' ? describe : describe.skip
suite('Attention system notifications PostgreSQL', () => {
  let pool: pg.Pool,
    repository: AttentionNotificationRepository,
    userId: number,
    otherId: number
  beforeAll(async () => {
    pool = await lifecycleTestPool()
    await initDB(pool)
    repository = new AttentionNotificationRepository(pool, 'test-cursor-secret')
  }, 30_000)
  afterAll(async () => {
    await pool?.end()
  })
  beforeEach(async () => {
    await pool.query(
      'TRUNCATE users, daemons, sessions, deleted_sessions RESTART IDENTITY CASCADE',
    )
    const ids = await pool.query(
      "INSERT INTO users(email,password_hash) VALUES('notice@test.invalid','x'),('other@test.invalid','x') RETURNING id",
    )
    userId = ids.rows[0].id
    otherId = ids.rows[1].id
    await pool.query(
      "INSERT INTO daemons(daemon_id,user_id) VALUES('host-a',$1),('host-b',$1),('other-host',$2)",
      [userId, otherId],
    )
  })
  async function record(
    sessionId = 'session-a',
    daemonId = 'host-a',
    notificationId = randomUUID(),
    state: 'succeeded' | 'failed' = 'succeeded',
  ) {
    const job = await new LifecycleJobRepository(pool).enqueue({
      userId,
      sessionId,
      action: 'archive',
      policyVersion: 'session-lifecycle-v1',
      activityEpoch: '1',
    })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await repository.recordResultInTransaction(client, {
        operationId: job.operationId,
        notificationId,
        userId,
        sessionId,
        daemonId,
        titleSnapshot: sessionId,
        daemonNameSnapshot: daemonId,
        action: 'archive',
        state,
        activityAt: '2026-01-01T00:00:00Z',
        reasonCode: 'inactivity_60_days',
        retentionDays: 90,
      })
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
  test('same result is idempotent; retries update original notification revision', async () => {
    const id = randomUUID()
    await record('session-a', 'host-a', id, 'failed')
    await record('session-a', 'host-a', randomUUID(), 'failed')
    const first = await repository.get(userId, id)
    expect(first?.revision).toBe(1)
    const readOnly = await repository.list({ userId, limit: 10, read: true })
    expect(readOnly.notifications).toHaveLength(0)
    expect(readOnly.unread).toBe(1)
    await record('session-a', 'host-a', randomUUID(), 'succeeded')
    const next = await repository.get(userId, id)
    expect(next?.revision).toBe(2)
    expect(next?.subjects[0].state).toBe('succeeded')
    expect(
      (await repository.list({ userId, limit: 10 })).notifications,
    ).toHaveLength(1)
  })
  test('database rollback never leaves a business result without its notification', async () => {
    const job = await new LifecycleJobRepository(pool).enqueue({
      userId,
      sessionId: 'rollback',
      action: 'purge',
      policyVersion: 'v1',
      activityEpoch: '1',
    })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await repository.recordResultInTransaction(client, {
        operationId: job.operationId,
        notificationId: randomUUID(),
        userId,
        sessionId: 'rollback',
        daemonId: 'host-a',
        titleSnapshot: 'secret',
        daemonNameSnapshot: 'host',
        action: 'purge',
        state: 'succeeded',
        activityAt: '2026-01-01T00:00:00Z',
        reasonCode: 'inactivity_90_days',
        retentionDays: 90,
      })
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM session_lifecycle_results',
        )
      ).rows[0].n,
    ).toBe(0)
    expect(
      (await repository.list({ userId, limit: 10 })).notifications,
    ).toEqual([])
  })
  test('durable notification delivery survives listener gaps and concurrent drain workers', async () => {
    await record()
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM notification_delivery_outbox WHERE delivered_at IS NULL',
        )
      ).rows[0].n,
    ).toBe(1)
    const results = await Promise.all([
      repository.deliverPending(10),
      repository.deliverPending(10),
    ])
    expect(results.reduce((a, b) => a + b, 0)).toBe(1)
    expect(
      (await repository.list({ userId, limit: 10 })).notifications,
    ).toHaveLength(1)
    expect(await repository.deliverPending(10)).toBe(0)
  })
  test('equivalent stage maps do not create duplicate revisions', async () => {
    const job = await new LifecycleJobRepository(pool).enqueue({
      userId,
      sessionId: 'stages',
      action: 'purge',
      policyVersion: 'v1',
      activityEpoch: '1',
    })
    const notificationId = randomUUID()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const base = {
        operationId: job.operationId,
        notificationId,
        userId,
        sessionId: 'stages',
        daemonId: 'host-a',
        titleSnapshot: 'stages',
        daemonNameSnapshot: 'host',
        action: 'purge' as const,
        state: 'partial' as const,
        activityAt: '2026-01-01T00:00:00Z',
        reasonCode: 'external_pending',
        retentionDays: 90,
      }
      const first = await repository.recordResultInTransaction(client, {
        ...base,
        stages: { memory: 'pending', relay: 'succeeded' },
      })
      const same = await repository.recordResultInTransaction(client, {
        ...base,
        stages: { relay: 'succeeded', memory: 'pending' },
      })
      expect(same.revision).toBe(first.revision)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })
  test('per-host filtering only returns its subjects and counts', async () => {
    const id = randomUUID()
    await record('session-a', 'host-a', id)
    await record('session-b', 'host-b', id)
    const scoped = await repository.get(userId, id, 'host-a')
    expect(scoped?.subjectCount).toBe(1)
    expect(scoped?.subjects.map((s) => s.title)).toEqual(['session-a'])
    expect(
      (await repository.list({ userId, daemonId: 'host-a', limit: 10 })).unread,
    ).toBe(1)
    expect(await repository.get(otherId, id)).toBeNull()
    await pool.query("UPDATE daemons SET user_id=$1 WHERE daemon_id='host-a'", [
      otherId,
    ])
    expect(await repository.get(userId, id, 'host-a')).toBeNull()
    expect(
      (await repository.get(userId, id))?.subjects.map((s) => s.title),
    ).toEqual(['session-b'])
  })
  test('subject stable cursor pages and read CAS are independent from approvals/activity', async () => {
    const id = randomUUID()
    for (let i = 0; i < 5; i++) await record(`session-${i}`, 'host-a', id)
    const first = await repository.subjects({
      userId,
      notificationId: id,
      limit: 2,
    })
    const second = await repository.subjects({
      userId,
      notificationId: id,
      limit: 2,
      cursor: first!.nextCursor,
    })
    expect(
      new Set([...first!.subjects, ...second!.subjects].map((s) => s.id)).size,
    ).toBe(4)
    const notification = (await repository.get(userId, id))!
    expect(
      await repository.markRead(userId, id, notification.revision - 1),
    ).toBe('stale_revision')
    expect(await repository.markRead(userId, id, notification.revision)).toBe(
      'read',
    )
    expect(await repository.markRead(userId, id, notification.revision)).toBe(
      'read',
    )
    expect((await repository.list({ userId, limit: 10 })).unread).toBe(0)
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM attention_items'))
        .rows[0].n,
    ).toBe(0)
  })
  test('removed sessions use summary detail; expiry removes all subject summaries', async () => {
    const id = randomUUID()
    await pool.query(
      "INSERT INTO sessions(session_id,user_id,daemon_id) VALUES('session-a',$1,'host-a')",
      [userId],
    )
    await record('session-a', 'host-a', id)
    expect(
      (await repository.get(userId, id))?.subjects[0].navigation.type,
    ).toBe('session')
    await pool.query("DELETE FROM sessions WHERE session_id='session-a'")
    const deleted = (await repository.get(userId, id))!
    expect(deleted.subjects[0].navigation.type).toBe('lifecycle_detail')
    await pool.query(
      "UPDATE attention_notifications SET expires_at=NOW()-interval '1 second'",
    )
    expect(await repository.get(userId, id)).toBeNull()
    expect(await repository.expire(10)).toBe(1)
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM attention_notification_subjects',
        )
      ).rows[0].n,
    ).toBe(0)
    expect(
      (await pool.query('SELECT title_snapshot FROM session_lifecycle_results'))
        .rows[0].title_snapshot,
    ).toBe('')
    await record('session-a', 'host-a', randomUUID())
    expect(
      (await repository.list({ userId, limit: 10 })).notifications,
    ).toHaveLength(0)
  })
  test('HTTP API authenticates every detail, paginates subjects and accepts read only', async () => {
    const id = randomUUID()
    await record('session-a', 'host-a', id)
    const app = Fastify()
    registerAttentionNotificationRoutes(app, {
      pool,
      repository,
      enabled: true,
      verifyAccessToken: async (token) =>
        token === 'owner'
          ? { userId }
          : token === 'other'
            ? { userId: otherId }
            : null,
    })
    try {
      expect(
        (await app.inject({ url: `/api/attention/notifications/${id}` }))
          .statusCode,
      ).toBe(401)
      expect(
        (
          await app.inject({
            url: `/api/attention/notifications/${id}`,
            headers: { authorization: 'Bearer other' },
          })
        ).statusCode,
      ).toBe(404)
      const response = await app.inject({
        url: '/api/attention/notifications',
        headers: { authorization: 'Bearer owner' },
      })
      expect(response.statusCode).toBe(200)
      const notice = response.json().notifications[0]
      expect(notice.requires_approval).toBe(false)
      const headers = { authorization: 'Bearer owner' }
      await pool.query(`INSERT INTO sessions(session_id,daemon_id,user_id,title,status) VALUES('navigation-session','host-a',$1,'Navigation fixture','idle')`, [userId])
      expect((await app.inject({ url: '/api/sessions/navigation-session' })).statusCode).toBe(401)
      expect((await app.inject({ url: '/api/sessions/navigation-session', headers: { authorization: 'Bearer other' } })).statusCode).toBe(404)
      const metadata = await app.inject({ url: '/api/sessions/navigation-session', headers })
      expect(metadata.statusCode).toBe(200)
      expect(metadata.json().session.title).toBe('Navigation fixture')
      expect(metadata.headers['cache-control']).toContain('no-store')
      await pool.query(`UPDATE daemons SET user_id=$1 WHERE daemon_id='host-a'`, [otherId])
      expect((await app.inject({ url: '/api/sessions/navigation-session', headers })).statusCode).toBe(404)
      await pool.query(`UPDATE daemons SET user_id=$1 WHERE daemon_id='host-a'`, [userId])
      await pool.query(`UPDATE sessions SET content_state='deleting' WHERE session_id='navigation-session'`)
      expect((await app.inject({ url: '/api/sessions/navigation-session', headers })).statusCode).toBe(404)
      const subject = notice.subject_preview[0].subject_id
      expect(
        (
          await app.inject({
            url: `/api/attention/notifications/${id}/subjects/${subject}`,
            headers,
          })
        ).statusCode,
      ).toBe(200)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/attention/notifications/${id}/read`,
            headers,
            payload: { expected_revision: notice.revision },
          })
        ).statusCode,
      ).toBe(200)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/attention/notifications/${id}/actions`,
            headers,
            payload: { action: 'approve' },
          })
        ).statusCode,
      ).toBe(404)
      expect(
        (
          await app.inject({
            url: '/api/attention/notifications?limit=1000000',
            headers,
          })
        ).statusCode,
      ).toBe(400)
    } finally {
      await app.close()
    }
  })
})
