import pg from 'pg'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB, persistOwnedClientEvent } from '../db.js'
import { upsertProviderDefinitions } from '../extensions/catalog.js'
import { signProviderExtensionToken } from '../extensions/provider-auth.js'
import { registerSnapshotRoutes } from '../extensions/snapshot-routes.js'
import { ExtensionInstallationRepository } from '../extensions/installation-repository.js'
import {
  assertDurableIngressTestDatabase,
  resetDurableIngressTestDatabase,
} from './durable-ingress-test-db.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const PROVIDER_SECRET = 'provider-secret-0123456789abcdef'
const CURSOR_SECRET = 'cursor-secret-0123456789abcdef'
const ISSUER = 'https://relay.example.test'

describeWithDatabase('extension snapshot (PostgreSQL)', () => {
  let pool: pg.Pool
  let app: FastifyInstance
  let userIdA: number
  let userIdB: number
  let installationA: string

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    const database = await pool.query<{ database_name: string }>(
      'SELECT current_database() AS database_name',
    )
    if (!/test/i.test(database.rows[0]?.database_name ?? '')) {
      throw new Error('Refusing PostgreSQL integration test against non-test database')
    }
    await initDB(pool)
    app = Fastify()
    registerSnapshotRoutes(app, {
      pool,
      mode: 'enabled',
      providerJwtSecret: PROVIDER_SECRET,
      issuer: ISSUER,
      cursorSecret: CURSOR_SECRET,
    })
  }, 30_000)

  afterAll(async () => {
    await app?.close()
    await pool?.end()
  })

  beforeEach(async () => {
    await assertDurableIngressTestDatabase(pool, databaseUrl!)
    await resetDurableIngressTestDatabase(pool, databaseUrl!)
    await upsertProviderDefinitions(pool)
    userIdA = (await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('snap-a@example.test', 'x') RETURNING id
    `)).rows[0].id
    userIdB = (await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('snap-b@example.test', 'x') RETURNING id
    `)).rows[0].id
    for (const [sessionId, owner] of [
      ['snap-session-a1', userIdA], ['snap-session-a2', userIdA], ['snap-session-b1', userIdB],
    ] as const) {
      await pool.query(`
        INSERT INTO daemons (daemon_id, hostname, agents, status, user_id)
        VALUES ($1, 'h', '[]'::jsonb, 'online', $2)
      `, [`${sessionId}-daemon`, owner])
      await pool.query(`
        INSERT INTO sessions (session_id, daemon_id, agent_type, cwd, status, user_id)
        VALUES ($1, $2, 'codex', '/repo', 'running', $3)
      `, [sessionId, `${sessionId}-daemon`, owner])
    }
    await persistOwnedClientEvent(pool, userIdA, 'snap-session-a1', 'agent_text',
      { type: 'agent_text', text: 'a1-one' }, null)
    await persistOwnedClientEvent(pool, userIdA, 'snap-session-a1', 'agent_text',
      { type: 'agent_text', text: 'a1-two' }, null)
    await persistOwnedClientEvent(pool, userIdB, 'snap-session-b1', 'agent_text',
      { type: 'agent_text', text: 'b1-one' }, null)
    const installation = await new ExtensionInstallationRepository(pool).createInstallation({
      ownerUserId: userIdA,
      providerId: 'pocketctl-memory',
      grantedScopes: ['session:events:read', 'session:snapshot:read'],
      subscriptions: ['session.event.v1'],
      enabledServices: ['memory.search'],
      eventFilter: {},
      startPolicy: 'from_now',
    })
    installationA = installation.installation_id
  })

  function providerToken() {
    return signProviderExtensionToken({
      providerId: 'pocketctl-memory', credentialId: 'c', secret: PROVIDER_SECRET, issuer: ISSUER,
    })
  }

  test('inventory returns only the owning user sessions', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/sessions?installation_id=${installationA}&limit=10`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(response.statusCode).toBe(200)
    const sessions = response.json().sessions
    expect(sessions.map((session: { session_id: string }) => session.session_id).sort())
      .toEqual(['snap-session-a1', 'snap-session-a2'])
  })

  test('snapshots page through events with the full turn fields', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/sessions/snap-session-a1/snapshot?installation_id=${installationA}&limit=1`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.events.length).toBe(1)
    expect(body.events[0].payload.text).toBe('a1-one')
    expect(body.next_cursor).toBeTruthy()

    const second = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/sessions/snap-session-a1/snapshot?installation_id=${installationA}&limit=1&cursor=${encodeURIComponent(body.next_cursor)}`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().events[0].payload.text).toBe('a1-two')
  })

  test('a cross-owner session is a 404 with no events leaked', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/sessions/snap-session-b1/snapshot?installation_id=${installationA}`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe('not_found')
    // A truly missing session is indistinguishable from a foreign one.
    const missing = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/sessions/does-not-exist/snapshot?installation_id=${installationA}`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.code).toBe('not_found')
  })

  test('a cursor bound to another installation fails closed', async () => {
    const first = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/sessions?installation_id=${installationA}&limit=1`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    const cursor = first.json().next_cursor
    const wrongInstallation = '99999999-9999-9999-9999-999999999999'
    const response = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/sessions?installation_id=${wrongInstallation}&cursor=${encodeURIComponent(cursor)}`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(response.statusCode).toBe(404)
  })
})
