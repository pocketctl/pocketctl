import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { registerCapabilityV2GrantRoutes } from '../extensions/capability-routes.js'
import {
  resolveGrantKeyMaterial,
  verifyCapabilityGrantV2,
} from '../extensions/capability-grant.js'

const ISSUER = 'https://relay.example.test'
const PROVIDER = 'pocketctl-memory'
const PERSONAL_INSTALL = '11111111-1111-4111-8111-111111111111'
const TEAM_INSTALL = '22222222-2222-4222-8222-222222222222'
const FOREIGN_INSTALL = '33333333-3333-4333-8333-333333333333'
// One stable keypair for the whole file: verify must use the signing key.
const MATERIAL = resolveGrantKeyMaterial({ NODE_ENV: 'test' })

interface QueryScript {
  match: RegExp
  rows: Record<string, unknown>[]
}

function poolWith(queries: QueryScript[]) {
  const calls: Array<{ sql: string; params?: unknown[] }> = []
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params })
      for (const script of queries) {
        if (script.match.test(sql.replace(/\s+/g, ' '))) return { rows: script.rows, rowCount: script.rows.length }
      }
      return { rows: [], rowCount: 0 }
    }),
    _calls: calls,
  }
  return pool as unknown as import('pg').Pool & { _calls: typeof calls }
}

const INSTALLATION_ROW = {
  installation_id: PERSONAL_INSTALL,
  provider_id: PROVIDER,
  owner_user_id: 9,
  status: 'active',
  enabled_services: ['memory.search', 'memory.recall'],
  config_version: '3',
  owner_scope_kind: 'personal',
  owner_scope_id: PERSONAL_INSTALL,
  authorization_epoch: '1',
  membership_id: null,
  membership_revision: null,
  roles: null,
  membership_state: null,
}

const TEAM_ROW = {
  installation_id: TEAM_INSTALL,
  provider_id: PROVIDER,
  owner_user_id: null,
  status: 'active',
  enabled_services: ['memory.search'],
  config_version: '5',
  owner_scope_kind: 'team',
  owner_scope_id: '44444444-4444-4444-8444-444444444444',
  authorization_epoch: '4',
  membership_id: '55555555-5555-4555-8555-555555555555',
  membership_revision: '2',
  roles: ['reader', 'reviewer'],
  membership_state: 'active',
}

describe('extension v2 grant routes', () => {
  const apps: Array<FastifyInstance> = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()))
  })

  function makeApp(options: {
    v2Mode?: 'off' | 'shadow' | 'enabled'
    userId?: number | null
    queries?: QueryScript[]
  } = {}) {
    const app = Fastify()
    apps.push(app)
    registerCapabilityV2GrantRoutes(app, {
      pool: poolWith(options.queries ?? [
        { match: /FROM extension_installations i/, rows: [INSTALLATION_ROW, TEAM_ROW] },
        {
          match: /FROM extension_teams|FROM extension_organizations|UNION ALL/,
          rows: [{ scope_kind: 'team', scope_id: '44444444-4444-4444-8444-444444444444', state: 'active', authorization_epoch: '4' }],
        },
        { match: /INSERT INTO audit_log/, rows: [] },
      ]),
      verifyAccessToken: vi.fn(async () =>
        options.userId === null ? null : { userId: options.userId ?? 9 }),
      mode: 'enabled',
      v2Mode: options.v2Mode ?? 'enabled',
      issuer: ISSUER,
      grantKeys: MATERIAL,
      providerPublicOrigins: new Map([[PROVIDER, 'https://memory.example.test']]),
    })
    return app
  }

  function headers() {
    return { authorization: 'Bearer user-token' }
  }

  test('mints a bounded v2 grant for explicitly requested installations', async () => {
    const app = makeApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/extensions/v2/grants',
      headers: headers(),
      payload: { installation_ids: [PERSONAL_INSTALL, TEAM_INSTALL], services: ['memory.search'] },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.token_type).toBe('extension_capability_v2')
    expect(body.provider_public_origin).toBe('https://memory.example.test')
    expect(body.expires_in).toBeLessThanOrEqual(60)

    const verified = verifyCapabilityGrantV2(MATERIAL.publicKeyPem, body.grant, ISSUER)
    expect(verified).not.toBeNull()
    expect(verified!.scopeBindings.map(b => b.installation_id)).toEqual([PERSONAL_INSTALL, TEAM_INSTALL])
    expect(verified!.primaryInstallationId).toBe(PERSONAL_INSTALL)
    const teamBinding = verified!.scopeBindings.find(b => b.installation_id === TEAM_INSTALL)!
    expect(teamBinding.permissions).toEqual(['read', 'review'])
    expect(teamBinding.membership_revision).toBe('2')
    expect(teamBinding.authorization_epoch).toBe('4')
    const personalBinding = verified!.scopeBindings.find(b => b.installation_id === PERSONAL_INSTALL)!
    expect(personalBinding.permissions).toContain('scope_admin')
    expect(personalBinding.membership_id).toBeNull()
  })

  test('uses the live shared-scope epoch instead of a stale installation snapshot', async () => {
    const staleTeam = { ...TEAM_ROW, authorization_epoch: '1' }
    const app = makeApp({ queries: [
      { match: /FROM extension_installations i/, rows: [INSTALLATION_ROW, staleTeam] },
      {
        match: /FROM extension_teams|FROM extension_organizations|UNION ALL/,
        rows: [{ scope_kind: 'team', scope_id: staleTeam.owner_scope_id, state: 'active', authorization_epoch: '9' }],
      },
      { match: /INSERT INTO audit_log/, rows: [] },
    ] })
    const response = await app.inject({
      method: 'POST', url: '/api/extensions/v2/grants', headers: headers(),
      payload: { installation_ids: [PERSONAL_INSTALL, TEAM_INSTALL], services: ['memory.search'] },
    })

    expect(response.statusCode).toBe(200)
    const verified = verifyCapabilityGrantV2(MATERIAL.publicKeyPem, response.json().grant, ISSUER)!
    expect(verified.scopeBindings.find(binding => binding.installation_id === TEAM_INSTALL)?.authorization_epoch)
      .toBe('9')
  })

  test('mints only a scope-admin memory.manage disposition grant for a dissolving scope', async () => {
    const dissolvingTeam = {
      ...TEAM_ROW,
      enabled_services: ['memory.manage'],
      roles: ['scope_administrator'],
    }
    const queries: QueryScript[] = [
      { match: /FROM extension_installations i/, rows: [dissolvingTeam] },
      {
        match: /FROM extension_teams|FROM extension_organizations|UNION ALL/,
        rows: [{
          scope_kind: 'team', scope_id: TEAM_ROW.owner_scope_id,
          state: 'dissolving', authorization_epoch: '8',
        }],
      },
      { match: /INSERT INTO audit_log/, rows: [] },
    ]
    const allowed = await makeApp({ queries }).inject({
      method: 'POST', url: '/api/extensions/v2/grants', headers: headers(),
      payload: { installation_ids: [TEAM_INSTALL], services: ['memory.manage'] },
    })
    expect(allowed.statusCode).toBe(200)
    const verified = verifyCapabilityGrantV2(MATERIAL.publicKeyPem, allowed.json().grant, ISSUER)!
    expect(verified.services).toEqual(['memory.manage'])
    expect(verified.scopeBindings[0].authorization_epoch).toBe('8')

    const denied = await makeApp({ queries }).inject({
      method: 'POST', url: '/api/extensions/v2/grants', headers: headers(),
      payload: { installation_ids: [TEAM_INSTALL], services: ['memory.search'] },
    })
    expect(denied.statusCode).toBe(404)
  })

  test('requires every federated binding to enable each requested service', async () => {
    const app = makeApp({ queries: [
      {
        match: /FROM extension_installations i/,
        rows: [INSTALLATION_ROW, { ...TEAM_ROW, enabled_services: [] }],
      },
      {
        match: /FROM extension_teams|FROM extension_organizations|UNION ALL/,
        rows: [{ scope_kind: 'team', scope_id: TEAM_ROW.owner_scope_id, state: 'active', authorization_epoch: '4' }],
      },
    ] })
    const response = await app.inject({
      method: 'POST', url: '/api/extensions/v2/grants', headers: headers(),
      payload: { installation_ids: [PERSONAL_INSTALL, TEAM_INSTALL], services: ['memory.search'] },
    })
    expect(response.statusCode).toBe(403)
  })

  test('validates the explicit binding list bounds', async () => {
    const app = makeApp()
    await expect(app.inject({
      method: 'POST', url: '/api/extensions/v2/grants', headers: headers(),
      payload: { installation_ids: [] },
    })).resolves.toMatchObject({ statusCode: 400 })
    await expect(app.inject({
      method: 'POST', url: '/api/extensions/v2/grants', headers: headers(),
      payload: { installation_ids: [PERSONAL_INSTALL, PERSONAL_INSTALL] },
    })).resolves.toMatchObject({ statusCode: 400 })
    await expect(app.inject({
      method: 'POST', url: '/api/extensions/v2/grants', headers: headers(),
      payload: { installation_ids: Array.from({ length: 17 }, (_, i) => `${String(i + 1).padStart(8, '0')}-1111-4111-8111-111111111111`) },
    })).resolves.toMatchObject({ statusCode: 400 })
    await expect(app.inject({
      method: 'POST', url: '/api/extensions/v2/grants', headers: headers(),
      payload: { installation_ids: 'not-an-array' },
    })).resolves.toMatchObject({ statusCode: 400 })
  })

  test('foreign and inaccessible installations answer a uniform 404', async () => {
    const foreign = makeApp({
      queries: [
        { match: /FROM extension_installations i/, rows: [] },
        { match: /INSERT INTO audit_log/, rows: [] },
      ],
    })
    const response = await foreign.inject({
      method: 'POST', url: '/api/extensions/v2/grants', headers: headers(),
      payload: { installation_ids: [FOREIGN_INSTALL] },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe('not_found')

    // A revoked membership never yields a binding.
    const revokedMember = makeApp({
      queries: [
        {
          match: /FROM extension_installations i/,
          rows: [{ ...TEAM_ROW, membership_state: 'revoked' }],
        },
        { match: /INSERT INTO audit_log/, rows: [] },
      ],
    })
    const revoked = await revokedMember.inject({
      method: 'POST', url: '/api/extensions/v2/grants', headers: headers(),
      payload: { installation_ids: [TEAM_INSTALL] },
    })
    expect(revoked.statusCode).toBe(404)
    expect(revoked.json()).toEqual(response.json())
  })

  test('narrows services to the primary installation and rejects unknown ones', async () => {
    const app = makeApp()
    const denied = await app.inject({
      method: 'POST', url: '/api/extensions/v2/grants', headers: headers(),
      payload: { installation_ids: [PERSONAL_INSTALL], services: ['memory.mcp'] },
    })
    expect(denied.statusCode).toBe(403)

    const narrowed = await app.inject({
      method: 'POST', url: '/api/extensions/v2/grants', headers: headers(),
      payload: { installation_ids: [PERSONAL_INSTALL], services: ['memory.recall'] },
    })
    expect(narrowed.statusCode).toBe(200)
    const verified = verifyCapabilityGrantV2(MATERIAL.publicKeyPem, narrowed.json().grant, ISSUER)
    expect(verified!.services).toEqual(['memory.recall'])
  })

  test('audit rows stay bounded and content-free', async () => {
    const queries = [
      { match: /FROM extension_installations i/, rows: [INSTALLATION_ROW] },
      { match: /INSERT INTO audit_log/, rows: [] },
    ]
    const pool = poolWith(queries)
    const app = Fastify()
    apps.push(app)
    registerCapabilityV2GrantRoutes(app, {
      pool,
      verifyAccessToken: vi.fn(async () => ({ userId: 9 })),
      mode: 'enabled',
      v2Mode: 'enabled',
      issuer: ISSUER,
      grantKeys: MATERIAL,
    })
    const response = await app.inject({
      method: 'POST', url: '/api/extensions/v2/grants', headers: headers(),
      payload: { installation_ids: [PERSONAL_INSTALL] },
    })
    expect(response.statusCode).toBe(200)
    const auditCall = pool._calls.find(call => /INSERT INTO audit_log/.test(call.sql))
    expect(auditCall).toBeDefined()
    const details = JSON.parse(String(auditCall!.params![2])) as Record<string, unknown>
    expect(Object.keys(details).sort()).toEqual(['binding_count', 'caller_type', 'provider_id'])
    expect(String(auditCall!.params![2])).not.toContain('grant')
    expect(String(auditCall!.params![2])).not.toContain('jti')
    expect(String(auditCall!.params![2])).not.toContain(PERSONAL_INSTALL)
    expect(String(auditCall!.params![2])).not.toContain('memory.search')
  })

  test('requires the v2 feature flag and authentication', async () => {
    const off = makeApp({ v2Mode: 'off' })
    const disabled = await off.inject({
      method: 'POST', url: '/api/extensions/v2/grants', headers: headers(),
      payload: { installation_ids: [PERSONAL_INSTALL] },
    })
    expect(disabled.statusCode).toBe(503)
    expect(disabled.json().error.code).toBe('feature_disabled')

    const unauthenticated = makeApp({ userId: null })
    const noToken = await unauthenticated.inject({
      method: 'POST', url: '/api/extensions/v2/grants',
      headers: {},
      payload: { installation_ids: [PERSONAL_INSTALL] },
    })
    expect(noToken.statusCode).toBe(401)
  })
})
