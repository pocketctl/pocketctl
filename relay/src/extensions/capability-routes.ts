import type { FastifyInstance, FastifyRequest } from 'fastify'
import type pg from 'pg'
import type { ExtensionMode } from './types.js'
import { ExtensionApiError } from './errors.js'
import {
  publicJwks,
  resolveGrantKeyMaterial,
  signCapabilityGrant,
  CAPABILITY_GRANT_MAX_TTL_SECONDS,
  type GrantKeyMaterial,
} from './capability-grant.js'

export interface CapabilityRouteDeps {
  pool: pg.Pool
  verifyAccessToken(token: string, pool?: unknown): Promise<{ userId: number } | null>
  mode: ExtensionMode
  issuer: string
  grantKeys?: GrantKeyMaterial
  ttlSeconds?: number
  rateLimiter?: { check(key: string): { allowed: boolean; retryAfterMs?: number } }
  /** Operator-owned provider origins; the only source of provider origins. */
  providerPublicOrigins?: ReadonlyMap<string, string>
}

const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_SERVICES = 16

function fail(reply: { code: (status: number) => unknown }, error: ExtensionApiError) {
  reply.code(error.httpStatus)
  // Server-controlled details nest inside the envelope.
  return { error: { code: error.code, message: error.message, ...(error.details ?? {}) } }
}

/** Input to the shared grant mint service; userId is already authenticated. */
export interface GrantMintInput {
  userId: number
  installationId: string
  callerType: 'web' | 'daemon' | 'agent'
  services?: string[]
  sessionId?: string | null
}

export type GrantMintResult =
  | {
      ok: true
      token: string
      expiresInSeconds: number
      providerId: string
      providerPublicOrigin?: string
    }
  | { ok: false; error: ExtensionApiError }

/**
 * Shared Capability Grant mint service. Authorization derives entirely from
 * the installation row (owner, status, enabled services) — never from the
 * request's claims — and callers must authenticate `userId` before calling.
 * The HTTP route and the daemon/agent grant broker (Phase 1 Task 12) both
 * delegate here; there is no second authorization path.
 */
export function createCapabilityGrantService(
  deps: CapabilityRouteDeps,
  grantKeys: GrantKeyMaterial,
) {
  return {
    async mint(input: GrantMintInput): Promise<GrantMintResult> {
      if (deps.mode !== 'enabled') {
        return { ok: false, error: new ExtensionApiError('feature_disabled', 'grants require RELAY_EXTENSIONS=enabled') }
      }
      if (!INSTALLATION_ID_PATTERN.test(input.installationId)) {
        return { ok: false, error: new ExtensionApiError('invalid_request', 'installation_id required') }
      }
      if (!['web', 'daemon', 'agent'].includes(input.callerType)) {
        return { ok: false, error: new ExtensionApiError('invalid_request', 'caller_type must be web, daemon or agent') }
      }
      const requestedServices = input.services
      if (requestedServices
        && (!Array.isArray(requestedServices)
          || requestedServices.some(service => typeof service !== 'string')
          || requestedServices.length === 0
          || requestedServices.length > MAX_SERVICES)) {
        return { ok: false, error: new ExtensionApiError('invalid_request', 'services must be a non-empty bounded list') }
      }
      const sessionId = typeof input.sessionId === 'string' && input.sessionId ? input.sessionId : null
      if (sessionId !== null && sessionId.length > 64) {
        return { ok: false, error: new ExtensionApiError('invalid_request', 'session_id too long') }
      }

      const installation = await deps.pool.query<{
        provider_id: string
        owner_user_id: number
        status: string
        enabled_services: string[]
        config_version: string | number
      }>(
        `SELECT provider_id, owner_user_id, status, enabled_services, config_version
         FROM extension_installations
         WHERE installation_id = $1 AND owner_user_id = $2`,
        [input.installationId, input.userId],
      )
      const row = installation.rows[0]
      if (!row) {
        return { ok: false, error: new ExtensionApiError('not_found', 'installation not found') }
      }
      if (row.status === 'paused' || row.status === 'pending') {
        return { ok: false, error: new ExtensionApiError('installation_paused', 'installation is not active') }
      }
      if (row.status !== 'active') {
        return { ok: false, error: new ExtensionApiError('installation_revoked', 'installation is revoked') }
      }
      // Services may only narrow the enabled set, never widen it.
      const services = requestedServices
        ? requestedServices.filter(service => row.enabled_services.includes(service))
        : [...row.enabled_services]
      if (requestedServices && services.length !== requestedServices.length) {
        return { ok: false, error: new ExtensionApiError('forbidden', 'requested services are not enabled for this installation') }
      }

      if (sessionId !== null) {
        // Session ownership in the same SQL boundary as the installation
        // lookup: one owner-scoped existence check, no separate unrestricted
        // read helper.
        const owned = await deps.pool.query(
          `SELECT 1 FROM sessions s
           JOIN extension_installations i ON i.owner_user_id = s.user_id
           WHERE i.installation_id = $1 AND s.session_id = $2`,
          [input.installationId, sessionId],
        )
        if ((owned.rowCount ?? 0) === 0) {
          return { ok: false, error: new ExtensionApiError('not_found', 'session not found or not owned') }
        }
      }

      const ttl = Math.min(
        Math.max(1, Math.trunc(deps.ttlSeconds ?? CAPABILITY_GRANT_MAX_TTL_SECONDS)),
        CAPABILITY_GRANT_MAX_TTL_SECONDS,
      )
      const token = signCapabilityGrant(grantKeys, {
        issuer: deps.issuer,
        providerId: row.provider_id,
        installationId: input.installationId,
        userId: input.userId,
        callerType: input.callerType,
        sessionId,
        services,
        configVersion: row.config_version,
        ttlSeconds: ttl,
      })
      // Bounded audit: provider allowlist id and a service-count category only.
      // Never the grant, jti, session id or service list itself.
      await deps.pool.query(
        `INSERT INTO audit_log (user_id, action, details) VALUES ($1, $2, $3::jsonb)`,
        [input.userId, 'extension_capability_grant', JSON.stringify({
          provider_id: row.provider_id,
          installation_id: input.installationId,
          service_count: services.length,
          caller_type: input.callerType,
        })],
      ).catch(() => undefined)
      const providerPublicOrigin = deps.providerPublicOrigins?.get(row.provider_id)
      return {
        ok: true,
        token,
        expiresInSeconds: ttl,
        providerId: row.provider_id,
        ...(providerPublicOrigin ? { providerPublicOrigin } : {}),
      }
    },
  }
}

/**
 * RS256 Capability Grant surface: a public, cacheable JWKS document and a
 * user-authenticated mint endpoint. Grants are never persisted to events,
 * feed or audit details; the audit trail records only the bounded service
 * category and provider allowlist id.
 */
export function registerCapabilityRoutes(app: FastifyInstance, deps: CapabilityRouteDeps): void {
  const grantKeys = deps.grantKeys ?? resolveGrantKeyMaterial(process.env, {
    strictProduction: deps.mode === 'enabled',
  })
  const grantService = createCapabilityGrantService(deps, grantKeys)

  app.get('/.well-known/pocketctl-extension-jwks.json', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300')
    return publicJwks(grantKeys)
  })

  app.post('/api/extensions/v1/grants', { bodyLimit: 4096 }, async (req, reply) => {
    if (deps.rateLimiter) {
      const decision = deps.rateLimiter.check(`grant:${String(req.ip ?? '-')}`)
      if (!decision.allowed) {
        reply.code(429)
        return { error: { code: 'invalid_request', message: 'rate limit exceeded' } }
      }
    }
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      return fail(reply, new ExtensionApiError('unauthorized', 'authorization required'))
    }
    const payload = await deps.verifyAccessToken(header.slice(7), deps.pool)
    if (!payload) {
      return fail(reply, new ExtensionApiError('unauthorized', 'invalid token'))
    }
    const body = req.body as Record<string, unknown> | null
    if (!body || typeof body !== 'object'
      || typeof body.installation_id !== 'string'
      || (body.caller_type !== undefined && typeof body.caller_type !== 'string')
      || (body.services !== undefined
        && (!Array.isArray(body.services) || body.services.some(service => typeof service !== 'string')))
      || (body.session_id !== undefined && body.session_id !== null && typeof body.session_id !== 'string')) {
      return fail(reply, new ExtensionApiError('invalid_request', 'invalid grant request'))
    }
    const callerType = body?.caller_type ?? 'web'
    const requestedServices = Array.isArray(body?.services)
      ? body.services as string[]
      : undefined

    const minted = await grantService.mint({
      userId: payload.userId,
      installationId: typeof body?.installation_id === 'string' ? body.installation_id : '',
      callerType: callerType as 'web' | 'daemon' | 'agent',
      services: requestedServices,
      sessionId: typeof body?.session_id === 'string' ? body.session_id : null,
    })
    if (!minted.ok) {
      return fail(reply, minted.error)
    }
    return {
      grant: minted.token,
      expires_in: minted.expiresInSeconds,
      token_type: 'extension_capability',
      ...('providerPublicOrigin' in minted && minted.providerPublicOrigin
        ? { provider_public_origin: minted.providerPublicOrigin }
        : {}),
    }
  })
}
