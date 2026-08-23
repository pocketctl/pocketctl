import { beforeAll, describe, expect, test, vi } from 'vitest'
import jwt from 'jsonwebtoken'

let verifyTokenForRevocation: (token: string) => {
  type: 'access' | 'refresh'
  userId: number
  jti: string
  exp: number
} | null
let handleTokenRevocationRequest: (req: any, reply: any, deps: any) => Promise<any>

const signingMaterial = 'token-revocation-test-secret'

beforeAll(async () => {
  vi.stubEnv('JWT_SECRET', signingMaterial)
  const auth = await import('../auth.js')
  verifyTokenForRevocation = auth.verifyTokenForRevocation
  const server = await import('../server.js')
  handleTokenRevocationRequest = server.handleTokenRevocationRequest
})

function sign(claims: Record<string, unknown>, secret = signingMaterial): string {
  return jwt.sign(claims, secret, { expiresIn: '1h' })
}

describe('verifyTokenForRevocation (M-5)', () => {
  test('accepts structurally valid access and refresh tokens regardless of expiry', () => {
    const access = sign({ type: 'access', userId: 7, jti: 'jti-access-1', email: 'u@example.test', machine_id: 'm' })
    const refresh = sign({ type: 'refresh', userId: 7, jti: 'jti-refresh-1' })
    expect(verifyTokenForRevocation(access)).toMatchObject({ type: 'access', userId: 7, jti: 'jti-access-1' })
    expect(verifyTokenForRevocation(refresh)).toMatchObject({ type: 'refresh', userId: 7, jti: 'jti-refresh-1' })
  })

  test('accepts an already expired but correctly signed token', () => {
    const expired = jwt.sign({ type: 'access', userId: 7, jti: 'jti-expired' }, signingMaterial, { expiresIn: -60 })
    expect(verifyTokenForRevocation(expired)).toMatchObject({ type: 'access', userId: 7, jti: 'jti-expired' })
  })

  test('rejects unsigned (alg=none), wrong-signature and garbage tokens', () => {
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify({ type: 'access', userId: 7, jti: 'forged-jti-xx' })).toString('base64url')}.`
    expect(verifyTokenForRevocation(unsigned)).toBeNull()
    expect(verifyTokenForRevocation(sign({ type: 'access', userId: 7, jti: 'jti-attacker' }, 'wrong-secret'))).toBeNull()
    expect(verifyTokenForRevocation('not-a-jwt')).toBeNull()
    expect(verifyTokenForRevocation('')).toBeNull()
  })

  test('rejects unknown types, missing or malformed jti, invalid userId, missing exp/iat', () => {
    expect(verifyTokenForRevocation(sign({ type: 'session_share', userId: 7, jti: 'jti-share-1' }))).toBeNull()
    expect(verifyTokenForRevocation(sign({ type: 'access', userId: 7 }))).toBeNull() // no jti
    expect(verifyTokenForRevocation(sign({ type: 'access', userId: 7, jti: 'x' }))).toBeNull() // too short
    expect(verifyTokenForRevocation(sign({ type: 'access', userId: -1, jti: 'jti-valid-1' }))).toBeNull()
    expect(verifyTokenForRevocation(sign({ type: 'access', userId: '7', jti: 'jti-valid-2' }))).toBeNull()
    // No expiresIn → no exp claim → rejected even with a valid signature.
    expect(verifyTokenForRevocation(jwt.sign({ type: 'access', userId: 7, jti: 'jti-no-exp' }, signingMaterial))).toBeNull()
    expect(verifyTokenForRevocation(sign({ type: 'access', userId: 7, jti: 'jti-valid-3' }))).not.toBeNull()
  })

  test('an access token whose payload omits userId is rejected, not decoded for its jti', () => {
    const forged = sign({ type: 'access', jti: 'known-jti-from-victim' })
    expect(verifyTokenForRevocation(forged)).toBeNull()
  })
})

class FakeReply {
  statusCode = 200
  headers: Record<string, unknown> = {}
  code(c: number) { this.statusCode = c; return this }
  header(n: string, v: unknown) { this.headers[n] = v; return this }
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    pool: {},
    verifyCallerAccessToken: vi.fn(async () => ({ userId: 7, email: 'caller@example.test', jti: 'caller-jti', machine_id: 'web' })),
    verifyForRevocation: verifyTokenForRevocation,
    revokeToken: vi.fn(async (_pool: any, _jti: string, _userId: number, _reason: string, _options?: unknown) => undefined),
    insertAuditLog: vi.fn(async () => undefined),
    pepper: 'revocation-test-pepper-0123456789abcdef',
    rejectIfRateLimited: vi.fn(async () => false),
    ...overrides,
  }
}

function callerReq(token: string, hint?: string) {
  return {
    headers: { authorization: 'Bearer caller-token' },
    body: hint === undefined ? { token } : { token, token_type_hint: hint },
    ip: '203.0.113.10',
  }
}

describe('POST /api/auth/revoke (RFC 7009) (M-5)', () => {
  test('revokes the caller own valid access and refresh tokens with type and expiry', async () => {
    const deps = makeDeps()
    const reply = new FakeReply()
    const body = await handleTokenRevocationRequest(
      callerReq(sign({ type: 'access', userId: 7, jti: 'jti-own-access' } as never)) as never,
      reply as never,
      deps,
    )
    expect(reply.statusCode).toBe(200)
    expect(body).toEqual({})
    expect(deps.revokeToken).toHaveBeenCalledTimes(1)
    const call = deps.revokeToken.mock.calls[0] as unknown as [any, string, number, string, { tokenType: string; expiresAt: Date }]
    expect(call[1]).toBe('jti-own-access')
    expect(call[2]).toBe(7)
    expect(call[3]).toBe('user_revoke')
    expect(call[4].tokenType).toBe('access')
    expect(call[4].expiresAt.getTime()).toBeGreaterThan(Date.now() - 5_000)
  })

  test('a forged token omitting userId with a victim jti returns 200 and never writes', async () => {
    const deps = makeDeps()
    const reply = new FakeReply()
    const forged = `${sign({ type: 'access', userId: 7, jti: 'x' }, signingMaterial).split('.')[0]}.${Buffer.from(JSON.stringify({ type: 'access', jti: 'victim-jti-1' })).toString('base64url')}.${sign({ type: 'access', userId: 7, jti: 'x' }, signingMaterial).split('.')[2]}`
    const body = await handleTokenRevocationRequest(callerReq(forged) as never, reply as never, deps)
    expect(reply.statusCode).toBe(200)
    expect(body).toEqual({})
    expect(deps.revokeToken).not.toHaveBeenCalled()
  })

  test('a correctly signed token belonging to another user returns 200 without writing', async () => {
    const deps = makeDeps()
    const reply = new FakeReply()
    const otherUser = sign({ type: 'access', userId: 99, jti: 'jti-victim-2' })
    await handleTokenRevocationRequest(callerReq(otherUser) as never, reply as never, deps)
    expect(reply.statusCode).toBe(200)
    expect(deps.revokeToken).not.toHaveBeenCalled()
  })

  test('alg=none and malformed tokens return 200 without writing', async () => {
    const deps = makeDeps()
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ type: 'access', userId: 7, jti: 'forged-jti-yy' })).toString('base64url')}.`
    const reply = new FakeReply()
    await handleTokenRevocationRequest(callerReq(unsigned) as never, reply as never, deps)
    expect(reply.statusCode).toBe(200)
    expect(deps.revokeToken).not.toHaveBeenCalled()
    const reply2 = new FakeReply()
    await handleTokenRevocationRequest(callerReq('garbage') as never, reply2 as never, deps)
    expect(reply2.statusCode).toBe(200)
    expect(deps.revokeToken).not.toHaveBeenCalled()
  })

  test('duplicate revocation of the same jti stays idempotent and audits only fingerprints', async () => {
    const deps = makeDeps()
    const token = sign({ type: 'refresh', userId: 7, jti: 'jti-dup-1' })
    await handleTokenRevocationRequest(callerReq(token) as never, new FakeReply() as never, deps)
    await handleTokenRevocationRequest(callerReq(token) as never, new FakeReply() as never, deps)
    expect(deps.insertAuditLog).toHaveBeenCalledTimes(2)
    for (const call of deps.insertAuditLog.mock.calls as unknown as any[][]) {
      const details = JSON.stringify(call[2])
      expect(details).not.toContain(token)
      expect(details).not.toMatch(/"jti":"jti-dup-1"/)
    }
  })

  test('token_type_hint never changes the verification outcome', async () => {
    const deps = makeDeps()
    const access = sign({ type: 'access', userId: 7, jti: 'jti-hint-1' })
    await handleTokenRevocationRequest(callerReq(access, 'refresh_token') as never, new FakeReply() as never, deps)
    expect((deps.revokeToken.mock.calls[0] as unknown as any[])[4].tokenType).toBe('access')
  })

  test('missing token still answers 400 before any verification', async () => {
    const deps = makeDeps()
    const reply = new FakeReply()
    const body = await handleTokenRevocationRequest(
      { headers: { authorization: 'Bearer caller' }, body: {}, ip: '203.0.113.10' } as never,
      reply as never,
      deps,
    )
    expect(reply.statusCode).toBe(400)
    expect(body.error).toBe('invalid_request')
  })
})
