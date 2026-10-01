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

describeWithDatabase('Team session acceptance boundaries (PostgreSQL)', () => {
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
    const session = await service.createSession({ teamId: team.id, actorUserId: owner, title: 'Acceptance', taskId: null, offerIds: [first.id, second.id], requestId: key })
    return { key, owner, member, teams, service, team, session, first, second, daemonIds, membership: accepted.membership! }
  }

  test.each(['removed', 'left'] as const)('excludes a %s team member from session detail and list while preserving history', async action => {
    const f = await fixture()
    const note = await f.service.appendMessage({ sessionId: f.session.id, actorUserId: f.member, requestId: f.key, content: 'Retained history', targetMode: 'discussion', targetOfferIds: [], referenceEventId: null })
    if (action === 'removed') await f.teams.removeMember({ teamId: f.team.id, membershipId: f.membership.id, actorUserId: f.owner, expectedRevision: f.membership.revision, requestId: f.key })
    else await f.teams.leaveTeam({ teamId: f.team.id, actorUserId: f.member, expectedRevision: f.membership.revision, requestId: f.key })
    expect((await f.service.getSession(f.session.id, f.owner)).participants.map(p => p.user_id)).toEqual([f.owner])
    expect((await f.service.listSessions(f.team.id, f.owner))[0].participants.map(p => p.user_id)).toEqual([f.owner])
    expect((await f.service.listEvents(f.session.id, f.owner, 0, 10)).events[0].id).toBe(note.event.id)
    await expect(f.service.getSession(f.session.id, f.member)).rejects.toMatchObject({ code: 'team_not_found' })
    expect((await pool.query('SELECT state FROM team_agent_offers WHERE offer_id = $1', [f.second.id])).rows[0].state).toBe('revoked')
  })

  test('keeps native IDs owner-only in reads, mutations and legacy idempotent responses', async () => {
    const f = await fixture()
    await pool.query(`UPDATE collaboration_session_agent_bindings SET native_session_id = CASE WHEN owner_user_id = $2 THEN 'native-owner' ELSE 'native-member' END WHERE team_session_id = $1`, [f.session.id, f.owner])
    const ownerView = await f.service.getSession(f.session.id, f.owner)
    const memberView = await f.service.getSession(f.session.id, f.member)
    expect(ownerView.agent_bindings.find(b => b.owner_user_id === f.owner)?.native_session_id).toBe('native-owner')
    expect(ownerView.agent_bindings.find(b => b.owner_user_id === f.member)?.native_session_id).toBeNull()
    expect(memberView.agent_bindings.find(b => b.owner_user_id === f.owner)?.native_session_id).toBeNull()
    expect(memberView.agent_bindings.find(b => b.owner_user_id === f.member)?.native_session_id).toBe('native-member')
    expect(JSON.stringify(await f.service.listSessions(f.team.id, f.member))).not.toContain('native-owner')
    const mutation = { sessionId: f.session.id, actorUserId: f.owner, title: 'Renamed', expectedRevision: 1, requestId: 'privacy-update' }
    expect(JSON.stringify(await f.service.updateSession(mutation))).not.toContain('native-member')
    // Responses cached before the fix also cross the same privacy boundary.
    await pool.query(`UPDATE collaboration_team_idempotency SET response = jsonb_set(response, '{agent_bindings}', $3::jsonb)
      WHERE user_id = $1 AND request_id = $2`, [f.owner, 'privacy-update', JSON.stringify(ownerView.agent_bindings.map(b => ({ ...b, native_session_id: b.owner_user_id === f.owner ? 'native-owner' : 'native-member' })))])
    expect(JSON.stringify(await f.service.updateSession(mutation))).not.toContain('native-member')
  })

  test('accepts offline human discussion without calls while enforcing dispatch and lifecycle gates', async () => {
    const f = await fixture()
    await pool.query(`UPDATE daemons SET status = 'offline' WHERE daemon_id = ANY($1::text[])`, [f.daemonIds])
    const input = { sessionId: f.session.id, actorUserId: f.member, requestId: f.key, content: 'Offline human note', targetMode: 'discussion' as const, targetOfferIds: [], referenceEventId: null }
    const note = await f.service.appendMessage(input)
    expect(note).toMatchObject({ event: { target_mode: 'discussion', target_offer_ids: [], content: 'Offline human note' }, call_ids: [] })
    expect((await f.service.appendMessage(input)).event.id).toBe(note.event.id)
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM collaboration_calls WHERE team_session_id = $1', [f.session.id])).rows[0].count).toBe(0)
    for (const targetMode of ['all', 'offers'] as const) await expect(f.service.appendMessage({ ...input, requestId: `${f.key}-${targetMode}`, targetMode, targetOfferIds: [f.first.id] })).rejects.toMatchObject({ code: 'no_callable_agent' })
    await f.service.updateSession({ sessionId: f.session.id, actorUserId: f.owner, state: 'ended', expectedRevision: 1, requestId: 'end' })
    await expect(f.service.appendMessage({ ...input, requestId: 'ended-note' })).rejects.toMatchObject({ code: 'invalid_state' })
  })

  test('settles an exhausted worker-call budget once without dispatching another call', async () => {
    const f = await fixture()
    const context = await new TeamContextService(pool).create({ sessionId: f.session.id, actorUserId: f.owner, expectedRevision: 0, requestId: f.key, goal: 'Bounded task', consensus: [], openQuestions: [], references: [] })
    const repository = new TeamRunRepository(pool)
    const created = await repository.create({ sessionId: f.session.id, actorUserId: f.owner, coordinatorOfferId: f.first.id, contextVersion: context.context.version, budget: { max_calls: 1, max_concurrent_calls: 1, max_duration_seconds: 1800 }, requestId: f.key })
    const worker = new TeamRunWorker({ repository, workerId: f.key })
    await worker.runOnce()
    const call = (await pool.query('SELECT * FROM collaboration_calls WHERE run_id = $1', [created.run.id])).rows[0]
    await pool.query(`UPDATE collaboration_calls SET state = 'completed', outcome = 'completed' WHERE call_id = $1`, [call.call_id])
    await pool.query(`WITH next AS (UPDATE collaboration_sessions SET latest_event_seq = latest_event_seq + 1 WHERE team_session_id = $2 RETURNING latest_event_seq)
      INSERT INTO collaboration_events (event_id, team_session_id, event_seq, kind, author_offer_id, context_version, call_id, content)
      SELECT $1, $2, latest_event_seq, 'agent_message', $3, 1, $4, $5 FROM next`,
    [`cev_${randomUUID()}`, f.session.id, f.first.id, call.call_id, JSON.stringify({ action: 'call_agent', context_version: 1, target_offer_id: f.second.id, instruction: 'Check independently' })])
    await pool.query('UPDATE collaboration_runs SET next_wake_at = NOW() WHERE run_id = $1', [created.run.id])
    await worker.runOnce()
    const stopped = await repository.get(created.run.id, f.owner)
    expect(stopped).toMatchObject({ state: 'failed', terminal_reason: 'budget_exhausted', calls_used: 1, processed_call_step: 1 })
    expect(stopped.finished_at).not.toBeNull()
    expect(await worker.runOnce()).toBe(false)
    expect((await repository.get(created.run.id, f.owner)).revision).toBe(stopped.revision)
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM collaboration_calls WHERE run_id = $1', [created.run.id])).rows[0].count).toBe(1)
  })
})
