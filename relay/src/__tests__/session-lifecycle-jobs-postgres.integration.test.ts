import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import type pg from 'pg'
import { initDB } from '../db.js'
import {
  initSessionLifecycleSchema,
  assertSessionLifecycleSchema,
} from '../session-lifecycle/schema.js'
import { LifecycleJobRepository } from '../session-lifecycle/repository.js'
import { lifecycleTestPool } from './session-lifecycle-test-database.js'

const suite =
  process.env.RUN_SESSION_LIFECYCLE_POSTGRES === '1' ? describe : describe.skip
suite('session lifecycle jobs PostgreSQL', () => {
  let pool: pg.Pool, jobs: LifecycleJobRepository, userId: number
  beforeAll(async () => {
    pool = await lifecycleTestPool()
    await initDB(pool)
    jobs = new LifecycleJobRepository(pool)
  }, 30_000)
  afterAll(async () => {
    await pool?.end()
  })
  beforeEach(async () => {
    await pool.query(
      'TRUNCATE users, daemons, sessions, deleted_sessions RESTART IDENTITY CASCADE',
    )
    userId = (
      await pool.query(
        "INSERT INTO users(email,password_hash) VALUES('lifecycle@test.invalid','x') RETURNING id",
      )
    ).rows[0].id
  })
  const create = () =>
    jobs.enqueue({
      userId,
      sessionId: 'session-1',
      action: 'archive',
      policyVersion: 'session-lifecycle-v2',
      activityEpoch: '0',
    })
  test('incremental schema reruns and keeps existing hot payloads', async () => {
    await pool.query(
      "INSERT INTO events(session_id,event_type,payload) VALUES('old-session','agent_text','{\"text\":\"历史\"}')",
    )
    await initSessionLifecycleSchema(pool)
    await initSessionLifecycleSchema(pool)
    await expect(assertSessionLifecycleSchema(pool)).resolves.toBeUndefined()
    expect(
      (await pool.query('SELECT payload FROM events')).rows[0].payload,
    ).toEqual({ text: '历史' })
  })
  test('unique operation survives duplicate enqueue and concurrent worker claim', async () => {
    const [one, two] = await Promise.all([create(), create()])
    expect(one.operationId).toBe(two.operationId)
    const claims = await Promise.all([
      jobs.claim('worker-a', 30_000),
      jobs.claim('worker-b', 30_000),
    ])
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(claims.find(Boolean)).toMatchObject({
      operationId: one.operationId,
      attempt: 1,
    })
  })
  test('expired lease takeover rejects stale completion and renewal', async () => {
    await create()
    const old = (await jobs.claim('worker-a', 30_000))!
    await pool.query(
      "UPDATE session_lifecycle_jobs SET lease_until=NOW()-interval '1 second'",
    )
    const next = (await jobs.claim('worker-b', 30_000))!
    expect(next.leaseToken).not.toBe(old.leaseToken)
    expect(next.attempt).toBe(2)
    expect(await jobs.finish(old, 'succeeded', { reason: 'old' })).toBe(false)
    expect(await jobs.renew(old, 30_000)).toBe(false)
    expect(await jobs.finish(next, 'succeeded', { reason: 'complete' })).toBe(
      true,
    )
    expect(await jobs.claim('worker-c', 30_000)).toBeNull()
    expect((await pool.query('SELECT attempt,state,finished_at IS NOT NULL AS ended FROM session_lifecycle_attempts ORDER BY attempt')).rows)
      .toEqual([{attempt:1,state:'expired',ended:true},{attempt:2,state:'succeeded',ended:true}])
  })
  test('failed operation retries with the same business ID and a new attempt', async () => {
    await create()
    const first = (await jobs.claim('worker', 30_000))!
    expect(
      await jobs.finish(first, 'failed', { reason: 'object_unavailable' }, 0),
    ).toBe(true)
    const retry = (await jobs.claim('worker', 30_000))!
    expect(retry.operationId).toBe(first.operationId)
    expect(retry.attempt).toBe(2)
  })
  test('checks reject malformed state and leases; account deletion clears new metadata', async () => {
    const job = await create()
    await expect(
      pool.query(
        "UPDATE session_lifecycle_jobs SET state='running' WHERE operation_id=$1",
        [job.operationId],
      ),
    ).rejects.toThrow()
    await pool.query('DELETE FROM users WHERE id=$1', [userId])
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM session_lifecycle_jobs',
        )
      ).rows[0].n,
    ).toBe(0)
  })
})
