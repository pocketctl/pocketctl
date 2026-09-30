import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { TeamRepository } from '../team/repository.js'
import { TeamSessionService } from '../team/session-service.js'
import { TeamContextService } from '../team/context-service.js'
import { TeamRunRepository } from '../team/run-repository.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const withDatabase = databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

withDatabase('Team Run request contract acceptance (PostgreSQL)', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    const url = new URL(databaseUrl!), database = decodeURIComponent(url.pathname.slice(1))
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
      || !/test/i.test(database) || decodeURIComponent(url.username) !== database
      || url.searchParams.has('options')) throw new Error('Refusing non-isolated database')
    pool = new pg.Pool({ connectionString: databaseUrl })
    const identity = (await pool.query(`SELECT current_database() AS database, current_user AS "user",
      (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)).rows[0]
    if (identity.database !== database || identity.user !== database || identity.superuser) throw new Error('Unexpected database identity')
    await initDB(pool)
  }, 30_000)
  afterAll(async () => {
    if (pool) { await pool.query('TRUNCATE users, daemons RESTART IDENTITY CASCADE'); await pool.end() }
  })

  async function fixture() {
    const key = randomUUID(), teams = new TeamRepository(pool), sessions = new TeamSessionService(pool)
    const owner = Number((await pool.query("INSERT INTO users (email,password_hash, team_enabled) VALUES ($1,'x',true) RETURNING id", [`${key}@example.test`])).rows[0].id)
    const team = (await teams.createTeam({ actorUserId: owner, name: 'Run contract acceptance', requestId: key })).team
    // Isolated account/capability input; this is not evidence of a native run.
    await pool.query(`INSERT INTO daemons(daemon_id,hostname,agents,status,user_id,collaboration_capabilities)
      VALUES($1,'request-host','[{"type":"codex","manageable":true}]','online',$2,
        '["team_collaboration_dispatch_v1","team_collaboration_context_v1"]')`, [key, owner])
    const offer = await teams.addAgentOffer({ teamId: team.id, actorUserId: owner, daemonId: key, provider: 'codex', runtimeProfileId: null, expectedRevision: 1, requestId: key })
    const session = await sessions.createSession({ teamId: team.id, actorUserId: owner, title: 'Request contract', taskId: null, offerIds: [offer.id], requestId: key })
    await new TeamContextService(pool).create({ sessionId: session.id, actorUserId: owner, expectedRevision: 0, requestId: key, goal: 'Run contract', consensus: [], openQuestions: [], references: [] })
    const runs = new TeamRunRepository(pool)
    const runInput = { sessionId: session.id, actorUserId: owner, coordinatorOfferId: offer.id, contextVersion: 1,
      budget: { max_calls: 3, max_concurrent_calls: 1, max_duration_seconds: 1800 }, requestId: 'run-client-id' }
    const note = (requestId: string, content = 'Independent human note') => sessions.appendMessage({
      sessionId: session.id, actorUserId: owner, requestId, content, targetMode: 'discussion', targetOfferIds: [], referenceEventId: null,
    })
    return { owner, session, runs, runInput, note }
  }

  test.each([117, 118, 128])('creates and replays a Run using a valid %i-character request_id', async length => {
    const f = await fixture(), input = { ...f.runInput, requestId: 'c'.repeat(length) }
    const first = await f.runs.create(input)
    expect(await f.runs.create(input)).toEqual({ ...first, replayed: true })
    expect(first.run).toMatchObject({ state: 'ready', calls_used: 0, context_version: 1 })
  })
  test.each([118, 119, 128])('pauses and replays a Run using a valid %i-character request_id', async length => {
    const f = await fixture(), run = await f.runs.create(f.runInput)
    const input = { runId: run.run.id, actorUserId: f.owner, action: 'pause' as const, expectedRevision: run.run.revision, requestId: 'p'.repeat(length) }
    const first = await f.runs.control(input)
    expect(first.run.state).toBe('paused')
    expect(await f.runs.control(input)).toEqual({ ...first, replayed: true })
  })
  test.each([118, 119, 128])('accepts and replays requested input using a valid %i-character request_id', async length => {
    const f = await fixture(), run = await f.runs.create(f.runInput)
    // Explicit waiting-input fixture for repository acceptance. Live Docker
    // acceptance enters this state through a real coordinator model response.
    await pool.query("UPDATE collaboration_runs SET state='waiting_input',waiting_question='Question?' WHERE run_id=$1", [run.run.id])
    const input = { runId: run.run.id, actorUserId: f.owner, expectedRevision: run.run.revision, content: 'Answer', requestId: 'i'.repeat(length) }
    const first = await f.runs.supplement(input)
    expect(first.run.state).toBe('running')
    expect(await f.runs.supplement(input)).toEqual({ ...first, replayed: true })
  })
  test.each(['create', 'pause', 'input'] as const)('a message ID cannot collide with the %s Run operation family', async operation => {
    const f = await fixture(), requestId = 'independent-client-id'
    const original = await f.note(`run:${operation}:${requestId}`)
    if (operation === 'create') {
      const created = await f.runs.create({ ...f.runInput, requestId })
      expect(created.event.id).not.toBe(original.event.id)
    } else {
      const created = await f.runs.create(f.runInput)
      if (operation === 'pause') {
        const changed = await f.runs.control({ runId: created.run.id, actorUserId: f.owner, action: 'pause', expectedRevision: created.run.revision, requestId })
        expect(changed.run.state).toBe('paused')
        expect(changed.event.id).not.toBe(original.event.id)
      } else {
        await pool.query("UPDATE collaboration_runs SET state='waiting_input',waiting_question='Question?' WHERE run_id=$1", [created.run.id])
        const changed = await f.runs.supplement({ runId: created.run.id, actorUserId: f.owner, expectedRevision: created.run.revision, content: 'Answer', requestId })
        expect(changed.run.state).toBe('running')
        expect(changed.event.id).not.toBe(original.event.id)
      }
    }
  })
  test('a prior Run-created event cannot be treated as a message receipt from another operation family', async () => {
    const f = await fixture(), created = await f.runs.create(f.runInput)
    const note = await f.note(`run:create:${f.runInput.requestId}`)
    expect(note.event.kind).toBe('member_message')
    expect(note.event.id).not.toBe(created.event.id)
  })
  test('a prior Run input event cannot silently suppress an independent same-body message', async () => {
    const f = await fixture(), created = await f.runs.create(f.runInput)
    await pool.query("UPDATE collaboration_runs SET state='waiting_input',waiting_question='Question?' WHERE run_id=$1", [created.run.id])
    const accepted = await f.runs.supplement({ runId: created.run.id, actorUserId: f.owner, expectedRevision: created.run.revision, content: 'Same body', requestId: 'answer-client-id' })
    const note = await f.note('run:input:answer-client-id', 'Same body')
    expect(note.event.id).not.toBe(accepted.event.id)
    expect(note.event.event_seq).toBe(accepted.event.event_seq + 1)
  })
  test('ordinary identical client IDs remain independent across message and Run families', async () => {
    const f = await fixture(), note = await f.note(f.runInput.requestId), created = await f.runs.create(f.runInput)
    expect(created.event.id).not.toBe(note.event.id)
    expect(created.run.state).toBe('ready')
  })
  test('two sequential Runs in one session have independent control receipts for the same client ID', async () => {
    const f = await fixture(), first = await f.runs.create(f.runInput)
    const paused = await f.runs.control({ runId: first.run.id, actorUserId: f.owner, action: 'pause', expectedRevision: first.run.revision, requestId: 'same-per-run-control-id' })
    const stopped = await f.runs.control({ runId: first.run.id, actorUserId: f.owner, action: 'cancel', expectedRevision: paused.run.revision, requestId: 'stop-first-run' })
    // The real repository settles the known zero-call Run; no native result
    // is fabricated. Its current lease token is incremented by control.
    const leaseToken = Number((await pool.query('SELECT lease_token FROM collaboration_runs WHERE run_id=$1', [stopped.run.id])).rows[0].lease_token)
    await f.runs.transition({ runId: stopped.run.id, leaseToken, state: 'cancelled', content: 'Zero-call stop settled', terminalReason: 'run_stop_requested' })
    const second = await f.runs.create({ ...f.runInput, requestId: 'second-run-client-id' })
    const secondPaused = await f.runs.control({ runId: second.run.id, actorUserId: f.owner, action: 'pause', expectedRevision: second.run.revision, requestId: 'same-per-run-control-id' })
    expect(secondPaused.run.state).toBe('paused')
    expect(secondPaused.run.id).not.toBe(paused.run.id)
    expect(secondPaused.event.id).not.toBe(paused.event.id)
  })

  test.each(['resume', 'cancel'] as const)('%s accepts a 128-character ID and preserves conflict/replay semantics', async action => {
    const f = await fixture(), created = await f.runs.create(f.runInput)
    const paused = await f.runs.control({ runId: created.run.id, actorUserId: f.owner, action: 'pause', expectedRevision: 1, requestId: 'prepare-pause' })
    const input = { runId: created.run.id, actorUserId: f.owner, action, expectedRevision: paused.run.revision, requestId: 'x'.repeat(128) }
    const first = await f.runs.control(input)
    expect(await f.runs.control(input)).toEqual({ ...first, replayed: true })
    await expect(f.runs.control({ ...input, expectedRevision: first.run.revision })).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  test.each(['create', 'pause', 'input'] as const)('schema upgrade frees legacy %s IDs without altering events or Run receipts', async operation => {
    const f = await fixture(), created = await f.runs.create(f.runInput)
    let receipt = created
    const clientId = operation === 'create' ? f.runInput.requestId : 'legacy-operation-id'
    if (operation === 'pause') {
      receipt = await f.runs.control({ runId: created.run.id, actorUserId: f.owner, action: 'pause', expectedRevision: 1, requestId: clientId })
    } else if (operation === 'input') {
      await pool.query("UPDATE collaboration_runs SET state='waiting_input',waiting_question='Question?' WHERE run_id=$1", [created.run.id])
      receipt = await f.runs.supplement({ runId: created.run.id, actorUserId: f.owner, expectedRevision: 1, content: 'Legacy answer', requestId: clientId })
    }
    // Reconstruct the old persisted event format, not a fabricated Run receipt.
    const legacyId = `run:${operation}:${clientId}`
    await pool.query('UPDATE collaboration_events SET request_id=$2 WHERE event_id=$1', [receipt.event.id, legacyId])
    const direct = await f.note('run:input:unrelated-human-id', 'Human message with a Run-like ID')
    const cachedBefore = (await pool.query('SELECT operation,request_id,request_hash,response FROM collaboration_team_idempotency WHERE user_id=$1 ORDER BY operation,request_id', [f.owner])).rows
    const eventsBefore = (await pool.query('SELECT * FROM collaboration_events WHERE team_session_id=$1 ORDER BY event_seq', [f.session.id])).rows
    await initDB(pool)
    await initDB(pool) // Upgrade is repeatable across API/worker restarts.
    expect((await pool.query('SELECT operation,request_id,request_hash,response FROM collaboration_team_idempotency WHERE user_id=$1 ORDER BY operation,request_id', [f.owner])).rows).toEqual(cachedBefore)
    const eventsAfter = (await pool.query('SELECT * FROM collaboration_events WHERE team_session_id=$1 ORDER BY event_seq', [f.session.id])).rows
    expect(eventsAfter).toEqual(eventsBefore.map(row => ({ ...row, request_id: row.event_id === receipt.event.id ? null : row.request_id })))
    expect((await f.note('run:input:unrelated-human-id', 'Human message with a Run-like ID')).event).toEqual(direct.event)
    if (operation === 'create') expect(await f.runs.create(f.runInput)).toEqual({ ...receipt, replayed: true })
    if (operation === 'pause') expect(await f.runs.control({ runId: created.run.id, actorUserId: f.owner, action: 'pause', expectedRevision: 1, requestId: clientId })).toEqual({ ...receipt, replayed: true })
    if (operation === 'input') expect(await f.runs.supplement({ runId: created.run.id, actorUserId: f.owner, expectedRevision: 1, content: 'Legacy answer', requestId: clientId })).toEqual({ ...receipt, replayed: true })
    const note = await f.note(legacyId, operation === 'input' ? 'Legacy answer' : 'Independent note')
    expect(note.event.id).not.toBe(receipt.event.id)
    expect(note.event.event_seq).toBe(Number(eventsBefore[eventsBefore.length - 1].event_seq) + 1)
  })
})
