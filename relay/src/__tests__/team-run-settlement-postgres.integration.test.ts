import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { TeamRepository } from '../team/repository.js'
import { TeamSessionService } from '../team/session-service.js'
import { TeamContextService } from '../team/context-service.js'
import { TeamRunRepository } from '../team/run-repository.js'
import { TeamRunWorker } from '../team/run-worker.js'
import { TeamDispatchRepository } from '../team/dispatch-repository.js'
import { TeamMemoryBindingService } from '../team/memory-binding-service.js'
import { ExtensionInstallationRepository } from '../extensions/installation-repository.js'
import { createV2GrantService } from '../extensions/v2-grant-service.js'
import { resolveGrantKeyMaterial } from '../extensions/capability-grant.js'

const url = process.env.TEST_DATABASE_URL
const databaseTests = url && process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
databaseTests('Run settlement and binding pool boundaries (PostgreSQL)', () => {
  let pool: pg.Pool
  const grantKeys = resolveGrantKeyMaterial({ NODE_ENV: 'test' })
  beforeAll(async () => {
    const parsed = new URL(url!), name = decodeURIComponent(parsed.pathname.slice(1))
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname)
      || !/test/i.test(name) || decodeURIComponent(parsed.username) !== name || parsed.searchParams.has('options')) throw new Error('Non-isolated database')
    pool = new pg.Pool({ connectionString: url })
    const identity = (await pool.query(`SELECT current_database() AS name,current_user AS role,
      (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)).rows[0]
    if (identity.name !== name || identity.role !== name || identity.superuser) throw new Error('Unexpected database identity')
    await initDB(pool)
  }, 30_000)
  afterAll(async () => { if (pool) { await pool.query('TRUNCATE extension_providers,users,daemons RESTART IDENTITY CASCADE'); await pool.end() } })

  async function user() {
    return Number((await pool.query(`INSERT INTO users(email,password_hash) VALUES($1,'x') RETURNING id`, [`${randomUUID()}@example.test`])).rows[0].id)
  }
  async function fixture(otherCreator = false) {
    const owner = await user(), teams = new TeamRepository(pool)
    const team = (await teams.createTeam({ actorUserId: owner, name: 'Settlement boundaries', requestId: randomUUID() })).team
    const creator = otherCreator ? await user() : owner
    let membership: any
    if (otherCreator) {
      const email = (await pool.query('SELECT email FROM users WHERE id=$1', [creator])).rows[0].email
      const invitation = await teams.invite({ teamId: team.id, actorUserId: owner, email, expectedRevision: (await teams.getTeam(team.id, owner)).revision, requestId: randomUUID() })
      membership = (await teams.respondToInvitation({ invitationId: invitation.id, actorUserId: creator, action: 'accepted', expectedRevision: invitation.revision, requestId: randomUUID() })).membership
    }
    const offers: Array<{ offer: Awaited<ReturnType<TeamRepository['addAgentOffer']>>; daemon: string }> = []
    for (let i = 0; i < 2; i++) {
      // Two isolated synthetic daemon declarations, both owned by the remaining member.
      const daemon = randomUUID()
      await pool.query(`INSERT INTO daemons(daemon_id,hostname,agents,status,user_id,collaboration_capabilities)
        VALUES($1,'settlement-fixture','[{"type":"codex","manageable":true}]','online',$2,
          '["team_collaboration_dispatch_v1","team_collaboration_context_v1"]')`, [daemon, owner])
      const offer = await teams.addAgentOffer({ teamId: team.id, actorUserId: owner, daemonId: daemon, provider: 'codex', runtimeProfileId: null, expectedRevision: (await teams.getTeam(team.id, owner)).revision, requestId: randomUUID() })
      offers.push({ offer, daemon })
    }
    const sessions = new TeamSessionService(pool)
    const session = await sessions.createSession({ teamId: team.id, actorUserId: creator, title: 'Settlement boundary', taskId: null, offerIds: offers.map(v => v.offer.id), requestId: randomUUID() })
    await new TeamContextService(pool).create({ sessionId: session.id, actorUserId: creator, expectedRevision: 0, goal: 'Settle accepted calls safely', consensus: [], openQuestions: [], references: [], requestId: randomUUID() })
    const runs = new TeamRunRepository(pool), worker = new TeamRunWorker({ repository: runs, workerId: 'settlement-fixture' })
    const created = await runs.create({ sessionId: session.id, actorUserId: creator, coordinatorOfferId: offers[0].offer.id, contextVersion: 1, budget: { max_calls: 6, max_concurrent_calls: 1, max_duration_seconds: 120 }, requestId: randomUUID() })
    expect(await worker.runOnce()).toBe(true)
    const call = (await pool.query('SELECT call_id FROM collaboration_calls WHERE run_id=$1', [created.run.id])).rows[0].call_id
    const dispatch = new TeamDispatchRepository(pool), native = randomUUID()
    expect(await dispatch.claim(call)).not.toBeNull()
    expect(await dispatch.bindNativeSession(call, offers[0].daemon, owner, native)).toBe(true)
    expect(await dispatch.recordReceipt(call, offers[0].daemon, owner, 'accepted', null)).toBe(true)
    // Synthetic native events enter the real projection/settlement code. Docker
    // scenarios separately prove these decisions with actual native model requests.
    async function settle(action: 'request_input' | 'call_agent' | 'invalid') {
      const decision = action === 'request_input'
        ? { action, context_version: 1, question: 'Which migration?' }
        : action === 'call_agent' ? { action, context_version: 1, target_offer_id: offers[1].offer.id, instruction: 'Inspect the migration' }
        : { action: 'unrecognized', context_version: 1 }
      await dispatch.projectDaemonEvent(offers[0].daemon, owner, { type: 'agent_text', session_id: native, seq: 1, text: JSON.stringify(decision) })
      await dispatch.projectDaemonEvent(offers[0].daemon, owner, { type: 'turn_status', session_id: native, seq: 2, turn_status: 'completed' })
    }
    async function process() {
      await expect.poll(async () => (await pool.query('SELECT next_wake_at<=NOW() AS ready FROM collaboration_runs WHERE run_id=$1', [created.run.id])).rows[0].ready, { timeout: 2_000 }).toBe(true)
      expect(await worker.runOnce()).toBe(true)
    }
    // Fixture cleanup only; no claim about product cancellation is derived from it.
    async function cleanup() { await pool.query('DELETE FROM collaboration_runs WHERE run_id=$1', [created.run.id]) }
    return { owner, creator, team, membership, teams, session, sessions, runs, worker, run: created.run, settle, process, cleanup }
  }
  test.each(['ended', 'archived'] as const)('an accepted input request cannot leave a %s Session waiting for impossible input', async state => {
    const f = await fixture()
    try {
      await f.sessions.updateSession({ sessionId: f.session.id, actorUserId: f.creator, state, expectedRevision: 1, requestId: randomUUID() })
      await f.settle('request_input'); await f.process()
      expect(await f.runs.get(f.run.id, f.creator)).toMatchObject({ state: 'cancelled', calls_used: 1 })
    } finally { await f.cleanup() }
  })
  test('an active Session can still wait for participant input', async () => {
    const f = await fixture()
    try {
      await f.settle('request_input'); await f.process()
      expect(await f.runs.get(f.run.id, f.creator)).toMatchObject({ state: 'waiting_input', calls_used: 1, waiting_question: 'Which migration?' })
    } finally { await f.cleanup() }
  })
  test('cancellation remains available while an accepted call settles in a paused Session', async () => {
    const f = await fixture()
    try {
      await f.sessions.updateSession({ sessionId: f.session.id, actorUserId: f.creator, state: 'paused', expectedRevision: 1, requestId: randomUUID() })
      await f.runs.control({ runId: f.run.id, actorUserId: f.creator, action: 'cancel', expectedRevision: (await f.runs.get(f.run.id, f.creator)).revision, requestId: randomUUID() })
      await f.settle('call_agent'); await f.process()
      expect(await f.runs.get(f.run.id, f.creator)).toMatchObject({ state: 'cancelled', calls_used: 1 })
    } finally { await f.cleanup() }
  })
  test('revoking the initiator settles the Run without throwing or scheduling another call', async () => {
    const f = await fixture(true)
    try {
      await f.teams.removeMember({ teamId: f.team.id, membershipId: f.membership.id, actorUserId: f.owner, expectedRevision: f.membership.revision, requestId: randomUUID() })
      await f.settle('call_agent')
      await f.process()
      expect(await f.runs.get(f.run.id, f.owner)).toMatchObject({ state: 'cancelled', calls_used: 1 })
    } finally { await f.cleanup() }
  })
  for (const dormantState of ['waiting_input', 'paused', 'blocked'] as const) {
    test.each(['ended', 'archived'] as const)(`a ${dormantState} Run settles when its Session becomes %s`, async sessionState => {
      const f = await fixture()
      try {
        if (dormantState === 'paused') {
          await f.runs.control({ runId: f.run.id, actorUserId: f.creator, action: 'pause',
            expectedRevision: (await f.runs.get(f.run.id, f.creator)).revision, requestId: randomUUID() })
          await f.settle('request_input')
        } else {
          await f.settle(dormantState === 'blocked' ? 'invalid' : 'request_input'); await f.process()
        }
        expect(await f.runs.get(f.run.id, f.creator)).toMatchObject({ state: dormantState })
        await f.sessions.updateSession({ sessionId: f.session.id, actorUserId: f.creator, state: sessionState,
          expectedRevision: 1, requestId: randomUUID() })
        await f.process()
        expect(await f.runs.get(f.run.id, f.creator)).toMatchObject({ state: 'cancelled', calls_used: 1 })
      } finally { await f.cleanup() }
    })
    test(`a ${dormantState} Run settles after its initiator is removed`, async () => {
      const f = await fixture(true)
      try {
        if (dormantState === 'paused') {
          await f.runs.control({ runId: f.run.id, actorUserId: f.creator, action: 'pause',
            expectedRevision: (await f.runs.get(f.run.id, f.creator)).revision, requestId: randomUUID() })
          await f.settle('request_input')
        } else {
          await f.settle(dormantState === 'blocked' ? 'invalid' : 'request_input'); await f.process()
        }
        await f.teams.removeMember({ teamId: f.team.id, membershipId: f.membership.id, actorUserId: f.owner,
          expectedRevision: f.membership.revision, requestId: randomUUID() })
        await f.process()
        expect(await f.runs.get(f.run.id, f.owner)).toMatchObject({ state: 'cancelled', calls_used: 1 })
      } finally { await f.cleanup() }
    })
  }
  test('a paused Session defers an accepted input decision until Session resume', async () => {
    const f = await fixture()
    try {
      await f.sessions.updateSession({ sessionId: f.session.id, actorUserId: f.creator, state: 'paused', expectedRevision: 1, requestId: randomUUID() })
      await f.settle('request_input'); await f.process()
      expect(await f.runs.get(f.run.id, f.creator)).toMatchObject({ state: 'running', calls_used: 1, processed_call_step: 0 })
      await f.sessions.updateSession({ sessionId: f.session.id, actorUserId: f.creator, state: 'active', expectedRevision: 2, requestId: randomUUID() })
      await f.process()
      expect(await f.runs.get(f.run.id, f.creator)).toMatchObject({ state: 'waiting_input', calls_used: 1, waiting_question: 'Which migration?' })
    } finally { await f.cleanup() }
  })
  for (const dormantState of ['waiting_input', 'paused', 'blocked'] as const) {
    test(`an authorized ${dormantState} Run is not claimed without stop or lost authority`, async () => {
      const f = await fixture()
      try {
        if (dormantState === 'paused') {
          await f.runs.control({ runId: f.run.id, actorUserId: f.creator, action: 'pause',
            expectedRevision: (await f.runs.get(f.run.id, f.creator)).revision, requestId: randomUUID() })
          await f.settle('request_input')
        } else {
          await f.settle(dormantState === 'blocked' ? 'invalid' : 'request_input'); await f.process()
        }
        expect(await f.worker.runOnce()).toBe(false)
        expect(await f.runs.get(f.run.id, f.creator)).toMatchObject({ state: dormantState, calls_used: 1 })
      } finally { await f.cleanup() }
    })
  }
  test('initiator revocation also settles an accepted input request', async () => {
    const f = await fixture(true)
    try {
      await f.teams.removeMember({ teamId: f.team.id, membershipId: f.membership.id, actorUserId: f.owner,
        expectedRevision: f.membership.revision, requestId: randomUUID() })
      await f.settle('request_input'); await f.process()
      expect(await f.runs.get(f.run.id, f.owner)).toMatchObject({ state: 'cancelled', terminal_reason: 'initiator_unavailable', calls_used: 1 })
    } finally { await f.cleanup() }
  })
  test.each([1, 2])('binding with real installation and grant readers completes in a max=%s connection pool', async max => {
    const owner = await user(), teams = new TeamRepository(pool)
    const team = (await teams.createTeam({ actorUserId: owner, name: 'Pool boundary', requestId: randomUUID() })).team
    const installation = randomUUID()
    await pool.query(`INSERT INTO extension_providers(provider_id,manifest_version,manifest) VALUES('pocketctl-memory',1,'{}') ON CONFLICT DO NOTHING`)
    await pool.query(`INSERT INTO extension_installations(installation_id,provider_id,owner_user_id,status,granted_scopes,subscriptions,enabled_services,event_filter,start_policy)
      VALUES($1,'pocketctl-memory',$2,'active','{}','{}','{memory.context}','{}','from_now')`, [installation, owner])
    const limited = new pg.Pool({ connectionString: url, max, connectionTimeoutMillis: 300 })
    try {
      const grants = createV2GrantService({ pool: limited, issuer: 'https://relay.example.test', v2Mode: 'enabled', grantKeys })
      const service = new TeamMemoryBindingService(limited, new ExtensionInstallationRepository(limited), grants, { memoryBridgeEnabled: true })
      await expect(service.bind({ teamId: team.id, actorUserId: owner, installationId: installation, expectedRevision: 0, requestId: randomUUID() })).resolves.toMatchObject({ manageable: true, access_state: 'available' })
    } finally { await limited.end() }
  })
})
