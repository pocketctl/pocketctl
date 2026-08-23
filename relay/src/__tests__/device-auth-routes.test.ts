import { beforeAll, describe, expect, test, vi } from 'vitest'
import { createDeviceAuthSessionStore, DeviceAuthStoreCapacityError } from '../config/auth-sessions.js'

let handleDeviceAuthorizeRequest: (req: any, reply: any, deps: any) => Promise<any>
let handleDeviceTokenRequest: (req: any, reply: any, deps: any) => Promise<any>

beforeAll(async () => {
  vi.stubEnv('JWT_SECRET', 'device-auth-routes-test-secret')
  const server = await import('../server.js')
  handleDeviceAuthorizeRequest = server.handleDeviceAuthorizeRequest
  handleDeviceTokenRequest = server.handleDeviceTokenRequest
})

class FakeReply {
  statusCode = 200
  headers: Record<string, unknown> = {}
  code(c: number) { this.statusCode = c; return this }
  header(n: string, v: unknown) { this.headers[n] = v; return this }
}

function makeAuthorizeDeps(store = createDeviceAuthSessionStore(undefined, () => 1_000)) {
  return {
    store,
    validateClient: (clientId: string) =>
      clientId === 'pocketctl-cli'
        ? { client_id: 'pocketctl-cli', token_endpoint_auth_method: 'none' as const }
        : null,
    webAppUrl: 'https://www.example.test',
    relayPort: 8080,
    hostname: 'www.example.test',
  }
}

function makeTokenDeps(store = createDeviceAuthSessionStore(undefined, () => Date.now())) {
  return {
    store,
    validateClient: (clientId: string) =>
      ['pocketctl-cli', 'pocketctl-web', 'pocketctl-ios'].includes(clientId)
        ? { client_id: clientId, token_endpoint_auth_method: 'none' as const }
        : null,
    getUserById: vi.fn(async () => ({ id: 7, email: 'u@example.test', phone: null })),
    signAccessToken: vi.fn(async () => 'access-token'),
    signRefreshToken: vi.fn(async () => 'refresh-token'),
    insertAuditLog: vi.fn(async () => {}),
    setRefreshCookie: vi.fn(),
    canonicalIp: () => '203.0.113.10',
    rejectIfRateLimited: vi.fn(async () => false),
  }
}

describe('POST /api/auth/device/authorize (M-2/M-3 wiring)', () => {
  test('returns device_code, user_code, verification URIs and interval', async () => {
    const reply = new FakeReply()
    const body = await handleDeviceAuthorizeRequest(
      { body: { client_id: 'pocketctl-cli', code_challenge: 'cc' } } as never,
      reply as never,
      makeAuthorizeDeps(),
    )
    expect(reply.statusCode).toBe(200)
    expect(body.device_code).toBeTruthy()
    expect(body.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    expect(body.verification_uri).toBe('https://www.example.test/login/cli')
    expect(body.interval).toBe(5)
  })

  test('store capacity exhaustion answers 503 with Retry-After and no occupancy numbers', async () => {
    const deps = makeAuthorizeDeps(
      createDeviceAuthSessionStore({ maxSessions: 1 }, () => 1_000),
    )
    const first = await handleDeviceAuthorizeRequest(
      { body: { client_id: 'pocketctl-cli', code_challenge: 'cc' } } as never,
      new FakeReply() as never,
      deps,
    )
    const reply = new FakeReply()
    const body = await handleDeviceAuthorizeRequest(
      { body: { client_id: 'pocketctl-cli', code_challenge: 'cc2' } } as never,
      reply as never,
      deps,
    )
    expect(reply.statusCode).toBe(503)
    expect(reply.headers['Retry-After']).toBeGreaterThan(0)
    expect(JSON.stringify(body)).not.toContain(String(1))
    expect(JSON.stringify(body)).not.toMatch(/\d{2,}/)
    expect(first.device_code).toBeTruthy()
  })
})

describe('POST /api/auth/device/token (RFC 8628 polling contract)', () => {
  test('too-fast polling returns slow_down and the enforced interval grows by 5s', async () => {
    let now = 10_000
    const store = createDeviceAuthSessionStore(undefined, () => now)
    const deps = makeTokenDeps(store)
    const created = store.create('pocketctl-cli', 'cc', undefined)

    const first = await handleDeviceTokenRequest(
      { body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: created.device_code, client_id: 'pocketctl-cli' }, ip: '203.0.113.10' } as never,
      new FakeReply() as never,
      deps,
    )
    expect(first).toMatchObject({ error: 'authorization_pending' })

    now += 1_000
    const tooFast = await handleDeviceTokenRequest(
      { body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: created.device_code, client_id: 'pocketctl-cli' }, ip: '203.0.113.10' } as never,
      new FakeReply() as never,
      deps,
    )
    expect(tooFast.error).toBe('slow_down')
    expect(tooFast.interval).toBe(10)

    // Within the original 5s but before the enlarged 10s interval → still slow_down.
    now += 5_000
    const stillTooFast = await handleDeviceTokenRequest(
      { body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: created.device_code, client_id: 'pocketctl-cli' }, ip: '203.0.113.10' } as never,
      new FakeReply() as never,
      deps,
    )
    expect(stillTooFast.error).toBe('slow_down')
  })

  test('client_id mismatch is rejected as invalid_grant', async () => {
    const store = createDeviceAuthSessionStore(undefined, () => 10_000)
    const deps = makeTokenDeps(store)
    const created = store.create('pocketctl-cli', 'cc', undefined)
    store.authorize(created.user_code, 7)
    const reply = new FakeReply()
    // A different but registered client must not consume another client's code.
    const body = await handleDeviceTokenRequest(
      { body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: created.device_code, client_id: 'pocketctl-web', code_verifier: 'v' }, ip: '203.0.113.10' } as never,
      reply as never,
      deps,
    )
    expect(reply.statusCode).toBe(400)
    expect(body.error).toBe('invalid_grant')
    expect(deps.signAccessToken).not.toHaveBeenCalled()
    // The session survives a mismatched-client probe.
    expect(store.getByDeviceCode(created.device_code)).toBeDefined()
  })

  test('successful exchange verifies PKCE, issues tokens and consumes the session', async () => {
    const store = createDeviceAuthSessionStore(undefined, () => 10_000)
    const deps = makeTokenDeps(store)
    const codeVerifier = 'verifier-1234567890abcdef'
    const challenge = Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier)),
    ).toString('base64url')
    const created = store.create('pocketctl-cli', challenge, 'machine-1')
    store.authorize(created.user_code, 7)
    const reply = new FakeReply()
    const body = await handleDeviceTokenRequest(
      { body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: created.device_code, client_id: 'pocketctl-cli', code_verifier: codeVerifier }, ip: '203.0.113.10' } as never,
      reply as never,
      deps,
    )
    expect(reply.statusCode).toBe(200)
    expect(body.access_token).toBe('access-token')
    expect(deps.setRefreshCookie).toHaveBeenCalled()
    expect(store.getByDeviceCode(created.device_code)).toBeUndefined()
    expect(store.userCodeIndexSize()).toBe(store.size())
  })

  test('unknown device code answers expired_token without retaining polling state', async () => {
    const store = createDeviceAuthSessionStore(undefined, () => 10_000)
    const deps = makeTokenDeps(store)
    const reply = new FakeReply()
    const body = await handleDeviceTokenRequest(
      { body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'no-such-code', client_id: 'pocketctl-cli' }, ip: '203.0.113.10' } as never,
      reply as never,
      deps,
    )
    expect(body.error).toBe('expired_token')
    expect(store.size()).toBe(0)
  })
})
