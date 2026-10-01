import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { TeamRepository } from '../team/repository.js'
import { TeamSessionService } from '../team/session-service.js'
import { TeamContextService } from '../team/context-service.js'
import { TeamRunRepository } from '../team/run-repository.js'
import { TeamRunWorker } from '../team/run-worker.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const describeWithDatabase = databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

describeWithDatabase('Team mutation authorization (PostgreSQL)', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    const database = decodeURIComponent(url.pathname.slice(1))
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
      || !/test/i.test(database) || decodeURIComponent(url.username) !== database) {
      throw new Error('Refusing Team acceptance test outside the isolated test database')
    }
    pool = new pg.Pool({ connectionString: databaseUrl })
    const identity = (await pool.query(`SELECT current_database() AS database, current_user AS "user",
      (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`)).rows[0]
    if (identity.database !== database || identity.user !== database || identity.superuser) throw new Error('Unexpected test database identity')
    await initDB(pool)
  }, 30_000)
  afterAll(async () => {
    if (pool) { await pool.query('TRUNCATE users, daemons RESTART IDENTITY CASCADE'); await pool.end() }
  })

  async function fixture() {
    const key = randomUUID()
    const users = (await pool.query(`INSERT INTO users (email, password_hash, team_enabled) VALUES ($1, 'x',true), ($2, 'x',true) RETURNING id`, [`${key}.owner@example.test`, `${key}.member@example.test`])).rows
    const owner = Number(users[0].id), member = Number(users[1].id)
    const teams = new TeamRepository(pool), service = new TeamSessionService(pool)
    const team = (await teams.createTeam({ actorUserId: owner, name: 'Acceptance', requestId: key })).team
    const invitation = await teams.invite({ teamId: team.id, actorUserId: owner, email: `${key}.member@example.test`, expectedRevision: 1, requestId: key })
    const accepted = await teams.respondToInvitation({ invitationId: invitation.id, actorUserId: member, action: 'accepted', expectedRevision: 1, requestId: key })
    const daemonIds = [`${key}-one`, `${key}-two`]
    await pool.query(`INSERT INTO daemons (daemon_id, hostname, agents, status, user_id, collaboration_capabilities)
      VALUES ($1, 'one', '[{"type":"codex","manageable":true}]', 'online', $2,
        '["team_collaboration_dispatch_v1","team_collaboration_context_v1"]'),
      ($3, 'two', '[{"type":"codex","manageable":true}]', 'online', $4,
        '["team_collaboration_dispatch_v1","team_collaboration_context_v1"]')`, [daemonIds[0], owner, daemonIds[1], member])
    const first = await teams.addAgentOffer({ teamId: team.id, actorUserId: owner, daemonId: daemonIds[0], provider: 'codex', runtimeProfileId: null, expectedRevision: 3, requestId: key })
    const second = await teams.addAgentOffer({ teamId: team.id, actorUserId: member, daemonId: daemonIds[1], provider: 'codex', runtimeProfileId: null, expectedRevision: 4, requestId: key })
    const session = await service.createSession({ teamId: team.id, actorUserId: member, title: 'Acceptance', taskId: null, offerIds: [first.id, second.id], requestId: key })
    const contexts = new TeamContextService(pool), runs = new TeamRunRepository(pool)
    const sessionInput = { teamId: team.id, actorUserId: member, title: 'Acceptance', taskId: null, offerIds: [first.id, second.id], requestId: key }
    const contextInput = { sessionId: session.id, actorUserId: member, expectedRevision: 0, requestId: key, goal: 'Bounded task', consensus: [], openQuestions: [], references: [] }
    const context = await contexts.create(contextInput)
    const runInput = { sessionId: session.id, actorUserId: member, coordinatorOfferId: second.id, contextVersion: 1, budget: { max_calls: 5, max_concurrent_calls: 1, max_duration_seconds: 1800 }, requestId: key }
    const run = await runs.create(runInput)
    return { contexts, runs, context, run, sessionInput, contextInput, runInput, key, owner, member, teams, service, team, session, first, second, daemonIds, membership: accepted.membership! }
  }


  async function waiting(f: Awaited<ReturnType<typeof fixture>>) {
    await pool.query("UPDATE collaboration_runs SET state='waiting_input', waiting_question='Question?' WHERE run_id=$1", [f.run.run.id])
    return { runId: f.run.run.id, actorUserId: f.member, expectedRevision: (await f.runs.get(f.run.run.id, f.member)).revision, content: 'Answer', requestId: 'answer' }
  }
  async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
    return (await pool.query(`SELECT session.revision, session.current_context_version, session.latest_event_seq,
      run.state, run.revision AS run_revision, run.stop_requested, run.calls_used, run.waiting_question,
      (SELECT count(*)::int FROM collaboration_calls WHERE team_session_id=session.team_session_id) AS calls,
      (SELECT count(*)::int FROM collaboration_events WHERE team_session_id=session.team_session_id) AS events,
      (SELECT count(*)::int FROM collaboration_team_idempotency WHERE user_id=$2) AS caches
      FROM collaboration_sessions session JOIN collaboration_runs run USING (team_session_id)
      WHERE session.team_session_id=$1`, [f.session.id, f.member])).rows[0]
  }
  async function revoke(f: Awaited<ReturnType<typeof fixture>>, action: 'removed' | 'left' | 'dissolved') {
    if (action === 'removed') await f.teams.removeMember({ teamId: f.team.id, membershipId: f.membership.id, actorUserId: f.owner, expectedRevision: f.membership.revision, requestId: 'remove' })
    else if (action === 'left') await f.teams.leaveTeam({ teamId: f.team.id, actorUserId: f.member, expectedRevision: f.membership.revision, requestId: 'leave' })
    else await f.teams.dissolveTeam({ teamId: f.team.id, actorUserId: f.owner, expectedRevision: (await f.teams.getTeam(f.team.id, f.owner)).revision, requestId: 'dissolve' })
  }

  test.each(['paused', 'ended', 'archived'] as const)('F22 fences fresh input and resume in a %s session without any mutation', async state => {
    const f = await fixture(), input = await waiting(f)
    await f.service.updateSession({ sessionId: f.session.id, actorUserId: f.member, state, expectedRevision: 1, requestId: 'end' })
    const before = await snapshot(f)
    await expect(f.runs.supplement(input)).rejects.toMatchObject({ code: 'invalid_state' })
    await expect(f.runs.control({ runId: f.run.run.id, actorUserId: f.member, action: 'resume', expectedRevision: input.expectedRevision, requestId: 'resume' })).rejects.toMatchObject({ code: 'invalid_state' })
    expect(await snapshot(f)).toEqual(before)
    // Ending a session still permits stopping and settling accepted work.
    const stopped = await f.runs.control({ runId: f.run.run.id, actorUserId: f.member, action: 'cancel', expectedRevision: input.expectedRevision, requestId: 'cancel' })
    expect(stopped.run.stop_requested).toBe(true)
    const worker = new TeamRunWorker({ repository: f.runs, workerId: f.key })
    expect(await worker.runOnce()).toBe(true)
    expect(await f.runs.get(f.run.run.id, f.member)).toMatchObject({ state: 'cancelled', calls_used: 0 })
  })

  for (const revocation of ['removed', 'left', 'dissolved'] as const) {
    test.each(['pause', 'resume', 'cancel'] as const)(`F23 denies fresh %s after creator membership is ${revocation}`, async action => {
      const f = await fixture(), input = await waiting(f)
      await revoke(f, revocation)
      const before = await snapshot(f)
      await expect(f.runs.get(f.run.run.id, f.member)).rejects.toMatchObject({ code: 'team_not_found' })
      await expect(f.runs.control({ runId: f.run.run.id, actorUserId: f.member, action, expectedRevision: input.expectedRevision, requestId: action })).rejects.toMatchObject({ code: 'team_not_found' })
      expect(await snapshot(f)).toEqual(before)
    })
    test.each(['session', 'context', 'run', 'control', 'input'] as const)(`F24 denies cached %s after membership is ${revocation}`, async operation => {
      const f = await fixture()
      const controlInput = { runId: f.run.run.id, actorUserId: f.member, action: 'pause' as const, expectedRevision: 1, requestId: 'pause' }
      await f.runs.control(controlInput)
      const input = await waiting(f)
      await f.runs.supplement(input)
      await revoke(f, revocation)
      const before = await snapshot(f)
      const replay = () => operation === 'session' ? f.service.createSession(f.sessionInput)
        : operation === 'context' ? f.contexts.create(f.contextInput)
        : operation === 'run' ? f.runs.create(f.runInput)
        : operation === 'control' ? f.runs.control(controlInput) : f.runs.supplement(input)
      await expect(replay()).rejects.toMatchObject({ code: 'team_not_found' })
      expect(await snapshot(f)).toEqual(before)
    })
  }

  test('authorized old-CAS replays return original results after state and Context advance', async () => {
    const f = await fixture()
    const controlInput = { runId: f.run.run.id, actorUserId: f.member, action: 'pause' as const, expectedRevision: 1, requestId: 'pause' }
    const paused = await f.runs.control(controlInput), input = await waiting(f)
    const supplemented = await f.runs.supplement(input)
    await f.contexts.create({ ...f.contextInput, expectedRevision: 1, requestId: 'context-new', goal: 'New context' })
    await f.service.updateSession({ sessionId: f.session.id, actorUserId: f.member, state: 'ended', expectedRevision: 1, requestId: 'end' })
    const before = await snapshot(f)
    expect(await f.service.createSession(f.sessionInput)).toEqual(f.session)
    expect(await f.contexts.create(f.contextInput)).toEqual(f.context)
    expect(await f.runs.create(f.runInput)).toEqual({ ...f.run, replayed: true })
    expect(await f.runs.control(controlInput)).toEqual({ ...paused, replayed: true })
    expect(await f.runs.supplement(input)).toEqual({ ...supplemented, replayed: true })
    expect(await snapshot(f)).toEqual(before)
    await expect(f.runs.supplement({ ...input, content: 'Different' })).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  test('F22 serializes input against an uncommitted session end', async () => {
    const f = await fixture(), input = await waiting(f), client = await pool.connect()
    let outcome: unknown
    try {
      await client.query('BEGIN')
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await client.query("UPDATE collaboration_sessions SET state='ended' WHERE team_session_id=$1", [f.session.id])
      const pending = f.runs.supplement(input).then(value => { outcome = value }, error => { outcome = error })
      await expect.poll(async () => outcome !== undefined || (await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rowCount! > 0).toBe(true)
      await client.query('COMMIT'); await pending
      expect(outcome).toMatchObject({ code: 'invalid_state' })
      expect((await snapshot(f)).events).toBe(2)
    } finally { await client.query('ROLLBACK'); client.release() }
  })

  test('F23 serializes control against an uncommitted membership revocation', async () => {
    const f = await fixture(), input = await waiting(f), client = await pool.connect()
    let outcome: unknown
    try {
      await client.query('BEGIN')
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await client.query("UPDATE collaboration_team_memberships SET state='removed' WHERE membership_id=$1", [f.membership.id])
      const pending = f.runs.control({ runId: input.runId, actorUserId: f.member, action: 'pause', expectedRevision: input.expectedRevision, requestId: 'pause' }).then(value => { outcome = value }, error => { outcome = error })
      await expect.poll(async () => outcome !== undefined || (await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rowCount! > 0).toBe(true)
      await client.query('COMMIT'); await pending
      expect(outcome).toMatchObject({ code: 'team_not_found' })
      expect((await snapshot(f)).events).toBe(2)
    } finally { await client.query('ROLLBACK'); client.release() }
  })
})
