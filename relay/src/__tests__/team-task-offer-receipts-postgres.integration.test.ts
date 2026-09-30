import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { TeamRepository } from '../team/repository.js'
import { TeamTaskService } from '../team/task-service.js'
import { TeamSessionService } from '../team/session-service.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const describeWithDatabase = databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

describeWithDatabase('Task and offer receipt authorization (PostgreSQL)', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    const url = new URL(databaseUrl!), database = decodeURIComponent(url.pathname.slice(1))
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
      || !/test/i.test(database) || decodeURIComponent(url.username) !== database) {
      throw new Error('Refusing receipt tests outside the isolated test database')
    }
    pool = new pg.Pool({ connectionString: databaseUrl })
    const identity = (await pool.query(`SELECT current_database() AS database, current_user AS "user",
      (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)).rows[0]
    if (identity.database !== database || identity.user !== database || identity.superuser) throw new Error('Unexpected test database identity')
    await initDB(pool)
  }, 30_000)
  afterAll(async () => {
    if (pool) { await pool.query('TRUNCATE users, daemons RESTART IDENTITY CASCADE'); await pool.end() }
  })

  async function fixture() {
    const key = randomUUID(), teams = new TeamRepository(pool), tasks = new TeamTaskService(pool), sessions = new TeamSessionService(pool)
    const users = (await pool.query(`INSERT INTO users (email,password_hash) VALUES ($1,'x'),($2,'x') RETURNING id`,
      [`${key}.owner@example.test`, `${key}.member@example.test`])).rows
    const owner = Number(users[0].id), member = Number(users[1].id)
    const team = (await teams.createTeam({ actorUserId: owner, name: 'Receipt acceptance', requestId: key })).team
    const invitation = await teams.invite({ teamId: team.id, actorUserId: owner, email: `${key}.member@example.test`, expectedRevision: 1, requestId: key })
    const acceptedInput = { invitationId: invitation.id, actorUserId: member, action: 'accepted' as const, expectedRevision: 1, requestId: key }
    const accepted = await teams.respondToInvitation(acceptedInput)
    // Synthetic daemon capability evidence; no host daemon or native process is involved.
    await pool.query(`INSERT INTO daemons (daemon_id,hostname,agents,status,user_id,collaboration_capabilities)
      VALUES ($1,'receipt-fixture','[{"type":"codex","manageable":true}]','online',$2,
      '["team_collaboration_dispatch_v1","team_collaboration_context_v1"]')`, [key, member])
    const offerInput = { teamId: team.id, actorUserId: member, daemonId: key, provider: 'codex' as const, runtimeProfileId: null, expectedRevision: 3, requestId: key }
    const offer = await teams.addAgentOffer(offerInput)
    const sessionInput = { teamId: team.id, actorUserId: member, title: 'Receipt session', taskId: null as string | null, offerIds: [offer.id], requestId: key }
    const session = await sessions.createSession(sessionInput)
    const createInput = { teamId: team.id, actorUserId: member, title: 'Receipt task', background: 'Private task fixture', requestId: key }
    const task = await tasks.createTask(createInput)
    return { key, teams, tasks, sessions, owner, member, team, membership: accepted.membership!, acceptedInput, accepted, offer, offerInput, session, sessionInput, task, createInput }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  async function snapshot(f: Fixture) {
    return (await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY task_id) FROM team_tasks t WHERE team_id=$1) AS tasks,
      (SELECT jsonb_agg(to_jsonb(h) ORDER BY user_id) FROM team_task_holders h JOIN team_tasks t USING(task_id) WHERE t.team_id=$1) AS holders,
      (SELECT jsonb_agg(to_jsonb(s) ORDER BY team_session_id) FROM collaboration_sessions s WHERE team_id=$1) AS sessions,
      (SELECT jsonb_agg(to_jsonb(o) ORDER BY offer_id) FROM team_agent_offers o WHERE team_id=$1) AS offers,
      (SELECT count(*)::int FROM collaboration_team_idempotency WHERE user_id=$2) AS receipts,
      (SELECT count(*)::int FROM collaboration_events e JOIN collaboration_sessions s USING(team_session_id) WHERE s.team_id=$1) AS events`, [f.team.id, f.member])).rows[0]
  }
  async function revoke(f: Fixture, action: 'removed' | 'left' | 'dissolved') {
    if (action === 'removed') return f.teams.removeMember({ teamId: f.team.id, membershipId: f.membership.id, actorUserId: f.owner, expectedRevision: 1, requestId: 'remove' })
    if (action === 'left') return f.teams.leaveTeam({ teamId: f.team.id, actorUserId: f.member, expectedRevision: 1, requestId: 'leave' })
    return f.teams.dissolveTeam({ teamId: f.team.id, actorUserId: f.owner, expectedRevision: (await f.teams.getTeam(f.team.id, f.owner)).revision, requestId: 'dissolve' })
  }

  async function taskReceipts(f: Fixture) {
    let task = f.task
    const receipts: Record<string, { replay: () => Promise<unknown>; result: unknown }> = {
      create: { replay: () => f.tasks.createTask(f.createInput), result: task },
    }
    async function remember(name: string, replay: () => ReturnType<TeamTaskService['getTask']>) {
      task = await replay(); receipts[name] = { replay, result: task }
    }
    const base = () => ({ taskId: task.id, actorUserId: f.member, expectedRevision: task.revision })
    const holder = { ...base(), holderUserId: f.member, active: true, requestId: 'holder' }
    await remember('holder', () => f.tasks.setHolder(holder))
    const update = { ...base(), title: 'Updated private task', requestId: 'update' }
    await remember('update', () => f.tasks.updateTask(update))
    const link = { ...base(), sessionId: f.session.id, linked: true, requestId: 'link' }
    await remember('link', () => f.tasks.linkSession(link))
    const unlink = { ...base(), sessionId: f.session.id, linked: false, requestId: 'unlink' }
    await remember('unlink', () => f.tasks.linkSession(unlink))
    const archive = { ...base(), state: 'archived' as const, requestId: 'archive' }
    await remember('archive', () => f.tasks.updateTask(archive))
    const restoreArchive = { ...base(), requestId: 'restore-archive' }
    await remember('restore_archive', () => f.tasks.restoreTask(restoreArchive))
    const deleted = { ...base(), requestId: 'delete' }
    await remember('delete', () => f.tasks.deleteTask(deleted))
    const restoreDeleted = { ...base(), requestId: 'restore-delete' }
    await remember('restore_deleted', () => f.tasks.restoreTask(restoreDeleted))
    return receipts
  }

  for (const action of ['removed', 'left', 'dissolved'] as const) {
    test.each(['create', 'holder', 'update', 'link', 'unlink', 'archive', 'restore_archive', 'delete', 'restore_deleted'])(`F25 denies cached %s after membership is ${action} without changing rows`, async operation => {
      const f = await fixture(), receipts = await taskReceipts(f)
      await revoke(f, action)
      const before = await snapshot(f)
      await expect(f.tasks.getTask(f.task.id, f.member)).rejects.toMatchObject({ code: 'team_not_found' })
      await expect(receipts[operation].replay()).rejects.toMatchObject({ code: 'team_not_found' })
      await expect(f.tasks.createTask({ ...f.createInput, requestId: 'fresh' })).rejects.toMatchObject({ code: 'team_not_found' })
      expect(await snapshot(f)).toEqual(before)
    })
    test(`F26 denies cached offer add after membership is ${action} before disclosing a payload conflict`, async () => {
      const f = await fixture()
      await revoke(f, action)
      const before = await snapshot(f)
      await expect(f.teams.addAgentOffer(f.offerInput)).rejects.toMatchObject({ code: 'team_not_found' })
      await expect(f.teams.addAgentOffer({ ...f.offerInput, daemonId: 'other' })).rejects.toMatchObject({ code: 'team_not_found' })
      expect(await snapshot(f)).toEqual(before)
    })
  }

  test('authorized Task receipts retain original old-CAS results across later edits and deletion', async () => {
    const f = await fixture(), receipts = await taskReceipts(f)
    const task = await f.tasks.getTask(f.task.id, f.member)
    await f.tasks.deleteTask({ taskId: task.id, actorUserId: f.member, expectedRevision: task.revision, requestId: 'delete-later' })
    const before = await snapshot(f)
    for (const receipt of Object.values(receipts)) expect(await receipt.replay()).toEqual(receipt.result)
    await expect(f.tasks.createTask({ ...f.createInput, title: 'Different' })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(await snapshot(f)).toEqual(before)
  })
  test('authorized offer add replay does not reactivate a revoked offer or require the old Team revision', async () => {
    const f = await fixture()
    await f.teams.revokeAgentOffer({ offerId: f.offer.id, actorUserId: f.member, expectedRevision: 1, requestId: 'revoke' })
    const before = await snapshot(f)
    expect(await f.teams.addAgentOffer(f.offerInput)).toEqual(f.offer)
    await expect(f.teams.addAgentOffer({ ...f.offerInput, daemonId: 'other' })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(await snapshot(f)).toEqual(before)
  })
  test.each(['left', 'dissolved'] as const)('terminal %s and accepted-invitation receipts remain replayable', async action => {
    const f = await fixture(), result = await revoke(f, action)
    const replay = action === 'left'
      ? () => f.teams.leaveTeam({ teamId: f.team.id, actorUserId: f.member, expectedRevision: 1, requestId: 'leave' })
      : () => f.teams.dissolveTeam({ teamId: f.team.id, actorUserId: f.owner, expectedRevision: 4, requestId: 'dissolve' })
    expect(await replay()).toEqual(result)
    expect(await f.teams.respondToInvitation(f.acceptedInput)).toEqual(f.accepted)
  })

  test.each(['archived', 'deleted'] as const)('F27 denies fresh Session creation on a %s Task without writes, while its old receipt stays valid', async state => {
    const f = await fixture(), input = { ...f.sessionInput, taskId: f.task.id, requestId: 'linked-session' }
    const original = await f.sessions.createSession(input)
    if (state === 'archived') await f.tasks.updateTask({ taskId: f.task.id, actorUserId: f.member, state, expectedRevision: 1, requestId: state })
    else await f.tasks.deleteTask({ taskId: f.task.id, actorUserId: f.member, expectedRevision: 1, requestId: state })
    const before = await snapshot(f)
    await expect(f.sessions.createSession({ ...input, requestId: 'fresh-linked-session' })).rejects.toMatchObject({ code: state === 'archived' ? 'invalid_state' : 'team_not_found' })
    expect(await f.sessions.createSession(input)).toEqual(original)
    expect(await snapshot(f)).toEqual(before)
    const task = await f.tasks.getTask(f.task.id, f.member)
    await f.tasks.restoreTask({ taskId: task.id, actorUserId: f.member, expectedRevision: task.revision, requestId: 'restore' })
    expect((await f.sessions.createSession({ ...input, requestId: 'restored-linked-session' })).task_id).toBe(task.id)
  })
  test.each(['open', 'in_progress', 'completed'] as const)('Session creation still links a %s Task in the current Team', async state => {
    const f = await fixture()
    if (state !== 'open') await f.tasks.updateTask({ taskId: f.task.id, actorUserId: f.member, state: 'in_progress', expectedRevision: 1, requestId: 'progress' })
    if (state === 'completed') await f.tasks.updateTask({ taskId: f.task.id, actorUserId: f.member, state, expectedRevision: 2, requestId: 'complete' })
    const linked = await f.sessions.createSession({ ...f.sessionInput, taskId: f.task.id, requestId: 'linked' })
    expect(linked.task_id).toBe(f.task.id)
    expect((await f.tasks.getTask(f.task.id, f.member)).session_ids).toEqual([linked.id])
  })
  test('Session creation cannot link a Task in another Team', async () => {
    const f = await fixture(), other = await fixture(), before = await snapshot(f)
    await expect(f.sessions.createSession({ ...f.sessionInput, taskId: other.task.id, requestId: 'other-team' })).rejects.toMatchObject({ code: 'team_not_found' })
    expect(await snapshot(f)).toEqual(before)
  })

  test.each(['task-member', 'task-team', 'offer-member', 'offer-team', 'session-archive', 'session-delete'] as const)('%s waits for an uncommitted revocation and rejects the committed state', async operation => {
    const f = await fixture(), client = await pool.connect()
    let outcome: unknown, pending: Promise<void> | undefined, blocked = false
    try {
      await client.query('BEGIN')
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      if (operation.endsWith('member')) await client.query("UPDATE collaboration_team_memberships SET state='removed' WHERE membership_id=$1", [f.membership.id])
      else if (operation.endsWith('team')) await client.query("UPDATE collaboration_teams SET state='dissolved' WHERE team_id=$1", [f.team.id])
      else await client.query('UPDATE team_tasks SET state=$2 WHERE task_id=$1', [f.task.id, operation === 'session-archive' ? 'archived' : 'deleted'])
      const action = operation.startsWith('task') ? () => f.tasks.createTask(f.createInput)
        : operation.startsWith('offer') ? () => f.teams.addAgentOffer(f.offerInput)
        : () => f.sessions.createSession({ ...f.sessionInput, taskId: f.task.id, requestId: 'racing' })
      pending = action().then(value => { outcome = value }, error => { outcome = error })
      await expect.poll(async () => {
        blocked = (await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rowCount! > 0
        return blocked || outcome !== undefined
      }).toBe(true)
      await client.query('COMMIT'); await pending
      expect(blocked).toBe(true)
      expect(outcome).toMatchObject({ code: operation === 'session-archive' ? 'invalid_state' : 'team_not_found' })
    } finally { await client.query('ROLLBACK'); client.release(); await pending }
  })

  test('offer revocation blocked on Team does not hold the offer needed by Session creation', async () => {
    const f = await fixture(), client = await pool.connect()
    let revokeOutcome: unknown
    let revoking: Promise<void> | undefined
    try {
      await client.query('BEGIN')
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await client.query('SELECT 1 FROM collaboration_teams WHERE team_id=$1 FOR SHARE', [f.team.id])
      revoking = f.teams.revokeAgentOffer({ offerId: f.offer.id, actorUserId: f.member, expectedRevision: 1, requestId: 'revoke-racing' })
        .then(value => { revokeOutcome = value }, error => { revokeOutcome = error })
      await expect.poll(async () => (await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rowCount! > 0).toBe(true)
      // The Team holder can still lock the offer needed by creation. Otherwise
      // Team -> offer and offer -> Team form a cycle. NOWAIT proves this without
      // depending on PostgreSQL's ordering of queued Team lock requests.
      expect((await client.query('SELECT 1 FROM team_agent_offers WHERE offer_id=$1 FOR UPDATE NOWAIT', [f.offer.id])).rowCount).toBe(1)
      await client.query('COMMIT'); await revoking
      expect(revokeOutcome).toMatchObject({ state: 'revoked' })
    } finally { await client.query('ROLLBACK'); client.release(); await revoking }
  })
})
