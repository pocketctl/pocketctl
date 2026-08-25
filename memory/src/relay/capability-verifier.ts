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
  }
}

export type CapabilityVerifier = ReturnType<typeof createCapabilityVerifier>
