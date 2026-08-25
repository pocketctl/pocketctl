import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { signProviderExtensionToken } from '../extensions/provider-auth.js'
import type { StatusRouteDeps } from '../extensions/status-routes.js'

const { registerStatusRoutes } = await import('../extensions/status-routes.js')

const PROVIDER_SECRET = 'provider-secret-0123456789abcdef'
const ISSUER = 'https://relay.example.test'
const INSTALLATION = '11111111-1111-1111-1111-111111111111'

function providerToken() {
  return signProviderExtensionToken({
    providerId: 'pocketctl-memory', credentialId: 'c', secret: PROVIDER_SECRET, issuer: ISSUER,
  })
}

function makeApp(deps: Partial<StatusRouteDeps> = {}) {
  const app = Fastify()
  registerStatusRoutes(app, {
    pool: { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) } as never,
    mode: 'enabled',
    providerJwtSecret: PROVIDER_SECRET,
    issuer: ISSUER,
    verifyAccessToken: vi.fn(async () => ({ userId: 42 })),
    ...deps,
  } as StatusRouteDeps)
  return app
}

describe('extension provider status routes', () => {
  const apps: Array<FastifyInstance> = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()))
  })

  function track(app: FastifyInstance) {
    apps.push(app)
    return app
  }

  const VALID = {
    installation_id: INSTALLATION,
    state: 'ready',
    provider_version: '1.0.0',
    last_feed_id: 100,
    feed_lag_seconds: 2,
    pending_jobs: 0,
    failed_jobs_24h: 0,
  }

  test('accepts an allowlisted status report', async () => {
    const app = track(makeApp())
    const response = await app.inject({
      method: 'POST', url: '/api/extensions/v1/status',
      headers: { authorization: `Bearer ${providerToken()}` },
      payload: VALID,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().state).toBe('ready')
  })

  test('rejects states outside the allowlist', async () => {
    const app = track(makeApp())
    const response = await app.inject({
      method: 'POST', url: '/api/extensions/v1/status',
      headers: { authorization: `Bearer ${providerToken()}` },
      payload: { ...VALID, state: 'offline' },
    })
    expect(response.statusCode).toBe(400)
  })

  test('never accepts free-text diagnostics', async () => {
    const app = track(makeApp())
    for (const forbidden of ['message', 'stack', 'prompt', 'error_message']) {
      const response = await app.inject({
        method: 'POST', url: '/api/extensions/v1/status',
        headers: { authorization: `Bearer ${providerToken()}` },
        payload: { ...VALID, [forbidden]: 'boom with user content' },
      })
      expect(response.statusCode).toBe(400)
    }
  })

  test('bounds string lengths and counter values', async () => {
    const app = track(makeApp())
    const longVersion = await app.inject({
      method: 'POST', url: '/api/extensions/v1/status',
      headers: { authorization: `Bearer ${providerToken()}` },
      payload: { ...VALID, provider_version: 'v'.repeat(65) },
    })
    expect(longVersion.statusCode).toBe(400)
    const negative = await app.inject({
      method: 'POST', url: '/api/extensions/v1/status',
      headers: { authorization: `Bearer ${providerToken()}` },
      payload: { ...VALID, pending_jobs: -1 },
    })
    expect(negative.statusCode).toBe(400)
  })

  test('a foreign installation maps to 404', async () => {
    const app = track(makeApp({
      pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as never,
    }))
    const response = await app.inject({
      method: 'POST', url: '/api/extensions/v1/status',
      headers: { authorization: `Bearer ${providerToken()}` },
      payload: VALID,
    })
    expect(response.statusCode).toBe(404)
  })

  test('user view derives offline from the heartbeat TTL', async () => {
    const app = track(makeApp({
      pool: {
        query: vi.fn(async () => ({
          rows: [{
            installation_id: INSTALLATION,
            provider_id: 'pocketctl-memory',
            installation_status: 'active',
            provider_version: '1.0.0',
            state: 'ready',
            reported_at: new Date(Date.now() - 3600_000).toISOString(),
          }],
        })),
      } as never,
      offlineAfterSeconds: 300,
    }))
    const response = await app.inject({
      method: 'GET', url: '/api/extensions/v1/status',
      headers: { authorization: 'Bearer user-token' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().installations[0].state).toBe('offline')
  })

  test('requires authentication on both surfaces', async () => {
    const app = track(makeApp())
    const provider = await app.inject({
      method: 'POST', url: '/api/extensions/v1/status', payload: VALID,
    })
    expect(provider.statusCode).toBe(401)
    const user = await app.inject({ method: 'GET', url: '/api/extensions/v1/status' })
    expect(user.statusCode).toBe(401)
  })
})
