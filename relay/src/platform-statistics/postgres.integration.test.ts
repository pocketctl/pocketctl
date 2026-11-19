import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { ensurePlatformStatisticsSchema } from './schema.js'
import { recordHumanDecision, recordMaterializedActivity, recordRegistration } from './facts.js'
import { platformStatisticsConfig } from './config.js'
import { parseStatisticsRange } from './range.js'
import { readPlatformStatistics } from './service.js'
import { statisticsCsv } from './routes.js'
import { heartbeatPlatformStatisticsCollector } from './collector.js'
import type { MaterializationInput } from '../materialization/types.js'
import type { MemorySnapshot } from './types.js'
import Fastify from 'fastify'
import { registerPlatformStatisticsRoutes } from './routes.js'

const dsn = process.env.PLATFORM_STATS_TEST_DATABASE_URL
describe.skipIf(!dsn)('platform statistics PostgreSQL durable facts', () => {
  const schema = `statistics_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: dsn, max: 1 })
  const pool = new pg.Pool({ connectionString: dsn, options: `-c search_path=${schema}`, max: 2 })
  const env = { PLATFORM_STATS_ENABLED: 'true', PLATFORM_STATS_OWNER_USER_ID: '1', PLATFORM_STATS_EXCLUDED_USER_IDS: '3' }
  const config = platformStatisticsConfig(env)
  const now = new Date('2026-11-07T04:30:00Z')
  const range = parseStatisticsRange({ from: '2026-11-01', to: '2026-11-02' }, now)
  const oldEnv = { ...process.env }
  beforeAll(async () => {
    Object.assign(process.env, env)
    await admin.query(`CREATE SCHEMA ${schema}`)
    await pool.query(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT);
      CREATE TABLE sessions(session_id TEXT PRIMARY KEY,user_id INTEGER,parent_session_id TEXT,is_subagent BOOLEAN DEFAULT false);
      CREATE TABLE event_inbox(received_at TIMESTAMPTZ,status SMALLINT,event_type TEXT,user_id INTEGER,payload JSONB);
      CREATE TABLE extension_installations(installation_id UUID PRIMARY KEY,owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        owner_scope_kind TEXT NOT NULL DEFAULT 'personal',owner_scope_id UUID);
      CREATE TABLE extension_scope_memberships(membership_id UUID PRIMARY KEY,scope_kind TEXT,scope_id UUID,user_id INTEGER REFERENCES users(id) ON DELETE SET NULL)`)
    await ensurePlatformStatisticsSchema(pool, env)
  })
  beforeEach(async () => {
    await pool.query('TRUNCATE platform_statistics_facts,platform_statistics_gaps,extension_installations,extension_scope_memberships,event_inbox,sessions,users CASCADE')
    await pool.query("UPDATE platform_statistics_coverage SET starts_at='2026-10-01T00:00:00Z'")
    await pool.query("INSERT INTO platform_statistics_collectors VALUES('relay',$1),('materializer',$1) ON CONFLICT(channel) DO UPDATE SET last_seen=EXCLUDED.last_seen", [now])
    await pool.query("INSERT INTO users(id,email) VALUES(1,'james_2001_2001@163.com'),(2,'other@example.test'),(3,'excluded@example.test'); INSERT INTO sessions(session_id,user_id) VALUES('main',1),('other',2); INSERT INTO sessions VALUES('child',1,'main',true)")
  })
  afterAll(async () => {
    for (const key of Object.keys(env)) { if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key] }
    await pool.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  })
  function output(overrides: Partial<MaterializationInput> = {}): MaterializationInput {
    return { inboxId: 1,userId: 1,daemonId: 'daemon',sessionId: 'main',eventType: 'agent_text',payload: { text: 'not persisted in facts' },receivedAt: new Date('2026-11-01T03:00:00Z'), ...overrides }
  }
  function memory(): MemorySnapshot {
    return { coverageStart: '2026-10-01T00:00:00Z',dataThrough: now.toISOString(),gaps: [],actorLimitExceeded: false,
      periods: { current: { memory: 0,automatic: 0,manual: 0,unclassified: 0,daily: [],actors: [],dailyActors: [] },
        previous: { memory: 0,automatic: 0,manual: 0,unclassified: 0,daily: [],actors: [],dailyActors: [] } } }
  }
  it('rolls facts back with the business transaction and deduplicates replay', async () => {
    const client = await pool.connect()
    await client.query('BEGIN')
    await recordRegistration(client, 1, '2026-11-01T03:00:00Z')
    await client.query('ROLLBACK')
    client.release()
    expect((await pool.query('SELECT * FROM platform_statistics_facts')).rows).toHaveLength(0)
    await recordRegistration(pool, 1, '2026-11-01T03:00:00Z')
    await recordRegistration(pool, 1, '2026-11-01T03:00:00Z')
    await recordMaterializedActivity(pool, output(), 1)
    await recordMaterializedActivity(pool, output(), 1)
    expect((await pool.query('SELECT kind FROM platform_statistics_facts')).rows).toHaveLength(2)
  })
  it('counts period distinct independently and combines verified Memory human actors', async () => {
    await recordHumanDecision(pool, { userId: 1,sessionId: 'main',requestId: 'first',type: 'approval_response' }, new Date('2026-11-01T03:00:00Z'))
    await recordHumanDecision(pool, { userId: 1,sessionId: 'main',requestId: 'second',type: 'question_response' }, new Date('2026-11-02T03:00:00Z'))
    const installation = '00000000-0000-4000-8000-000000000001'
    await pool.query('INSERT INTO extension_installations(installation_id,owner_user_id) VALUES($1,1)', [installation])
    const snapshot = memory()
    snapshot.periods.current.actors = [{ installationId: installation, readRequests: 2,writeRequests: 0,humanActivity: true }]
    snapshot.periods.current.dailyActors = [{ ...snapshot.periods.current.actors[0],date: '2026-11-01' }]
    const result = await readPlatformStatistics(pool, config, range, async () => snapshot, now)
    expect(result.metrics.activeUsers).toMatchObject({ value: 1,status: 'complete' })
    expect(result.metrics.sessions.value).toBe(1)
    expect(result.daily.map(day => day.activeUsers.value)).toEqual([1,1])
    expect(result.metrics.memoryUsers.value).toBe(1)
    expect(result.metrics.readRequests.value).toBe(2)
    expect(result.previous.activeUsers).toMatchObject({ value: 0,status: 'complete' })
    expect(result.comparisonAvailable).toBe(true)
    const csv = statisticsCsv(result)
    expect(csv).toContain('coverageStart')
    expect(csv).not.toContain(installation)
    expect(csv).not.toContain('not persisted in facts')
  })
  it('keeps zero complete only inside coverage and marks unknown Memory unavailable', async () => {
    await pool.query("UPDATE platform_statistics_coverage SET starts_at='2026-11-01T10:00:00Z'")
    const result = await readPlatformStatistics(pool, config, range, undefined, now)
    expect(result.metrics.newUsers).toMatchObject({ value: 0,status: 'partial',reason: 'before_forward_coverage' })
    expect(result.daily[1].newUsers).toMatchObject({ value: 0,status: 'complete' })
    expect(result.metrics.memory).toMatchObject({ value: null,status: 'unavailable' })
    expect(result.metrics.activeUsers.status).toBe('partial')
    expect(result.previous.newUsers).toMatchObject({ value: null,status: 'unavailable' })
  })
  it('shows the first observed session immediately, then keeps it in historical daily and distinct totals', async () => {
    const started = '2026-11-01T02:40:00Z'
    await pool.query('UPDATE platform_statistics_coverage SET starts_at=$1', [started])
    const snapshot = memory()
    snapshot.coverageStart = started
    await recordMaterializedActivity(pool, output(), 1)
    const today = new Date('2026-11-01T03:01:00Z')
    const dayRange = parseStatisticsRange({ from: '2026-11-01', to: '2026-11-01' }, today)
    const live = await readPlatformStatistics(pool, config, dayRange, async () => snapshot, today)
    const observed = { value: 1, status: 'partial', reason: 'before_forward_coverage' }
    expect(live.metrics.sessions).toMatchObject(observed)
    expect(live.metrics.memory).toMatchObject({ value: 0, status: 'partial' })
    expect(live.previous.sessions).toMatchObject({ value: null, status: 'unavailable' })

    await recordMaterializedActivity(pool, output({ receivedAt: new Date('2026-11-02T03:00:00Z') }), 2)
    const history = await readPlatformStatistics(pool, config, range, async () => snapshot, now)
    expect(history.metrics.sessions).toMatchObject(observed)
    expect(history.daily[0].sessions).toMatchObject(observed)
    expect(history.daily[1].sessions).toMatchObject({ value: 1, status: 'complete' })
    expect(history.comparisonAvailable).toBe(false)
    expect(statisticsCsv(history)).toContain('"current","2026-11-01","sessions","1","partial"')
  })

  it('keeps observed sessions around outages and does not infer zero across adjacent blind intervals', async () => {
    await pool.query(`INSERT INTO platform_statistics_gaps VALUES
      ('sessions','2026-10-31T16:00Z','2026-11-01T12:00Z','collector_interrupted'),
      ('sessions','2026-11-01T11:00Z','2026-11-01T16:00Z','collector_interrupted'),
      ('sessions','2026-11-01T16:00Z','2026-11-01T21:00Z','collector_interrupted')`)
    await recordMaterializedActivity(pool, output({ receivedAt: new Date('2026-11-02T03:00:00Z') }), 1)
    const result = await readPlatformStatistics(pool, config, range, async () => memory(), now)
    expect(result.daily[0].sessions).toMatchObject({ value: null, status: 'partial', reason: 'coverage_gap' })
    expect(result.daily[1].sessions).toMatchObject({ value: 1, status: 'partial', reason: 'coverage_gap' })
    expect(result.metrics.sessions).toMatchObject({ value: 1, status: 'partial' })
  })

  it('rejects resync, telemetry, empty output, unproven human events and foreign owners', async () => {
    await recordMaterializedActivity(pool, output({ payload: { text: 'x', resync: true } }), 1)
    await recordMaterializedActivity(pool, output({ payload: { text: 'x', content_class: 'telemetry' } }), 2)
    await recordMaterializedActivity(pool, output({ payload: { text: ' ' } }), 3)
    await recordMaterializedActivity(pool, output({ eventType: 'approval_resolved' }), 4)
    await recordMaterializedActivity(pool, output({ userId: 2 }), 5)
    expect((await pool.query('SELECT * FROM platform_statistics_facts')).rows).toHaveLength(0)
    await recordMaterializedActivity(pool, output({ sessionId: 'child',payload: { text: 'child output',is_subagent: true } }), 6)
    expect((await pool.query('SELECT session_id FROM platform_statistics_facts')).rows).toEqual([{ session_id: 'main' }])
  })
  it('preserves facts on ordinary session deletion, clears identifying facts and invalidates account history', async () => {
    await recordRegistration(pool, 1, '2026-11-01T03:00:00Z')
    await recordMaterializedActivity(pool, output(), 1)
    await pool.query("DELETE FROM sessions WHERE session_id='main'")
    expect((await pool.query('SELECT * FROM platform_statistics_facts')).rows).toHaveLength(2)
    await pool.query('DELETE FROM users WHERE id=1')
    expect((await pool.query('SELECT * FROM platform_statistics_facts')).rows).toHaveLength(0)
    const result = await readPlatformStatistics(pool, config, range, async () => memory(), now)
    expect(result.metrics.newUsers.status).toBe('partial')
    expect(result.metrics.sessions.status).toBe('partial')
  })
  it('invalidates historical Memory usage when an installation owner is deleted', async () => {
    await pool.query("INSERT INTO extension_installations(installation_id,owner_user_id) VALUES('00000000-0000-4000-8000-000000000001',1)")
    await pool.query('DELETE FROM users WHERE id=1')
    const result = await readPlatformStatistics(pool, config, range, async () => memory(), now)
    expect(result.metrics.memoryUsers.status).toBe('partial')
    expect(result.metrics.readRequests.status).toBe('partial')
    expect(result.metrics.activeUsers.status).toBe('partial')
  })
  it('maps a shared caller only through its verified membership, never the scope creator', async () => {
    const installation = '00000000-0000-4000-8000-000000000002'
    const membership = '00000000-0000-4000-8000-000000000003'
    const scope = '00000000-0000-4000-8000-000000000004'
    await pool.query("INSERT INTO extension_installations VALUES($1,NULL,'team',$2)", [installation,scope])
    await pool.query("INSERT INTO extension_scope_memberships VALUES($1,'team',$2,2)", [membership,scope])
    const snapshot = memory()
    snapshot.periods.current.actors = [{ installationId: installation,membershipId: membership,readRequests: 3,writeRequests: 0,humanActivity: true }]
    const result = await readPlatformStatistics(pool, config, range, async () => snapshot, now)
    expect(result.metrics.memoryUsers).toMatchObject({ value: 1,status: 'complete' })
    expect(result.metrics.activeUsers).toMatchObject({ value: 1,status: 'complete' })
    snapshot.periods.current.actors[0].membershipId = undefined
    const unknown = await readPlatformStatistics(pool, config, range, async () => snapshot, now)
    expect(unknown.metrics.memoryUsers).toMatchObject({ value: null,status: 'partial',reason: 'memory_actor_owner_unknown' })
  })
  it('records a durable gap when a collector resumes after a stale lease', async () => {
    await pool.query("UPDATE platform_statistics_collectors SET last_seen='2026-11-01T00:00:00Z' WHERE channel='materializer'")
    const stale = await readPlatformStatistics(pool, config, range, async () => memory(), now)
    expect(stale.metrics.sessions).toMatchObject({ value: 0,status: 'partial' })
    await heartbeatPlatformStatisticsCollector(pool, 'materializer', now)
    const resumed = await readPlatformStatistics(pool, config, range, async () => memory(), now)
    expect(resumed.metrics.sessions).toMatchObject({ value: 0,status: 'partial' })
    expect((await pool.query("SELECT 1 FROM platform_statistics_gaps WHERE reason='collector_interrupted'")).rowCount).toBe(2)
  })
  it('reruns aggregate-only summary and CSV with owner auth and no-store', async () => {
    const app = Fastify()
    let authentications = 0
    registerPlatformStatisticsRoutes(app, { pool,env,now: () => now,memoryReader: async () => memory(),
      verifyAccessToken: async token => { authentications++; return token === 'owner' ? { userId: 1 } : null } })
    for (const endpoint of ['/api/admin/statistics','/api/admin/statistics/export.csv']) {
      const result = await app.inject({ url: `${endpoint}?from=2026-11-01&to=2026-11-02`,headers: { authorization: 'Bearer owner' } })
      expect(result.statusCode).toBe(200)
      expect(result.headers['cache-control']).toContain('no-store')
      expect(result.body).not.toContain('owner_user_id')
      expect(result.body).not.toContain('installation_id')
    }
    expect(authentications).toBe(2)
    expect((await app.inject({ url: '/api/admin/statistics?from=2026-02-30&to=2026-03-01',headers: { authorization: 'Bearer owner' } })).statusCode).toBe(400)
    await app.close()
  })
  it('filters excluded users and never turns a Memory failure into a zero', async () => {
    await recordRegistration(pool, 3, '2026-11-01T03:00:00Z')
    const result = await readPlatformStatistics(pool, config, range, async () => { throw new Error('source offline') }, now)
    expect(result.metrics.newUsers).toMatchObject({ value: 0,status: 'complete' })
    expect(result.metrics.memory).toMatchObject({ value: null,status: 'unavailable' })
    expect(result.warnings).toEqual(['memory_source_unavailable'])
    const noExclusions = await readPlatformStatistics(pool, { ...config,excludedUserIds: [] }, range, async () => memory(), now)
    expect(noExclusions.metrics.newUsers).toMatchObject({ value: 1,status: 'complete' })
  })
  it('does not claim complete zero while accepted relevant inbox work remains unresolved', async () => {
    await pool.query("INSERT INTO event_inbox VALUES('2026-11-01T03:00:00Z',0,'agent_text',1,'{}')")
    const result = await readPlatformStatistics(pool, config, range, async () => memory(), now)
    expect(result.metrics.sessions).toMatchObject({ value: 0,status: 'partial',reason: 'source_cutoff_incomplete' })
    expect(result.metrics.activeUsers.status).toBe('partial')
    expect(result.metrics.newUsers).toMatchObject({ value: 0,status: 'complete' })
    await pool.query('UPDATE event_inbox SET status=2')
    const caughtUp = await readPlatformStatistics(pool, config, range, async () => memory(), now)
    expect(caughtUp.metrics.sessions).toMatchObject({ value: 0,status: 'complete' })
  })
  it('serializes concurrent bootstrap without replacing forward coverage', async () => {
    await Promise.all([ensurePlatformStatisticsSchema(pool,env),ensurePlatformStatisticsSchema(pool,env)])
    const coverage = (await pool.query("SELECT starts_at FROM platform_statistics_coverage WHERE metric='newUsers'")).rows[0]
    expect(coverage.starts_at.toISOString()).toBe('2026-10-01T00:00:00.000Z')
  })
  it('keeps known Memory creation complete when usage actor bounds were exceeded', async () => {
    const snapshot = memory()
    snapshot.actorLimitExceeded = true
    const result = await readPlatformStatistics(pool,config,range,async () => snapshot,now)
    expect(result.metrics.memory).toMatchObject({ value: 0,status: 'complete' })
    expect(result.metrics.memoryUsers).toMatchObject({ value: null,status: 'partial',reason: 'memory_actor_limit_exceeded' })
  })
})
