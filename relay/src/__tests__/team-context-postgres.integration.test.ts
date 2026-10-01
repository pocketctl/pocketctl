import Fastify from 'fastify'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { initDB } from '../db.js'
import { resolveTeamCollaborationConfig } from '../team/config.js'
import { TeamContextService } from '../team/context-service.js'
import { TeamRepository } from '../team/repository.js'
import { registerTeamSessionRoutes } from '../team/session-routes.js'
import { TeamSessionService } from '../team/session-service.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = enabled ? describe : describe.skip
const LEGACY_CONSTRAINT = 'collaboration_context_versions_team_session_id_content_hash_key'

describeWithDatabase('Team Context version restoration (PostgreSQL)', () => {
  let pool: pg.Pool
  let app: ReturnType<typeof Fastify>
  let contexts: TeamContextService
  let sessions: TeamSessionService
  let sessionId: string
  let owner: number
  let member: number
  let offerId: string

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    const database = decodeURIComponent(url.pathname.slice(1))
    if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
      || !/test/i.test(database) || decodeURIComponent(url.username) !== database
      || url.searchParams.has('options')) {
      throw new Error('Refusing Context regression outside the isolated test database')
    }
    pool = new pg.Pool({ connectionString: databaseUrl })
    const identity = (await pool.query(`SELECT current_database() AS database, current_user AS "user",
      (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`)).rows[0]
    if (identity.database !== database || identity.user !== database || identity.superuser) {
      throw new Error('Unexpected Context regression database identity')
    }
    await initDB(pool)
  }, 30_000)

  beforeEach(async () => {
    await pool.query('TRUNCATE users, daemons RESTART IDENTITY CASCADE')
    const users = (await pool.query(`INSERT INTO users (email, password_hash, team_enabled) VALUES ('f21.owner@example.test', 'x',true), ('f21.member@example.test', 'x',true) RETURNING id`)).rows
    owner = Number(users[0].id)
    member = Number(users[1].id)
    const teams = new TeamRepository(pool)
    const team = (await teams.createTeam({ actorUserId: owner, name: 'F21', requestId: 'create-team' })).team
    const invite = await teams.invite({ teamId: team.id, actorUserId: owner,
      email: 'f21.member@example.test', expectedRevision: 1, requestId: 'invite-member' })
    await teams.respondToInvitation({ invitationId: invite.id, actorUserId: member,
      action: 'accepted', expectedRevision: 1, requestId: 'accept-invite' })
    await pool.query(`INSERT INTO daemons (daemon_id, hostname, agents, status, user_id, collaboration_capabilities)
      VALUES ('f21-one', 'one', '[{"type":"codex","manageable":true}]', 'online', $1,
        '["team_collaboration_dispatch_v1","team_collaboration_context_v1"]'),
      ('f21-two', 'two', '[{"type":"codex","manageable":true}]', 'online', $2,
        '["team_collaboration_dispatch_v1","team_collaboration_context_v1"]')`, [owner, member])
    const first = await teams.addAgentOffer({ teamId: team.id, actorUserId: owner, daemonId: 'f21-one',
      provider: 'codex', runtimeProfileId: null, expectedRevision: 3, requestId: 'offer-one' })
    const second = await teams.addAgentOffer({ teamId: team.id, actorUserId: member, daemonId: 'f21-two',
      provider: 'codex', runtimeProfileId: null, expectedRevision: 4, requestId: 'offer-two' })
    offerId = first.id
    sessions = new TeamSessionService(pool)
    sessionId = (await sessions.createSession({ teamId: team.id, actorUserId: owner,
      title: 'F21', taskId: null, offerIds: [first.id, second.id], requestId: 'create-session' })).id
    contexts = new TeamContextService(pool)
    app = Fastify()
    registerTeamSessionRoutes(app, {
      config: resolveTeamCollaborationConfig({ TEAM_COLLABORATION: 'on' }),
      service: sessions, contextService: contexts,
      verifyAccessToken: async token => token.startsWith('user-') ? { userId: Number(token.slice(5)) } : null,
      getDatabaseReady: () => true,
    })
  })

  afterEach(async () => { await app?.close() })
  afterAll(async () => {
    if (pool) { await pool.query('TRUNCATE users, daemons RESTART IDENTITY CASCADE'); await pool.end() }
  })

  function save(goal: string, expectedRevision: number, requestId: string, actor = owner) {
    return app.inject({ method: 'POST', url: `/api/team/sessions/${sessionId}/context`,
      headers: { authorization: `Bearer user-${actor}` },
      payload: { goal, consensus: [], open_questions: [], references: [],
        expected_revision: expectedRevision, request_id: requestId } })
  }

  async function versions() {
    return (await pool.query(`SELECT context_version_id, version::int, content_hash, goal
      FROM collaboration_context_versions WHERE team_session_id = $1 ORDER BY version`, [sessionId])).rows
  }

  test('A → B → A and another A create distinct immutable versions with the same content hash', async () => {
    const saved = []
    for (const [i, goal] of ['A', 'B', 'A', 'A'].entries()) {
      const response = await save(goal, i, `save-${i}`)
      expect(response.statusCode, response.body).toBe(201)
      saved.push(response.json().context)
    }
    expect(saved.map(context => context.version)).toEqual([1, 2, 3, 4])
    expect(saved.map(context => context.revision)).toEqual([1, 2, 3, 4])
    expect(new Set(saved.map(context => context.id)).size).toBe(4)
    expect(saved[2].content_hash).toBe(saved[0].content_hash)
    expect(saved[3].content_hash).toBe(saved[0].content_hash)
    expect(saved[1].content_hash).not.toBe(saved[0].content_hash)
    expect(await contexts.get(sessionId, owner, 1)).toEqual(saved[0])
    expect(await contexts.get(sessionId, owner)).toEqual(saved[3])
    expect((await versions()).map(row => row.goal)).toEqual(['A', 'B', 'A', 'A'])
  })

  test('concurrent replay of one restoration request persists one version and one Context event', async () => {
    expect((await save('A', 0, 'first')).statusCode).toBe(201)
    expect((await save('B', 1, 'second')).statusCode).toBe(201)
    const results = await Promise.all([save('A', 2, 'restore'), save('A', 2, 'restore')])
    expect(results.map(response => response.statusCode)).toEqual([201, 201])
    expect(results[0].json()).toEqual(results[1].json())
    expect((await save('A', 2, 'restore')).json()).toEqual(results[0].json())
    expect((await versions()).map(row => row.version)).toEqual([1, 2, 3])
    expect((await sessions.listEvents(sessionId, owner, 0, 10)).events.map(event => event.event_seq))
      .toEqual([1, 2, 3])
    const mismatch = await save('different', 2, 'restore')
    expect(mismatch.statusCode).toBe(409)
    expect(mismatch.json().error.code).toBe('idempotency_conflict')
  })

  test('different restoration requests racing the same CAS have one winner and a revision conflict', async () => {
    await save('A', 0, 'first')
    await save('B', 1, 'second')
    const results = await Promise.all([save('A', 2, 'restore-one'), save('A', 2, 'restore-two')])
    expect(results.map(response => response.statusCode).sort()).toEqual([201, 409])
    expect(results.find(response => response.statusCode === 409)!.json().error)
      .toMatchObject({ code: 'context_revision_conflict', current_revision: 3 })
    expect((await versions()).map(row => row.version)).toEqual([1, 2, 3])
  })

  test('restoring historical content still enforces CAS, creator authority, and the session lifecycle', async () => {
    await save('A', 0, 'first')
    await save('B', 1, 'second')
    const stale = await save('A', 1, 'stale')
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error).toMatchObject({ code: 'context_revision_conflict', current_revision: 2 })
    const denied = await save('A', 2, 'member', member)
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error.code).toBe('creator_required')
    await sessions.updateSession({ sessionId, actorUserId: owner, state: 'ended',
      expectedRevision: 1, requestId: 'end-session' })
    const ended = await save('A', 2, 'after-end')
    expect(ended.statusCode).toBe(409)
    expect(ended.json().error.code).toBe('invalid_state')
    expect((await versions()).map(row => row.version)).toEqual([1, 2])
  })

  test('upgrades a legacy hash-unique database without rewriting history or cached responses', async () => {
    const first = await save('A', 0, 'first')
    await save('B', 1, 'second')
    const before = await versions()
    await pool.query(`ALTER TABLE collaboration_context_versions DROP CONSTRAINT IF EXISTS ${LEGACY_CONSTRAINT};
      ALTER TABLE collaboration_context_versions ADD CONSTRAINT ${LEGACY_CONSTRAINT} UNIQUE (team_session_id, content_hash)`)
    await initDB(pool)
    await initDB(pool)
    expect(await versions()).toEqual(before)
    expect((await save('A', 0, 'first')).json()).toEqual(first.json())
    const restored = await save('A', 2, 'restore-after-upgrade')
    expect(restored.statusCode, restored.body).toBe(201)
    expect(restored.json().context).toMatchObject({ version: 3, content_hash: first.json().context.content_hash })
    await expect(pool.query(`INSERT INTO collaboration_context_versions
      SELECT 'ccv_duplicate_version', team_session_id, version, revision, goal, consensus,
             open_questions, context_references, content_hash, created_by_user_id, created_at
      FROM collaboration_context_versions WHERE team_session_id = $1 AND version = 3`, [sessionId]))
      .rejects.toMatchObject({ code: '23505', constraint: 'collaboration_context_versions_team_session_id_version_key' })
  })

  test('calls freeze the restored version while previously accepted calls retain their original version', async () => {
    const first = await save('A', 0, 'first')
    const original = await sessions.appendMessage({ sessionId, actorUserId: owner, requestId: 'call-original',
      content: 'Use A', targetMode: 'offers', targetOfferIds: [offerId], referenceEventId: null })
    await save('B', 1, 'second')
    const restored = await save('A', 2, 'restore')
    expect(restored.statusCode, restored.body).toBe(201)
    const current = await sessions.appendMessage({ sessionId, actorUserId: owner, requestId: 'call-restored',
      content: 'Use restored A', targetMode: 'offers', targetOfferIds: [offerId], referenceEventId: null })
    const calls = (await pool.query(`SELECT call_id, context_version::int, context_snapshot_hash
      FROM collaboration_calls WHERE call_id = ANY($1::text[]) ORDER BY context_version`,
    [[...original.call_ids, ...current.call_ids]])).rows
    expect(calls).toEqual([
      { call_id: original.call_ids[0], context_version: 1, context_snapshot_hash: first.json().context.content_hash },
      { call_id: current.call_ids[0], context_version: 3, context_snapshot_hash: first.json().context.content_hash },
    ])
  })
})
