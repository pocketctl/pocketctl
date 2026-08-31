import { createPublicKey } from 'crypto'
import jwt from 'jsonwebtoken'

const JWKS_PATH = '/.well-known/pocketctl-extension-jwks.json'
const JWKS_CACHE_TTL_MS = 5 * 60_000
const CLOCK_TOLERANCE_SECONDS = 30
const CAPABILITY_GRANT_MAX_TTL_SECONDS = 300

export interface VerifiedGrant {
  installationId: string
  callerType: string
  sessionId?: string
  services: string[]
  configVersion: string
}

export interface VerifiedScopeBinding {
  installation_id: string
  owner_scope_kind: 'personal' | 'team' | 'organization'
  owner_scope_id: string
  membership_id: string | null
  membership_revision: string
  authorization_epoch: string
  permissions: string[]
}

export interface VerifiedGrantV2 {
  userId: number
  installationId: string
  callerType: string
  services: string[]
  configVersion: string
  scopeBindings: VerifiedScopeBinding[]
}

const CAPABILITY_GRANT_V2_MAX_TTL_SECONDS = 60
const CAPABILITY_GRANT_V2_MAX_BINDINGS = 16
const GRANT_PERMISSION_ALLOWLIST = new Set([
  'read', 'contribute', 'review', 'publish', 'policy_admin', 'scope_admin',
])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isValidScopeBinding(value: unknown): value is VerifiedScopeBinding {
  if (value === null || typeof value !== 'object') return false
  const binding = value as Record<string, unknown>
  if (typeof binding.installation_id !== 'string' || !UUID_PATTERN.test(binding.installation_id)) return false
  if (binding.owner_scope_kind !== 'personal' && binding.owner_scope_kind !== 'team'
    && binding.owner_scope_kind !== 'organization') return false
  if (typeof binding.owner_scope_id !== 'string' || !UUID_PATTERN.test(binding.owner_scope_id)) return false
  if (binding.membership_id !== null
    && (typeof binding.membership_id !== 'string' || !UUID_PATTERN.test(binding.membership_id))) return false
  if (binding.owner_scope_kind === 'personal' && binding.membership_id !== null) return false
  if (typeof binding.membership_revision !== 'string' || !/^[0-9]+$/.test(binding.membership_revision)) return false
  if (typeof binding.authorization_epoch !== 'string'
    || !/^[1-9][0-9]*$/.test(binding.authorization_epoch)) return false
  if (!Array.isArray(binding.permissions)
    || binding.permissions.some(permission =>
      typeof permission !== 'string' || !GRANT_PERMISSION_ALLOWLIST.has(permission))) return false
  if (new Set(binding.permissions as string[]).size !== (binding.permissions as string[]).length) return false
  return true
}

export interface CapabilityVerifierOptions {
  relayUrl: string
  issuer: string
  providerId?: string
  lookupInstallation(installationId: string): Promise<{
    local_status: string
    relay_status: string
    config_version: string | number
  } | null>
  fetchImpl?: typeof fetch
  now?: () => number
}

interface CachedJwk {
  jwk: { kty: string; n: string; e: string; alg: string; use: string; kid: string }
  fetchedAt: number
}

/**
 * Relay Capability Grant verification (authorization chain 2). RS256 only,
 * JWKS cached per kid for at most five minutes with exactly one forced
 * refresh on an unknown kid; a JWKS outage falls back to cached keys.
 * Every failure collapses to null — callers answer a uniform 401/403 and
 * never explain which claim missed.
 */
export function createCapabilityVerifier(options: CapabilityVerifierOptions) {
  const providerId = options.providerId ?? 'pocketctl-memory'
  const doFetch = options.fetchImpl ?? fetch
  const now = options.now ?? (() => Date.now())
  const cache = new Map<string, CachedJwk>()

  async function fetchJwks(): Promise<void> {
    const response = await doFetch(`${options.relayUrl}${JWKS_PATH}`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error('jwks endpoint unavailable')
    const document = await response.json() as { keys?: unknown }
    if (!Array.isArray(document?.keys)) throw new Error('malformed jwks')
    const fetchedAt = now()
    const refreshed = new Map<string, CachedJwk>()
    for (const entry of document.keys) {
      const jwk = entry as CachedJwk['jwk']
      if (typeof jwk?.kid === 'string' && jwk.kty === 'RSA' && jwk.alg === 'RS256'
        && typeof jwk.n === 'string' && typeof jwk.e === 'string') {
        refreshed.set(jwk.kid, { jwk, fetchedAt })
      }
    }
    cache.clear()
    for (const [kid, key] of refreshed) cache.set(kid, key)
  }

  async function keyFor(kid: string): Promise<ReturnType<typeof createPublicKey> | null> {
    const cached = cache.get(kid)
    if (cached && now() - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
      return createPublicKey({ key: cached.jwk, format: 'jwk' })
    }
    // Unknown or stale kid: exactly one forced refresh before failing.
    try {
      await fetchJwks()
    } catch {
      // Outage: fall back to a stale cached key rather than failing closed
      // on rotations we already know about.
      if (cached) return createPublicKey({ key: cached.jwk, format: 'jwk' })
      return null
    }
    const refreshed = cache.get(kid)
    return refreshed ? createPublicKey({ key: refreshed.jwk, format: 'jwk' }) : null
  }

  return {
    async verify(
      token: string,
      requiredService: string,
      requestSessionId?: string,
    ): Promise<VerifiedGrant | null> {
      let header: { kid?: unknown; alg?: unknown }
      try {
        const decoded = jwt.decode(token, { complete: true })
        header = (decoded as { header: { kid?: unknown; alg?: unknown } }).header
      } catch {
        return null
      }
      if (header?.alg !== 'RS256' || typeof header.kid !== 'string') return null
      const key = await keyFor(header.kid)
      if (!key) return null

      let payload: Record<string, unknown>
      try {
        payload = jwt.verify(token, key, {
          algorithms: ['RS256'],
          issuer: options.issuer,
          audience: providerId,
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
        }) as Record<string, unknown>
      } catch {
        return null
      }

      if (payload.token_type !== 'extension_capability') return null
      if (payload.provider_id !== providerId) return null
      const currentEpochSeconds = Math.floor(Date.now() / 1000)
      if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)
        || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)
        || payload.iat > currentEpochSeconds + CLOCK_TOLERANCE_SECONDS
        || payload.exp <= payload.iat
        || payload.exp - payload.iat > CAPABILITY_GRANT_MAX_TTL_SECONDS) return null
      const subject = typeof payload.sub === 'string' ? /^user:([1-9]\d*)$/.exec(payload.sub) : null
      if (!subject) return null
      if (typeof payload.installation_id !== 'string' || !Array.isArray(payload.services)) return null
      if (typeof payload.config_version !== 'string') return null

      const installation = await options.lookupInstallation(payload.installation_id)
      if (!installation) return null
      if (installation.local_status === 'purging' || installation.local_status === 'purged'
        || installation.local_status === 'integrity_error') return null
      if (installation.relay_status === 'revoking' || installation.relay_status === 'revoked') return null
      if (String(installation.config_version) !== payload.config_version) return null

      if (!(payload.services as unknown[]).includes(requiredService)) return null

      const grantSession = payload.session_id
      if (requestSessionId !== undefined || grantSession !== undefined) {
        if (typeof grantSession !== 'string' || grantSession !== requestSessionId) return null
      }

      return {
        installationId: payload.installation_id,
        callerType: typeof payload.caller_type === 'string' ? payload.caller_type : '',
        ...(typeof grantSession === 'string' ? { sessionId: grantSession } : {}),
        services: payload.services as string[],
        configVersion: payload.config_version,
      }
    },

    /**
     * Verify a Protocol v2 federated scope grant (ADR-P3-05). Cryptographic
     * and shape checks only — TTL is hard-capped at 60 seconds, bindings at
     * 16 unique entries — because mirror revalidation belongs to the scope
     * authorization layer, which sees the database fences.
     */
    async verifyV2(token: string, requiredService: string): Promise<VerifiedGrantV2 | null> {
      let header: { kid?: unknown; alg?: unknown }
      try {
        const decoded = jwt.decode(token, { complete: true })
        header = (decoded as { header: { kid?: unknown; alg?: unknown } }).header
      } catch {
        return null
      }
      if (header?.alg !== 'RS256' || typeof header.kid !== 'string') return null
      const key = await keyFor(header.kid)
      if (!key) return null

      let payload: Record<string, unknown>
      try {
        payload = jwt.verify(token, key, {
          algorithms: ['RS256'],
          issuer: options.issuer,
          audience: providerId,
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
        }) as Record<string, unknown>
      } catch {
        return null
      }

      if (payload.token_type !== 'extension_capability_v2') return null
      const currentEpochSeconds = Math.floor(Date.now() / 1000)
      if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)
        || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)
        || payload.iat > currentEpochSeconds + CLOCK_TOLERANCE_SECONDS
        || payload.exp <= payload.iat
        || payload.exp - payload.iat > CAPABILITY_GRANT_V2_MAX_TTL_SECONDS) return null
      const subject = typeof payload.sub === 'string' ? /^user:([1-9]\d*)$/.exec(payload.sub) : null
      if (!subject) return null
      if (typeof payload.primary_installation_id !== 'string'
        || !Array.isArray(payload.services) || typeof payload.config_version !== 'string') return null
      if (!(payload.services as unknown[]).includes(requiredService)) return null
      if (!Array.isArray(payload.scope_bindings)
        || payload.scope_bindings.length === 0
        || payload.scope_bindings.length > CAPABILITY_GRANT_V2_MAX_BINDINGS
        || !payload.scope_bindings.every(binding => isValidScopeBinding(binding))) return null
      const bindings = payload.scope_bindings as VerifiedScopeBinding[]
      const installationIds = new Set(bindings.map(binding => binding.installation_id))
      if (installationIds.size !== bindings.length) return null
      if (!installationIds.has(payload.primary_installation_id)) return null

      return {
        userId: Number(subject[1]),
        installationId: payload.primary_installation_id,
        callerType: typeof payload.caller_type === 'string' ? payload.caller_type : '',
        services: payload.services as string[],
        configVersion: payload.config_version,
        scopeBindings: bindings,
      }
    },
  }
}

export type CapabilityVerifier = ReturnType<typeof createCapabilityVerifier>
