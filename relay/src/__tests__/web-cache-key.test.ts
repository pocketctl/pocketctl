import { describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
vi.mock('../auth.js', () => ({ verifyAccessTokenWithRevocation: vi.fn(async (token: string) => token === 'valid' ? { userId: 7 } : null) }))
import { personalCacheKey, registerWebCacheKey } from '../web-cache-key.js'
describe('personal cache key', () => {
  test('separates users, purposes and secret rotations; rejects weak configuration', () => {
    const secret = 's'.repeat(40)
    expect(personalCacheKey(secret, 7)).toEqual(personalCacheKey(secret, 7))
    expect(personalCacheKey(secret, 7)).not.toEqual(personalCacheKey(secret, 8))
    expect(personalCacheKey(secret, 7)).not.toEqual(personalCacheKey('t'.repeat(40), 7))
    expect(personalCacheKey('weak', 7)).toBeNull()
    expect(personalCacheKey(secret, NaN)).toBeNull()
    expect(Buffer.from(personalCacheKey(secret, 7)!.key, 'base64')).toHaveLength(32)
  })
  test('requires verified bearer identity, ignores supplied user and forbids HTTP caching', async () => {
    vi.stubEnv('WEB_CACHE_SECRET', 's'.repeat(40))
    const app = Fastify(); registerWebCacheKey(app, {} as any)
    for (const authorization of ['', 'Bearer revoked', 'Bearer share-token']) {
      expect((await app.inject({ url: '/api/user/cache-key', headers: { authorization } })).statusCode).toBe(401)
    }
    const reply = await app.inject({ url: '/api/user/cache-key?user_id=8', headers: { authorization: 'Bearer valid' } })
    expect(reply.statusCode).toBe(200)
    expect(reply.headers['cache-control']).toContain('no-store')
    expect(reply.json()).toMatchObject({ user_id: 7, ...personalCacheKey('s'.repeat(40), 7)! })
    await app.close(); vi.unstubAllEnvs()
  })
})
