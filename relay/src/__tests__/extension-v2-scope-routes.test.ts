import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { ExtensionScopeRouteService } from '../extensions/scope-routes.js'

const { registerExtensionScopeRoutes } = await import('../extensions/scope-routes.js') as {
  registerExtensionScopeRoutes: (
    app: FastifyInstance,
    deps: {
      pool: unknown
      verifyAccessToken(token: string): Promise<{ userId: number } | null>
      v2Mode: 'off' | 'shadow' | 'enabled'
      service?: ExtensionScopeRouteService
    },
  ) => void
}

const ORG_ID = '11111111-1111-4111-8111-111111111111'
const TEAM_ID = '22222222-2222-4222-8222-222222222222'
const MEMBERSHIP_ID = '33333333-3333-4333-8333-333333333333'

function baseScope() {
  return {
    owner_scope_kind: 'organization' as const,
    owner_scope_id: ORG_ID,
    parent_organization_id: null,
    name: 'fixture-org',
    state: 'active' as const,
    authorization_epoch: 3,
    revision: 3,
    membership_id: MEMBERSHIP_ID,
    membership_revision: 2,
    roles: ['scope_administrator' as const],
    created_at: new Date('2026-08-30T10:00:00Z'),
  }
}

function baseMembership() {
  return {
    membership_id: MEMBERSHIP_ID,
    scope_kind: 'team' as const,
    scope_id: TEAM_ID,
    user_id: 7,
    roles: ['reader' as const],
    state: 'active' as const,
    membership_revision: 1,
    created_at: new Date('2026-08-30T10:00:00Z'),
    updated_at: new Date('2026-08-30T10:00:00Z'),
    revoked_at: null,
    display_label: 'fixture member',
  }
}

function makeService(overrides: Partial<ExtensionScopeRouteService> = {}): ExtensionScopeRouteService {
  return {
    listScopesForUser: vi.fn(async () => [baseScope()]),
    createOrganization: vi.fn(async () => ({
      organization: {
        organization_id: ORG_ID,
        name: 'fixture-org',
        state: 'active' as const,
        authorization_epoch: 2,
        revision: 2,
        created_by_user_id: 1,
        created_at: new Date('2026-08-30T10:00:00Z'),
        updated_at: new Date('2026-08-30T10:00:00Z'),
      },
      creatorMembership: { ...baseMembership(), roles: ['scope_administrator'] },
    })),
    createTeam: vi.fn(async () => ({
      team: {
        team_id: TEAM_ID,
        organization_id: ORG_ID,
        name: 'fixture-team',
        state: 'active' as const,
        authorization_epoch: 1,
        revision: 1,
        created_by_user_id: 1,
        created_at: new Date('2026-08-30T10:00:00Z'),
        updated_at: new Date('2026-08-30T10:00:00Z'),
      },
      creatorMembership: baseMembership(),
    })),
    listMembers: vi.fn(async () => [baseMembership()]),
    addMember: vi.fn(async () => baseMembership()),
    updateMember: vi.fn(async () => baseMembership()),
    updateLifecycle: vi.fn(async () => baseScope()),
    beginIdempotency: vi.fn(async () => ({ kind: 'fresh' as const })),
    commitIdempotency: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as ExtensionScopeRouteService
}

describe('extension v2 scope routes', () => {
  const apps: Array<FastifyInstance> = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()))
  })

  function makeApp(options: {
    v2Mode?: 'off' | 'shadow' | 'enabled'
    userId?: number | null
    service?: ExtensionScopeRouteService
  } = {}) {
    const app = Fastify()
    apps.push(app)
    registerExtensionScopeRoutes(app, {
      pool: {},
      verifyAccessToken: vi.fn(async () =>
        options.userId === null ? null : { userId: options.userId ?? 1 }),
      v2Mode: options.v2Mode ?? 'enabled',
      service: options.service ?? makeService(),
    })
    return app
  }

  function authHeaders() {
    return { authorization: 'Bearer test-token' }
  }

  test('rejects unauthenticated calls on every v2 scope route', async () => {
    const app = makeApp()
    const noToken = { authorization: '' }
    await expect(app.inject({ method: 'GET', url: '/api/extensions/v2/scopes', headers: noToken })).resolves.toMatchObject({ statusCode: 401 })
    await expect(app.inject({
      method: 'POST', url: '/api/extensions/v2/organizations', headers: noToken,
    })).resolves.toMatchObject({ statusCode: 401 })
    await expect(app.inject({
      method: 'GET', url: `/api/extensions/v2/scopes/team/${TEAM_ID}/members`, headers: noToken,
    })).resolves.toMatchObject({ statusCode: 401 })
  })

  test('lists caller-accessible scopes for an authenticated user', async () => {
    const service = makeService()
    const app = makeApp({ service })
    const response = await app.inject({
      method: 'GET', url: '/api/extensions/v2/scopes', headers: authHeaders(),
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.scopes).toHaveLength(1)
    expect(body.scopes[0]).toMatchObject({
      owner_scope_kind: 'organization',
      owner_scope_id: ORG_ID,
      state: 'active',
      roles: ['scope_administrator'],
    })
    expect(service.listScopesForUser).toHaveBeenCalledWith(1)
  })

  test('creates an organization and creator scope-admin membership when enabled', async () => {
    const service = makeService()
    const app = makeApp({ service })
    const response = await app.inject({
      method: 'POST',
      url: '/api/extensions/v2/organizations',
      headers: { ...authHeaders(), 'idempotency-key': 'org-1' },
      payload: { name: 'fixture-org' },
    })
    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.organization.organization_id).toBe(ORG_ID)
    expect(body.creator_membership.roles).toEqual(['scope_administrator'])
    expect(service.createOrganization).toHaveBeenCalledWith(expect.objectContaining({
      name: 'fixture-org',
      actorUserId: 1,
    }))
  })

  test('blocks v2 mutations while the feature flag is off', async () => {
    const service = makeService()
    const app = makeApp({ v2Mode: 'off', service })
    const response = await app.inject({
      method: 'POST',
      url: '/api/extensions/v2/organizations',
      headers: { ...authHeaders(), 'idempotency-key': 'org-1' },
      payload: { name: 'fixture-org' },
    })
    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe('feature_disabled')
    expect(service.createOrganization).not.toHaveBeenCalled()
  })

  test('requires a bounded non-empty organization or team name', async () => {
    const app = makeApp()
    await expect(app.inject({
      method: 'POST',
      url: '/api/extensions/v2/organizations',
      headers: { ...authHeaders(), 'idempotency-key': 'org-1' },
      payload: { name: '' },
    })).resolves.toMatchObject({ statusCode: 400 })
    await expect(app.inject({
      method: 'POST',
      url: '/api/extensions/v2/organizations',
      headers: { ...authHeaders(), 'idempotency-key': 'org-1' },
      payload: { name: 'x'.repeat(129) },
    })).resolves.toMatchObject({ statusCode: 400 })
    await expect(app.inject({
      method: 'POST',
      url: `/api/extensions/v2/organizations/${ORG_ID}/teams`,
      headers: { ...authHeaders(), 'idempotency-key': 'team-1' },
      payload: {},
    })).resolves.toMatchObject({ statusCode: 400 })
  })

  test('creates a team under an organization with scope-admin permission', async () => {
    const service = makeService()
    const app = makeApp({ service })
    const response = await app.inject({
      method: 'POST',
      url: `/api/extensions/v2/organizations/${ORG_ID}/teams`,
      headers: { ...authHeaders(), 'idempotency-key': 'team-1' },
      payload: { name: 'fixture-team' },
    })
    expect(response.statusCode).toBe(201)
    expect(response.json().team.team_id).toBe(TEAM_ID)
    expect(service.createTeam).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: ORG_ID,
      name: 'fixture-team',
      actorUserId: 1,
    }))
  })

  test('adds a member by normalized email with allowlisted roles', async () => {
    const service = makeService()
    const app = makeApp({ service })
    const response = await app.inject({
      method: 'POST',
      url: `/api/extensions/v2/scopes/team/${TEAM_ID}/members`,
      headers: { ...authHeaders(), 'idempotency-key': 'member-1' },
      payload: { email: 'Member@Example.TEST ', roles: ['reader'] },
    })
    expect(response.statusCode).toBe(201)
    expect(service.addMember).toHaveBeenCalledWith(expect.objectContaining({
      email: 'member@example.test',
      roles: ['reader'],
    }))
  })

  test('rejects unknown roles and malformed email payloads', async () => {
    const app = makeApp()
    await expect(app.inject({
      method: 'POST',
      url: `/api/extensions/v2/scopes/team/${TEAM_ID}/members`,
      headers: { ...authHeaders(), 'idempotency-key': 'member-1' },
      payload: { email: 'member@example.test', roles: ['warlord'] },
    })).resolves.toMatchObject({ statusCode: 400 })
    await expect(app.inject({
      method: 'POST',
      url: `/api/extensions/v2/scopes/team/${TEAM_ID}/members`,
      headers: { ...authHeaders(), 'idempotency-key': 'member-1' },
      payload: { email: 'not-an-email', roles: ['reader'] },
    })).resolves.toMatchObject({ statusCode: 400 })
  })

  test('membership updates require expected_revision and Idempotency-Key', async () => {
    const app = makeApp()
    await expect(app.inject({
      method: 'PATCH',
      url: `/api/extensions/v2/scopes/team/${TEAM_ID}/members/${MEMBERSHIP_ID}`,
      headers: authHeaders(),
      payload: { roles: ['reviewer'] },
    })).resolves.toMatchObject({ statusCode: 400 })
    await expect(app.inject({
      method: 'PATCH',
      url: `/api/extensions/v2/scopes/team/${TEAM_ID}/members/${MEMBERSHIP_ID}`,
      headers: { ...authHeaders(), 'idempotency-key': 'member-2' },
      payload: { roles: ['reviewer'] },
    })).resolves.toMatchObject({ statusCode: 400 })
    await expect(app.inject({
      method: 'PATCH',
      url: `/api/extensions/v2/scopes/team/${TEAM_ID}/members/${MEMBERSHIP_ID}`,
      headers: { ...authHeaders(), 'idempotency-key': 'member-2' },
      payload: { expected_revision: 0, roles: ['reviewer'] },
    })).resolves.toMatchObject({ statusCode: 400 })
  })

  test('maps permission failures to forbidden and scope misses to uniform 404s', async () => {
    const { ScopeNotFoundError, ScopePermissionError } = await import('../extensions/scope-repository.js')
    const app = makeApp({
      service: makeService({
        createTeam: vi.fn(async () => { throw new ScopePermissionError() }),
        listMembers: vi.fn(async () => { throw new ScopeNotFoundError() }),
        updateMember: vi.fn(async () => { throw new ScopeNotFoundError() }),
      }),
    })
    await expect(app.inject({
      method: 'POST',
      url: `/api/extensions/v2/organizations/${ORG_ID}/teams`,
      headers: { ...authHeaders(), 'idempotency-key': 'team-2' },
      payload: { name: 'fixture-team' },
    })).resolves.toMatchObject({ statusCode: 403 })
    // Foreign and missing scopes are indistinguishable.
    await expect(app.inject({
      method: 'GET',
      url: `/api/extensions/v2/scopes/team/${TEAM_ID}/members`,
      headers: authHeaders(),
    })).resolves.toMatchObject({ statusCode: 404 })
    await expect(app.inject({
      method: 'PATCH',
      url: `/api/extensions/v2/scopes/team/${TEAM_ID}/members/${MEMBERSHIP_ID}`,
      headers: { ...authHeaders(), 'idempotency-key': 'member-3' },
      payload: { expected_revision: 1, roles: ['reviewer'] },
    })).resolves.toMatchObject({ statusCode: 404 })
  })

  test('maps revision conflicts to bounded 409 responses carrying current state', async () => {
    const { MembershipRevisionConflictError } = await import('../extensions/scope-repository.js')
    const app = makeApp({
      service: makeService({
        updateMember: vi.fn(async () => {
          throw Object.assign(new MembershipRevisionConflictError(), {
            currentRevision: 7,
            currentState: 'active',
          })
        }),
      }),
    })
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/extensions/v2/scopes/team/${TEAM_ID}/members/${MEMBERSHIP_ID}`,
      headers: { ...authHeaders(), 'idempotency-key': 'member-4' },
      payload: { expected_revision: 1, roles: ['reviewer'] },
    })
    expect(response.statusCode).toBe(409)
    const error = response.json().error
    expect(error.code).toBe('revision_conflict')
    expect(error.current_revision).toBe(7)
    expect(error.current_state).toBe('active')
  })

  test('lifecycle transitions require CAS and a known state', async () => {
    const service = makeService()
    const app = makeApp({ service })
    await expect(app.inject({
      method: 'POST',
      url: `/api/extensions/v2/scopes/team/${TEAM_ID}/lifecycle`,
      headers: { ...authHeaders(), 'idempotency-key': 'life-1' },
      payload: { state: 'exploded' },
    })).resolves.toMatchObject({ statusCode: 400 })
    await expect(app.inject({
      method: 'POST',
      url: `/api/extensions/v2/scopes/team/${TEAM_ID}/lifecycle`,
      headers: { ...authHeaders(), 'idempotency-key': 'life-1' },
      payload: { state: 'suspended' },
    })).resolves.toMatchObject({ statusCode: 400 })
    const response = await app.inject({
      method: 'POST',
      url: `/api/extensions/v2/scopes/team/${TEAM_ID}/lifecycle`,
      headers: { ...authHeaders(), 'idempotency-key': 'life-1' },
      payload: { state: 'suspended', expected_revision: 4 },
    })
    expect(response.statusCode).toBe(200)
    expect(service.updateLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      scopeKind: 'team',
      scopeId: TEAM_ID,
      expectedRevision: 4,
      state: 'suspended',
    }))
  })

  test('replays an idempotent mutation instead of executing it twice', async () => {
    const service = makeService({
      beginIdempotency: vi.fn(async () => ({
        kind: 'replay' as const,
        response: { status: 201, body: { membership: baseMembership() } },
      })),
    })
    const app = makeApp({ service })
    const response = await app.inject({
      method: 'POST',
      url: `/api/extensions/v2/scopes/team/${TEAM_ID}/members`,
      headers: { ...authHeaders(), 'idempotency-key': 'same-key' },
      payload: { email: 'member@example.test', roles: ['reader'] },
    })
    expect(response.statusCode).toBe(201)
    expect(response.json().membership.membership_id).toBe(MEMBERSHIP_ID)
    expect(service.addMember).not.toHaveBeenCalled()
    expect(service.commitIdempotency).not.toHaveBeenCalled()
  })

  test('rejects an idempotency key replayed with a different request body', async () => {
    const service = makeService({
      beginIdempotency: vi.fn(async () => ({ kind: 'mismatch' as const })),
    })
    const app = makeApp({ service })
    const response = await app.inject({
      method: 'POST',
      url: `/api/extensions/v2/scopes/team/${TEAM_ID}/members`,
      headers: { ...authHeaders(), 'idempotency-key': 'same-key' },
      payload: { email: 'member@example.test', roles: ['reader'] },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('revision_conflict')
    expect(service.addMember).not.toHaveBeenCalled()
  })
})
