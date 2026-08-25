import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { generateKeyPairSync } from 'crypto'
import {
  resolveGrantKeyMaterial,
  verifyCapabilityGrant,
} from '../extensions/capability-grant.js'
import type { CapabilityRouteDeps } from '../extensions/capability-routes.js'

const { registerCapabilityRoutes } = await import('../extensions/capability-routes.js')

const ISSUER = 'https://relay.example.test'
const INSTALLATION = '11111111-1111-1111-1111-111111111111'

function grantKeys() {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return resolveGrantKeyMaterial({
    EXTENSION_GRANT_PRIVATE_KEY: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    EXTENSION_GRANT_PUBLIC_KEY: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    EXTENSION_GRANT_KEY_ID: 'test-kid',
  })
}

function installationPool(overrides: Record<string, unknown> = {}, sessionOwned = true) {
  return {
    query: vi.fn(async (sql: string) => {
      if (/FROM extension_installations/.test(sql)) {
        return {
          rows: [{
            provider_id: 'pocketctl-memory',
            owner_user_id: 42,
            status: 'active',
            enabled_services: ['memory.search', 'memory.recall'],
            config_version: 2,
            ...overrides,
          }],
        }
      }
      if (/JOIN extension_installations i ON i.owner_user_id = s.user_id/.test(sql)) {
        return { rows: sessionOwned ? [{ '?column?': 1 }] : [], rowCount: sessionOwned ? 1 : 0 }
      }
      return { rows: [] }
    }),
  }
}

function makeApp(deps: Partial<CapabilityRouteDeps> = {}, installation: Record<string, unknown> = {}, sessionOwned = true) {
  const app = Fastify()
  registerCapabilityRoutes(app, {
    pool: installationPool(installation, sessionOwned) as never,
    verifyAccessToken: vi.fn(async () => ({ userId: 42 })),
    mode: 'enabled',
    issuer: ISSUER,
    grantKeys: grantKeys(),
    ...deps,
  } as CapabilityRouteDeps)
  return app
}

describe('extension capability routes', () => {
  const apps: Array<FastifyInstance> = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()))
  })

  function track(app: FastifyInstance) {
    apps.push(app)
    return app
  }

  test('serves a public read-only JWKS without auth', async () => {
    const app = track(makeApp())
    const response = await app.inject({ method: 'GET', url: '/.well-known/pocketctl-extension-jwks.json' })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.keys[0].kid).toBe('test-kid')
    expect(Object.keys(body.keys[0]).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use'])
  })

  test('mints a grant for an active installation with narrowed services', async () => {
    const keys = grantKeys()
    const app = track(makeApp({ grantKeys: keys }))
    const response = await app.inject({
      method: 'POST', url: '/api/extensions/v1/grants',
      headers: { authorization: 'Bearer user-token' },
      payload: {
        installation_id: INSTALLATION,
        caller_type: 'web',
        services: ['memory.search'],
        session_id: 'ses-1',
      },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.token_type).toBe('extension_capability')
    expect(body.expires_in).toBeLessThanOrEqual(300)
    const verified = verifyCapabilityGrant(keys.publicKeyPem, body.grant, ISSUER)
    expect(verified).toMatchObject({
      userId: 42,
      providerId: 'pocketctl-memory',
      installationId: INSTALLATION,
      sessionId: 'ses-1',
      services: ['memory.search'],
      configVersion: '2',
    })
  })

  test('requires a valid user access token', async () => {
    const app = track(makeApp({
      verifyAccessToken: vi.fn(async () => null),
    }))
    const response = await app.inject({
      method: 'POST', url: '/api/extensions/v1/grants',
      headers: { authorization: 'Bearer bad' },
      payload: { installation_id: INSTALLATION },
    })
    expect(response.statusCode).toBe(401)
  })

  test('off and shadow modes refuse to mint grants', async () => {
    for (const mode of ['off', 'shadow'] as const) {
      const app = track(makeApp({ mode }))
      const response = await app.inject({
        method: 'POST', url: '/api/extensions/v1/grants',
        headers: { authorization: 'Bearer t' },
        payload: { installation_id: INSTALLATION },
      })
      expect(response.statusCode).toBe(503)
      expect(response.json().error.code).toBe('feature_disabled')
    }
  })

  test('paused, pending and revoked installations never receive grants', async () => {
    for (const [status, expected] of [
      ['paused', 'installation_paused'],
      ['pending', 'installation_paused'],
      ['revoking', 'installation_revoked'],
      ['revoked', 'installation_revoked'],
    ] as const) {
      const app = track(makeApp({}, { status }))
      const response = await app.inject({
        method: 'POST', url: '/api/extensions/v1/grants',
        headers: { authorization: 'Bearer t' },
        payload: { installation_id: INSTALLATION },
      })
      expect(response.statusCode).toBeGreaterThanOrEqual(400)
      expect(response.json().error.code).toBe(expected)
    }
  })

  test('cross-user installations are a 404', async () => {
    const app = track(makeApp())
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
    }
    // Swap deps by registering directly with the empty pool.
    const other = Fastify()
    apps.push(other)
    registerCapabilityRoutes(other, {
      pool: pool as never,
      verifyAccessToken: vi.fn(async () => ({ userId: 42 })),
      mode: 'enabled',
      issuer: ISSUER,
      grantKeys: grantKeys(),
    })
    const response = await other.inject({
      method: 'POST', url: '/api/extensions/v1/grants',
      headers: { authorization: 'Bearer t' },
      payload: { installation_id: INSTALLATION },
    })
    expect(response.statusCode).toBe(404)
    expect(app).toBeDefined()
  })

  test('service widening is forbidden', async () => {
    const app = track(makeApp())
    const response = await app.inject({
      method: 'POST', url: '/api/extensions/v1/grants',
      headers: { authorization: 'Bearer t' },
      payload: { installation_id: INSTALLATION, services: ['memory.mcp'] },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('forbidden')
  })

  test('malformed service and session values are rejected instead of discarded', async () => {
    const app = track(makeApp())
    for (const payload of [
      { installation_id: INSTALLATION, services: ['memory.search', 42] },
      { installation_id: INSTALLATION, session_id: 42 },
    ]) {
      const response = await app.inject({
        method: 'POST', url: '/api/extensions/v1/grants',
        headers: { authorization: 'Bearer t' }, payload,
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().error.code).toBe('invalid_request')
    }
  })

  test('a minted management grant carries the operator provider origin', async () => {
    const keys = grantKeys()
    const app = track(makeApp({
      grantKeys: keys,
      providerPublicOrigins: new Map([['pocketctl-memory', 'https://memory.example']]),
    }, {
      enabled_services: ['memory.search', 'memory.recall', 'memory.manage'],
    }))
    const response = await app.inject({
      method: 'POST', url: '/api/extensions/v1/grants',
      headers: { authorization: 'Bearer t' },
      payload: { installation_id: INSTALLATION, services: ['memory.manage'] },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.provider_public_origin).toBe('https://memory.example')
    const verified = verifyCapabilityGrant(keys.publicKeyPem, body.grant, ISSUER)
    expect(verified!.services).toEqual(['memory.manage'])
  })

  test('the provider origin comes only from operator config, never unconfigured', async () => {
    const app = track(makeApp())
    const response = await app.inject({
      method: 'POST', url: '/api/extensions/v1/grants',
      headers: { authorization: 'Bearer t' },
      payload: { installation_id: INSTALLATION },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().provider_public_origin).toBeUndefined()
  })

  test('a foreign session id is a 404', async () => {
    const app = track(makeApp({}, {}, false))
    const response = await app.inject({
      method: 'POST', url: '/api/extensions/v1/grants',
      headers: { authorization: 'Bearer t' },
      payload: { installation_id: INSTALLATION, session_id: 'someone-elses' },
    })
    expect(response.statusCode).toBe(404)
  })
})
