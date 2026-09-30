import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { Router } from '../router.js'
import { TeamRepository } from '../team/repository.js'
import { TeamSessionService } from '../team/session-service.js'
import { TeamContextService } from '../team/context-service.js'
import { TeamMemoryContextBridge } from '../team/memory-context-bridge.js'
import { TeamRepositoryError } from '../team/repository.js'

const url = process.env.TEST_DATABASE_URL
const databaseTests = url && process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
databaseTests('Participant receipt and Context admission boundaries (PostgreSQL)', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    const parsed = new URL(url!), name = decodeURIComponent(parsed.pathname.slice(1))
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname) || !/test/i.test(name)
      || decodeURIComponent(parsed.username) !== name || parsed.searchParams.has('options')) throw new Error('Non-isolated database')
    pool = new pg.Pool({ connectionString: url })
    const identity = (await pool.query(`SELECT current_database() AS name,current_user AS role,
      (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)).rows[0]
    if (identity.name !== name || identity.role !== name || identity.superuser) throw new Error('Unexpected database identity')
    await initDB(pool)
  }, 30_000)
  afterAll(async () => { if (pool) { await pool.query('TRUNCATE users,daemons RESTART IDENTITY CASCADE'); await pool.end() } })
  async function fixture() {
    const key = randomUUID(), teams = new TeamRepository(pool), sessions = new TeamSessionService(pool)
    const users = (await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'x'),($2,'x') RETURNING id", [`${key}-one@example.test`, `${key}-two@example.test`])).rows
    const owner = Number(users[0].id), member = Number(users[1].id)
    let team = (await teams.createTeam({ actorUserId: owner, name: 'Participant boundaries', requestId: key })).team
    const invite = await teams.invite({ teamId: team.id, actorUserId: owner, email: `${key}-two@example.test`, expectedRevision: team.revision, requestId: key })
    await teams.respondToInvitation({ invitationId: invite.id, actorUserId: member, action: 'accepted', expectedRevision: invite.revision, requestId: key })
    const offers = []
    // Capability fixtures, independent of the separate live native acceptance.
    for (const user of [owner, member]) {
      const daemon = randomUUID()
      await pool.query(`INSERT INTO daemons(daemon_id,hostname,agents,status,user_id,collaboration_capabilities)
        VALUES($1,'participant-test','[{"type":"codex","manageable":true}]','online',$2,
          '["team_collaboration_dispatch_v1","team_collaboration_context_v1"]')`, [daemon, user])
      team = await teams.getTeam(team.id, owner)
      offers.push(await teams.addAgentOffer({ teamId: team.id, actorUserId: user, daemonId: daemon, provider: 'codex', runtimeProfileId: null, expectedRevision: team.revision, requestId: daemon }))
    }
    const session = await sessions.createSession({ teamId: team.id, actorUserId: owner, title: 'Participant boundary', taskId: null, offerIds: [offers[0].id], requestId: key })
    return { owner, member, session, offers, sessions }
  }

  test.each(['participant', 'binding'] as const)('cached removal cannot revoke an authorized participant restored through %s', async mode => {
    const f = await fixture(), router = new Router(pool, { teamSubscriptionAuthorizer: f.sessions })
    const sessions = new TeamSessionService(pool, { revoked: (id, user) => router.revokeTeamSubscription(id, user) })
    const added = await sessions.addParticipant({ sessionId: f.session.id, actorUserId: f.owner, userId: f.member, expectedRevision: 1, requestId: 'add' })
    const input = { sessionId: f.session.id, actorUserId: f.owner, userId: f.member, expectedRevision: added.revision, requestId: 'remove' }
    const removed = await sessions.removeParticipant(input)
    if (mode === 'participant') await sessions.addParticipant({ ...input, expectedRevision: removed.revision, requestId: 'restore' })
    else await sessions.changeBinding({ sessionId: f.session.id, actorUserId: f.owner, offerId: f.offers[1].id, active: true, expectedRevision: removed.revision, requestId: 'restore-binding' })
    const frames: any[] = [], ws = { readyState: 1, send: (text: string) => frames.push(JSON.parse(text)) } as any
    try {
      router.registerClient(ws, f.member)
      await router.handleClientMessage(ws, { type: 'team_collaboration_subscribe', team_session_id: f.session.id })
      expect(frames.at(-1)).toMatchObject({ subscribed: true })
      const before = await sessions.getSession(f.session.id, f.member)
      expect(await sessions.removeParticipant(input)).toEqual(removed)
      expect(await sessions.getSession(f.session.id, f.member)).toEqual(before)
      expect(await sessions.canSubscribe(f.member, f.session.id)).toBe(true)
      expect(frames.filter(frame => frame.type === 'team_collaboration_access_revoked')).toEqual([])
    } finally { router.stop() }
  })

  test('concurrent removal receipts revoke once after commit; conflicts and revoked actors cannot replay effects', async () => {
    const f = await fixture(), notifications: Array<Promise<boolean>> = []
    const sessions = new TeamSessionService(pool, { revoked: (id, user) => {
      notifications.push(pool.query(`SELECT state FROM collaboration_session_participants
        WHERE team_session_id=$1 AND user_id=$2`, [id, user]).then(result => result.rows[0]?.state === 'removed'))
    } })
    const added = await sessions.addParticipant({ sessionId: f.session.id, actorUserId: f.owner, userId: f.member, expectedRevision: 1, requestId: 'add' })
    const input = { sessionId: f.session.id, actorUserId: f.owner, userId: f.member, expectedRevision: added.revision, requestId: 'remove' }
    const results = await Promise.all([sessions.removeParticipant(input), sessions.removeParticipant(input)])
    expect(results[0]).toEqual(results[1])
    await expect(sessions.removeParticipant({ ...input, expectedRevision: input.expectedRevision + 1 })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await pool.query(`UPDATE collaboration_team_memberships SET state='removed' WHERE team_id=$1 AND user_id=$2`, [f.session.team_id, f.owner])
    await expect(sessions.removeParticipant(input)).rejects.toMatchObject({ code: 'team_not_found' })
    expect(await Promise.all(notifications)).toEqual([true])
    const receipt = (await pool.query(`SELECT response FROM collaboration_team_idempotency WHERE user_id=$1 AND request_id='remove'`, [f.owner])).rows[0].response
    expect(receipt).toEqual(results[0])
    expect(receipt).not.toHaveProperty('replayed')
  })

  test('an addition receipt preserves its result after Memory access changes while fresh admission is checked', async () => {
    const f = await fixture()
    let denied = false
    const bridge = { validateParticipantAddition: async () => {
      if (denied) throw new TeamRepositoryError('memory_grant_required', 'receiver has no Memory read')
    } } as unknown as TeamMemoryContextBridge
    const sessions = new TeamSessionService(pool, {}, undefined, bridge)
    const input = { sessionId: f.session.id, actorUserId: f.owner, userId: f.member, expectedRevision: 1, requestId: 'add' }
    const added = await sessions.addParticipant(input)
    denied = true
    expect(await sessions.addParticipant(input)).toEqual(added)
    await expect(sessions.addParticipant({ ...input, expectedRevision: added.revision, requestId: 'fresh-add' })).rejects.toMatchObject({ code: 'memory_grant_required' })
    expect(await sessions.getSession(f.session.id, f.owner)).toEqual(added)
  })

  async function memoryFixture() {
    const f = await fixture(), installation = randomUUID(), scope = randomUUID()
    // External Memory binding/grants/reference responses are explicit fixtures.
    // The actual bridge, participant reads, authorization and transactions run.
    const readPool = { query: async (sql: string, args: any[]) => {
      if (sql.includes('binding.installation_id::text')) {
        const row = (await pool.query(`SELECT team_id,ARRAY(SELECT user_id FROM collaboration_session_participants
          WHERE team_session_id=$1 AND state='active') AS participant_user_ids FROM collaboration_sessions WHERE team_session_id=$1`, [args[0]])).rows[0]
        return { rows: [{ ...row, installation_id: installation, owner_scope_id: scope, owner_scope_kind: 'team' }] }
      }
      return pool.query(sql, args)
    } } as unknown as pg.Pool
    const bridge = new TeamMemoryContextBridge(readPool, { mint: async ({ userId }) => userId === f.owner
      ? { ok: true, token: 'fixture-only', providerPublicOrigin: 'http://memory.fixture', bindings: [{ installation_id: installation, owner_scope_id: scope, permissions: ['read'] }] } as any
      : { ok: false } as any }, { enabled: true, fetchImpl: async () => new Response('{}', { status: 200 }) })
    const contextInput = { sessionId: f.session.id, actorUserId: f.owner, expectedRevision: 0, requestId: 'selected-context', goal: 'Requires Memory read', consensus: [], openQuestions: [],
      references: [{ source_kind: 'memory_claim' as const, source_id: randomUUID(), source_version: randomUUID(), owner_scope_id: scope, installation_id: installation }] }
    return { ...f, bridge, contextInput }
  }
  test('fresh participant admission after selected Context rejects a receiver without Memory read', async () => {
    const f = await memoryFixture()
    await new TeamContextService(pool, {}, f.bridge).create(f.contextInput)
    const sessions = new TeamSessionService(pool, {}, undefined, f.bridge)
    await expect(sessions.addParticipant({ sessionId: f.session.id, actorUserId: f.owner, userId: f.member, expectedRevision: 1, requestId: 'denied' })).rejects.toMatchObject({ code: 'memory_grant_required' })
    expect(await sessions.canSubscribe(f.member, f.session.id)).toBe(false)
  })
  test.each(['participant', 'binding'] as const)('Context commit fences concurrent %s admission without receiver Memory read', async mode => {
    const f = await memoryFixture()
    let release!: () => void, contextEntered!: () => void, admissionEntered!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { contextEntered = resolve })
    const waiting = new Promise<void>(resolve => { admissionEntered = resolve })
    let contextAtInsert = false
    const gated = { connect: async () => {
      const client = await pool.connect()
      return { release: () => client.release(), query: async (sql: string, args?: any[]) => {
        if (sql.includes('INSERT INTO collaboration_context_versions')) { contextAtInsert = true; contextEntered(); await held }
        else if (contextAtInsert && sql.includes('FOR UPDATE OF session')) admissionEntered()
        return client.query(sql, args)
      } }
    } } as unknown as pg.Pool
    const contexts = new TeamContextService(gated, {}, f.bridge), sessions = new TeamSessionService(gated, {}, undefined, f.bridge)
    const context = contexts.create(f.contextInput)
    await ready
    const admission = mode === 'participant'
      ? sessions.addParticipant({ sessionId: f.session.id, actorUserId: f.owner, userId: f.member, expectedRevision: 1, requestId: 'concurrent-add' })
      : sessions.changeBinding({ sessionId: f.session.id, actorUserId: f.owner, offerId: f.offers[1].id, active: true, expectedRevision: 1, requestId: 'concurrent-binding' })
    const result = admission.then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error }))
    try { await waiting } finally { release() }
    expect((await context).context.version).toBe(1)
    expect(await result).toMatchObject({ status: 'rejected', error: { code: 'memory_grant_required' } })
    expect(await f.sessions.canSubscribe(f.member, f.session.id)).toBe(false)
  })
})
