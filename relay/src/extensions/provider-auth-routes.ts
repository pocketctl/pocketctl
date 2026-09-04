import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import type { ExtensionMode } from './types.js'
import {
  authenticateProviderCredentials,
  signProviderExtensionToken,
  PROVIDER_TOKEN_TTL_SECONDS,
} from './provider-auth.js'

export interface ProviderRateLimiter {
  check(key: string): { allowed: boolean; retryAfterMs?: number }
}

export interface ProviderTokenRouteDeps {
  pool: pg.Pool
  mode: ExtensionMode
  providerJwtSecret: string
  issuer: string
  authenticate?: typeof authenticateProviderCredentials
  rateLimiter?: ProviderRateLimiter
  ttlSeconds?: number
}

const MAX_CLIENT_ID_LENGTH = 128
const MAX_CLIENT_SECRET_LENGTH = 512
const TOKEN_BODY_LIMIT_BYTES = 4096

/**
 * In-process fixed-window limiter for the token endpoint. Keys combine the
 * client identity and remote address; production deployments sit behind the
 * shared PostgreSQL limiter as well.
 */
export function createProviderTokenRateLimiter(options: {
  windowMs?: number
  maxPerWindow?: number
  now?: () => number
}): ProviderRateLimiter {
  const windowMs = options.windowMs ?? 60_000
  const max = options.maxPerWindow ?? 30
  const now = options.now ?? (() => Date.now())
  const windows = new Map<string, { startedAt: number; count: number }>()
  return {
    check(key) {
      const timestamp = now()
      const current = windows.get(key)
      if (!current || timestamp - current.startedAt >= windowMs) {
        windows.set(key, { startedAt: timestamp, count: 1 })
        return { allowed: true }
      }
      current.count++
      if (current.count > max) {
        return { allowed: false, retryAfterMs: windowMs - (timestamp - current.startedAt) }
      }
      return { allowed: true }
    },
  }
}

/** POST /api/extensions/v1/token — provider client-credentials exchange. */
export function registerProviderTokenRoute(
  app: FastifyInstance,
  deps: ProviderTokenRouteDeps,
): void {
  const authenticate = deps.authenticate ?? authenticateProviderCredentials
  const rateLimiter = deps.rateLimiter ?? createProviderTokenRateLimiter({})

  app.post('/api/extensions/v1/token', { bodyLimit: TOKEN_BODY_LIMIT_BYTES }, async (req, reply) => {
    if (deps.mode !== 'enabled') {
      reply.code(503)
      return { error: { code: 'feature_disabled', message: 'provider tokens require RELAY_EXTENSIONS=enabled' } }
    }
    const body = req.body as Record<string, unknown> | null
    const grantType = body?.grant_type
    const clientId = body?.client_id
    const clientSecret = body?.client_secret
    const unauthorized = () => {
      reply.code(401)
      return { error: { code: 'unauthorized', message: 'invalid client credentials' } }
    }
    if (grantType !== 'client_credentials'
      || typeof clientId !== 'string' || clientId.length === 0 || clientId.length > MAX_CLIENT_ID_LENGTH
      || typeof clientSecret !== 'string' || clientSecret.length === 0
      || clientSecret.length > MAX_CLIENT_SECRET_LENGTH) {
      return unauthorized()
    }

    const limiterKey = `${typeof req.ip === 'string' ? req.ip : '-'}:${clientId}`
    const decision = rateLimiter.check(limiterKey)
    if (!decision.allowed) {
      reply.code(429)
      if (decision.retryAfterMs) reply.header('retry-after', Math.ceil(decision.retryAfterMs / 1000))
      return { error: { code: 'invalid_request', message: 'rate limit exceeded' } }
    }

    const providerId = typeof body?.provider_id === 'string' ? body.provider_id : 'pocketctl-memory'
    const authenticated = await authenticate(deps.pool, {
      providerId, clientId, clientSecret,
    })
    if (!authenticated) {
      // Log only the allowlist provider id and an error category; never the
      // client id, secret, or token material.
      console.warn('[extensions] provider token exchange rejected', {
        provider: providerId, category: 'invalid_credentials',
      })
      return unauthorized()
    }

    const accessToken = signProviderExtensionToken({
      providerId: authenticated.providerId,
      credentialId: authenticated.credentialId,
      secret: deps.providerJwtSecret,
      issuer: deps.issuer,
      jti: authenticated.tokenJti,
      ttlSeconds: deps.ttlSeconds,
    })
    return {
      access_token: accessToken,
      token_type: 'extension_provider',
      expires_in: deps.ttlSeconds && deps.ttlSeconds < PROVIDER_TOKEN_TTL_SECONDS
        ? deps.ttlSeconds
        : PROVIDER_TOKEN_TTL_SECONDS,
    }
  })
}
