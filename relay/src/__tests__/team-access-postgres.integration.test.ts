import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import pg from 'pg'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { TeamRepository } from '../team/repository.js'
import { isTeamEnabled, registerTeamAccessGuard, setTeamAccess } from '../team/access.js'
import { registerTeamCapabilityRoutes, resolveTeamCollaborationConfig } from '../team/config.js'
import { registerTeamRoutes } from '../team/routes.js'
import { TeamSessionService } from '../team/session-service.js'
import { TeamContextService } from '../team/context-service.js'
import { TeamDispatchRepository } from '../team/dispatch-repository.js'
import { TeamDispatchService } from '../team/dispatch-service.js'
import { TeamRunRepository } from '../team/run-repository.js'
import { TeamRunWorker } from '../team/run-worker.js'

const url = process.env.TEST_DATABASE_URL
const databaseTests = url && process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
databaseTests('Team account rollout (isolated PostgreSQL)', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    const parsed = new URL(url!), name = decodeURIComponent(parsed.pathname.slice(1))
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname)
      || !/test/i.test(name) || decodeURIComponent(parsed.username) !== name || parsed.searchParams.has('options')) throw new Error('Non-isolated database')
    pool = new pg.Pool({ connectionString: url })
    const identity = (await pool.query(`SELECT current_database() AS name, current_user AS role,
      (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`)).rows[0]
    if (identity.name !== name || identity.role !== name || identity.superuser) throw new Error('Unexpected database identity')
    await initDB(pool)
  }, 30_000)
  afterAll(async () => { if (pool) { await pool.query('TRUNCATE users,daemons RESTART IDENTITY CASCADE'); await pool.end() } })

  test('does not enroll ordinary, Pro or quota-whitelisted accounts automatically', async () => {
    const teams = new TeamRepository(pool)
    for (const [plan, whitelist] of [['free', false], ['pro', false], ['free', true]] as const) {
      const user = Number((await pool.query(`INSERT INTO users(email,password_hash,plan,whitelist)
        VALUES($1,'x',$2,$3) RETURNING id`, [`${randomUUID()}@example.test`, plan, whitelist])).rows[0].id)
      await expect(teams.createTeam({ actorUserId: user, name: 'Closed beta', requestId: randomUUID() }))
        .rejects.toMatchObject({ code: 'team_access_denied' })
    }
    expect(Number((await pool.query('SELECT COUNT(*) FROM collaboration_teams')).rows[0].count)).toBe(0)
  })

  async function account(enabled = false) {
    const id = Number((await pool.query(`INSERT INTO users(email,password_hash) VALUES($1,'x') RETURNING id`, [`${randomUUID()}@example.test`])).rows[0].id)
    if (enabled) await setTeamAccess(pool, { userId: id, enabled, operator: 'acceptance', reason: 'fixture enrollment' })
    return id
  }
  const access = (userId: number, enabled: boolean) => setTeamAccess(pool, { userId, enabled, operator: 'acceptance', reason: 'rollout test' })

  async function fixture() {
    const initiator = await account(true), owner = await account(true)
    const teams = new TeamRepository(pool), sessions = new TeamSessionService(pool)
    const team = (await teams.createTeam({ actorUserId: initiator, name: 'Pilot', requestId: randomUUID() })).team
    const email = (await pool.query('SELECT email FROM users WHERE id=$1', [owner])).rows[0].email
    const invite = await teams.invite({ teamId: team.id, actorUserId: initiator, email, expectedRevision: 1, requestId: randomUUID() })
    await teams.respondToInvitation({ invitationId: invite.id, actorUserId: owner, action: 'accepted', expectedRevision: 1, requestId: randomUUID() })
    const daemon = `beta-${randomUUID()}`
    await pool.query(`INSERT INTO daemons(daemon_id,hostname,agents,status,user_id,collaboration_capabilities)
      VALUES($1,'pilot','[{"type":"codex","manageable":true}]','online',$2,
        '["team_collaboration_dispatch_v1","team_collaboration_context_v1"]')`, [daemon, owner])
    const offer = await teams.addAgentOffer({ teamId: team.id, actorUserId: owner, daemonId: daemon, provider: 'codex', runtimeProfileId: null, expectedRevision: 3, requestId: randomUUID() })
    const session = await sessions.createSession({ teamId: team.id, actorUserId: initiator, title: 'Pilot', taskId: null, offerIds: [offer.id], requestId: randomUUID() })
    await new TeamContextService(pool).create({ sessionId: session.id, actorUserId: initiator, expectedRevision: 0, requestId: randomUUID(), goal: 'Acceptance', consensus: [], openQuestions: [], references: [] })
    const message = () => sessions.appendMessage({ sessionId: session.id, actorUserId: initiator, requestId: randomUUID(), content: 'Work', targetMode: 'all', targetOfferIds: [], referenceEventId: null })
    return { initiator, owner, teams, sessions, team, session, offer, daemon, message }
  }

  test('grants dynamically, audits changes, and refuses invitations and cached receipts after withdrawal', async () => {
    const actor = await account(true), recipient = await account()
    const teams = new TeamRepository(pool)
    const create = { actorUserId: actor, name: 'Beta', requestId: randomUUID() }
    const created = await teams.createTeam(create)
    const email = (await pool.query('SELECT email FROM users WHERE id=$1', [recipient])).rows[0].email
    const invitation = await teams.invite({ teamId: created.team.id, actorUserId: actor, email, expectedRevision: 1, requestId: randomUUID() })
    const accept = { invitationId: invitation.id, actorUserId: recipient, action: 'accepted' as const, expectedRevision: 1, requestId: randomUUID() }
    await expect(teams.respondToInvitation(accept)).rejects.toMatchObject({ code: 'team_access_denied' })
    await access(recipient, true)
    expect((await teams.respondToInvitation(accept)).membership?.state).toBe('active')
    await access(recipient, false)
    await expect(teams.respondToInvitation(accept)).rejects.toMatchObject({ code: 'team_access_denied' })
    await expect(teams.listTeams(recipient)).rejects.toMatchObject({ code: 'team_access_denied' })
    await access(actor, false)
    await expect(teams.createTeam(create)).rejects.toMatchObject({ code: 'team_access_denied' })
    expect((await pool.query('SELECT previous_enabled,enabled FROM team_access_audit WHERE user_id=$1 ORDER BY id', [recipient])).rows)
      .toEqual([{ previous_enabled: false, enabled: true }, { previous_enabled: true, enabled: false }])
    await expect(access(2_147_483_647, true)).rejects.toThrow('Account not found')
    expect((await pool.query('SELECT state FROM collaboration_team_memberships WHERE team_id=$1 AND user_id=$2', [created.team.id, recipient])).rows[0].state).toBe('active')
  })

  test('allows a granted creator to remove a revoked participant while preserving admission and actor checks', async () => {
    const f = await fixture()
    await access(f.owner, false)
    await expect(f.sessions.removeParticipant({ sessionId: f.session.id, actorUserId: f.initiator,
      userId: f.owner, expectedRevision: f.session.revision, requestId: randomUUID() }))
      .rejects.toMatchObject({ code: 'invalid_state' })
    await access(f.owner, true)
    const withoutBinding = await f.sessions.changeBinding({ sessionId: f.session.id, actorUserId: f.owner,
      offerId: f.offer.id, active: false, expectedRevision: f.session.revision, requestId: randomUUID() })
    await access(f.owner, false)
    const requestId = randomUUID()
    const input = { sessionId: f.session.id, actorUserId: f.initiator, userId: f.owner,
      expectedRevision: withoutBinding.revision, requestId }
    const removed = await f.sessions.removeParticipant(input)
    expect(removed.participants.some(p => p.user_id === f.owner)).toBe(false)
    expect((await pool.query(`SELECT state FROM collaboration_session_participants
      WHERE team_session_id=$1 AND user_id=$2`, [f.session.id, f.owner])).rows[0].state).toBe('removed')
    expect((await f.sessions.removeParticipant(input)).revision).toBe(removed.revision)
    await expect(f.sessions.addParticipant({ ...input, expectedRevision: removed.revision, requestId: randomUUID() }))
      .rejects.toMatchObject({ code: 'team_access_denied' })
    await access(f.initiator, false)
    await expect(f.sessions.removeParticipant(input)).rejects.toMatchObject({ code: 'team_access_denied' })
  })

  test('HTTP capabilities stay readable while protected Team APIs deny an unenrolled account', async () => {
    const userId = await account()
    const app = Fastify(), config = resolveTeamCollaborationConfig({ TEAM_COLLABORATION: 'on' })
    const dependencies = { verifyAccessToken: async (token: string) => token === 'valid' ? { userId } : null, isTeamEnabled: (id: number) => isTeamEnabled(pool, id), getDatabaseReady: () => true }
    registerTeamAccessGuard(app, dependencies)
    registerTeamCapabilityRoutes(app, { ...dependencies, config, memoryExtensionAvailable: false })
    registerTeamRoutes(app, { ...dependencies, config, service: new TeamRepository(pool) })
    const headers = { authorization: 'Bearer valid' }
    try {
      expect((await app.inject({ url: '/api/team/teams' })).statusCode).toBe(401)
      expect((await app.inject({ url: '/api/team/capabilities', headers })).json().collaboration).toBe(false)
      expect((await app.inject({ url: '/api/team/teams', headers })).statusCode).toBe(403)
      await access(userId, true)
      expect((await app.inject({ url: '/api/team/teams', headers })).statusCode).toBe(200)
      await access(userId, false)
      expect((await app.inject({ method: 'POST', url: '/api/team/teams', headers, payload: { name: 'Spoofed', request_id: 'new' } })).statusCode).toBe(403)
      expect((await app.inject({ url: '/api/team/capabilities', headers })).headers['cache-control']).toBe('no-store')
    } finally { await app.close() }
  })

  test('the compiled operator command grants, queries and withdraws only the specified account', async () => {
    const userId = await account(), other = await account()
    const command = async (action: string) => {
      const result = await promisify(execFile)(process.execPath, ['dist/team-access-main.js', action, '--user-id', String(userId),
        ...(action === 'status' ? [] : ['--operator', 'acceptance', '--reason', 'CLI verification'])],
      { env: { ...process.env, DATABASE_URL: url }, timeout: 10_000 })
      return JSON.parse(result.stdout)
    }
    expect(await command('status')).toEqual({ user_id: userId, team_enabled: false })
    expect(await command('enable')).toEqual({ user_id: userId, team_enabled: true, changed: true })
    expect(await command('enable')).toEqual({ user_id: userId, team_enabled: true, changed: false })
    expect(await isTeamEnabled(pool, other)).toBe(false)
    expect(await command('disable')).toEqual({ user_id: userId, team_enabled: false, changed: true })
    expect(Number((await pool.query('SELECT count(*) FROM team_access_audit WHERE user_id=$1', [userId])).rows[0].count)).toBe(2)
    await expect(promisify(execFile)(process.execPath, ['dist/team-access-main.js', 'enable', '--user-id', '0'],
      { env: { ...process.env, DATABASE_URL: 'must-not-be-used' } })).rejects.toMatchObject({ code: 1 })
  })

  test.each(['initiator', 'owner'] as const)('withdrawn %s blocks pending dispatch but accepted calls still settle', async whom => {
    const f = await fixture(), dispatch = new TeamDispatchRepository(pool)
    const first = (await f.message()).call_ids[0]!
    const claimed = await dispatch.claim(first)
    expect(claimed).not.toBeNull()
    expect(await dispatch.sendIfEnabled(first, () => true)).toBe('sent')
    await dispatch.bindNativeSession(first, f.daemon, f.owner, `native-${first}`)
    await dispatch.recordReceipt(first, f.daemon, f.owner, 'accepted', null)
    const pending = (await f.message()).call_ids[0]!
    await access(f[whom], false)
    if (whom === 'owner') {
      expect((await f.sessions.getSession(f.session.id, f.initiator)).agent_bindings[0].availability).toBe('access_disabled')
      expect((await f.teams.listAgentOffers(f.team.id, f.initiator))[0]).toMatchObject({ availability: 'access_disabled', managed_callable: false })
    }
    expect(await dispatch.claim(pending)).toBeNull()
    expect((await pool.query('SELECT state,outcome FROM collaboration_calls WHERE call_id=$1', [pending])).rows[0])
      .toEqual({ state: 'blocked', outcome: 'team_access_revoked' })
    expect(await f.sessions.canSubscribe(f[whom], f.session.id)).toBe(false)
    const reply = await dispatch.projectDaemonEvent(f.daemon, f.owner, { type: 'agent_text', session_id: `native-${first}`, seq: 1, text: 'Accepted reply' })
    expect(reply?.event.content).toBe('Accepted reply')
    await dispatch.projectDaemonEvent(f.daemon, f.owner, { type: 'turn_status', session_id: `native-${first}`, seq: 2, turn_status: 'completed' })
    expect((await pool.query('SELECT state FROM collaboration_calls WHERE call_id=$1', [first])).rows[0].state).toBe('completed')
  })

  test('withdrawal during context preparation suppresses transport and releases the quota reservation', async () => {
    const f = await fixture(), callId = (await f.message()).call_ids[0]!
    const commands: unknown[] = []
    const dispatch = new TeamDispatchService(pool, { send: input => { commands.push(input); return true } }, {}, {
      memoryContextBridge: { prepareDispatch: async () => { await access(f.owner, false); return undefined } } as any,
    })
    await dispatch.dispatch(callId)
    expect(commands).toEqual([])
    expect((await pool.query('SELECT state,outcome FROM collaboration_calls WHERE call_id=$1', [callId])).rows[0])
      .toEqual({ state: 'blocked', outcome: 'team_access_revoked' })
    expect(Number((await pool.query(`SELECT count(*) FROM quota_reservations WHERE user_id=$1 AND state IN ('pending','uncertain')`, [f.owner])).rows[0].count)).toBe(0)
    await dispatch.stop()
  })

  test.each(['ready', 'waiting_input', 'paused', 'blocked'] as const)('revocation settles a %s Run without adding calls', async state => {
    const f = await fixture(), runs = new TeamRunRepository(pool)
    const run = (await runs.create({ sessionId: f.session.id, actorUserId: f.initiator, coordinatorOfferId: f.offer.id, contextVersion: 1, budget: { max_calls: 4, max_concurrent_calls: 1, max_duration_seconds: 120 }, requestId: randomUUID() })).run
    await pool.query('UPDATE collaboration_runs SET state=$2 WHERE run_id=$1', [run.id, state])
    await access(f.initiator, false)
    await new TeamRunWorker({ repository: runs, workerId: 'rollout' }).runOnce()
    expect((await pool.query('SELECT state,terminal_reason,calls_used FROM collaboration_runs WHERE run_id=$1', [run.id])).rows[0])
      .toMatchObject({ state: 'cancelled', terminal_reason: 'initiator_unavailable', calls_used: 0 })
  })

  test('a running Run drains an accepted coordinator call before stopping after revocation', async () => {
    const f = await fixture(), runs = new TeamRunRepository(pool), dispatch = new TeamDispatchRepository(pool)
    const run = (await runs.create({ sessionId: f.session.id, actorUserId: f.initiator, coordinatorOfferId: f.offer.id, contextVersion: 1, budget: { max_calls: 4, max_concurrent_calls: 1, max_duration_seconds: 120 }, requestId: randomUUID() })).run
    const worker = new TeamRunWorker({ repository: runs, workerId: 'rollout-running', pollIntervalMs: 25 })
    await worker.runOnce()
    const callId = (await pool.query('SELECT call_id FROM collaboration_calls WHERE run_id=$1', [run.id])).rows[0].call_id
    await dispatch.claim(callId)
    await dispatch.bindNativeSession(callId, f.daemon, f.owner, `native-${callId}`)
    await dispatch.recordReceipt(callId, f.daemon, f.owner, 'accepted', null)
    await access(f.initiator, false)
    await pool.query('UPDATE collaboration_runs SET next_wake_at=NOW() WHERE run_id=$1', [run.id])
    await worker.runOnce()
    expect((await pool.query('SELECT state FROM collaboration_calls WHERE call_id=$1', [callId])).rows[0].state).toBe('accepted')
    await dispatch.projectDaemonEvent(f.daemon, f.owner, { type: 'agent_text', session_id: `native-${callId}`, seq: 1, text: '{"action":"complete","context_version":1,"summary":"Accepted work done"}' })
    await dispatch.projectDaemonEvent(f.daemon, f.owner, { type: 'turn_status', session_id: `native-${callId}`, seq: 2, turn_status: 'completed' })
    await pool.query('UPDATE collaboration_runs SET next_wake_at=NOW() WHERE run_id=$1', [run.id])
    await worker.runOnce()
    expect((await pool.query('SELECT state,terminal_reason,calls_used FROM collaboration_runs WHERE run_id=$1', [run.id])).rows[0])
      .toMatchObject({ state: 'cancelled', terminal_reason: 'initiator_unavailable', calls_used: 1 })
    expect((await pool.query('SELECT state FROM collaboration_calls WHERE call_id=$1', [callId])).rows[0].state).toBe('completed')
  })
})
