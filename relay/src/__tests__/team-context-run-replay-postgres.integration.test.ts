import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { Router } from '../router.js'
import { TeamRepository } from '../team/repository.js'
import { TeamSessionService } from '../team/session-service.js'
import { TeamContextService } from '../team/context-service.js'
import { TeamRunService } from '../team/run-service.js'
import type { TeamEvent } from '../team/types.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const withDatabase = databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

withDatabase('Context operation and Run replay acceptance (PostgreSQL)', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    const url = new URL(databaseUrl!), database = decodeURIComponent(url.pathname.slice(1))
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
      || !/test/i.test(database) || decodeURIComponent(url.username) !== database
      || url.searchParams.has('options')) throw new Error('Refusing non-isolated database')
    pool = new pg.Pool({ connectionString: databaseUrl })
    const identity = (await pool.query(`SELECT current_database() AS database,current_user AS role,
      (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)).rows[0]
    if (identity.database !== database || identity.role !== database || identity.superuser) throw new Error('Unexpected database identity')
    await initDB(pool)
  }, 30_000)
  afterAll(async () => { if (pool) { await pool.query('TRUNCATE users,daemons RESTART IDENTITY CASCADE'); await pool.end() } })

  async function fixture() {
    const key = randomUUID(), teams = new TeamRepository(pool), sessions = new TeamSessionService(pool)
    const users = (await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'x'),($2,'x') RETURNING id", [`${key}-owner@example.test`, `${key}-member@example.test`])).rows
    const owner = Number(users[0].id), member = Number(users[1].id)
    const team = (await teams.createTeam({ actorUserId: owner, name: 'Context replay acceptance', requestId: key })).team
    const invite = await teams.invite({ teamId: team.id, actorUserId: owner, email: `${key}-member@example.test`, expectedRevision: 1, requestId: key })
    await teams.respondToInvitation({ invitationId: invite.id, actorUserId: member, action: 'accepted', expectedRevision: 1, requestId: key })
    // Account/capability fixture; native execution is verified separately in Docker.
    await pool.query(`INSERT INTO daemons(daemon_id,hostname,agents,status,user_id,collaboration_capabilities)
      VALUES($1,'replay-host','[{"type":"codex","manageable":true}]','online',$2,
        '["team_collaboration_dispatch_v1","team_collaboration_context_v1"]')`, [key, owner])
    const offer = await teams.addAgentOffer({ teamId: team.id, actorUserId: owner, daemonId: key, provider: 'codex', runtimeProfileId: null, expectedRevision: 3, requestId: key })
    const newSession = () => sessions.createSession({ teamId: team.id, actorUserId: owner, title: 'Replay boundary', taskId: null, offerIds: [offer.id], requestId: randomUUID() })
    const session = await newSession(), contexts = new TeamContextService(pool)
    const contextInput = { sessionId: session.id, actorUserId: owner, expectedRevision: 0, requestId: 'context-client-id', goal: 'Independent Context', consensus: [], openQuestions: [], references: [] }
    const note = (requestId: string) => sessions.appendMessage({ sessionId: session.id, actorUserId: owner, requestId, content: 'Independent human message', targetMode: 'discussion', targetOfferIds: [], referenceEventId: null })
    return { owner, member, teams, team, sessions, session, contexts, contextInput, offer, note, newSession }
  }
  const internalContextId = (id: string) => 'context:' + createHash('sha256').update(JSON.stringify(id)).digest('hex').slice(0, 40)

  test('a valid discussion ID cannot prevent an independent Context save', async () => {
    const f = await fixture(), note = await f.note(internalContextId(f.contextInput.requestId))
    const saved = await f.contexts.create(f.contextInput)
    expect(saved.context.version).toBe(1)
    expect(saved.event.id).not.toBe(note.event.id)
  })
  test('a prior Context event cannot be returned or rejected as an independent discussion receipt', async () => {
    const f = await fixture(), saved = await f.contexts.create(f.contextInput)
    const note = await f.note(internalContextId(f.contextInput.requestId))
    expect(note.event.kind).toBe('member_message')
    expect(note.event.id).not.toBe(saved.event.id)
  })
  test('a Context and independent discussion racing different request families both succeed', async () => {
    const f = await fixture()
    const results = await Promise.allSettled([f.contexts.create(f.contextInput), f.note(internalContextId(f.contextInput.requestId))])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect((await f.sessions.listEvents(f.session.id, f.owner, 0, 10)).events).toHaveLength(2)
  })
  test('Context IDs in different sessions have independent receipts', async () => {
    const f = await fixture(), other = await f.newSession()
    const first = await f.contexts.create(f.contextInput), second = await f.contexts.create({ ...f.contextInput, sessionId: other.id })
    expect(second.context.version).toBe(1)
    expect(second.event.id).not.toBe(first.event.id)
    expect(await f.contexts.create(f.contextInput)).toEqual(first)
  })
  test('a 128-character Context ID preserves replay and content-conflict semantics', async () => {
    const f = await fixture(), input = { ...f.contextInput, requestId: 'c'.repeat(128) }
    const first = await f.contexts.create(input)
    expect(await f.contexts.create(input)).toEqual(first)
    await expect(f.contexts.create({ ...input, goal: 'Different goal' })).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })
  test('ordinary identical IDs remain independent across Context and message', async () => {
    const f = await fixture(), note = await f.note(f.contextInput.requestId), saved = await f.contexts.create(f.contextInput)
    expect(note.event.id).not.toBe(saved.event.id)
  })

  test('schema upgrade frees only receipt-identified legacy Context keys and preserves history and replay', async () => {
    const f = await fixture(), saved = await f.contexts.create(f.contextInput)
    const legacyId = internalContextId(f.contextInput.requestId)
    // Reconstruct the old event key using a real persisted Context receipt.
    await pool.query('UPDATE collaboration_events SET request_id=$2 WHERE event_id=$1', [saved.event.id, legacyId])
    const direct = await f.note(internalContextId('unrelated-human-id'))
    const receiptsBefore = (await pool.query('SELECT * FROM collaboration_team_idempotency WHERE user_id=$1 ORDER BY operation,request_id', [f.owner])).rows
    const eventsBefore = (await pool.query('SELECT * FROM collaboration_events WHERE team_session_id=$1 ORDER BY event_seq', [f.session.id])).rows
    await initDB(pool)
    await initDB(pool)
    expect((await pool.query('SELECT * FROM collaboration_team_idempotency WHERE user_id=$1 ORDER BY operation,request_id', [f.owner])).rows).toEqual(receiptsBefore)
    expect((await pool.query('SELECT * FROM collaboration_events WHERE team_session_id=$1 ORDER BY event_seq', [f.session.id])).rows)
      .toEqual(eventsBefore.map(row => ({ ...row, request_id: row.event_id === saved.event.id ? null : row.request_id })))
    expect(await f.contexts.create(f.contextInput)).toEqual(saved)
    expect((await f.note(internalContextId('unrelated-human-id'))).event).toEqual(direct.event)
    expect((await f.note(legacyId)).event.id).not.toBe(saved.event.id)
  })

  test('concurrent Context retries publish one fresh event and preserve conflict detection', async () => {
    const f = await fixture(), events: unknown[] = []
    const contexts = new TeamContextService(pool, { event: (_id, _participants, event) => events.push(event) })
    const responses = await Promise.all([contexts.create(f.contextInput), contexts.create(f.contextInput)])
    expect(responses[0]).toEqual(responses[1])
    expect(events).toEqual([responses[0].event])
    await expect(contexts.create({ ...f.contextInput, goal: 'Changed' })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(events).toHaveLength(1)
  })

  async function runOperation(operation: 'create' | 'pause' | 'resume' | 'cancel' | 'input') {
    const f = await fixture()
    await f.contexts.create(f.contextInput)
    const notifications: TeamEvent[] = []
    const runs = new TeamRunService(pool, { event: (_id, _participants, event) => notifications.push(event) })
    const input = { sessionId: f.session.id, actorUserId: f.owner, coordinatorOfferId: f.offer.id, contextVersion: 1,
      budget: { max_calls: 3, max_concurrent_calls: 1, max_duration_seconds: 120 }, requestId: 'concurrent-operation' }
    if (operation === 'create') return { f, notifications, execute: () => runs.create(input) }
    let created = await runs.create({ ...input, requestId: 'prepare-run' })
    if (operation === 'resume') created = await runs.control({ runId: created.id, actorUserId: f.owner, action: 'pause', expectedRevision: created.revision, requestId: 'prepare-pause' })
    if (operation === 'input') await pool.query("UPDATE collaboration_runs SET state='waiting_input' WHERE run_id=$1", [created.id])
    notifications.length = 0
    const execute = operation === 'input'
      ? () => runs.supplement({ runId: created.id, actorUserId: f.owner, expectedRevision: created.revision, content: 'Answer', requestId: input.requestId })
      : () => runs.control({ runId: created.id, actorUserId: f.owner, action: operation, expectedRevision: created.revision, requestId: input.requestId })
    return { f, notifications, execute }
  }

  test.each(['create', 'pause', 'resume', 'cancel', 'input'] as const)('concurrent Run %s retries publish only the committed fresh event', async operation => {
    const { f, notifications, execute } = await runOperation(operation)
    const responses = await Promise.all([execute(), execute()])
    expect(responses[0]).toEqual(responses[1])
    expect(notifications).toHaveLength(1)
    const receiptsBefore = (await pool.query("SELECT * FROM collaboration_team_idempotency WHERE user_id=$1 AND operation LIKE 'team.run.%' ORDER BY operation", [f.owner])).rows
    // Cached legacy receipts have no replay marker. Replay metadata must never
    // be persisted or exposed as part of the public Run response.
    expect(receiptsBefore.every(row => !('replayed' in row.response))).toBe(true)
    expect(await execute()).toEqual(responses[0])
    expect(notifications).toHaveLength(1)
    expect((await pool.query("SELECT * FROM collaboration_team_idempotency WHERE user_id=$1 AND operation LIKE 'team.run.%' ORDER BY operation", [f.owner])).rows).toEqual(receiptsBefore)
  })

  test.each(['create', 'pause', 'input'] as const)('cached Run %s still checks current authority before returning a receipt', async operation => {
    const { f, notifications, execute } = await runOperation(operation)
    await execute()
    const team = await f.teams.getTeam(f.team.id, f.owner)
    await f.teams.dissolveTeam({ teamId: f.team.id, actorUserId: f.owner, expectedRevision: team.revision, requestId: 'dissolve-before-replay' })
    notifications.length = 0
    await expect(execute()).rejects.toMatchObject({ code: 'team_not_found' })
    expect(notifications).toEqual([])
  })

  test.each(['create', 'pause', 'input'] as const)('cached Run %s cannot revoke a newly admitted participant subscription', async operation => {
    const f = await fixture()
    await f.contexts.create(f.contextInput)
    const router = new Router(pool, { teamSubscriptionAuthorizer: f.sessions })
    const runs = new TeamRunService(pool, { event: (id, participants, event) => router.broadcastTeamEvent(id, participants, event) })
    const input = { sessionId: f.session.id, actorUserId: f.owner, coordinatorOfferId: f.offer.id, contextVersion: 1, budget: { max_calls: 3, max_concurrent_calls: 1, max_duration_seconds: 120 }, requestId: 'original-create' }
    const created = await runs.create(input)
    const pause = { runId: created.id, actorUserId: f.owner, action: 'pause' as const, expectedRevision: created.revision, requestId: 'original-pause' }
    const supplement = { runId: created.id, actorUserId: f.owner, expectedRevision: created.revision, content: 'Answer', requestId: 'original-input' }
    if (operation === 'pause') await runs.control(pause)
    if (operation === 'input') {
      // Explicit waiting-input fixture, not a fabricated native coordinator response.
      await pool.query("UPDATE collaboration_runs SET state='waiting_input' WHERE run_id=$1", [created.id])
      await runs.supplement(supplement)
    }
    await f.sessions.addParticipant({ sessionId: f.session.id, actorUserId: f.owner, userId: f.member, expectedRevision: f.session.revision, requestId: 'admit-member' })
    const frames: any[] = []
    // A transport recorder exercises the real Router and PostgreSQL authorizer.
    // Separate live acceptance uses an actual authenticated network WebSocket.
    const ws = { OPEN: 1, readyState: 1, send: (raw: string) => frames.push(JSON.parse(raw)) } as any
    try {
      router.registerClient(ws, f.member)
      await router.handleClientMessage(ws, { type: 'team_collaboration_subscribe', team_session_id: f.session.id })
      expect(frames.at(-1)).toMatchObject({ subscribed: true })
      const before = (await pool.query('SELECT current_context_version,latest_event_seq FROM collaboration_sessions WHERE team_session_id=$1', [f.session.id])).rows
      if (operation === 'create') await runs.create(input)
      if (operation === 'pause') await runs.control(pause)
      if (operation === 'input') await runs.supplement(supplement)
      expect((await pool.query('SELECT current_context_version,latest_event_seq FROM collaboration_sessions WHERE team_session_id=$1', [f.session.id])).rows).toEqual(before)
      expect(await f.sessions.canSubscribe(f.member, f.session.id)).toBe(true)
      expect(frames.filter(frame => frame.type === 'team_collaboration_access_revoked')).toEqual([])
    } finally { router.stop() }
  })
})
