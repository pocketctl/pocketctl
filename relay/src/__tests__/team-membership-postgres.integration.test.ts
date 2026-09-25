import Fastify, { type FastifyInstance } from 'fastify'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { initDB } from '../db.js'
import { resolveTeamCollaborationConfig } from '../team/config.js'
import { createTeamRouteService, registerTeamRoutes } from '../team/routes.js'
import { createTeamTaskRouteService, registerTeamTaskRoutes } from '../team/task-routes.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

async function assertTeamTestDatabase(pool: pg.Pool, rawUrl: string): Promise<void> {
  const url = new URL(rawUrl)
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  const user = decodeURIComponent(url.username)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !loopbackHosts.has(url.hostname)
    || !/test/i.test(database)
    || user !== database
    || url.searchParams.has('options')) {
    throw new Error('Refusing Team integration test outside a loopback test database owned by its same-named role')
  }
  const identity = await pool.query<{ database: string; user: string; schema: string | null; superuser: boolean }>(`
    SELECT current_database() AS database, current_user AS "user", current_schema() AS schema,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser
  `)
  if (identity.rows[0]?.database !== database
    || identity.rows[0]?.user !== user
    || identity.rows[0]?.schema !== 'public'
    || identity.rows[0]?.superuser) {
    throw new Error('Refusing Team integration test against an unexpected database identity')
  }
}

async function resetTeamTestDatabase(pool: pg.Pool, rawUrl: string): Promise<void> {
  await assertTeamTestDatabase(pool, rawUrl)
  await pool.query(`TRUNCATE users, daemons RESTART IDENTITY CASCADE`)
}

describeWithDatabase('Team membership and Agent offers (PostgreSQL)', () => {
  let pool: pg.Pool
  let app: FastifyInstance

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    await assertTeamTestDatabase(pool, databaseUrl!)
    await initDB(pool)
    app = Fastify()
    registerTeamRoutes(app, {
      config: resolveTeamCollaborationConfig({ TEAM_COLLABORATION: 'on' }),
      service: createTeamRouteService(pool),
      verifyAccessToken: async token => token.startsWith('user-') ? { userId: Number(token.slice(5)) } : null,
      getDatabaseReady: () => true,
    })
    registerTeamTaskRoutes(app, {
      config: resolveTeamCollaborationConfig({ TEAM_COLLABORATION: 'on' }),
      service: createTeamTaskRouteService(pool),
      verifyAccessToken: async token => token.startsWith('user-') ? { userId: Number(token.slice(5)) } : null,
      getDatabaseReady: () => true,
    })
  }, 30_000)

  afterEach(async () => {
    await resetTeamTestDatabase(pool, databaseUrl!)
  })

  afterAll(async () => {
    await app?.close()
    await pool?.end()
  })

  async function user(email: string, displayName?: string): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', $2) RETURNING id`,
      [email, displayName ?? null],
    )
    return result.rows[0].id
  }

  function headers(userId: number) {
    return { authorization: `Bearer user-${userId}` }
  }

  async function createTeam(userId: number, name: string, requestId: string) {
    return app.inject({
      method: 'POST', url: '/api/team/teams', headers: headers(userId),
      payload: { request_id: requestId, name },
    })
  }

  test('keeps pending invitations out of membership and accepts them without a daemon', async () => {
    const creatorId = await user('team.creator@example.test', 'Creator')
    const memberId = await user('team.member@example.test', 'Member')
    const created = await createTeam(creatorId, 'No-host team', 'create-no-host')
    expect(created.statusCode).toBe(201)
    const teamId = created.json().team.id
    expect(created.json().creator_membership.user_id).toBe(creatorId)

    const invited = await app.inject({
      method: 'POST', url: `/api/team/teams/${teamId}/invitations`, headers: headers(creatorId),
      payload: { request_id: 'invite-member', expected_revision: 1, email: 'TEAM.MEMBER@example.test' },
    })
    expect(invited.statusCode).toBe(201)
    const invitation = invited.json().invitation
    expect(invitation.state).toBe('pending')

    const inboxInvitations = await app.inject({ method: 'GET', url: '/api/team/invitations', headers: headers(memberId) })
    expect(inboxInvitations.statusCode).toBe(200)
    expect(inboxInvitations.json().invitations[0]).toMatchObject({
      id: invitation.id, team_name: 'No-host team', invited_by_label: 'Creator',
    })

    const hidden = await app.inject({ method: 'GET', url: `/api/team/teams/${teamId}`, headers: headers(memberId) })
    expect(hidden.statusCode).toBe(404)

    const sameRequest = await app.inject({
      method: 'POST', url: `/api/team/teams/${teamId}/invitations`, headers: headers(creatorId),
      payload: { request_id: 'invite-member', expected_revision: 1, email: 'team.member@example.test' },
    })
    expect(sameRequest.json().invitation.id).toBe(invitation.id)

    const repeatedInvite = await app.inject({
      method: 'POST', url: `/api/team/teams/${teamId}/invitations`, headers: headers(creatorId),
      payload: { request_id: 'invite-member-again', expected_revision: 2, email: 'team.member@example.test' },
    })
    expect(repeatedInvite.statusCode).toBe(201)
    expect(repeatedInvite.json().invitation.id).toBe(invitation.id)

    const accepted = await app.inject({
      method: 'POST', url: `/api/team/invitations/${invitation.id}/accept`, headers: headers(memberId),
      payload: { request_id: 'accept-member', expected_revision: 1 },
    })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json()).toMatchObject({ invitation: { state: 'accepted', revision: 2 }, membership: { user_id: memberId, state: 'active' } })

    const repeatedAccept = await app.inject({
      method: 'POST', url: `/api/team/invitations/${invitation.id}/accept`, headers: headers(memberId),
      payload: { request_id: 'accept-member-again', expected_revision: 2 },
    })
    expect(repeatedAccept.statusCode).toBe(200)
    expect(repeatedAccept.json().membership.user_id).toBe(memberId)

    const members = await app.inject({ method: 'GET', url: `/api/team/teams/${teamId}/members`, headers: headers(memberId) })
    expect(members.json().members.map((entry: { user_id: number }) => entry.user_id)).toEqual([creatorId, memberId])

    const daemonCount = await pool.query(`SELECT COUNT(*)::int AS count FROM daemons WHERE user_id = $1`, [memberId])
    expect(daemonCount.rows[0].count).toBe(0)

    const renamed = await app.inject({
      method: 'PATCH', url: `/api/team/teams/${teamId}`, headers: headers(creatorId),
      payload: { request_id: 'rename-team', expected_revision: 3, name: 'Renamed no-host team' },
    })
    expect(renamed.json().team).toMatchObject({ name: 'Renamed no-host team', revision: 4 })

    const memberRecord = members.json().members.find((entry: { user_id: number }) => entry.user_id === memberId)
    const removed = await app.inject({
      method: 'DELETE', url: `/api/team/teams/${teamId}/members/${memberRecord.id}`, headers: headers(creatorId),
      payload: { request_id: 'remove-member', expected_revision: 1 },
    })
    expect(removed.statusCode, removed.body).toBe(200)
    expect(removed.json().membership.state).toBe('removed')
    const hiddenAfterRemoval = await app.inject({ method: 'GET', url: `/api/team/teams/${teamId}`, headers: headers(memberId) })
    expect(hiddenAfterRemoval.statusCode).toBe(404)
  })

  test('locks a daemon to one team until every active offer is revoked', async () => {
    const ownerId = await user('agent.owner@example.test')
    await pool.query(
      `INSERT INTO daemons (daemon_id, hostname, agents, status, user_id)
       VALUES ('daemon-team-lock', 'host-one', $1::jsonb, 'offline', $2)`,
      [JSON.stringify([
        { type: 'codex', manageable: true },
        { type: 'claude-code', manageable: false },
      ]), ownerId],
    )
    await pool.query(
      `INSERT INTO sessions (session_id, daemon_id, agent_type, user_id, title)
       VALUES ('native-session-kept', 'daemon-team-lock', 'codex', $1, 'Personal history')`,
      [ownerId],
    )
    const first = await createTeam(ownerId, 'First team', 'create-first')
    const second = await createTeam(ownerId, 'Second team', 'create-second')
    const firstId = first.json().team.id
    const secondId = second.json().team.id

    const candidates = await app.inject({ method: 'GET', url: `/api/team/teams/${firstId}/agent-candidates`, headers: headers(ownerId) })
    expect(candidates.json().agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'codex', availability: 'offline', managed_callable: false }),
      expect.objectContaining({ provider: 'claude-code', availability: 'offline', managed_callable: false }),
    ]))

    const codex = await app.inject({
      method: 'POST', url: `/api/team/teams/${firstId}/agent-offers`, headers: headers(ownerId),
      payload: { request_id: 'offer-codex', expected_revision: 1, daemon_id: 'daemon-team-lock', provider: 'codex' },
    })
    expect(codex.statusCode).toBe(201)
    expect(codex.json().offer).toMatchObject({ owner_user_id: ownerId, availability: 'offline', state: 'active' })

    const claude = await app.inject({
      method: 'POST', url: `/api/team/teams/${firstId}/agent-offers`, headers: headers(ownerId),
      payload: { request_id: 'offer-claude', expected_revision: 2, daemon_id: 'daemon-team-lock', provider: 'claude-code' },
    })
    expect(claude.statusCode).toBe(201)

    const conflict = await app.inject({
      method: 'POST', url: `/api/team/teams/${secondId}/agent-offers`, headers: headers(ownerId),
      payload: { request_id: 'offer-conflict', expected_revision: 1, daemon_id: 'daemon-team-lock', provider: 'codex' },
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().error.code).toBe('daemon_team_conflict')

    const revokeCodex = await app.inject({
      method: 'DELETE', url: `/api/team/agent-offers/${codex.json().offer.id}`, headers: headers(ownerId),
      payload: { request_id: 'revoke-codex', expected_revision: 1 },
    })
    expect(revokeCodex.statusCode).toBe(200)
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM collaboration_team_daemon_bindings`)).rows[0].count).toBe(1)

    const revokeClaude = await app.inject({
      method: 'DELETE', url: `/api/team/agent-offers/${claude.json().offer.id}`, headers: headers(ownerId),
      payload: { request_id: 'revoke-claude', expected_revision: 1 },
    })
    expect(revokeClaude.statusCode).toBe(200)
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM collaboration_team_daemon_bindings`)).rows[0].count).toBe(0)

    const moved = await app.inject({
      method: 'POST', url: `/api/team/teams/${secondId}/agent-offers`, headers: headers(ownerId),
      payload: { request_id: 'offer-after-release', expected_revision: 1, daemon_id: 'daemon-team-lock', provider: 'codex' },
    })
    expect(moved.statusCode).toBe(201)
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM sessions WHERE session_id = 'native-session-kept'`)).rows[0].count).toBe(1)
  })

  test('leaving revokes only the member offers and dissolution preserves native data', async () => {
    const creatorId = await user('leave.creator@example.test')
    const memberId = await user('leave.member@example.test')
    await pool.query(
      `INSERT INTO daemons (daemon_id, hostname, agents, status, user_id)
       VALUES ('member-daemon', 'member-host', '[{"type":"codex","manageable":true}]'::jsonb, 'online', $1)`,
      [memberId],
    )
    await pool.query(
      `INSERT INTO sessions (session_id, daemon_id, agent_type, user_id, title)
       VALUES ('member-native-session', 'member-daemon', 'codex', $1, 'Keep me')`,
      [memberId],
    )
    const created = await createTeam(creatorId, 'Exit team', 'create-exit')
    const teamId = created.json().team.id
    const invitation = await app.inject({
      method: 'POST', url: `/api/team/teams/${teamId}/invitations`, headers: headers(creatorId),
      payload: { request_id: 'invite-exit', expected_revision: 1, email: 'leave.member@example.test' },
    })
    await app.inject({
      method: 'POST', url: `/api/team/invitations/${invitation.json().invitation.id}/accept`, headers: headers(memberId),
      payload: { request_id: 'accept-exit', expected_revision: 1 },
    })
    const offered = await app.inject({
      method: 'POST', url: `/api/team/teams/${teamId}/agent-offers`, headers: headers(memberId),
      payload: { request_id: 'member-offer', expected_revision: 3, daemon_id: 'member-daemon', provider: 'codex' },
    })
    expect(offered.statusCode).toBe(201)

    const left = await app.inject({
      method: 'POST', url: `/api/team/teams/${teamId}/leave`, headers: headers(memberId),
      payload: { request_id: 'member-leave', expected_revision: 1 },
    })
    expect(left.json().membership.state).toBe('left')
    expect((await pool.query(`SELECT state FROM team_agent_offers WHERE offer_id = $1`, [offered.json().offer.id])).rows[0].state).toBe('revoked')
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM collaboration_team_daemon_bindings WHERE daemon_id = 'member-daemon'`)).rows[0].count).toBe(0)
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM sessions WHERE session_id = 'member-native-session'`)).rows[0].count).toBe(1)

    const creatorLeave = await app.inject({
      method: 'POST', url: `/api/team/teams/${teamId}/leave`, headers: headers(creatorId),
      payload: { request_id: 'creator-leave', expected_revision: 1 },
    })
    expect(creatorLeave.statusCode).toBe(409)

    const current = await pool.query<{ revision: string }>(`SELECT revision FROM collaboration_teams WHERE team_id = $1`, [teamId])
    const dissolved = await app.inject({
      method: 'DELETE', url: `/api/team/teams/${teamId}`, headers: headers(creatorId),
      payload: { request_id: 'dissolve-team', expected_revision: Number(current.rows[0].revision) },
    })
    expect(dissolved.json().team.state).toBe('dissolved')
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM daemons WHERE daemon_id = 'member-daemon'`)).rows[0].count).toBe(1)
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM sessions WHERE session_id = 'member-native-session'`)).rows[0].count).toBe(1)
  })

  test('persists lightweight task state, holders, and same-team session links independently', async () => {
    const creatorId = await user('task.creator@example.test')
    const otherId = await user('task.other@example.test')
    const first = await createTeam(creatorId, 'Task team', 'create-task-team')
    const second = await createTeam(creatorId, 'Other task team', 'create-other-task-team')
    const teamId = first.json().team.id
    const otherTeamId = second.json().team.id
    const invitation = await app.inject({
      method: 'POST', url: `/api/team/teams/${teamId}/invitations`, headers: headers(creatorId),
      payload: { request_id: 'invite-task-member', expected_revision: 1, email: 'task.other@example.test' },
    })
    await app.inject({
      method: 'POST', url: `/api/team/invitations/${invitation.json().invitation.id}/accept`, headers: headers(otherId),
      payload: { request_id: 'accept-task-member', expected_revision: 1 },
    })

    const created = await app.inject({
      method: 'POST', url: `/api/team/teams/${teamId}/tasks`, headers: headers(otherId),
      payload: { request_id: 'create-task', title: 'Investigate behavior', background: 'Initial context' },
    })
    expect(created.statusCode).toBe(201)
    const taskId = created.json().task.id
    expect(created.json().task).toMatchObject({ state: 'open', revision: 1, holder_user_ids: [], session_ids: [] })

    const invalidComplete = await app.inject({
      method: 'PATCH', url: `/api/team/tasks/${taskId}`, headers: headers(creatorId),
      payload: { request_id: 'skip-progress', expected_revision: 1, state: 'completed' },
    })
    expect(invalidComplete.statusCode).toBe(409)
    expect(invalidComplete.json().error.code).toBe('invalid_state')

    const claimed = await app.inject({
      method: 'POST', url: `/api/team/tasks/${taskId}/holders/self`, headers: headers(otherId),
      payload: { request_id: 'claim-task', expected_revision: 1 },
    })
    expect(claimed.statusCode, claimed.body).toBe(200)
    expect(claimed.json().task).toMatchObject({ revision: 2, holder_user_ids: [otherId] })

    const progressed = await app.inject({
      method: 'PATCH', url: `/api/team/tasks/${taskId}`, headers: headers(creatorId),
      payload: { request_id: 'progress-task', expected_revision: 2, state: 'in_progress', background: 'Expanded context' },
    })
    expect(progressed.json().task).toMatchObject({ state: 'in_progress', revision: 3, background: 'Expanded context' })

    await pool.query(
      `INSERT INTO collaboration_sessions (team_session_id, team_id, creator_user_id, title)
       VALUES ('css_same-team', $1, $2, 'Same team session'), ('css_other-team', $3, $2, 'Other team session')`,
      [teamId, creatorId, otherTeamId],
    )
    const linked = await app.inject({
      method: 'PUT', url: `/api/team/tasks/${taskId}/sessions/css_same-team`, headers: headers(otherId),
      payload: { request_id: 'link-session', expected_revision: 3 },
    })
    expect(linked.json().task).toMatchObject({ revision: 4, session_ids: ['css_same-team'] })

    const crossTeam = await app.inject({
      method: 'PUT', url: `/api/team/tasks/${taskId}/sessions/css_other-team`, headers: headers(otherId),
      payload: { request_id: 'link-cross-team', expected_revision: 4 },
    })
    expect(crossTeam.statusCode).toBe(404)

    const archived = await app.inject({
      method: 'PATCH', url: `/api/team/tasks/${taskId}`, headers: headers(otherId),
      payload: { request_id: 'archive-task', expected_revision: 4, state: 'archived' },
    })
    expect(archived.json().task).toMatchObject({ state: 'archived', previous_state: 'in_progress', revision: 5 })
    const restored = await app.inject({
      method: 'POST', url: `/api/team/tasks/${taskId}/restore`, headers: headers(otherId),
      payload: { request_id: 'restore-archive', expected_revision: 5 },
    })
    expect(restored.json().task).toMatchObject({ state: 'in_progress', previous_state: null, revision: 6 })

    const deleted = await app.inject({
      method: 'DELETE', url: `/api/team/tasks/${taskId}`, headers: headers(otherId),
      payload: { request_id: 'delete-task', expected_revision: 6 },
    })
    expect(deleted.json().task).toMatchObject({ state: 'deleted', revision: 7, session_ids: ['css_same-team'] })
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM collaboration_sessions WHERE team_session_id = 'css_same-team'`)).rows[0].count).toBe(1)

    const restoredDelete = await app.inject({
      method: 'POST', url: `/api/team/tasks/${taskId}/restore`, headers: headers(otherId),
      payload: { request_id: 'restore-delete', expected_revision: 7 },
    })
    expect(restoredDelete.json().task).toMatchObject({ state: 'in_progress', revision: 8, session_ids: ['css_same-team'] })
  })
})
