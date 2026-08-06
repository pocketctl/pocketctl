import Fastify from 'fastify'
import jwt from 'jsonwebtoken'
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

const shareTestKey = 'share-test-key'

type ShareClaims = { userId: number; sessionId: string }
describe('temporary session share links', () => {
  const apps: Array<ReturnType<typeof Fastify>> = []
  let registerSessionShareRoutes: any
  let signSessionShareToken: (userId: number, sessionId: string) => string
  let verifySessionShareToken: (token: string) => ShareClaims | null

  beforeAll(async () => {
    vi.stubEnv('JWT_SECRET', shareTestKey)
    const auth = await import('../auth.js')
    const routes = await import('../session-share-routes.js')
    signSessionShareToken = auth.signSessionShareToken
    verifySessionShareToken = auth.verifySessionShareToken
    registerSessionShareRoutes = routes.registerSessionShareRoutes
  })

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
  })

  function makeApp(options: {
    owned?: (userId: number, sessionId: string) => boolean
    events?: any[]
    logger?: any
  } = {}) {
    const app = Fastify(options.logger)
    apps.push(app)
    registerSessionShareRoutes(app, {
      pool: {},
      publicIssuer: 'https://public.example',
      verifyAccessToken: vi.fn(async (token) => token === 'owner-access'
        ? { userId: 7 }
        : null),
      isSessionOwnedByUser: vi.fn(async (_pool, userId, sessionId) =>
        (options.owned ?? ((candidateUserId, candidateSessionId) =>
          candidateUserId === 7 && candidateSessionId === 'ses_1'))(userId, sessionId)),
      getSessionAllEvents: vi.fn(async () => options.events ?? [
        {
          id: 1,
          event_type: 'user_text',
          created_at: '2026-08-06T00:00:00.000Z',
          payload: { type: 'user_text', text: '<script>alert(1)</script>', marker: 'first-event' },
        },
        {
          id: 2,
          event_type: 'tool_result',
          created_at: '2026-08-06T00:00:01.000Z',
          payload: { type: 'tool_result', output: 'second-event' },
        },
      ]),
      signSessionShareToken,
      verifySessionShareToken,
    })
    return app
  }

  test('authenticated owner receives a 15-minute absolute URL from the configured public issuer', async () => {
    const app = makeApp()
    const before = Date.now()
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/ses_1/share-link',
      headers: {
        authorization: 'Bearer owner-access',
        host: 'attacker.invalid',
      },
    })
    const after = Date.now()

    expect(response.statusCode).toBe(200)
    const body = response.json<{ url: string; expires_at: string }>()
    expect(body.url).toMatch(/^https:\/\/public\.example\/share\/session\/[A-Za-z0-9._-]+$/)
    expect(body.url).not.toContain('attacker.invalid')
    const expiresAt = Date.parse(body.expires_at)
    expect(expiresAt).toBeGreaterThanOrEqual(before + 14 * 60_000 + 50_000)
    expect(expiresAt).toBeLessThanOrEqual(after + 15 * 60_000 + 10_000)
  })

  test('share-link creation rejects missing or invalid authentication and hides unowned sessions', async () => {
    const app = makeApp({ owned: () => false })
    const missing = await app.inject({ method: 'POST', url: '/api/sessions/ses_1/share-link' })
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/sessions/ses_1/share-link',
      headers: { authorization: 'Bearer invalid' },
    })
    const unowned = await app.inject({
      method: 'POST',
      url: '/api/sessions/ses_1/share-link',
      headers: { authorization: 'Bearer owner-access' },
    })

    expect(missing.statusCode).toBe(401)
    expect(invalid.statusCode).toBe(401)
    expect(unowned.statusCode).toBe(404)
  })

  test('public viewer renders every owned event as escaped, non-cacheable HTML', async () => {
    const app = makeApp()
    const token = signSessionShareToken(7, 'ses_1')
    const response = await app.inject({ method: 'GET', url: `/share/session/${token}` })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.headers['cache-control']).toBe('no-store, private')
    expect(response.headers.pragma).toBe('no-cache')
    expect(response.headers['referrer-policy']).toBe('no-referrer')
    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    )
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.body).toContain('first-event')
    expect(response.body).toContain('second-event')
    expect(response.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(response.body).not.toContain('<script>alert(1)</script>')
    expect(response.body).not.toMatch(/<script|<form|<iframe/i)
  })

  test('all invalid, expired, wrong-type, and mismatched share tokens return one generic unavailable page', async () => {
    const app = makeApp()
    const malformed = await app.inject({ method: 'GET', url: '/share/session/not-a-token' })
    const wrongTypeToken = jwt.sign(
      { type: 'access', userId: 7, email: 'owner@example.com' },
      shareTestKey,
      { expiresIn: '15m' },
    )
    const expiredToken = jwt.sign(
      { type: 'session_share', userId: 7, sessionId: 'ses_1' },
      shareTestKey,
      { expiresIn: -1 },
    )
    const mismatchToken = signSessionShareToken(8, 'ses_1')

    const responses = await Promise.all([
      app.inject({ method: 'GET', url: `/share/session/${wrongTypeToken}` }),
      app.inject({ method: 'GET', url: `/share/session/${expiredToken}` }),
      app.inject({ method: 'GET', url: `/share/session/${mismatchToken}` }),
    ])

    for (const response of [malformed, ...responses]) {
      expect(response.statusCode).toBe(404)
      expect(response.body).toBe(malformed.body)
      expect(response.body).not.toContain('ses_1')
      expect(response.body).not.toContain('first-event')
    }
  })

  test('share token verifier accepts only the dedicated exact claim shape', () => {
    const valid = signSessionShareToken(7, 'ses_1')
    const extraClaim = jwt.sign(
      { type: 'session_share', userId: 7, sessionId: 'ses_1', role: 'admin' },
      shareTestKey,
      { expiresIn: '15m' },
    )

    expect(verifySessionShareToken(valid)).toEqual({ userId: 7, sessionId: 'ses_1' })
    expect(verifySessionShareToken(extraClaim)).toBeNull()
    expect(verifySessionShareToken('invalid')).toBeNull()
  })

  test('public share route suppresses the bearer token from request logs', async () => {
    let logs = ''
    const app = makeApp({
      logger: {
        logger: {
          level: 'info',
          stream: { write: (message: string) => { logs += message } },
        },
      },
    })
    const token = signSessionShareToken(7, 'ses_1')
    await app.inject({ method: 'GET', url: `/share/session/${token}` })

    expect(logs).not.toContain(token)
  })

  test('production server registers the route with the resolved public issuer', () => {
    const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
    expect(source).toContain("import { registerSessionShareRoutes } from './session-share-routes.js'")
    expect(source).toContain('registerSessionShareRoutes(app, { pool, publicIssuer })')
  })
})
