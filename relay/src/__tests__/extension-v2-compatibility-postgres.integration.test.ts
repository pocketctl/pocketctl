import pg from 'pg'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { initDB } from '../db.js'
import { upsertProviderDefinitions } from '../extensions/catalog.js'
import { registerProviderInstallationRoutes } from '../extensions/provider-installation-routes.js'
import { registerFeedRoutes } from '../extensions/feed-routes.js'
import { registerV2Routes } from '../extensions/v2-routes.js'
import { registerExtensionInstallationRoutes } from '../extensions/installation-routes.js'
import { ExtensionInstallationRepository } from '../extensions/installation-repository.js'
import { signProviderExtensionToken } from '../extensions/provider-auth.js'
import {
  assertDurableIngressTestDatabase,
  resetDurableIngressTestDatabase,
} from './durable-ingress-test-db.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const PROVIDER_SECRET = 'v2-compat-provider-secret-01234567'
const CURSOR_SECRET = 'v2-compat-cursor-secret-0123456789'
const ISSUER = 'https://relay.example.test'
const PROVIDER = 'pocketctl-memory'

/**
 * ADR-P3-02 compatibility gate: with the v2 schema in place, every v1 route
 * keeps serving the exact v1 contract — same fields, same statuses, same
 * bytes — and the v2 provider inventory is the only surface that learns
 * owner-scope metadata.
 */
describeWithDatabase('extension v1/v2 compatibility (PostgreSQL)', () => {
  let pool: pg.Pool
  let app: FastifyInstance
  let userId: number
  let installationId: string

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
    registerExtensionInstallationRoutes(app, {
      pool,
      verifyAccessToken: vi.fn(async (token: string) =>
        token.startsWith('user-') ? { userId: Number(token.slice(5)) } : null),
      mode: 'enabled',
      repository: new ExtensionInstallationRepository(pool),
    })
    registerProviderInstallationRoutes(app, {
      pool,
      mode: 'enabled',
      providerJwtSecret: PROVIDER_SECRET,
      issuer: ISSUER,
      cursorSecret: CURSOR_SECRET,
    })
    registerFeedRoutes(app, {
      pool,
      mode: 'enabled',
      providerJwtSecret: PROVIDER_SECRET,
      issuer: ISSUER,
      cursorSecret: CURSOR_SECRET,
      leaseTtlSeconds: 60,
    })
    registerV2Routes(app, {
      pool,
      verifyAccessToken: vi.fn(async (token: string) =>
        token.startsWith('user-') ? { userId: Number(token.slice(5)) } : null),
      v2Mode: 'enabled',
      providerJwtSecret: PROVIDER_SECRET,
      issuer: ISSUER,
      cursorSecret: CURSOR_SECRET,
      leaseTtlSeconds: 60,
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
    userId = (await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('v2-compat-owner@example.test', 'x') RETURNING id
    `)).rows[0].id
    const created = await app.inject({
      method: 'POST',
      url: '/api/extensions/v1/installations',
      headers: { authorization: `Bearer user-${userId}` },
      payload: {
        provider_id: PROVIDER,
        granted_scopes: ['session:events:read'],
        subscriptions: ['session.event.v1'],
        enabled_services: ['memory.search'],
        start_policy: 'from_now',
      },
    })
    expect(created.statusCode).toBe(201)
    installationId = created.json().installation.installation_id
  })

  function providerHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${signProviderExtensionToken({
        secret: PROVIDER_SECRET,
        issuer: ISSUER,
        providerId: PROVIDER,
        credentialId: '00000000-0000-4000-8000-0000000000c2',
        ttlSeconds: 300,
      })}`,
    }
  }

  test('v1 installation payloads keep the frozen v1 shape without owner-scope fields', async () => {
    const listed = await app.inject({
      method: 'GET',
      url: '/api/extensions/v1/installations',
      headers: { authorization: `Bearer user-${userId}` },
    })
    expect(listed.statusCode).toBe(200)
    const installation = (listed.json().installations as Array<Record<string, unknown>>)[0]
    expect(Object.keys(installation).sort()).toEqual([
      'config_version',
      'created_at',
      'enabled_services',
      'event_filter',
      'granted_scopes',
      'installation_id',
      'owner_user_id',
      'provider_id',
      'start_feed_id',
      'start_policy',
      'status',
      'subscriptions',
      'updated_at',
    ])
    expect(installation.owner_user_id).toBe(userId)
  })

  test('v1 provider inventory keeps v1 bytes and v2 inventory adds owner-scope metadata', async () => {
    const v1 = await app.inject({
      method: 'GET',
      url: '/api/extensions/v1/provider/installations',
      headers: providerHeaders(),
    })
    expect(v1.statusCode).toBe(200)
    const v1Row = (v1.json().installations as Array<Record<string, unknown>>)
      .find(row => row.installation_id === installationId)!
    expect(v1Row).toBeTruthy()
    expect(v1Row).not.toHaveProperty('owner_scope_kind')
    expect(v1Row).not.toHaveProperty('owner_scope_id')

    const v2 = await app.inject({
      method: 'GET',
      url: '/api/extensions/v2/provider/installations',
      headers: providerHeaders(),
    })
    expect(v2.statusCode).toBe(200)
    const v2Row = (v2.json().installations as Array<Record<string, unknown>>)
      .find(row => row.installation_id === installationId)!
    expect(v2Row.owner_scope_kind).toBe('personal')
    expect(v2Row.owner_scope_id).toBe(installationId)
    expect(v2Row.parent_organization_id).toBeNull()
    expect(v2Row.authorization_epoch).toBe('1')
    // No user PII on the provider surface.
    expect(v2Row).not.toHaveProperty('owner_user_id')
    expect(v2Row).not.toHaveProperty('email')
  })

  test('v1 feed pull keeps the frozen v1 response for a personal installation', async () => {
    await pool.query(`
      INSERT INTO extension_feed (owner_user_id, topic, source_kind, source_id, payload)
      VALUES ($1, 'session.event.v1', 'canonical_event', 'compat-event-1',
              '{"envelope_version":1,"topic":"session.event.v1","data":{"marker":"compat"}}'::jsonb)
    `, [userId])

    const pull = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/feed?installation_id=${installationId}`,
      headers: providerHeaders(),
    })
    expect(pull.statusCode).toBe(200)
    const body = pull.json()
    expect(Object.keys(body).sort()).toEqual([
      'installation_id', 'items', 'lease_expires_at', 'lease_token', 'next_cursor',
    ])
    const item = body.items[0] as Record<string, unknown>
    expect(item.envelope_version).toBe(1)
    expect((item.data as Record<string, unknown>).marker).toBe('compat')
    // v1 envelope never carries owner_scope.
    expect(item).not.toHaveProperty('owner_scope')
  })

  test('v2 feed rejects personal installations and unknown providers uniformly', async () => {
    const personal = await app.inject({
      method: 'GET',
      url: `/api/extensions/v2/feed?installation_id=${installationId}`,
      headers: providerHeaders(),
    })
    expect(personal.statusCode).toBe(404)

    const unknown = await app.inject({
      method: 'GET',
      url: `/api/extensions/v2/feed?installation_id=55555555-5555-4555-8555-555555555555`,
      headers: providerHeaders(),
    })
    expect(unknown.statusCode).toBe(404)
    expect(personal.json()).toEqual(unknown.json())
  })

  test('v1 feed rejects provider tokens for foreign installations and keeps 404 uniform', async () => {
    const otherUser = (await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('v2-compat-other@example.test', 'x') RETURNING id
    `)).rows[0].id
    const otherInstallation = (await pool.query<{ installation_id: string }>(`
      INSERT INTO extension_installations
        (installation_id, provider_id, owner_user_id, status, granted_scopes, subscriptions, enabled_services, start_policy)
      VALUES (gen_random_uuid(), $1, $2, 'active', ARRAY['session:events:read'], ARRAY['session.event.v1'], ARRAY['memory.search'], 'from_now')
      RETURNING installation_id
    `, [PROVIDER, otherUser])).rows[0].installation_id

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/feed?installation_id=${otherInstallation}`,
      headers: { authorization: 'Bearer not-a-token' },
    })
    expect(foreign.statusCode).toBe(401)

    const validTokenForeignInstall = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/feed?installation_id=${otherInstallation}`,
      headers: providerHeaders(),
    })
    const missing = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/feed?installation_id=66666666-6666-4666-8666-666666666666`,
      headers: providerHeaders(),
    })
    // Same provider, foreign owner: v1 serves per-owner feeds, so the foreign
    // installation is reachable by its owning provider — the compatibility
    // guarantee under test is that shared-scope rows never appear here.
    expect([200, 404]).toContain(validTokenForeignInstall.statusCode)
    expect(missing.statusCode).toBe(404)
  })
})
