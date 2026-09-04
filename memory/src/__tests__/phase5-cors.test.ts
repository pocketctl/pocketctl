import Fastify from 'fastify'
import { describe, expect, test } from 'vitest'
import { registerSkillRoutes } from '../api/skill-routes.js'
import { registerReadRoutes } from '../api/read-routes.js'
import { createCorsHostPolicy } from '../auth/cors-host-policy.js'
import { MemoryApiError } from '../api/errors.js'
import { loadSkillConfig } from '../skills/config.js'

async function appFor(globalMode: 'enabled' | 'shadow') {
  const app = Fastify()
  const deps = {
    pool: { query: async () => { throw new Error('unexpected database access') } } as never,
    guard: { guardMcp: async () => { throw new MemoryApiError('unauthorized', 'grant rejected') } } as never,
    policy: createCorsHostPolicy({ allowedOrigins: ['https://web.example'], allowedHosts: ['memory.example'], isProduction: true }),
    context: { globalMode, sharedMode: 'shadow' as const, config: loadSkillConfig({ MEMORY_SKILL_MODE: 'shadow' }) },
    cursorSigningKey: 'cors-regression',
  }
  registerSkillRoutes(app, deps)
  if (globalMode === 'enabled') registerReadRoutes(app, { ...deps, recallEmbeddingTimeoutMs: 100 })
  await app.ready()
  return app
}

describe.each(['enabled', 'shadow'] as const)('Skill browser access with Memory %s', mode => {
  test.each(['GET', 'POST', 'PUT'])('allows authenticated %s preflight without a grant', async method => {
    const app = await appFor(mode)
    try {
      const response = await app.inject({ method: 'OPTIONS', url: '/api/v1/memory/skills/policy', headers: {
        host: 'memory.example', origin: 'https://web.example',
        'access-control-request-method': method, 'access-control-request-headers': 'authorization, content-type',
      } })
      expect(response.statusCode).toBe(200)
      expect(response.headers['access-control-allow-origin']).toBe('https://web.example')
      expect(response.headers['access-control-allow-methods']?.split(/,\s*/)).toContain(method)
      expect(response.headers['access-control-allow-headers']).toContain('authorization')
    } finally { await app.close() }
  })

  test('keeps allowed-origin authentication errors readable to the browser', async () => {
    const app = await appFor(mode)
    try {
      const response = await app.inject({ method: 'PUT', url: '/api/v1/memory/skills/policy',
        headers: { host: 'memory.example', origin: 'https://web.example', authorization: 'Bearer expired' }, payload: {} })
      expect(response.statusCode).toBe(401)
      expect(response.headers['access-control-allow-origin']).toBe('https://web.example')
    } finally { await app.close() }
  })

  test.each([
    { host: 'memory.example', origin: 'https://evil.example' },
    { host: 'evil.example', origin: 'https://web.example' },
  ])('rejects disallowed host/origin %j before authentication', async headers => {
    const app = await appFor(mode)
    try {
      for (const method of ['OPTIONS', 'GET'] as const) {
        const response = await app.inject({ method, url: '/api/v1/memory/skills/policy', headers })
        expect(response.statusCode).toBe(403)
        expect(response.headers['access-control-allow-origin']).toBeUndefined()
      }
    } finally { await app.close() }
  })
})
