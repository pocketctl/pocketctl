import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { TeamRepository } from '../team/repository.js'
import { TeamSessionService } from '../team/session-service.js'
import { TeamContextService } from '../team/context-service.js'
import { TeamMemoryBindingService } from '../team/memory-binding-service.js'
import { TeamRunRepository } from '../team/run-repository.js'
import { DEFAULT_TEAM_RUN_BUDGET } from '../team/run-service.js'
import { TeamRunWorker } from '../team/run-worker.js'
import { createOrganizationWithCreator, createTeamWithCreator } from '../extensions/scope-repository.js'

const url = process.env.TEST_DATABASE_URL
const databaseTests = url && process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
databaseTests('Memory binding and Session lifecycle boundaries (PostgreSQL)', () => {
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
  afterAll(async () => { if (pool) { await pool.query('TRUNCATE extension_providers,users,daemons RESTART IDENTITY CASCADE'); await pool.end() } })

  async function fixture() {
    const key = randomUUID(), teams = new TeamRepository(pool)
    const owner = Number((await pool.query(`INSERT INTO users(email,password_hash) VALUES($1,'x') RETURNING id`, [`${key}@example.test`])).rows[0].id)
    const team = (await teams.createTeam({ actorUserId: owner, name: 'Lifecycle boundaries', requestId: key })).team
    return { owner, team, teams }
  }
  async function memoryFixture() {
    const f = await fixture(), installation = randomUUID()
    const { organization } = await createOrganizationWithCreator(pool, { name: 'Binding authority', createdByUserId: f.owner })
    const { team } = await createTeamWithCreator(pool, { organizationId: organization.organization_id, name: 'Binding authority', createdByUserId: f.owner })
    const scope = team.team_id
    await pool.query(`INSERT INTO extension_providers(provider_id,manifest_version,manifest) VALUES('pocketctl-memory',1,'{}') ON CONFLICT DO NOTHING`)
    await pool.query(`INSERT INTO extension_installations(installation_id,provider_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,event_filter,start_policy)
      VALUES($1,'pocketctl-memory','team',$2,'active','{}','{}','{}','{}','from_now')`, [installation, scope])
    // External grant responses are explicit fixtures; scope, membership,
    // installation, Team authorization, receipts and writes are real PG.
    let allowed = true
    const installations = { getScopedInstallation: async () => ({ installation_id: installation, provider_id: 'pocketctl-memory', owner_scope_kind: 'team', owner_scope_id: scope }) } as any
    const grants = { mint: async () => allowed
      ? { ok: true, token: 'fixture', bindings: [{ installation_id: installation, owner_scope_kind: 'team', owner_scope_id: scope, permissions: ['read', 'scope_admin'] }] }
      : { ok: false, code: 'not_found', message: 'scope no longer readable' } } as any
    const service = new TeamMemoryBindingService(pool, installations, grants, { memoryBridgeEnabled: true })
    return { ...f, scope, installation, installations, grants, service, revoke: () => { allowed = false } }
  }
  test('authorized Memory removal receipt preserves null without mutating the binding twice', async () => {
    const f = await memoryFixture()
    const binding = await f.service.bind({ teamId: f.team.id, actorUserId: f.owner, installationId: f.installation, expectedRevision: 0, requestId: 'bind' })
    const input = { teamId: f.team.id, actorUserId: f.owner, expectedRevision: binding.revision, requestId: 'remove' }
    expect(await f.service.remove(input)).toBeNull()
    const before = (await pool.query('SELECT * FROM team_memory_bindings WHERE team_id=$1', [f.team.id])).rows
    expect(await f.service.remove(input)).toBeNull()
    expect((await pool.query('SELECT * FROM team_memory_bindings WHERE team_id=$1', [f.team.id])).rows).toEqual(before)
  })
  test('a dissolved Team conceals cached Memory removal like fresh removal and ordinary reads', async () => {
    const f = await memoryFixture()
    const binding = await f.service.bind({ teamId: f.team.id, actorUserId: f.owner, installationId: f.installation, expectedRevision: 0, requestId: 'bind' })
    const input = { teamId: f.team.id, actorUserId: f.owner, expectedRevision: binding.revision, requestId: 'remove' }
    await f.service.remove(input)
    await f.teams.dissolveTeam({ teamId: f.team.id, actorUserId: f.owner, expectedRevision: f.team.revision, requestId: 'dissolve' })
    await expect(f.service.getBinding(f.team.id, f.owner)).rejects.toMatchObject({ code: 'team_not_found' })
    await expect(f.service.remove({ ...input, requestId: 'fresh-remove' })).rejects.toMatchObject({ code: 'team_not_found' })
    await expect(f.service.remove(input)).rejects.toMatchObject({ code: 'team_not_found' })
  })
  test('fresh binding with revoked Memory authority is rejected without database mutation', async () => {
    const f = await memoryFixture(); f.revoke()
    await expect(f.service.bind({ teamId: f.team.id, actorUserId: f.owner, installationId: f.installation, expectedRevision: 0, requestId: 'bind' })).rejects.toMatchObject({ code: 'memory_grant_required' })
    expect((await pool.query('SELECT * FROM team_memory_bindings WHERE team_id=$1', [f.team.id])).rows).toEqual([])
  })
  test('a binding waiting for the Team lock revalidates revoked Memory authority before commit', async () => {
    const f = await memoryFixture(), blocker = await pool.connect()
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const gated = { query: pool.query.bind(pool), connect: async () => {
      const client = await pool.connect()
      return { release: () => client.release(), query: (sql: string, args?: any[]) => {
        if (sql.includes('FOR UPDATE OF team')) entered()
        return client.query(sql, args)
      } }
    } } as unknown as pg.Pool
    await blocker.query('BEGIN')
    await blocker.query('SELECT 1 FROM collaboration_teams WHERE team_id=$1 FOR UPDATE', [f.team.id])
    const service = new TeamMemoryBindingService(gated, f.installations, f.grants, { memoryBridgeEnabled: true })
    const result = service.bind({ teamId: f.team.id, actorUserId: f.owner, installationId: f.installation, expectedRevision: 0, requestId: 'bind' })
      .then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error }))
    try { await waiting; f.revoke() } finally { await blocker.query('COMMIT'); blocker.release() }
    expect(await result).toMatchObject({ status: 'rejected', error: { code: 'memory_grant_required' } })
    expect((await pool.query('SELECT * FROM team_memory_bindings WHERE team_id=$1', [f.team.id])).rows).toEqual([])
  })
  test.each(['scope', 'membership', 'installation'] as const)('binding commit serializes a concurrent %s authority change', async authority => {
    const f = await memoryFixture(), writer = await pool.connect()
    let entered!: () => void, release!: () => void
    const atWrite = new Promise<void>(resolve => { entered = resolve })
    const proceed = new Promise<void>(resolve => { release = resolve })
    const gated = { query: pool.query.bind(pool), connect: async () => {
      const client = await pool.connect()
      return { release: () => client.release(), query: async (sql: string, args?: any[]) => {
        if (sql.includes('INSERT INTO team_memory_bindings')) { entered(); await proceed }
        return client.query(sql, args)
      } }
    } } as unknown as pg.Pool
    const service = new TeamMemoryBindingService(gated, f.installations, f.grants, { memoryBridgeEnabled: true })
    const binding = service.bind({ teamId: f.team.id, actorUserId: f.owner, installationId: f.installation, expectedRevision: 0, requestId: 'bind' })
    let change: Promise<unknown> | undefined
    try {
      await atWrite
      const pid = Number((await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      const query = authority === 'scope'
        ? [`UPDATE extension_teams SET state='suspended' WHERE team_id=$1`, [f.scope]]
        : authority === 'membership'
          ? [`UPDATE extension_scope_memberships SET state='revoked' WHERE scope_id=$1 AND user_id=$2`, [f.scope, f.owner]]
          : [`UPDATE extension_installations SET status='paused' WHERE installation_id=$1`, [f.installation]]
      change = writer.query(query[0] as string, query[1] as any[])
      // Observe an actual competing writer, rather than assert SQL text or mock counts.
      await expect.poll(async () => (await pool.query('SELECT state,wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0], { timeout: 2_000 })
        .toMatchObject({ state: 'active', wait_event_type: 'Lock' })
      release()
      expect(await binding).toMatchObject({ access_state: 'available', manageable: true })
      await change
      expect((await pool.query('SELECT COUNT(*)::int AS n FROM team_memory_bindings WHERE team_id=$1', [f.team.id])).rows[0].n).toBe(1)
    } finally { release(); await binding.catch(() => undefined); await change?.catch(() => undefined); writer.release() }
  })
  test.each(['active', 'paused', 'ended'] as const)('new Run scheduling observes the current %s Session state', async state => {
    const f = await fixture(), sessions = new TeamSessionService(pool), daemon = randomUUID()
    await pool.query(`INSERT INTO daemons(daemon_id,hostname,agents,status,user_id,collaboration_capabilities)
      VALUES($1,'lifecycle-fixture','[{"type":"codex","manageable":true}]','online',$2,
        '["team_collaboration_dispatch_v1","team_collaboration_context_v1"]')`, [daemon, f.owner])
    const offer = await f.teams.addAgentOffer({ teamId: f.team.id, actorUserId: f.owner, daemonId: daemon, provider: 'codex', runtimeProfileId: null, expectedRevision: f.team.revision, requestId: 'offer' })
    const session = await sessions.createSession({ teamId: f.team.id, actorUserId: f.owner, title: 'Run state boundary', taskId: null, offerIds: [offer.id], requestId: 'session' })
    await new TeamContextService(pool).create({ sessionId: session.id, actorUserId: f.owner, goal: 'Run state boundary', consensus: [], openQuestions: [], references: [], expectedRevision: 0, requestId: 'context' })
    const runs = new TeamRunRepository(pool)
    const created = await runs.create({ sessionId: session.id, actorUserId: f.owner, coordinatorOfferId: offer.id, contextVersion: 1, budget: DEFAULT_TEAM_RUN_BUDGET, requestId: 'run' })
    const lease = await runs.claimNext('lifecycle-verifier', 15_000)
    expect(lease?.run.id).toBe(created.run.id)
    if (state !== 'active') await sessions.updateSession({ sessionId: session.id, actorUserId: f.owner, expectedRevision: 1, state, requestId: 'state' })
    const input = { runId: created.run.id, leaseToken: lease!.leaseToken, offerId: offer.id, role: 'coordinator' as const, content: 'New scheduling must respect Session state', processedCallStep: 0 }
    try {
      if (state === 'active') expect(await runs.scheduleCall(input)).toHaveProperty('callId')
      else {
        const before = await sessions.getSession(session.id, f.owner)
        await expect(runs.scheduleCall(input)).rejects.toMatchObject({ code: 'invalid_state' })
        expect(await sessions.getSession(session.id, f.owner)).toEqual(before)
        expect((await pool.query('SELECT * FROM collaboration_calls WHERE run_id=$1', [created.run.id])).rows).toEqual([])
      }
    } finally {
      // Official cancellation/worker settlement keeps the next lease independent.
      await runs.control({ runId: created.run.id, actorUserId: f.owner, action: 'cancel', expectedRevision: (await runs.get(created.run.id, f.owner)).revision, requestId: 'cancel' })
      await new TeamRunWorker({ repository: runs, workerId: 'lifecycle-cleanup' }).runOnce()
    }
  })
})
