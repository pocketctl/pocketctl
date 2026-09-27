import Fastify from 'fastify'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

import { initDB } from '../db.js'
import { ExtensionInstallationRepository } from '../extensions/installation-repository.js'
import { resolveTeamCollaborationConfig } from '../team/config.js'
import {
  TeamMemoryBindingService,
  type TeamMemoryBindingGrantService,
  type TeamMemoryInstallationReader,
} from '../team/memory-binding-service.js'
import {
  registerTeamMemoryBindingRoutes,
  type TeamMemoryBindingRouteService,
} from '../team/memory-binding-routes.js'
import { TeamRepositoryError } from '../team/repository.js'
import type { TeamMemoryBinding } from '../team/types.js'

const INSTALLATION_ID = '123e4567-e89b-42d3-a456-426614174000'
const SCOPE_ID = '223e4567-e89b-42d3-a456-426614174000'

function binding(overrides: Partial<TeamMemoryBinding> = {}): TeamMemoryBinding {
  return {
    id: 'cmbd_1',
    team_id: 'ctm_1',
    owner_scope_kind: 'organization',
    owner_scope_id: SCOPE_ID,
    installation_id: INSTALLATION_ID,
    revision: 1,
    created_by_user_id: 7,
    access_state: 'available',
    permissions: ['read', 'scope_admin'],
    manageable: true,
    created_at: '2026-09-26T00:00:00.000Z',
    updated_at: '2026-09-26T00:00:00.000Z',
    ...overrides,
  }
}

function routeService(overrides: Partial<TeamMemoryBindingRouteService> = {}): TeamMemoryBindingRouteService {
  return {
    getBinding: vi.fn(async () => null),
    bind: vi.fn(async () => binding()),
    remove: vi.fn(async () => null),
    ...overrides,
  }
}

function app(service: TeamMemoryBindingRouteService, memoryBridgeEnabled = true) {
  const server = Fastify()
  registerTeamMemoryBindingRoutes(server, {
    config: resolveTeamCollaborationConfig({
      TEAM_COLLABORATION: 'on',
      ...(memoryBridgeEnabled ? { TEAM_MEMORY_BRIDGE: 'on' } : {}),
    }),
    memoryBridgeEnabled,
    service,
    verifyAccessToken: async token => token.startsWith('user-')
      ? { userId: Number(token.slice(5)) }
      : null,
    getDatabaseReady: () => true,
  })
  return server
}

describe('Team Memory binding routes', () => {
  test('treats an unbound Team as a normal readable state', async () => {
    const getBinding = vi.fn(async () => null)
    const server = app(routeService({ getBinding }))
    const response = await server.inject({
      method: 'GET',
      url: '/api/team/teams/ctm_1/memory-binding',
      headers: { authorization: 'Bearer user-7' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ binding: null })
    expect(getBinding).toHaveBeenCalledWith('ctm_1', 7)
    await server.close()
  })

  test('accepts only an installation id and derives actor and owner scope server-side', async () => {
    const bind = vi.fn(async () => binding())
    const server = app(routeService({ bind }))
    const forged = await server.inject({
      method: 'PUT',
      url: '/api/team/teams/ctm_1/memory-binding',
      headers: { authorization: 'Bearer user-7' },
      payload: {
        request_id: 'bind-forged', expected_revision: 0, installation_id: INSTALLATION_ID,
        owner_scope_id: SCOPE_ID,
      },
    })
    expect(forged.statusCode).toBe(400)
    expect(bind).not.toHaveBeenCalled()

    const response = await server.inject({
      method: 'PUT',
      url: '/api/team/teams/ctm_1/memory-binding',
      headers: { authorization: 'Bearer user-7' },
      payload: { request_id: 'bind-1', expected_revision: 0, installation_id: INSTALLATION_ID },
    })
    expect(response.statusCode).toBe(200)
    expect(bind).toHaveBeenCalledWith({
      teamId: 'ctm_1', actorUserId: 7, installationId: INSTALLATION_ID,
      expectedRevision: 0, requestId: 'bind-1',
    })
    await server.close()
  })

  test('blocks new bindings when shared Memory is off but still permits unlinking', async () => {
    const bind = vi.fn(async () => binding())
    const remove = vi.fn(async () => null)
    const server = app(routeService({ bind, remove }), false)
    const disabled = await server.inject({
      method: 'PUT',
      url: '/api/team/teams/ctm_1/memory-binding',
      headers: { authorization: 'Bearer user-7' },
      payload: { request_id: 'bind-off', expected_revision: 0, installation_id: INSTALLATION_ID },
    })
    expect(disabled.statusCode).toBe(503)
    expect(disabled.json().error.code).toBe('team_feature_disabled')
    expect(bind).not.toHaveBeenCalled()

    const removed = await server.inject({
      method: 'DELETE',
      url: '/api/team/teams/ctm_1/memory-binding',
      headers: { authorization: 'Bearer user-7' },
      payload: { request_id: 'unbind-off', expected_revision: 3 },
    })
    expect(removed.statusCode).toBe(200)
    expect(removed.json()).toEqual({ binding: null })
    expect(remove).toHaveBeenCalledWith({
      teamId: 'ctm_1', actorUserId: 7, expectedRevision: 3, requestId: 'unbind-off',
    })
    await server.close()
  })

  test('reports optimistic binding conflicts without changing identifiers', async () => {
    const server = app(routeService({
      bind: vi.fn(async () => {
        throw new TeamRepositoryError('revision_conflict', 'Memory binding revision mismatch', 4)
      }),
    }))
    const response = await server.inject({
      method: 'PUT',
      url: '/api/team/teams/ctm_1/memory-binding',
      headers: { authorization: 'Bearer user-7' },
      payload: { request_id: 'bind-stale', expected_revision: 2, installation_id: INSTALLATION_ID },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatchObject({
      code: 'revision_conflict', current_revision: 4, retryable: true,
    })
    await server.close()
  })
})

describe('Team Memory binding authorization', () => {
  const row = {
    binding_id: 'cmbd_1', team_id: 'ctm_1', owner_scope_kind: 'organization' as const,
    owner_scope_id: SCOPE_ID, installation_id: INSTALLATION_ID, revision: '2',
    created_by_user_id: '7', created_at: new Date('2026-09-26T00:00:00Z'),
    updated_at: new Date('2026-09-26T00:00:00Z'),
  }
  const installations: TeamMemoryInstallationReader = {
    getScopedInstallation: vi.fn(async () => ({
      installation_id: INSTALLATION_ID,
      provider_id: 'pocketctl-memory',
      status: 'active' as const,
      enabled_services: ['memory.search'],
      owner_scope_kind: 'organization' as const,
      owner_scope_id: SCOPE_ID,
    })),
  }

  test('revalidates the current actor grant and hides cached permissions after revocation', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ creator_user_id: 7, state: 'active' }] })
      .mockResolvedValueOnce({ rows: [row] })
    const grants: TeamMemoryBindingGrantService = {
      mint: vi.fn(async () => ({ ok: false as const, code: 'not_found' as const, message: 'installation not found' })),
    }
    const service = new TeamMemoryBindingService(
      { query } as never, installations, grants, { memoryBridgeEnabled: true },
    )

    await expect(service.getBinding('ctm_1', 8)).resolves.toMatchObject({
      id: 'cmbd_1',
      team_id: 'ctm_1',
      owner_scope_id: SCOPE_ID,
      installation_id: INSTALLATION_ID,
      access_state: 'forbidden',
      permissions: [],
      manageable: false,
    })
    expect(grants.mint).toHaveBeenCalledWith({
      userId: 8, installationIds: [INSTALLATION_ID], callerType: 'web',
    })
  })

  test('retains the association but does not mint grants while the bridge is disabled', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ creator_user_id: 7, state: 'active' }] })
      .mockResolvedValueOnce({ rows: [row] })
    const grants: TeamMemoryBindingGrantService = { mint: vi.fn() }
    const service = new TeamMemoryBindingService(
      { query } as never, installations, grants, { memoryBridgeEnabled: false },
    )

    await expect(service.getBinding('ctm_1', 7)).resolves.toMatchObject({
      access_state: 'feature_disabled', permissions: [], manageable: false,
    })
    expect(grants.mint).not.toHaveBeenCalled()
  })

  test('does not infer scope administration from Team creator status', async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{ creator_user_id: 7, state: 'active' }],
    })
    const pool = { query, connect: vi.fn() }
    const grants: TeamMemoryBindingGrantService = {
      mint: vi.fn(async () => ({
        ok: true as const,
        token: 'grant',
        expiresInSeconds: 60,
        providerId: 'pocketctl-memory',
        bindings: [{
          installation_id: INSTALLATION_ID,
          owner_scope_kind: 'organization' as const,
          owner_scope_id: SCOPE_ID,
          membership_id: 'membership-1',
          membership_revision: '1',
          authorization_epoch: '1',
          permissions: ['read' as const],
        }],
      })),
    }
    const service = new TeamMemoryBindingService(
      pool as never, installations, grants, { memoryBridgeEnabled: true },
    )

    await expect(service.bind({
      teamId: 'ctm_1', actorUserId: 7, installationId: INSTALLATION_ID,
      expectedRevision: 0, requestId: 'bind-no-admin',
    })).rejects.toMatchObject({ code: 'memory_grant_required' })
    expect(pool.connect).not.toHaveBeenCalled()
  })
})

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

async function assertTeamTestDatabase(pool: pg.Pool, rawUrl: string): Promise<void> {
  const url = new URL(rawUrl)
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  const user = decodeURIComponent(url.username)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !loopbackHosts.has(url.hostname)
    || !/test/i.test(database)
    || user !== database
    || url.searchParams.has('options')) {
    throw new Error('Refusing Team integration test outside a loopback test database owned by its same-named role')
  }
  const identity = await pool.query<{ database: string; user: string; schema: string | null; superuser: boolean }>(`
    SELECT current_database() AS database, current_user AS "user", current_schema() AS schema,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser
  `)
  if (identity.rows[0]?.database !== database
    || identity.rows[0]?.user !== user
    || identity.rows[0]?.schema !== 'public'
    || identity.rows[0]?.superuser) {
    throw new Error('Refusing Team integration test against an unexpected database identity')
  }
}

async function resetTeamTestDatabase(pool: pg.Pool, rawUrl: string): Promise<void> {
  await assertTeamTestDatabase(pool, rawUrl)
  await pool.query(`TRUNCATE extension_providers, users, daemons RESTART IDENTITY CASCADE`)
}

describeWithDatabase('Team Memory binding persistence (PostgreSQL)', () => {
  let pool: pg.Pool
  let server: ReturnType<typeof Fastify>
  let disabledServer: ReturnType<typeof Fastify>
  let grantState: 'admin' | 'revoked'

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    await assertTeamTestDatabase(pool, databaseUrl!)
    await initDB(pool)
  }, 30_000)

  afterEach(async () => {
    await server?.close()
    await disabledServer?.close()
    await resetTeamTestDatabase(pool, databaseUrl!)
  })

  afterAll(async () => {
    await pool?.end()
  })

  test('binds an existing installation, revalidates revocation, and soft-removes while disabled', async () => {
    const creator = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password_hash) VALUES ('memory-owner@example.test', 'x') RETURNING id`,
    )
    const creatorId = creator.rows[0].id
    await pool.query(
      `INSERT INTO collaboration_teams (team_id, name, creator_user_id)
       VALUES ('ctm_memory_pg', 'Memory Team', $1)`,
      [creatorId],
    )
    await pool.query(
      `INSERT INTO collaboration_team_memberships (membership_id, team_id, user_id)
       VALUES ('cmb_memory_pg', 'ctm_memory_pg', $1)`,
      [creatorId],
    )
    await pool.query(
      `INSERT INTO extension_providers (provider_id, manifest_version, manifest)
       VALUES ('pocketctl-memory', 1, '{}'::jsonb)
       ON CONFLICT (provider_id) DO NOTHING`,
    )
    await pool.query(
      `INSERT INTO extension_installations
         (installation_id, provider_id, owner_user_id, status, granted_scopes,
          subscriptions, enabled_services, event_filter, start_policy)
       VALUES ($1, 'pocketctl-memory', $2, 'active', ARRAY['session:events:read'],
               ARRAY['session.event.v1'], ARRAY['memory.search'], '{}'::jsonb, 'from_now')`,
      [INSTALLATION_ID, creatorId],
    )

    grantState = 'admin'
    const grants: TeamMemoryBindingGrantService = {
      mint: vi.fn(async input => grantState === 'revoked'
        ? { ok: false as const, code: 'not_found' as const, message: 'installation not found' }
        : {
            ok: true as const,
            token: 'grant',
            expiresInSeconds: 60,
            providerId: 'pocketctl-memory',
            bindings: [{
              installation_id: input.installationIds[0],
              owner_scope_kind: 'personal' as const,
              owner_scope_id: input.installationIds[0],
              membership_id: null,
              membership_revision: '0',
              authorization_epoch: '1',
              permissions: ['read' as const, 'scope_admin' as const],
            }],
          }),
    }
    const service = new TeamMemoryBindingService(
      pool,
      new ExtensionInstallationRepository(pool),
      grants,
      { memoryBridgeEnabled: true },
    )
    server = app(service)

    const created = await server.inject({
      method: 'PUT',
      url: '/api/team/teams/ctm_memory_pg/memory-binding',
      headers: { authorization: `Bearer user-${creatorId}` },
      payload: { request_id: 'bind-pg', expected_revision: 0, installation_id: INSTALLATION_ID },
    })
    expect(created.statusCode, created.body).toBe(200)
    expect(created.json().binding).toMatchObject({
      team_id: 'ctm_memory_pg',
      owner_scope_id: INSTALLATION_ID,
      installation_id: INSTALLATION_ID,
      access_state: 'available',
    })
    expect(created.json().binding.id).toMatch(/^cmbd_/)

    const conflict = await server.inject({
      method: 'PUT',
      url: '/api/team/teams/ctm_memory_pg/memory-binding',
      headers: { authorization: `Bearer user-${creatorId}` },
      payload: { request_id: 'bind-pg-stale', expected_revision: 0, installation_id: INSTALLATION_ID },
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().error).toMatchObject({ code: 'revision_conflict', current_revision: 1 })

    grantState = 'revoked'
    const inaccessible = await server.inject({
      method: 'GET',
      url: '/api/team/teams/ctm_memory_pg/memory-binding',
      headers: { authorization: `Bearer user-${creatorId}` },
    })
    expect(inaccessible.json().binding).toMatchObject({
      access_state: 'forbidden', permissions: [], manageable: false,
    })

    disabledServer = app(service, false)
    const removed = await disabledServer.inject({
      method: 'DELETE',
      url: '/api/team/teams/ctm_memory_pg/memory-binding',
      headers: { authorization: `Bearer user-${creatorId}` },
      payload: { request_id: 'unbind-pg', expected_revision: 1 },
    })
    expect(removed.statusCode, removed.body).toBe(200)
    const retained = await pool.query<{ state: string }>(
      `SELECT state FROM team_memory_bindings WHERE team_id = 'ctm_memory_pg'`,
    )
    expect(retained.rows).toEqual([{ state: 'removed' }])
    expect((await pool.query(`SELECT 1 FROM extension_installations WHERE installation_id = $1`, [INSTALLATION_ID])).rowCount).toBe(1)
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM extension_organizations`)).rows[0].count).toBe(0)
  })
})
