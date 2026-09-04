import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { signProviderExtensionToken } from '../extensions/provider-auth.js'
import type { UsageRouteDeps } from '../extensions/usage-routes.js'

const { registerUsageRoutes } = await import('../extensions/usage-routes.js')

const PROVIDER_SECRET = 'provider-secret-0123456789abcdef'
const ISSUER = 'https://relay.example.test'
const INSTALLATION = '11111111-1111-1111-1111-111111111111'

function providerToken() {
  return signProviderExtensionToken({
    providerId: 'pocketctl-memory', credentialId: 'c', secret: PROVIDER_SECRET, issuer: ISSUER,
  })
}

function makeApp(deps: Partial<UsageRouteDeps> = {}, rowCount = 2) {
  const app = Fastify()
  registerUsageRoutes(app, {
    pool: { query: vi.fn(async () => ({ rows: [], rowCount })) } as never,
    mode: 'enabled',
    providerJwtSecret: PROVIDER_SECRET,
    issuer: ISSUER,
    verifyAccessToken: vi.fn(async () => ({ userId: 42 })),
    ...deps,
  } as UsageRouteDeps)
  return app
}

function fact(overrides: Record<string, unknown> = {}) {
  return {
    usage_id: 'u-1',
    operation: 'recall',
    model: 'gpt-test',
    input_tokens: 10,
    output_tokens: 5,
    embedding_tokens: 0,
    cached_tokens: 0,
    cost_micros: 100,
    occurred_at: new Date(Date.now() - 1000).toISOString(),
    ...overrides,
  }
}

describe('extension usage routes', () => {
  const apps: Array<FastifyInstance> = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()))
  })

  function track(app: FastifyInstance) {
    apps.push(app)
    return app
  }

  test('ingests an idempotent batch', async () => {
    const app = track(makeApp())
    const response = await app.inject({
      method: 'POST', url: '/api/extensions/v1/usage/batch',
      headers: { authorization: `Bearer ${providerToken()}` },
      payload: { installation_id: INSTALLATION, facts: [fact(), fact({ usage_id: 'u-2', operation: 'embedding' })] },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().ingested).toBe(2)
  })

  test('rejects operations outside the allowlist', async () => {
    const app = track(makeApp())
    const response = await app.inject({
      method: 'POST', url: '/api/extensions/v1/usage/batch',
      headers: { authorization: `Bearer ${providerToken()}` },
      payload: { installation_id: INSTALLATION, facts: [fact({ operation: 'side_effect' })] },
    })
    expect(response.statusCode).toBe(400)
  })

  test('rejects negative counters, future timestamps and duplicates', async () => {
    const app = track(makeApp())
    const negative = await app.inject({
      method: 'POST', url: '/api/extensions/v1/usage/batch',
      headers: { authorization: `Bearer ${providerToken()}` },
      payload: { installation_id: INSTALLATION, facts: [fact({ input_tokens: -5 })] },
    })
    expect(negative.statusCode).toBe(400)
    const future = await app.inject({
      method: 'POST', url: '/api/extensions/v1/usage/batch',
      headers: { authorization: `Bearer ${providerToken()}` },
      payload: { installation_id: INSTALLATION, facts: [fact({ occurred_at: new Date(Date.now() + 3600_000).toISOString() })] },
    })
    expect(future.statusCode).toBe(400)
    const duplicate = await app.inject({
      method: 'POST', url: '/api/extensions/v1/usage/batch',
      headers: { authorization: `Bearer ${providerToken()}` },
      payload: { installation_id: INSTALLATION, facts: [fact(), fact()] },
    })
    expect(duplicate.statusCode).toBe(400)
  })

  test('bounds the batch size', async () => {
    const app = track(makeApp())
    const facts = Array.from({ length: 101 }, (_, index) => fact({ usage_id: `u-${index}` }))
    const response = await app.inject({
      method: 'POST', url: '/api/extensions/v1/usage/batch',
      headers: { authorization: `Bearer ${providerToken()}` },
      payload: { installation_id: INSTALLATION, facts },
    })
    expect(response.statusCode).toBe(400)
  })

  test('a foreign installation maps to 404', async () => {
    const app = track(makeApp({}, 0))
    const response = await app.inject({
      method: 'POST', url: '/api/extensions/v1/usage/batch',
      headers: { authorization: `Bearer ${providerToken()}` },
      payload: { installation_id: INSTALLATION, facts: [fact()] },
    })
    expect(response.statusCode).toBe(404)
  })

  test('user summary aggregates without row content', async () => {
    const app = track(makeApp({
      pool: {
        query: vi.fn(async () => ({
          rows: [{
            installation_id: INSTALLATION, provider_id: 'pocketctl-memory',
            operation: 'recall', input_tokens: '10', output_tokens: '5',
            embedding_tokens: '0', cached_tokens: '0', cost_micros: '100', facts: '1',
          }],
        })),
      } as never,
    }))
    const response = await app.inject({
      method: 'GET', url: '/api/extensions/v1/usage',
      headers: { authorization: 'Bearer user-token' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().usage.length).toBe(1)
    expect(response.json().usage[0].operation).toBe('recall')
  })
})
