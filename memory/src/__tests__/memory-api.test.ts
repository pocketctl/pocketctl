import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { GrantGuard } from '../auth/grant-guard.js'
import { MemoryApiError } from '../api/errors.js'
import { createCorsHostPolicy } from '../auth/cors-host-policy.js'
import { registerReadRoutes } from '../api/read-routes.js'
import { registerManageRoutes } from '../api/manage-routes.js'

const INSTALLATION = '11111111-1111-4111-8111-111111111111'

function fakePool() {
  return {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  } as never
}

function fakeGuard(mode: 'ok' | 'reject' | 'wrong-service') {
  const seen: string[] = []
  const guard: GrantGuard = {
    guard: vi.fn(async (input: { requiredService: string }) => {
      seen.push(input.requiredService)
      if (mode === 'reject') throw new MemoryApiError('unauthorized', 'grant rejected')
      if (mode === 'wrong-service' && input.requiredService === 'memory.manage') {
        throw new MemoryApiError('unauthorized', 'grant rejected')
      }
      return { installationId: INSTALLATION, services: [input.requiredService], configVersion: '1' }
    }),
  } as never
  return { guard, seen }
}

function policy() {
  return createCorsHostPolicy({
    allowedOrigins: ['https://web.example'],
    allowedHosts: ['memory.example'],
    isProduction: false,
  })
}

function makeReadApp(mode: 'ok' | 'reject' | 'wrong-service' = 'ok') {
  const { guard, seen } = fakeGuard(mode)
  const app = Fastify()
  registerReadRoutes(app, {
    pool: fakePool(),
    guard,
    policy: policy(),
    recallEmbeddingTimeoutMs: 100,
    cursorSigningKey: 'test-cursor-signing-key',
  })
  return { app, seen }
}

function makeManageApp(options: { mode?: 'ok' | 'reject' | 'wrong-service'; limiter?: { check(): { allowed: boolean } } } = {}) {
  const { guard } = fakeGuard(options.mode ?? 'ok')
  const app = Fastify()
  registerManageRoutes(app, {
    pool: fakePool(),
    guard,
    policy: policy(),
    ...(options.limiter ? { rateLimiter: options.limiter } : {}),
    textConfigured: false,
    embeddingConfigured: false,
    tombstoneHmacKeys: [{ version: 'v1', key: 't'.repeat(32) }],
  })
  return app
}

function makeFullMemoryApp(mode: 'ok' | 'reject' | 'wrong-service' = 'ok') {
  const { guard, seen } = fakeGuard(mode)
  const app = Fastify()
  const shared = { pool: fakePool(), guard, policy: policy() }
  registerReadRoutes(app, {
    ...shared,
    recallEmbeddingTimeoutMs: 100,
    cursorSigningKey: 'test-cursor-signing-key',
  })
  registerManageRoutes(app, {
    ...shared,
    textConfigured: false,
    embeddingConfigured: false,
    tombstoneHmacKeys: [{ version: 'v1', key: 't'.repeat(32) }],
  })
  return { app, seen }
}

describe('memory api read routes', () => {
  const apps: Array<FastifyInstance> = []
  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()))
  })

  test('disallowed hosts fail closed', async () => {
    const { app } = makeReadApp()
    apps.push(app)
    const response = await app.inject({
      method: 'POST', url: '/api/v1/memory/search',
      headers: { host: 'evil.example', authorization: 'Bearer t' },
      payload: { query: 'x' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('forbidden')
  })

  test('disallowed origins fail closed; allowed origins pass the hook', async () => {
    const { app } = makeReadApp()
    apps.push(app)
    const rejected = await app.inject({
      method: 'POST', url: '/api/v1/memory/search',
      headers: { host: 'memory.example', origin: 'https://evil.example', authorization: 'Bearer t' },
      payload: { query: 'x' },
    })
    expect(rejected.statusCode).toBe(403)
  })

  test('CORS preflight answers without authorization', async () => {
    const { app } = makeReadApp()
    apps.push(app)
    const response = await app.inject({
      method: 'OPTIONS', url: '/api/v1/memory/search',
      headers: { host: 'memory.example', origin: 'https://web.example' },
    })
    expect(response.statusCode).toBeLessThan(400)
    expect(response.headers['access-control-allow-methods']).toContain('POST')
    expect(response.headers['access-control-allow-origin']).toBe('https://web.example')
  })

  test('each route demands its exact service from the grant guard', async () => {
    const { app, seen } = makeReadApp()
    apps.push(app)
    await app.inject({ method: 'POST', url: '/api/v1/memory/search', headers: { host: 'memory.example', authorization: 'Bearer t' }, payload: { query: 'vitest' } })
    await app.inject({ method: 'POST', url: '/api/v1/memory/recall', headers: { host: 'memory.example', authorization: 'Bearer t' }, payload: { query: 'vitest' } })
    await app.inject({ method: 'GET', url: '/api/v1/memory/claims', headers: { host: 'memory.example', authorization: 'Bearer t' } })
    await app.inject({ method: 'GET', url: '/api/v1/memory/claims/11111111-1111-4111-8111-111111111111', headers: { host: 'memory.example', authorization: 'Bearer t' } })
    await app.inject({ method: 'GET', url: '/api/v1/memory/evidence/11111111-1111-4111-8111-111111111111', headers: { host: 'memory.example', authorization: 'Bearer t' } })
    await app.inject({ method: 'GET', url: '/api/v1/memory/episodes', headers: { host: 'memory.example', authorization: 'Bearer t' } })
    await app.inject({ method: 'GET', url: '/api/v1/memory/repositories/11111111-1111-4111-8111-111111111111/context', headers: { host: 'memory.example', authorization: 'Bearer t' } })
    expect(seen).toEqual([
      'memory.search', 'memory.recall', 'memory.search', 'memory.search', 'memory.search',
      'memory.search', 'memory.recall',
    ])
  })

  test('rejected grants answer the one uniform envelope', async () => {
    const { app } = makeReadApp('reject')
    apps.push(app)
    const response = await app.inject({
      method: 'POST', url: '/api/v1/memory/search',
      headers: { host: 'memory.example', authorization: 'Bearer t' },
      payload: { query: 'vitest' },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: { code: 'unauthorized', message: 'grant rejected' } })
  })

  test('a shared-primary v2 grant cannot read implicitly without a scope selector', async () => {
    const pool = fakePool() as unknown as { query: ReturnType<typeof vi.fn> }
    const sharedGrant = {
      version: 'v2' as const,
      installationId: INSTALLATION,
      primaryInstallationId: INSTALLATION,
      services: ['memory.search'],
      configVersion: '1',
      callerType: 'web',
      scopeBindings: [{
        installation_id: INSTALLATION,
        owner_scope_kind: 'team' as const,
        owner_scope_id: '22222222-2222-4222-8222-222222222222',
        membership_id: '33333333-3333-4333-8333-333333333333',
        membership_revision: '1',
        authorization_epoch: '1',
        permissions: ['read'],
      }],
    }
    const app = Fastify()
    apps.push(app)
    registerReadRoutes(app, {
      pool: pool as never,
      guard: {
        guardMcp: vi.fn(async () => sharedGrant),
        guardV2: vi.fn(async () => sharedGrant),
      } as never,
      policy: policy(),
      recallEmbeddingTimeoutMs: 100,
      cursorSigningKey: 'test-cursor-signing-key',
      sharedScopesEnabled: true,
    })

    const response = await app.inject({
      method: 'POST', url: '/api/v1/memory/search',
      headers: { host: 'memory.example', authorization: 'Bearer v2' },
      payload: { query: 'implicit shared read' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('invalid_request')
    expect(pool.query).not.toHaveBeenCalled()
  })

  test('rejected grants win over malformed bodies and resource ids', async () => {
    const { app } = makeReadApp('reject')
    apps.push(app)
    const headers = { host: 'memory.example', authorization: 'Bearer bad' }
    const malformedBody = await app.inject({
      method: 'POST', url: '/api/v1/memory/search', headers, payload: { query: '' },
    })
    const malformedId = await app.inject({
      method: 'GET', url: '/api/v1/memory/claims/not-a-uuid', headers,
    })
    expect(malformedBody.statusCode).toBe(401)
    expect(malformedId.statusCode).toBe(401)
    expect(malformedBody.json().error.code).toBe('unauthorized')
    expect(malformedId.json().error.code).toBe('unauthorized')
  })

  test('rejected grants win before JSON parsing and body-size enforcement', async () => {
    const { app } = makeReadApp('reject')
    apps.push(app)
    const headers = {
      host: 'memory.example', authorization: 'Bearer bad',
      'content-type': 'application/json',
    }
    const malformedJson = await app.inject({
      method: 'POST', url: '/api/v1/memory/search', headers, payload: '{',
    })
    const oversized = await app.inject({
      method: 'POST', url: '/api/v1/memory/search', headers,
      payload: JSON.stringify({ query: 'x'.repeat(20_000) }),
    })
    for (const response of [malformedJson, oversized]) {
      expect(response.statusCode).toBe(401)
      expect(response.json().error.code).toBe('unauthorized')
    }
  })

  test('search bodies are strictly bounded', async () => {
    const { app } = makeReadApp()
    apps.push(app)
    for (const body of [
      {}, { query: '' }, { query: 'x'.repeat(2001) }, { query: 'x', limit: 21 },
      { query: 'x', claim_types: [] }, { query: 'x', branch: 'x'.repeat(256) },
    ]) {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/memory/search',
        headers: { host: 'memory.example', authorization: 'Bearer t' },
        payload: body,
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().error.code).toBe('invalid_request')
    }
  })

  test('resource ids and episode queries are rejected before SQL', async () => {
    const { app } = makeReadApp()
    apps.push(app)
    const headers = { host: 'memory.example', authorization: 'Bearer t' }
    for (const url of [
      '/api/v1/memory/claims?limit=0',
      '/api/v1/memory/claims?limit=101',
      '/api/v1/memory/claims?state=revoked',
      '/api/v1/memory/claims?cursor=bad',
      '/api/v1/memory/claims/not-a-uuid',
      '/api/v1/memory/claims/11111111-1111-4111-8111-111111111111?version_limit=21',
      '/api/v1/memory/claims/11111111-1111-4111-8111-111111111111?version_cursor=bad',
      '/api/v1/memory/evidence/not-a-uuid',
      '/api/v1/memory/versions/not-a-uuid/evidence',
      '/api/v1/memory/repositories/not-a-uuid/context',
      '/api/v1/memory/episodes?limit=1.5',
      '/api/v1/memory/episodes?limit=101',
      `/api/v1/memory/episodes?session_id=${'x'.repeat(513)}`,
    ]) {
      const response = await app.inject({ method: 'GET', url, headers })
      expect(response.statusCode).toBe(400)
      expect(response.json().error.code).toBe('invalid_request')
    }
  })
})

describe('memory api manage routes', () => {
  const apps: Array<FastifyInstance> = []
  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()))
  })

  test('management preflight remains unauthenticated when read and manage routes share an app', async () => {
    const { app, seen } = makeFullMemoryApp('reject')
    apps.push(app)
    const response = await app.inject({
      method: 'OPTIONS', url: '/api/v1/memory/candidates',
      headers: { host: 'memory.example', origin: 'https://web.example' },
    })
    expect(response.statusCode).toBeLessThan(400)
    expect(response.headers['access-control-allow-methods']).toContain('GET')
    expect(response.headers['access-control-allow-headers']).toContain('authorization')
    expect(seen).toEqual([])
  })

  test('mutations refuse to run without an Idempotency-Key', async () => {
    const app = makeManageApp()
    apps.push(app)
    const response = await app.inject({
      method: 'POST', url: `/api/v1/memory/candidates/11111111-1111-4111-8111-111111111111/accept`,
      headers: { host: 'memory.example', authorization: 'Bearer t' },
      payload: { expected_revision: 1 },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('invalid_request')
  })

  test('manage authorization runs before mutation path/body validation', async () => {
    const app = makeManageApp({ mode: 'wrong-service' })
    apps.push(app)
    const response = await app.inject({
      method: 'POST', url: '/api/v1/memory/candidates/not-a-uuid/accept',
      headers: { host: 'memory.example', authorization: 'Bearer wrong', 'idempotency-key': 'k' },
      payload: { expected_revision: 0 },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe('unauthorized')
  })

  test('a wrong-service grant never reaches management handlers', async () => {
    const app = makeManageApp({ mode: 'wrong-service' })
    apps.push(app)
    const response = await app.inject({
      method: 'GET', url: '/api/v1/memory/candidates',
      headers: { host: 'memory.example', authorization: 'Bearer t' },
    })
    expect(response.statusCode).toBe(401)
  })

  test('rate limiting answers 429 with the bounded envelope', async () => {
    let calls = 0
    const app = makeManageApp({
      limiter: { check: () => { calls++; return { allowed: calls <= 2 } } },
    })
    apps.push(app)
    const headers = { host: 'memory.example', authorization: 'Bearer t' }
    for (let i = 0; i < 3; i++) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/memory/candidates', headers })
      if (i < 2) expect(response.statusCode).toBeLessThan(500)
      else expect(response.statusCode).toBe(429)
    }
    const limited = await app.inject({
      method: 'GET', url: '/api/v1/memory/settings', headers,
    })
    expect(limited.statusCode).toBe(429)
    expect(limited.json().error.code).toBe('rate_limited')
  })

  test('settings report adapter readiness explicitly', async () => {
    const app = makeManageApp()
    apps.push(app)
    const response = await app.inject({
      method: 'GET', url: '/api/v1/memory/settings',
      headers: { host: 'memory.example', authorization: 'Bearer t' },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body).toMatchObject({ extraction_ready: false, embedding_ready: false })
  })

  test('candidate list limits are strictly validated before SQL', async () => {
    const app = makeManageApp()
    apps.push(app)
    for (const limit of ['banana', '0', '101', '1.5']) {
      const response = await app.inject({
        method: 'GET', url: `/api/v1/memory/candidates?limit=${limit}`,
        headers: { host: 'memory.example', authorization: 'Bearer t' },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().error.code).toBe('invalid_request')
    }
  })

  test('correction evidence uses a strict discriminated shape', async () => {
    const app = makeManageApp()
    apps.push(app)
    const base = {
      expected_revision: 1,
      statement: 'corrected',
      evidence: [{
        evidence_kind: 'event',
        episode_id: '11111111-1111-4111-8111-111111111111',
        excerpt: 'x',
        occurred_at: '2026-08-25T00:00:00Z',
      }],
    }
    const response = await app.inject({
      method: 'POST', url: '/api/v1/memory/claims/11111111-1111-4111-8111-111111111111/correct',
      headers: {
        host: 'memory.example', authorization: 'Bearer t', 'idempotency-key': 'strict-evidence',
      },
      payload: base,
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('invalid_request')
  })

  test('mutation resource ids are rejected before the idempotency transaction', async () => {
    const app = makeManageApp()
    apps.push(app)
    const response = await app.inject({
      method: 'POST', url: '/api/v1/memory/candidates/not-a-uuid/accept',
      headers: {
        host: 'memory.example', authorization: 'Bearer t', 'idempotency-key': 'bad-path-id',
      },
      payload: { expected_revision: 1 },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('invalid_request')
  })
})
