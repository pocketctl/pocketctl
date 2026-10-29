import Fastify from 'fastify'
import { expect, test } from 'vitest'
import { registerContextRoutes, type ContextRouteDeps } from '../api/context-routes.js'
import { MemoryApiError } from '../api/errors.js'

// Regression: the API currently runs with Fastify logging disabled and its
// global bounded handler hides the server-side error type as well as the body.
test('an unexpected governance failure retains SQLSTATE without leaking request or database text', async () => {
  const lines: string[] = []
  const app = Fastify({ logger: false })
  registerContextRoutes(app, { unexpectedErrorSink: (line: string) => lines.push(line) } as unknown as ContextRouteDeps)
  app.post('/api/v1/memory/governance/proposals/:privateId', async () => {
    throw Object.assign(new Error('secret-password secret-query private-statement'), {
      code: '40P01', detail: 'private-database-detail', table: 'private-table',
    })
  })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/memory/governance/proposals/private-resource?grant=private-token',
      headers: { authorization: 'Bearer private-authorization' }, payload: { statement: 'private-statement' } })
    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({ error: { code: 'internal', message: 'internal error' } })
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'api_unexpected_error', surface: 'governance', error_class: 'database_error', database_code: '40P01' })
    expect(lines.join(' ')).not.toMatch(/private-|secret-|password|authorization|statement|table/)
  } finally { await app.close() }
})

test('unrecognized error names and codes cannot become diagnostic content', async () => {
  const lines: string[] = []
  const app = Fastify({ logger: false })
  registerContextRoutes(app, { unexpectedErrorSink: (line: string) => lines.push(line) } as unknown as ContextRouteDeps)
  app.get('/api/v1/memory/context/private-test', async () => {
    throw Object.assign(new TypeError('private-message'), { name: 'private-error-name', code: 'private-token-code' })
  })
  try {
    expect((await app.inject('/api/v1/memory/context/private-test')).statusCode).toBe(500)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ surface: 'context', error_class: 'type_error', database_code: null })
    expect(lines.join(' ')).not.toContain('private')
  } finally { await app.close() }
})

test('expected client errors retain their bounded response without unexpected-error noise', async () => {
  const lines: string[] = []
  const app = Fastify({ logger: false })
  registerContextRoutes(app, { unexpectedErrorSink: (line: string) => lines.push(line) } as unknown as ContextRouteDeps)
  app.get('/api/v1/memory/context/private-test', async () => { throw new MemoryApiError('forbidden', 'forbidden') })
  try {
    expect((await app.inject('/api/v1/memory/context/private-test')).statusCode).toBe(403)
    expect(lines).toEqual([])
  } finally { await app.close() }
})
