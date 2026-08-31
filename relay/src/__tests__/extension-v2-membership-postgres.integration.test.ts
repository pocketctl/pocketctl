import Fastify, { type FastifyInstance } from 'fastify'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { initDB } from '../db.js'
import { createExtensionScopeRouteService, registerExtensionScopeRoutes } from '../extensions/scope-routes.js'
import {
  assertDurableIngressTestDatabase,
  resetDurableIngressTestDatabase,
} from './durable-ingress-test-db.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const ORG_ID = 'd0000000-0000-4000-8000-000000000001'
const TEAM_ID = 'd0000000-0000-4000-8000-000000000002'
const MEMBERSHIP_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describeWithDatabase('extension v2 scope membership routes (PostgreSQL)', () => {
  let pool: pg.Pool
  let app: FastifyInstance

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    const database = await pool.query<{ database_name: string }>(
      'SELECT current_database() AS database_name',
    )
    const databaseName = database.rows[0]?.database_name ?? ''
    if (!/test/i.test(databaseName)) {
      throw new Error(`Refusing PostgreSQL integration test against non-test database: ${databaseName || '<unknown>'}`)
    }
    await initDB(pool)
    app = Fastify()
    registerExtensionScopeRoutes(app, {
      pool,
      verifyAccessToken: vi.fn(async (token: string) =>
        token.startsWith('user-') ? { userId: Number(token.slice(5)) } : null),
      v2Mode: 'enabled',
      service: createExtensionScopeRouteService(pool),
    })
  }, 30_000)

  afterEach(async () => {
    await assertDurableIngressTestDatabase(pool, databaseUrl!)
    await resetDurableIngressTestDatabase(pool, databaseUrl!)
  })

  afterAll(async () => {
    await app?.close()
    await pool?.end()
  })

  async function insertUser(email: string, displayName?: string): Promise<number> {
    await pool.query(
      `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', $2)
       ON CONFLICT (email) DO UPDATE SET password_hash = 'x'`,
      [email, displayName ?? null],
    )
    const row = await pool.query<{ id: number }>(`SELECT id FROM users WHERE email = $1`, [email])
    return row.rows[0].id
  }

  function headers(userId: number, idempotencyKey?: string): Record<string, string> {
    const base: Record<string, string> = { authorization: `Bearer user-${userId}` }
    if (idempotencyKey) base['idempotency-key'] = idempotencyKey
    return base
  }

  test('creates an organization with a creator scope-admin membership and journals events', async () => {
    const creatorId = await insertUser('v2-admin@example.test', 'Org Admin')
    const response = await app.inject({
      method: 'POST',
      url: '/api/extensions/v2/organizations',
      headers: headers(creatorId, 'create-org-key-0001'),
      payload: { name: 'route-org' },
    })
    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.organization.name).toBe('route-org')
    expect(body.organization.state).toBe('active')
    expect(body.creator_membership.roles).toEqual(['scope_administrator'])

    const membership = await pool.query<{ roles: string[]; state: string; user_id: number }>(
      `SELECT roles, state, user_id FROM extension_scope_memberships
       WHERE membership_id = $1`,
      [body.creator_membership.membership_id],
    )
    expect(membership.rows[0].roles).toEqual(['scope_administrator'])
    expect(membership.rows[0].state).toBe('active')
    expect(Number(membership.rows[0].user_id)).toBe(creatorId)

    // Append-only control events: scope creation and creator membership.
    const events = await pool.query<{ topic: string; payload: Record<string, unknown> }>(
      `SELECT topic, payload FROM extension_scope_outbox
       WHERE scope_kind = 'organization' AND scope_id = $1 ORDER BY outbox_id ASC`,
      [body.organization.organization_id],
    )
    expect(events.rows.map(row => row.topic)).toEqual([
      'scope.lifecycle.v2',
      'scope.membership.v2',
    ])
    expect(events.rows[0].payload.event_type).toBe('scope_created')
    expect(events.rows[1].payload.event_type).toBe('membership_created')
    // Payload allowlist: opaque ids/state/roles/revision/epoch only.
    expect(Object.keys(events.rows[1].payload).sort()).toEqual([
      'authorization_epoch', 'event_type', 'membership_id', 'membership_revision', 'roles', 'state',
    ])
  })

  test('resolves an existing user by normalized email and rejects unknown emails with 404', async () => {
    const adminId = await insertUser('v2-org-admin2@example.test')
    const memberId = await insertUser('V2.Member@Example.TEST', 'Team Member')
    const org = await app.inject({
      method: 'POST',
      url: '/api/extensions/v2/organizations',
      headers: headers(adminId, 'create-org-key-0002'),
      payload: { name: 'member-org' },
    })
    const organizationId = org.json().organization.organization_id

    const added = await app.inject({
      method: 'POST',
      url: `/api/extensions/v2/scopes/organization/${organizationId}/members`,
      headers: headers(adminId, 'add-member-key-0002'),
      payload: { email: '  v2.member@example.test ', roles: ['reader', 'reviewer'] },
    })
    expect(added.statusCode).toBe(201)
    const membership = added.json().membership
    expect(membership.roles).toEqual(['reader', 'reviewer'])
    expect(membership.display_label).toBe('Team Member')
    expect(membership).not.toHaveProperty('user_id')
    expect(membership).not.toHaveProperty('email')

    const unknown = await app.inject({
      method: 'POST',
      url: `/api/extensions/v2/scopes/organization/${organizationId}/members`,
      headers: headers(adminId, 'add-member-key-0003'),
      payload: { email: 'ghost@example.test', roles: ['reader'] },
    })
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json().error.code).toBe('not_found')
  })

  test('requires scope_admin permission and keeps foreign scopes indistinguishable', async () => {
    const adminId = await insertUser('v2-org-admin3@example.test')
    const readerId = await insertUser('v2-reader3@example.test')
    const strangerId = await insertUser('v2-stranger3@example.test')
    const org = await app.inject({
      method: 'POST',
      url: '/api/extensions/v2/organizations',
      headers: headers(adminId, 'create-org-key-0003'),
      payload: { name: 'perm-org' },
    })
    const organizationId = org.json().organization.organization_id
    await app.inject({
      method: 'POST',
      url: `/api/extensions/v2/scopes/organization/${organizationId}/members`,
      headers: headers(adminId, 'add-reader-key-0003'),
      payload: { email: 'v2-reader3@example.test', roles: ['reader'] },
    })

    // A reader cannot list or mutate members.
    const listDenied = await app.inject({
      method: 'GET',
      url: `/api/extensions/v2/scopes/organization/${organizationId}/members`,
      headers: headers(readerId),
    })
    expect(listDenied.statusCode).toBe(403)
    const addDenied = await app.inject({
      method: 'POST',
      url: `/api/extensions/v2/scopes/organization/${organizationId}/members`,
      headers: headers(readerId, 'denied-add-key-0003'),
      payload: { email: 'v2-stranger3@example.test', roles: ['reader'] },
    })
    expect(addDenied.statusCode).toBe(403)

    // A non-member sees the same 404 as a totally foreign scope.
    const foreignList = await app.inject({
      method: 'GET',
      url: `/api/extensions/v2/scopes/organization/${organizationId}/members`,
      headers: headers(strangerId),
    })
    const missingList = await app.inject({
      method: 'GET',
      url: `/api/extensions/v2/scopes/organization/dabad0ba-0000-4000-8000-00000000bad0/members`,
      headers: headers(strangerId),
    })
    expect(foreignList.statusCode).toBe(404)
    expect(missingList.statusCode).toBe(404)
    expect(foreignList.json()).toEqual(missingList.json())
  })

  test('creates teams under an organization and enforces the parent scope_admin gate', async () => {
    const adminId = await insertUser('v2-org-admin4@example.test')
    const outsiderId = await insertUser('v2-outsider4@example.test')
    const org = await app.inject({
      method: 'POST',
      url: '/api/extensions/v2/organizations',
      headers: headers(adminId, 'create-org-key-0004'),
      payload: { name: 'team-parent-org' },
    })
    const organizationId = org.json().organization.organization_id

    const denied = await app.inject({
      method: 'POST',
      url: `/api/extensions/v2/organizations/${organizationId}/teams`,
      headers: headers(outsiderId, 'create-team-key-denied'),
      payload: { name: 'denied-team' },
    })
    expect(denied.statusCode).toBe(404)

    const team = await app.inject({
      method: 'POST',
      url: `/api/extensions/v2/organizations/${organizationId}/teams`,
      headers: headers(adminId, 'create-team-key-0004'),
      payload: { name: 'route-team' },
    })
    expect(team.statusCode).toBe(201)
    expect(team.json().team.organization_id).toBe(organizationId)
    expect(team.json().creator_membership.roles).toEqual(['scope_administrator'])

    // An unknown parent organization is a uniform 404.
    const orphan = await app.inject({
      method: 'POST',
      url: `/api/extensions/v2/organizations/${TEAM_ID}/teams`,
      headers: headers(adminId, 'create-team-key-orphan'),
      payload: { name: 'orphan-team' },
    })
    expect(orphan.statusCode).toBe(404)
  })

  test('updates membership roles with CAS and returns current state on conflict', async () => {
    const adminId = await insertUser('v2-org-admin5@example.test')
    const memberId = await insertUser('v2-member5@example.test')
    const org = await app.inject({
      method: 'POST',
      url: '/api/extensions/v2/organizations',
      headers: headers(adminId, 'create-org-key-0005'),
      payload: { name: 'cas-org' },
    })
    const organizationId = org.json().organization.organization_id
    const added = await app.inject({
      method: 'POST',
      url: `/api/extensions/v2/scopes/organization/${organizationId}/members`,
      headers: headers(adminId, 'add-member-key-0005'),
      payload: { email: 'v2-member5@example.test', roles: ['reader'] },
    })
    const membershipId = added.json().membership.membership_id

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/extensions/v2/scopes/organization/${organizationId}/members/${membershipId}`,
      headers: headers(adminId, 'patch-member-key-stale'),
      payload: { expected_revision: 99, roles: ['reviewer'] },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.code).toBe('revision_conflict')
    expect(stale.json().error.current_revision).toBe(1)
    expect(stale.json().error.current_state).toBe('active')

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/extensions/v2/scopes/organization/${organizationId}/members/${membershipId}`,
      headers: headers(adminId, 'patch-member-key-0005'),
      payload: { expected_revision: 1, roles: ['reviewer', 'publisher'] },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().membership.roles).toEqual(['reviewer', 'publisher'])
    expect(updated.json().membership.membership_revision).toBe(2)

    // Scope epoch advanced across the add and the role change.
    const scope = await pool.query<{ authorization_epoch: string }>(
      `SELECT authorization_epoch FROM extension_organizations WHERE organization_id = $1`,
      [organizationId],
    )
    expect(Number(scope.rows[0].authorization_epoch)).toBe(3)

    // Revocation is terminal and sets revoked_at.
    const revoked = await app.inject({
      method: 'PATCH',
      url: `/api/extensions/v2/scopes/organization/${organizationId}/members/${membershipId}`,
      headers: headers(adminId, 'patch-member-key-revoke'),
      payload: { expected_revision: 2, state: 'revoked' },
    })
    expect(revoked.statusCode).toBe(200)
    expect(revoked.json().membership.state).toBe('revoked')
    expect(revoked.json().membership.revoked_at).not.toBeNull()
    const terminal = await app.inject({
      method: 'PATCH',
      url: `/api/extensions/v2/scopes/organization/${organizationId}/members/${membershipId}`,
      headers: headers(adminId, 'patch-member-key-terminal'),
      payload: { expected_revision: 3, roles: ['reader'] },
    })
    expect(terminal.statusCode).toBe(400)
  })

  test('replays idempotent mutations and rejects key reuse with a different body', async () => {
    const adminId = await insertUser('v2-org-admin6@example.test')
    const org = await app.inject({
      method: 'POST',
      url: '/api/extensions/v2/organizations',
      headers: headers(adminId, 'idem-key-org-0006'),
      payload: { name: 'idem-org' },
    })
    expect(org.statusCode).toBe(201)
    const replayed = await app.inject({
      method: 'POST',
      url: '/api/extensions/v2/organizations',
      headers: headers(adminId, 'idem-key-org-0006'),
      payload: { name: 'idem-org' },
    })
    expect(replayed.statusCode).toBe(201)
    expect(replayed.json().organization.organization_id).toBe(org.json().organization.organization_id)
    const count = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM extension_organizations WHERE name = 'idem-org'`,
    )
    expect(Number(count.rows[0].count)).toBe(1)

    const mismatch = await app.inject({
      method: 'POST',
      url: '/api/extensions/v2/organizations',
      headers: headers(adminId, 'idem-key-org-0006'),
      payload: { name: 'different-name' },
    })
    expect(mismatch.statusCode).toBe(409)
    expect(mismatch.json().error.code).toBe('revision_conflict')
  })

  test('suspends and dissolves scopes through the lifecycle route with CAS', async () => {
    const adminId = await insertUser('v2-org-admin7@example.test')
    const org = await app.inject({
      method: 'POST',
      url: '/api/extensions/v2/organizations',
      headers: headers(adminId, 'create-org-key-0007'),
      payload: { name: 'lifecycle-org' },
    })
    const organizationId = org.json().organization.organization_id

    const stale = await app.inject({
      method: 'POST',
      url: `/api/extensions/v2/scopes/organization/${organizationId}/lifecycle`,
      headers: headers(adminId, 'lifecycle-key-stale'),
      payload: { state: 'suspended', expected_revision: 99 },
    })
    expect(stale.statusCode).toBe(404)

    const suspended = await app.inject({
      method: 'POST',
      url: `/api/extensions/v2/scopes/organization/${organizationId}/lifecycle`,
      headers: headers(adminId, 'lifecycle-key-suspend'),
      payload: { state: 'suspended', expected_revision: 1 },
    })
    expect(suspended.statusCode).toBe(200)
    expect(suspended.json().scope.state).toBe('suspended')
    expect(suspended.json().scope.authorization_epoch).toBe(2)

    const dissolved = await app.inject({
      method: 'POST',
      url: `/api/extensions/v2/scopes/organization/${organizationId}/lifecycle`,
      headers: headers(adminId, 'lifecycle-key-dissolve'),
      payload: { state: 'dissolved', expected_revision: 2 },
    })
    expect(dissolved.statusCode).toBe(200)
    expect(dissolved.json().scope.state).toBe('dissolved')

    const events = await pool.query<{ topic: string; payload: Record<string, unknown> }>(
      `SELECT topic, payload FROM extension_scope_outbox
       WHERE scope_kind = 'organization' AND scope_id = $1 ORDER BY outbox_id ASC`,
      [organizationId],
    )
    const lifecycle = events.rows.filter(row => row.topic === 'scope.lifecycle.v2')
    expect(lifecycle.map(row => row.payload.event_type)).toEqual([
      'scope_created', 'scope_suspended', 'scope_dissolved',
    ])
  })

  test('lists caller scopes across personal installations and memberships', async () => {
    const adminId = await insertUser('v2-org-admin8@example.test')
    await pool.query(
      `INSERT INTO extension_providers (provider_id, manifest_version, manifest)
       VALUES ('v2-routes-provider', 1, '{}'::jsonb)
       ON CONFLICT (provider_id) DO NOTHING`,
    )
    await pool.query(`
      INSERT INTO extension_installations
        (installation_id, provider_id, owner_user_id, status, granted_scopes, subscriptions, enabled_services, start_policy)
      VALUES ($1, 'v2-routes-provider', $2, 'active', ARRAY['session:events:read'], ARRAY['session.event.v1'], ARRAY['memory.search'], 'from_now')
    `, [ORG_ID, adminId])
    const org = await app.inject({
      method: 'POST',
      url: '/api/extensions/v2/organizations',
      headers: headers(adminId, 'create-org-key-0008'),
      payload: { name: 'list-org' },
    })
    expect(org.statusCode).toBe(201)

    const listed = await app.inject({
      method: 'GET',
      url: '/api/extensions/v2/scopes',
      headers: headers(adminId),
    })
    expect(listed.statusCode).toBe(200)
    const scopes = listed.json().scopes as Array<Record<string, unknown>>
    const personal = scopes.find(scope => scope.owner_scope_kind === 'personal')
    const shared = scopes.find(scope => scope.owner_scope_kind === 'organization')
    expect(personal?.owner_scope_id).toBe(ORG_ID)
    expect(shared?.permissions).toContain('scope_admin')
    expect(MEMBERSHIP_PATTERN.test(String(shared?.membership_id))).toBe(true)
  })

  test('blocks scope reads and mutations while the v2 feature flag is off', async () => {
    const offApp = Fastify()
    registerExtensionScopeRoutes(offApp, {
      pool,
      verifyAccessToken: vi.fn(async () => ({ userId: 1 })),
      v2Mode: 'off',
      service: createExtensionScopeRouteService(pool),
    })
    const read = await offApp.inject({
      method: 'GET',
      url: '/api/extensions/v2/scopes',
      headers: headers(1),
    })
    expect(read.statusCode).toBe(503)
    expect(read.json().error.code).toBe('feature_disabled')
    const create = await offApp.inject({
      method: 'POST',
      url: '/api/extensions/v2/organizations',
      headers: headers(1, 'flag-off-key-0001'),
      payload: { name: 'flag-off-org' },
    })
    expect(create.statusCode).toBe(503)
    expect(create.json().error.code).toBe('feature_disabled')
    await offApp.close()
  })
})
