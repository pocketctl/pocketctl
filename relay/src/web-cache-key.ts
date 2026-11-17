import { createHash, hkdfSync } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { verifyAccessTokenWithRevocation } from './auth.js'

/** Purpose separation: the returned key cannot sign tokens or derive other users' keys. */
export function personalCacheKey(secret: string, userId: number) {
  if (Buffer.byteLength(secret) < 32 || !Number.isSafeInteger(userId) || userId <= 0) return null
  const key = Buffer.from(hkdfSync('sha256', secret, 'pocketctl.web.personal-cache.v1', `user:${userId}`, 32))
  return { key: key.toString('base64'), key_id: createHash('sha256').update(key).digest('hex').slice(0, 24) }
}
export function registerWebCacheKey(app: FastifyInstance, pool: Pool) {
  app.get('/api/user/cache-key', async (req, reply) => {
    reply.header('Cache-Control', 'no-store, private').header('Pragma', 'no-cache').header('Vary', 'Authorization')
    const authorization = req.headers.authorization
    const auth = authorization?.startsWith('Bearer ')
      ? await verifyAccessTokenWithRevocation(authorization.slice(7), pool) : null
    if (!auth) return reply.code(401).send({ error: 'authorization required' })
    const material = personalCacheKey(process.env.WEB_CACHE_SECRET || process.env.JWT_SECRET || '', auth.userId)
    if (!material) return reply.code(503).send({ error: 'cache unavailable' })
    return { ...material, user_id: auth.userId, expires_at: Date.now() + 15 * 60_000 }
  })
}
