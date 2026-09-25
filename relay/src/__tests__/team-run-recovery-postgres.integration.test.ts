import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { initDB } from '../db.js'
import { TeamContextService } from '../team/context-service.js'
import { TeamRepository } from '../team/repository.js'
import { TeamRunRepository } from '../team/run-repository.js'
import { TeamRunWorker } from '../team/run-worker.js'
import { TeamSessionService } from '../team/session-service.js'
import { TeamTaskService } from '../team/task-service.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = enabled ? describe : describe.skip

describeWithDatabase('Team run recovery (PostgreSQL)', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    const database = decodeURIComponent(url.pathname.slice(1))
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
      || !/test/i.test(database) || decodeURIComponent(url.username) !== database) {
      throw new Error('Refusing Team run integration test outside the isolated test database')
    }
    pool = new pg.Pool({ connectionString: databaseUrl })
    const identity = await pool.query<{ database: string; user: string; superuser: boolean }>(`
      SELECT current_database() AS database, current_user AS "user",
             (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser
    `)
    if (identity.rows[0]?.database !== database || identity.rows[0]?.user !== database || identity.rows[0]?.superuser) {
      throw new Error('Unexpected Team run test database identity')
    }
    await initDB(pool)
  }, 30_000)

  afterAll(async () => {
    if (pool) {
      await pool.query(`TRUNCATE users, daemons RESTART IDENTITY CASCADE`)
      await pool.end()
    }
  })

  test('fences an expired worker and never repeats an uncertain call after restart', async () => {
    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password_hash) VALUES ('run.owner@example.test', 'x') RETURNING id`,
    )
    const ownerUserId = user.rows[0].id
    const teams = new TeamRepository(pool)
    const created = await teams.createTeam({ actorUserId: ownerUserId, name: 'Run recovery team', requestId: 'run-team' })
    await pool.query(
      `INSERT INTO daemons (daemon_id, hostname, agents, status, user_id, collaboration_capabilities)
       VALUES ('run-daemon', 'run-host', '[{"type":"codex","manageable":true}]'::jsonb,
               'online', $1, '["team_collaboration_dispatch_v1","team_collaboration_context_v1","team_collaboration_reconcile_v1"]'::jsonb)`,
      [ownerUserId],
    )
    const offer = await teams.addAgentOffer({
      teamId: created.team.id, actorUserId: ownerUserId, daemonId: 'run-daemon', provider: 'codex',
      runtimeProfileId: null, expectedRevision: 1, requestId: 'run-offer',
    })
    const task = await new TeamTaskService(pool).createTask({
      teamId: created.team.id, actorUserId: ownerUserId, title: 'Independent task', background: '', requestId: 'run-task',
    })
    const shared = await new TeamSessionService(pool).createSession({
      teamId: created.team.id, actorUserId: ownerUserId, title: 'Run session', taskId: task.id,
      offerIds: [offer.id], requestId: 'run-session',
    })
    const context = await new TeamContextService(pool).create({
      sessionId: shared.id, actorUserId: ownerUserId, expectedRevision: 0, requestId: 'run-context',
      goal: 'Reach a bounded result', consensus: [], openQuestions: [], references: [],
    })
    const repository = new TeamRunRepository(pool)
    const createdRun = await repository.create({
      sessionId: shared.id, actorUserId: ownerUserId, coordinatorOfferId: offer.id,
      contextVersion: context.context.version,
      budget: { max_calls: 3, max_concurrent_calls: 1, max_duration_seconds: 1_800 }, requestId: 'run-create',
    })

    const staleLease = await repository.claimNext('worker-before-crash', 1_000)
    expect(staleLease?.run.id).toBe(createdRun.run.id)
    await pool.query(`UPDATE collaboration_runs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE run_id = $1`, [createdRun.run.id])
    const recoveredLease = await repository.claimNext('worker-after-restart', 15_000)
    expect(recoveredLease!.leaseToken).toBeGreaterThan(staleLease!.leaseToken)
    await expect(repository.scheduleCall({
      runId: createdRun.run.id, leaseToken: staleLease!.leaseToken, offerId: offer.id,
      role: 'coordinator', content: 'stale dispatch', processedCallStep: 0,
    })).rejects.toThrow(/lease lost/)
    const scheduled = await repository.scheduleCall({
      runId: createdRun.run.id, leaseToken: recoveredLease!.leaseToken, offerId: offer.id,
      role: 'coordinator', content: 'bounded coordinator dispatch', processedCallStep: 0,
    })
    expect(scheduled.callId).toMatch(/^ccl_/)
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM collaboration_calls WHERE run_id = $1`, [createdRun.run.id])).rows[0].count).toBe(1)

    const current = await repository.get(createdRun.run.id, ownerUserId)
    const paused = await repository.control({
      runId: createdRun.run.id, actorUserId: ownerUserId, action: 'pause',
      expectedRevision: current.revision, requestId: 'run-pause',
    })
    expect(paused.run.state).toBe('paused')
    expect((await repository.control({
      runId: createdRun.run.id, actorUserId: ownerUserId, action: 'pause',
      expectedRevision: current.revision, requestId: 'run-pause',
    })).run.revision).toBe(paused.run.revision)
    const resumed = await repository.control({
      runId: createdRun.run.id, actorUserId: ownerUserId, action: 'resume',
      expectedRevision: paused.run.revision, requestId: 'run-resume',
    })
    expect(resumed.run.state).toBe('running')

    await pool.query(`UPDATE collaboration_calls SET state = 'uncertain', outcome = 'dispatch_timeout' WHERE call_id = $1`, [scheduled.callId])
    await pool.query(`UPDATE collaboration_runs SET next_wake_at = NOW() WHERE run_id = $1`, [createdRun.run.id])
    const restartedWorker = new TeamRunWorker({ repository, workerId: 'worker-second-restart' })
    expect(await restartedWorker.runOnce()).toBe(true)
    expect((await repository.get(createdRun.run.id, ownerUserId))).toMatchObject({
      state: 'blocked', terminal_reason: 'dispatch_uncertain', calls_used: 1,
    })
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM collaboration_calls WHERE run_id = $1`, [createdRun.run.id])).rows[0].count).toBe(1)
    expect((await new TeamTaskService(pool).getTask(task.id, ownerUserId)).state).toBe('open')
  })
})
