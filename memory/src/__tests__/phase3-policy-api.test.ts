import Fastify from 'fastify'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { registerPolicyRoutes } from '../api/policy-routes.js'

const TEAM = '22222222-2222-4222-8222-222222222222'

describe('Phase 3 policy API authorization', () => {
  const apps: Array<ReturnType<typeof Fastify>> = []
  afterEach(async () => Promise.all(apps.splice(0).map(app => app.close())))

  test('passes an exact v2 policy_admin binding to shared-layer writes', async () => {
    const app = Fastify()
    apps.push(app)
    const query = vi.fn(async (sql: string) => {
      if (/INSERT INTO memory_idempotency_keys/.test(sql)) {
        return { rows: [{ reserved: 1 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    const createVersion = vi.fn(async () => ({
      ok: true as const, policyVersionId: 'version-1', versionNumber: 1,
    }))
    registerPolicyRoutes(app, {
      pool: { query, connect: vi.fn(async () => ({ query, release: vi.fn() })) } as never,
      guard: {
        guard: vi.fn(),
        guardV2: vi.fn(async () => ({
          version: 'v2', installationId: TEAM, primaryInstallationId: TEAM,
          services: ['memory.manage'], configVersion: '1', callerType: 'web',
          scopeBindings: [{
            installation_id: TEAM,
            owner_scope_kind: 'team',
            owner_scope_id: '33333333-3333-4333-8333-333333333333',
            membership_id: '44444444-4444-4444-8444-444444444444',
            membership_revision: '2', authorization_epoch: '7',
            permissions: ['read', 'policy_admin'],
          }],
        })),
      } as never,
      policy: { hostAllowed: () => true, originAllowed: () => true } as never,
      policies: {} as never,
      transactionalPolicies: () => ({ createVersion } as never),
    })
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/memory/policies/context/versions',
      headers: { authorization: 'Bearer v2', 'idempotency-key': 'team-policy-1' },
      payload: {
        layer: 'team', scope_key: 'global', target_installation_id: TEAM,
        document: { schema_version: 1 },
      },
    })
    expect(response.statusCode).toBe(200)
    expect(createVersion).toHaveBeenCalledWith(expect.objectContaining({
      installationId: TEAM,
      layer: 'team',
      actor: { permissions: ['read', 'policy_admin'], ownerScopeKind: 'team' },
    }))
  })
})
