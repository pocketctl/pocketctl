import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, test, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import {
  authenticateProviderCredentials,
  createProviderCredential,
  PROVIDER_TOKEN_AUDIENCE,
  secretFingerprint,
  signProviderExtensionToken,
  verifyProviderExtensionToken,
} from '../extensions/provider-auth.js'
import type { ProviderTokenRouteDeps } from '../extensions/provider-auth-routes.js'

const { registerProviderTokenRoute } = await import('../extensions/provider-auth-routes.js') as {
  registerProviderTokenRoute(app: FastifyInstance, deps: ProviderTokenRouteDeps): void
}

const PROVIDER_SECRET = 'p'.repeat(48)
const USER_JWT_SECRET = 'user-jwt-secret-0123456789abcdef'

describe('provider extension token crypto', () => {
  test('signs HS256 tokens with the frozen audience and token_type', () => {
    const token = signProviderExtensionToken({
      providerId: 'pocketctl-memory',
      credentialId: 'cred-1',
      secret: PROVIDER_SECRET,
      issuer: 'https://relay.example.test',
    })
    const decoded = jwt.decode(token) as Record<string, unknown>
    expect(decoded.aud).toBe(PROVIDER_TOKEN_AUDIENCE)
    expect(decoded.token_type).toBe('extension_provider')
    expect(decoded.sub).toBe('provider:pocketctl-memory')
    expect(decoded.provider_id).toBe('pocketctl-memory')
    expect(decoded.credential_id).toBe('cred-1')
    expect(typeof decoded.jti).toBe('string')
    // TTL stays within the 15-minute ceiling.
    expect(Number(decoded.exp) - Number(decoded.iat)).toBeLessThanOrEqual(900)

    const verified = verifyProviderExtensionToken(token, {
      secret: PROVIDER_SECRET,
      issuer: 'https://relay.example.test',
    })
    expect(verified?.providerId).toBe('pocketctl-memory')

    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString())
    expect(header.alg).toBe('HS256')
  })

  test('verification pins HS256 and rejects foreign secrets and token types', () => {
    const token = signProviderExtensionToken({
      providerId: 'pocketctl-memory',
      credentialId: 'cred-1',
      secret: PROVIDER_SECRET,
      issuer: 'https://relay.example.test',
    })
    // Signed with the normal user JWT secret must not verify.
    expect(verifyProviderExtensionToken(token, {
      secret: USER_JWT_SECRET,
      issuer: 'https://relay.example.test',
    })).toBeNull()
    // alg=none is rejected.
    const unsigned = `${token.split('.').slice(0, 2).join('.')}.`
    expect(verifyProviderExtensionToken(unsigned, {
      secret: PROVIDER_SECRET,
      issuer: 'https://relay.example.test',
    })).toBeNull()
    // A normal user access token never verifies as a provider token.
    const accessToken = jwt.sign(
      { userId: 1, type: 'access' }, USER_JWT_SECRET, { expiresIn: '15m' },
    )
    expect(verifyProviderExtensionToken(accessToken, {
      secret: PROVIDER_SECRET,
      issuer: 'https://relay.example.test',
    })).toBeNull()
    // Wrong audience / issuer fail closed.
    const wrongAud = jwt.sign(
      { sub: 'provider:pocketctl-memory', token_type: 'extension_provider' },
      PROVIDER_SECRET, { algorithm: 'HS256', audience: 'something-else', expiresIn: '5m' },
    )
    expect(verifyProviderExtensionToken(wrongAud, {
      secret: PROVIDER_SECRET,
      issuer: 'https://relay.example.test',
    })).toBeNull()
  })

  test('expired tokens fail closed', () => {
    const expired = jwt.sign(
      {
        sub: 'provider:pocketctl-memory', token_type: 'extension_provider',
        provider_id: 'pocketctl-memory', credential_id: 'c',
      },
      PROVIDER_SECRET,
      { algorithm: 'HS256', audience: PROVIDER_TOKEN_AUDIENCE, expiresIn: -60 },
    )
    expect(verifyProviderExtensionToken(expired, {
      secret: PROVIDER_SECRET, issuer: 'https://relay.example.test',
    })).toBeNull()
  })
})

describe('provider credential creation and authentication', () => {
  function credentialRow(overrides: Record<string, unknown> = {}) {
    return {
      credential_id: 'cred-1',
      provider_id: 'pocketctl-memory',
      client_id: 'client-1',
      secret_digest: 'digest',
      status: 'active',
      expires_at: null,
      provider_status: 'enabled',
      ...overrides,
    }
  }

  test('createProviderCredential stores a bcrypt digest and a stable fingerprint', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 })
    const credential = await createProviderCredential({ query } as never, {
      providerId: 'pocketctl-memory',
      secret: 'S'.repeat(64),
      clientId: 'client-9',
    })
    expect(credential.clientId).toBe('client-9')
    expect(credential.clientSecret).toBe('S'.repeat(64))
    const params = query.mock.calls[0][1] as unknown[]
    const digest = String(params[3])
    // bcrypt digests carry their own prefix; the plaintext never reaches SQL.
    expect(digest).toMatch(/^\$2[aby]\$/)
    expect(digest).not.toContain('S'.repeat(8))
    expect(secretFingerprint('S'.repeat(64))).toHaveLength(16)
  })

  test('authentication compares digests and treats every failure identically', async () => {
    const digest = await import('bcryptjs').then(bcrypt =>
      bcrypt.hashSync('correct-secret', 10),
    )
    const query = vi.fn(async (sql: string) => {
      if (/FROM extension_provider_credentials/.test(sql)) {
        return { rows: [credentialRow({ secret_digest: digest })] }
      }
      return { rows: [], rowCount: 0 }
    })
    const ok = await authenticateProviderCredentials({ query } as never, {
      providerId: 'pocketctl-memory',
      clientId: 'client-1',
      clientSecret: 'correct-secret',
    })
    expect(ok).toEqual(expect.objectContaining({
      providerId: 'pocketctl-memory', credentialId: 'cred-1',
    }))
    expect(typeof ok?.tokenJti).toBe('string')

    const badSecret = await authenticateProviderCredentials({ query } as never, {
      providerId: 'pocketctl-memory', clientId: 'client-1', clientSecret: 'wrong',
    })
    expect(badSecret).toBeNull()

    const revoked = vi.fn(async (sql: string) => {
      if (/FROM extension_provider_credentials/.test(sql)) {
        return { rows: [credentialRow({ status: 'revoked' })] }
      }
      return { rows: [], rowCount: 0 }
    })
    expect(await authenticateProviderCredentials({ query: revoked } as never, {
      providerId: 'pocketctl-memory', clientId: 'client-1', clientSecret: 'correct-secret',
    })).toBeNull()

    const disabled = vi.fn(async (sql: string) => {
      if (/FROM extension_provider_credentials/.test(sql)) {
        return { rows: [credentialRow({ provider_status: 'disabled' })] }
      }
      return { rows: [], rowCount: 0 }
    })
    expect(await authenticateProviderCredentials({ query: disabled } as never, {
      providerId: 'pocketctl-memory', clientId: 'client-1', clientSecret: 'correct-secret',
    })).toBeNull()

    const expired = vi.fn(async (sql: string) => {
      if (/FROM extension_provider_credentials/.test(sql)) {
        return { rows: [credentialRow({ expires_at: new Date(Date.now() - 1000) })] }
      }
      return { rows: [], rowCount: 0 }
    })
    expect(await authenticateProviderCredentials({ query: expired } as never, {
      providerId: 'pocketctl-memory', clientId: 'client-1', clientSecret: 'correct-secret',
    })).toBeNull()
  })
})

describe('provider token route', () => {
  const apps: Array<FastifyInstance> = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()))
  })

  function makeApp(deps: Partial<ProviderTokenRouteDeps> = {}) {
    const app = Fastify()
    apps.push(app)
    registerProviderTokenRoute(app, {
      pool: {} as never,
      mode: 'enabled',
      providerJwtSecret: PROVIDER_SECRET,
      issuer: 'https://relay.example.test',
      authenticate: vi.fn(async () => ({ providerId: 'pocketctl-memory', credentialId: 'cred-1' })),
      ...deps,
    } as ProviderTokenRouteDeps)
    return app
  }

  test('exchanges client credentials for a bounded extension token', async () => {
    const app = makeApp()
    const response = await app.inject({
      method: 'POST', url: '/api/extensions/v1/token',
      payload: { grant_type: 'client_credentials', client_id: 'client-1', client_secret: 's'.repeat(48) },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.token_type).toBe('extension_provider')
    expect(body.expires_in).toBeLessThanOrEqual(900)
    expect(verifyProviderExtensionToken(body.access_token, {
      secret: PROVIDER_SECRET, issuer: 'https://relay.example.test',
    })?.providerId).toBe('pocketctl-memory')
  })

  test('returns an identical 401 for unknown, revoked and malformed clients', async () => {
    const app = makeApp({
      authenticate: vi.fn(async () => null),
    })
    const cases = [
      { grant_type: 'client_credentials', client_id: 'unknown', client_secret: 'x'.repeat(48) },
      { grant_type: 'client_credentials', client_id: '', client_secret: 'x'.repeat(48) },
      { grant_type: 'password', client_id: 'client-1', client_secret: 'x'.repeat(48) },
    ]
    for (const payload of cases) {
      const response = await app.inject({
        method: 'POST', url: '/api/extensions/v1/token', payload,
      })
      expect(response.statusCode).toBe(401)
      expect(response.json().error.code).toBe('unauthorized')
    }
  })

  test('rate limits repeated token requests per client identity', async () => {
    let calls = 0
    const app = makeApp({
      rateLimiter: {
        check: vi.fn(() => {
          calls++
          return calls <= 2
            ? { allowed: true }
            : { allowed: false, retryAfterMs: 1000 }
        }),
      },
    })
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST', url: '/api/extensions/v1/token',
        payload: { grant_type: 'client_credentials', client_id: 'client-1', client_secret: 's'.repeat(48) },
      })
    }
    const limited = await app.inject({
      method: 'POST', url: '/api/extensions/v1/token',
      payload: { grant_type: 'client_credentials', client_id: 'client-1', client_secret: 's'.repeat(48) },
    })
    expect(limited.statusCode).toBe(429)
  })

  test('off and shadow modes refuse to mint provider tokens', async () => {
    for (const mode of ['off', 'shadow'] as const) {
      const authenticate = vi.fn()
      const app = makeApp({ mode, authenticate })
      const response = await app.inject({
        method: 'POST', url: '/api/extensions/v1/token',
        payload: { grant_type: 'client_credentials', client_id: 'client-1', client_secret: 's'.repeat(48) },
      })
      expect(response.statusCode).toBe(503)
      expect(response.json().error.code).toBe('feature_disabled')
      expect(authenticate).not.toHaveBeenCalled()
    }
  })

  test('bounds client_id length and body fields', async () => {
    const app = makeApp()
    const longId = await app.inject({
      method: 'POST', url: '/api/extensions/v1/token',
      payload: { grant_type: 'client_credentials', client_id: 'x'.repeat(129), client_secret: 's'.repeat(48) },
    })
    expect(longId.statusCode).toBe(401)
  })
})
