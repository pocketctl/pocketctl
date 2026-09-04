import pg from 'pg'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { initDB } from '../db.js'
import { createOrganizationWithCreator, addScopeMembership } from '../extensions/scope-repository.js'
import { createExtensionScopeRouteService, registerExtensionScopeRoutes } from '../extensions/scope-routes.js'
import { registerV2Routes } from '../extensions/v2-routes.js'
import { registerProviderInstallationRoutes } from '../extensions/provider-installation-routes.js'
import { registerFeedRoutes } from '../extensions/feed-routes.js'
import { signProviderExtensionToken } from '../extensions/provider-auth.js'
import { upsertProviderDefinitions } from '../extensions/catalog.js'
import {
  assertDurableIngressTestDatabase,
  resetDurableIngressTestDatabase,
} from './durable-ingress-test-db.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const PROVIDER_SECRET = 'v2-feed-provider-secret-0123456789'
const CURSOR_SECRET = 'v2-feed-cursor-secret-0123456789'
const ISSUER = 'https://relay.example.test'
const PROVIDER = 'pocketctl-memory'

describeWithDatabase('extension v2 scope-control feed (PostgreSQL)', () => {
  let pool: pg.Pool
  let app: FastifyInstance
  let adminId: number
  let organizationId: string
  let teamId: string
  let sharedInstallationId: string

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    const database = await pool.query<{ database_name: string }>(
      'SELECT current_database() AS database_name',
    )
    if (!/test/i.test(database.rows[0]?.database_name ?? '')) {
      throw new Error('Refusing PostgreSQL integration test against non-test database')
    }
    await initDB(pool)
    await upsertProviderDefinitions(pool)

    app = Fastify()
    registerExtensionScopeRoutes(app, {
      pool,
      verifyAccessToken: vi.fn(async (token: string) =>
        token.startsWith('user-') ? { userId: Number(token.slice(5)) } : null),
      v2Mode: 'enabled',
      service: createExtensionScopeRouteService(pool),
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
  }, 30_000)

  afterAll(async () => {
    await app?.close()
    await pool?.end()
  })

  beforeEach(async () => {
    await assertDurableIngressTestDatabase(pool, databaseUrl!)
    await resetDurableIngressTestDatabase(pool, databaseUrl!)
    await upsertProviderDefinitions(pool)
    adminId = (await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('v2-feed-admin@example.test', 'x') RETURNING id
    `)).rows[0].id
    const { organization } = await createOrganizationWithCreator(pool, {
      name: 'feed-org',
      createdByUserId: adminId,
    })
    organizationId = organization.organization_id
    const team = await pool.query<{ team_id: string }>(`
      INSERT INTO extension_teams (team_id, organization_id, name, created_by_user_id)
      VALUES (gen_random_uuid(), $1, 'feed-team', $2) RETURNING team_id
    `, [organizationId, adminId])
    teamId = team.rows[0].team_id
    await addScopeMembership(pool, {
      scopeKind: 'team', scopeId: teamId, userId: adminId, roles: ['scope_administrator'],
    })
  })

  function providerToken(): string {
    return signProviderExtensionToken({
      secret: PROVIDER_SECRET,
      issuer: ISSUER,
      providerId: PROVIDER,
      credentialId: '00000000-0000-4000-8000-0000000000c1',
      ttlSeconds: 300,
    })
  }

  function providerHeaders(): Record<string, string> {
    return { authorization: `Bearer ${providerToken()}` }
  }

  function userHeaders(userId: number, idempotencyKey?: string): Record<string, string> {
    const headers: Record<string, string> = { authorization: `Bearer user-${userId}` }
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey
    return headers
  }

  async function createSharedInstallation(
    scopeKind: 'team' | 'organization',
    scopeId: string,
    overrides: { subscriptions?: string[]; idempotencyKey?: string; expectedRevision?: number } = {},
  ): Promise<{ statusCode: number; body: any }> {
    const revision = overrides.expectedRevision ?? 2
    const response = await app.inject({
      method: 'POST',
      url: '/api/extensions/v2/installations',
      headers: userHeaders(adminId, overrides.idempotencyKey ?? `install-${scopeId}-${revision}`),
      payload: {
        provider_id: PROVIDER,
        owner_scope_kind: scopeKind,
        owner_scope_id: scopeId,
        subscriptions: overrides.subscriptions ?? ['scope.membership.v2', 'scope.lifecycle.v2'],
        enabled_services: ['memory.search', 'memory.recall'],
        expected_revision: revision,
      },
    })
    return { statusCode: response.statusCode, body: response.json() }
  }

  test('creates a shared installation with scope_admin and control-only subscriptions', async () => {
    const created = await createSharedInstallation('team', teamId)
    expect(created.statusCode).toBe(201)
    sharedInstallationId = created.body.installation.installation_id
    expect(created.body.installation.owner_scope_kind).toBe('team')
    expect(created.body.installation.owner_scope_id).toBe(teamId)
    expect(created.body.installation.status).toBe('pending')

    const row = await pool.query<{ owner_user_id: number | null; granted_scopes: string[] }>(
      `SELECT owner_user_id, granted_scopes FROM extension_installations WHERE installation_id = $1`,
      [sharedInstallationId],
    )
    expect(row.rows[0].owner_user_id).toBeNull()
    expect(row.rows[0].granted_scopes).toEqual(['scope:control:read'])
  })

  test('rejects session topics and unknown scope kinds for shared installations', async () => {
    const sessionTopics = await createSharedInstallation('team', teamId, {
      subscriptions: ['session.event.v1', 'scope.membership.v2'],
      idempotencyKey: 'install-bad-topics-0001',
    })
    expect(sessionTopics.statusCode).toBe(400)

    const personalScope = await app.inject({
      method: 'POST',
      url: '/api/extensions/v2/installations',
      headers: userHeaders(adminId, 'install-personal-0001'),
      payload: {
        provider_id: PROVIDER,
        owner_scope_kind: 'personal',
        owner_scope_id: organizationId,
        subscriptions: ['scope.membership.v2'],
        expected_revision: 1,
      },
    })
    expect(personalScope.statusCode).toBe(400)

    const unknownScope = await app.inject({
      method: 'POST',
      url: '/api/extensions/v2/installations',
      headers: userHeaders(adminId, 'install-unknown-scope'),
      payload: {
        provider_id: PROVIDER,
        owner_scope_kind: 'team',
        owner_scope_id: '44444444-4444-4444-8444-444444444444',
        subscriptions: ['scope.membership.v2'],
        expected_revision: 1,
      },
    })
    expect(unknownScope.statusCode).toBe(404)

    // A non-admin member cannot create the shared installation.
    const readerId = (await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('v2-feed-reader@example.test', 'x') RETURNING id
    `)).rows[0].id
    await addScopeMembership(pool, {
      scopeKind: 'team', scopeId: teamId, userId: readerId, roles: ['reader'],
    })
    const denied = await app.inject({
      method: 'POST',
      url: '/api/extensions/v2/installations',
      headers: userHeaders(readerId, 'install-denied-0001'),
      payload: {
        provider_id: PROVIDER,
        owner_scope_kind: 'team',
        owner_scope_id: teamId,
        subscriptions: ['scope.membership.v2'],
        expected_revision: 2,
      },
    })
    expect(denied.statusCode).toBe(403)
  })

  test('delivers ordered membership control events with cursor and lease fencing', async () => {
    const memberId = (await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('v2-feed-member@example.test', 'x') RETURNING id
    `)).rows[0].id
    const created = await createSharedInstallation('team', teamId)
    sharedInstallationId = created.body.installation.installation_id
    const member = await addScopeMembership(pool, {
      scopeKind: 'team', scopeId: teamId, userId: memberId, roles: ['reader'],
    })

    const first = await app.inject({
      method: 'GET',
      url: `/api/extensions/v2/feed?installation_id=${sharedInstallationId}`,
      headers: providerHeaders(),
    })
    expect(first.statusCode).toBe(200)
    const firstBody = first.json()
    const events = firstBody.items as Array<Record<string, any>>
    // Creation membership events for admin (and now member) arrive in order;
    // every item carries the frozen v2 envelope shape.
    expect(events.length).toBeGreaterThanOrEqual(2)
    const topics = events.map(item => item.topic)
    expect(topics.every(topic => topic === 'scope.membership.v2' || topic === 'scope.lifecycle.v2')).toBe(true)
    expect(events.map(item => Number(item.feed_id))).toEqual(
      [...events.map(item => Number(item.feed_id))].sort((a, b) => a - b),
    )
    for (const item of events) {
      expect(item.envelope_version).toBe(2)
      expect(item.owner_scope.kind).toBe('team')
      expect(item.owner_scope.id).toBe(teamId)
      expect(item.data).not.toHaveProperty('email')
      expect(item.data).not.toHaveProperty('display_name')
    }
    expect(firstBody.next_cursor).toBeTruthy()
    expect(firstBody.lease_token).toBeTruthy()

    // Duplicate pull with the same cursor never re-serves consumed rows:
    // the cursor position is exclusive, so the window is empty.
    const duplicate = await app.inject({
      method: 'GET',
      url: `/api/extensions/v2/feed?installation_id=${sharedInstallationId}&cursor=${encodeURIComponent(firstBody.next_cursor)}`,
      headers: providerHeaders(),
    })
    expect(duplicate.statusCode).toBe(200)
    const duplicateItems = duplicate.json().items as Array<Record<string, any>>
    expect(duplicateItems).toEqual([])

    // ACK under the latest (continuation) lease advances the checkpoint.
    const ack = await app.inject({
      method: 'POST',
      url: '/api/extensions/v2/feed/ack',
      headers: providerHeaders(),
      payload: {
        installation_id: sharedInstallationId,
        cursor: duplicate.json().next_cursor,
        lease_token: duplicate.json().lease_token,
      },
    })
    expect(ack.statusCode).toBe(200)
    expect(Number(ack.json().ack_feed_id)).toBeGreaterThanOrEqual(
      Number(events[events.length - 1].feed_id),
    )

    // A fresh acquisition takes over the lease epoch, fencing the current
    // lease out: its ACK now fails closed.
    await app.inject({
      method: 'GET',
      url: `/api/extensions/v2/feed?installation_id=${sharedInstallationId}`,
      headers: providerHeaders(),
    })
    const staleAck = await app.inject({
      method: 'POST',
      url: '/api/extensions/v2/feed/ack',
      headers: providerHeaders(),
      payload: {
        installation_id: sharedInstallationId,
        cursor: duplicate.json().next_cursor,
        lease_token: duplicate.json().lease_token,
      },
    })
    expect(staleAck.statusCode).toBe(409)
    expect(staleAck.json().error.code).toBe('stale_lease')

    // After the ACK, the next pull starts beyond the consumed window.
    const next = await app.inject({
      method: 'GET',
      url: `/api/extensions/v2/feed?installation_id=${sharedInstallationId}`,
      headers: providerHeaders(),
    })
    expect(next.statusCode).toBe(200)
    const nextItems = next.json().items as Array<Record<string, any>>
    for (const item of nextItems) {
      expect(Number(item.feed_id)).toBeGreaterThan(Number(events[events.length - 1].feed_id))
    }
  })

  test('invalidates cursors when the scope authorization epoch advances', async () => {
    const created = await createSharedInstallation('team', teamId)
    sharedInstallationId = created.body.installation.installation_id
    const pull = await app.inject({
      method: 'GET',
      url: `/api/extensions/v2/feed?installation_id=${sharedInstallationId}`,
      headers: providerHeaders(),
    })
    expect(pull.statusCode).toBe(200)
    const cursor = pull.json().next_cursor as string

    // Any membership change advances the scope epoch.
    const memberId = (await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('v2-feed-epoch@example.test', 'x') RETURNING id
    `)).rows[0].id
    await addScopeMembership(pool, {
      scopeKind: 'team', scopeId: teamId, userId: memberId, roles: ['reader'],
    })

    const invalidated = await app.inject({
      method: 'GET',
      url: `/api/extensions/v2/feed?installation_id=${sharedInstallationId}&cursor=${encodeURIComponent(cursor)}`,
      headers: providerHeaders(),
    })
    expect(invalidated.statusCode).toBe(410)
    expect(invalidated.json().error.code).toBe('cursor_expired')
  })

  test('a shared installation cannot receive v1 session feed items', async () => {
    const created = await createSharedInstallation('team', teamId)
    sharedInstallationId = created.body.installation.installation_id

    // A canonical session event exists in the v1 feed for the admin user.
    await pool.query(`
      INSERT INTO extension_feed (owner_user_id, topic, source_kind, source_id, payload)
      VALUES ($1, 'session.event.v1', 'canonical_event', 'v2-compat-event-1', '{"envelope_version": 1}'::jsonb)
    `, [adminId])

    const v1Pull = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/feed?installation_id=${sharedInstallationId}`,
      headers: providerHeaders(),
    })
    expect([404, 403]).toContain(v1Pull.statusCode)

    const v2Pull = await app.inject({
      method: 'GET',
      url: `/api/extensions/v2/feed?installation_id=${sharedInstallationId}`,
      headers: providerHeaders(),
    })
    expect(v2Pull.statusCode).toBe(200)
    const items = v2Pull.json().items as Array<Record<string, any>>
    for (const item of items) {
      expect(item.topic).not.toBe('session.event.v1')
    }
  })

  test('lists accessible installations for the authenticated user', async () => {
    const created = await createSharedInstallation('team', teamId)
    sharedInstallationId = created.body.installation.installation_id
    // A personal installation for the same admin.
    await pool.query(`
      INSERT INTO extension_installations
        (installation_id, provider_id, owner_user_id, status, granted_scopes, subscriptions, enabled_services, start_policy)
      VALUES (gen_random_uuid(), $1, $2, 'active', ARRAY['session:events:read'], ARRAY['session.event.v1'], ARRAY['memory.search'], 'from_now')
    `, [PROVIDER, adminId])

    const listed = await app.inject({
      method: 'GET',
      url: '/api/extensions/v2/installations',
      headers: userHeaders(adminId),
    })
    expect(listed.statusCode).toBe(200)
    const installations = listed.json().installations as Array<Record<string, any>>
    const shared = installations.find(i => i.installation_id === sharedInstallationId)
    const personal = installations.find(i => i.owner_scope_kind === 'personal')
    expect(shared?.owner_scope_id).toBe(teamId)
    expect(personal?.owner_scope_kind).toBe('personal')

    // A user with no membership sees neither.
    const strangerId = (await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('v2-feed-stranger@example.test', 'x') RETURNING id
    `)).rows[0].id
    const stranger = await app.inject({
      method: 'GET',
      url: '/api/extensions/v2/installations',
      headers: userHeaders(strangerId),
    })
    expect(stranger.statusCode).toBe(200)
    expect((stranger.json().installations as unknown[]).filter(
      (i: any) => i.installation_id === sharedInstallationId,
    )).toHaveLength(0)
  })
})
