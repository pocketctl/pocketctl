import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { registerGovernanceRoutes } from '../api/governance-routes.js'
import { MemoryApiError } from '../api/errors.js'
import type { RouteV2Grant } from '../governance/authorization.js'
import { PublicationError } from '../governance/publication-service.js'

const TEAM = 'cafecafe-0000-4000-8000-000000000002'
const PERSONAL = 'cafecafe-0000-4000-8000-000000000001'
const CANDIDATE = 'cafecafe-0000-4000-8000-000000000011'

function grant(overrides: Partial<RouteV2Grant> = {}): RouteV2Grant {
  return {
    version: 'v2',
    installationId: TEAM,
    primaryInstallationId: TEAM,
    services: ['memory.search'],
    configVersion: '1',
    callerType: 'web',
    scopeBindings: [
      {
        installation_id: TEAM,
        owner_scope_kind: 'team',
        owner_scope_id: 'cafecafe-0000-4000-8000-000000000041',
        membership_id: 'cafecafe-0000-4000-8000-000000000021',
        membership_revision: '2',
        authorization_epoch: '1',
        permissions: ['read', 'contribute', 'review', 'publish', 'policy_admin', 'scope_admin'],
      },
    ],
    ...overrides,
  }
}

function makeApp(options: {
  grant?: RouteV2Grant | null
  poolQueries?: Array<{ match: RegExp; rows: Record<string, unknown>[]; error?: Error }>
} = {}) {
  const app = Fastify()
  const query = vi.fn(async (sql: string) => {
    for (const script of options.poolQueries ?? []) {
      if (script.match.test(sql.replace(/\s+/g, ' '))) {
        if (script.error) throw script.error
        return { rows: script.rows, rowCount: script.rows.length }
      }
    }
    if (/INSERT INTO memory_idempotency_keys/.test(sql)) {
      return { rows: [{ reserved: 1 }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })
  const pool = {
    query,
    connect: vi.fn(async () => ({ query, release: vi.fn() })),
  } as never as import('pg').Pool
  registerGovernanceRoutes(app, {
    pool,
    guard: {
      guard: vi.fn(),
      guardV2: vi.fn(async () => {
        if (options.grant === null) {
          throw new MemoryApiError('unauthorized', 'grant rejected')
        }
        return options.grant ?? grant()
      }),
      guardV2Disposition: vi.fn(async () => {
        if (options.grant === null) {
          throw new MemoryApiError('unauthorized', 'grant rejected')
        }
        return options.grant ?? grant()
      }),
    } as never,
    sharedScopesEnabled: false,
    cursorSigningKey: 'test-governance-cursor-key',
  })
  return { app, pool }
}

describe('memory governance API', () => {
  const apps: Array<FastifyInstance> = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(entry => entry.close()))
  })

  function make(options: Parameters<typeof makeApp>[0] = {}) {
    const made = makeApp(options)
    apps.push(made.app)
    return made
  }

  function headers() {
    return { authorization: 'Bearer v2-grant' }
  }

  test('lists the validated grant bindings as governance scopes', async () => {
    const { app } = make({
      poolQueries: [{
        match: /FROM memory_owner_scopes/,
        rows: [{
          installation_id: TEAM,
          state: 'active',
          parent_organization_id: 'cafecafe-0000-4000-8000-000000000099',
        }],
      }],
    })
    const response = await app.inject({
      method: 'GET', url: '/api/v1/memory/governance/scopes', headers: headers(),
    })
    expect(response.statusCode).toBe(200)
    const scopes = response.json().scopes
    expect(scopes[0].installation_id).toBe(TEAM)
    expect(scopes[0].permissions).toContain('publish')
    expect(scopes[0].state).toBe('active')
    expect(scopes[0].parent_organization_id).toBe('cafecafe-0000-4000-8000-000000000099')
  })

  test('rejects unauthenticated and v1 grant callers uniformly', async () => {
    const { app } = make({ grant: null })
    const response = await app.inject({
      method: 'GET', url: '/api/v1/memory/governance/scopes', headers: headers(),
    })
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe('unauthorized')
  })

  test('requires a target installation for the proposal queue', async () => {
    const { app } = make()
    const missing = await app.inject({
      method: 'GET', url: '/api/v1/memory/governance/proposals', headers: headers(),
    })
    expect(missing.statusCode).toBe(400)

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/v1/memory/governance/proposals?target_installation_id=${PERSONAL}`,
      headers: headers(),
    })
    expect(foreign.statusCode).toBe(404)
  })

  test('returns the active incumbent claims needed for explicit conflict resolution', async () => {
    const incumbent = 'cafecafe-0000-4000-8000-000000000051'
    const { app } = make({
      poolQueries: [
        {
          match: /SELECT \* FROM memory_promotion_candidates/,
          rows: [{
            candidate_id: CANDIDATE,
            target_installation_id: TEAM,
            source_installation_id: PERSONAL,
            source_scope_kind: 'personal',
            source_claim_id: 'cafecafe-0000-4000-8000-000000000012',
            source_version_id: 'cafecafe-0000-4000-8000-000000000013',
            source_content_hash: 'source-hash',
            target_claim_type: 'work_method',
            scope_kind: 'installation',
            scope_key: '',
            normalized_key: 'conflict-key',
            state: 'conflict',
            conflict_group_id: 'cafecafe-0000-4000-8000-000000000061',
            duplicate_of_claim_id: null,
            expires_at: new Date('2026-09-01T00:00:00Z'),
            revision: 1,
            created_by_membership_id: null,
            created_at: new Date('2026-08-30T00:00:00Z'),
            updated_at: new Date('2026-08-30T00:00:00Z'),
          }],
        },
        {
          match: /FROM memory_promotion_candidate_versions/,
          rows: [{
            candidate_revision_id: 'cafecafe-0000-4000-8000-000000000071',
            candidate_id: CANDIDATE,
            revision_number: 1,
            statement: 'candidate statement',
          }],
        },
        { match: /FROM memory_review_decisions/, rows: [] },
        {
          match: /JOIN knowledge_versions v ON v.version_id = c.current_version_id/,
          rows: [{ claim_id: incumbent, statement: 'incumbent statement', conflict_variant: 0 }],
        },
      ],
    })
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/memory/governance/proposals?target_installation_id=${TEAM}`,
      headers: headers(),
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().queue[0].conflict_claims).toEqual([{
      claim_id: incumbent,
      statement: 'incumbent statement',
      conflict_variant: 0,
    }])
  })

  test('mutations require an Idempotency-Key header', async () => {
    const { app } = make()
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/memory/governance/proposals',
      headers: headers(),
      payload: {
        source_installation_id: PERSONAL,
        source_claim_id: CANDIDATE,
        evidence_ids: ['cafecafe-0000-4000-8000-000000000031'],
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toContain('Idempotency-Key')
  })

  test('maps service errors to bounded HTTP envelopes', async () => {
    const { app } = make({
      poolQueries: [
        {
          match: /FROM memory_promotion_candidates/,
          rows: [],
          error: new PublicationError('quorum_failed', 'publication quorum failed: insufficient_approvals'),
        },
      ],
    })
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/memory/governance/proposals/${CANDIDATE}/publish`,
      headers: { ...headers(), 'idempotency-key': 'publish-key-1' },
      payload: {
        target_installation_id: TEAM,
        expected_revision: 1,
        resolution: 'new',
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('quorum_failed')
  })

  test('records a content-free audit event when publish permission is denied', async () => {
    const withoutPublish = grant({
      scopeBindings: [{
        ...grant().scopeBindings[0],
        permissions: ['read', 'review'],
      }],
    })
    const { app, pool } = make({ grant: withoutPublish })
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/memory/governance/proposals/${CANDIDATE}/publish`,
      headers: { ...headers(), 'idempotency-key': 'publish-denied-key-1' },
      payload: {
        target_installation_id: TEAM,
        expected_revision: 1,
        resolution: 'new',
      },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('forbidden')
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO memory_governance_events/),
      expect.arrayContaining([
        TEAM,
        withoutPublish.scopeBindings[0].membership_id,
        'candidate_publish_denied',
        'promotion_candidate',
        CANDIDATE,
      ]),
    )
  })

  test('registers revise, withdraw, and transfer mutations with bounded validation', async () => {
    const { app } = make()
    for (const url of [
      `/api/v1/memory/governance/proposals/${CANDIDATE}/revise`,
      `/api/v1/memory/governance/proposals/${CANDIDATE}/withdraw`,
      '/api/v1/memory/governance/transfers',
    ]) {
      const response = await app.inject({
        method: 'POST', url,
        headers: { ...headers(), 'idempotency-key': `key-${url}` },
        payload: {},
      })
      expect(response.statusCode, url).toBe(400)
      expect(response.json().error.code, url).toBe('invalid_request')
    }
  })

  test('review policy writes require the policy_admin permission', async () => {
    const { app } = make({
      grant: grant({
        scopeBindings: grant().scopeBindings.map(binding =>
          ({ ...binding, permissions: ['read'] })),
      }),
    })
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/memory/governance/review-policy',
      headers: { ...headers(), 'idempotency-key': 'policy-key-1' },
      payload: { target_installation_id: TEAM, expected_revision: 1, document: {} },
    })
    expect(response.statusCode).toBe(403)
  })

  test('audit reads require the scope_admin permission', async () => {
    const reader = make({
      grant: grant({
        scopeBindings: grant().scopeBindings.map(binding =>
          ({ ...binding, permissions: ['read'] })),
      }),
    })
    const denied = await reader.app.inject({
      method: 'GET',
      url: `/api/v1/memory/governance/audit?target_installation_id=${TEAM}`,
      headers: headers(),
    })
    expect(denied.statusCode).toBe(403)

    const { app } = make({
      poolQueries: [{ match: /FROM memory_governance_events/, rows: [] }],
    })
    const allowed = await app.inject({
      method: 'GET',
      url: `/api/v1/memory/governance/audit?target_installation_id=${TEAM}`,
      headers: headers(),
    })
    expect(allowed.statusCode).toBe(200)
    expect(allowed.json().events).toEqual([])
  })
})
