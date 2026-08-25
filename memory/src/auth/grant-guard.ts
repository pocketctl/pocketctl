import type pg from 'pg'
import { createCapabilityVerifier } from '../relay/capability-verifier.js'
import { MemoryApiError } from '../api/errors.js'

/**
 * Grant guard for /api/v1/memory routes: verifies the Relay Capability Grant
 * (RS256 via Relay JWKS, installation state, config version, session binding
 * all inside the verifier) and returns the verified installation context.
 * Every failure surfaces one bounded error — never which check failed.
 */

export interface GrantGuardDeps {
  pool: pg.Pool
  relayUrl: string
  relayIssuer: string
  fetchImpl?: typeof fetch
}

export interface VerifiedMemoryGrant {
  installationId: string
  services: string[]
  configVersion: string
  sessionId?: string
}

export function createGrantGuard(deps: GrantGuardDeps) {
  const verifier = createCapabilityVerifier({
    relayUrl: deps.relayUrl,
    issuer: deps.relayIssuer,
    providerId: 'pocketctl-memory',
    fetchImpl: deps.fetchImpl,
    lookupInstallation: async installationId => {
      const result = await deps.pool.query<{
        local_status: string
        relay_status: string
        config_version: string | number
      }>(`
        SELECT local_status, relay_status, config_version::text AS config_version
        FROM memory_installations WHERE installation_id = $1
      `, [installationId])
      return result.rows[0] ?? null
    },
  })

  return {
    async guard(input: {
      authorization: string | undefined
      requiredService: string
      installationId?: string
      sessionId?: string
    }): Promise<VerifiedMemoryGrant> {
      const reject = () => new MemoryApiError('unauthorized', 'grant rejected')
      const header = input.authorization
      if (!header?.startsWith('Bearer ')) throw reject()
      const verified = await verifier.verify(
        header.slice(7),
        input.requiredService,
        input.sessionId,
      )
      if (!verified) throw reject()
      if (input.installationId && input.installationId !== verified.installationId) {
        // Cross-installation ids are indistinguishable from missing ones.
        throw new MemoryApiError('not_found', 'resource not found')
      }
      return {
        installationId: verified.installationId,
        services: verified.services,
        configVersion: verified.configVersion,
        ...(verified.sessionId ? { sessionId: verified.sessionId } : {}),
      }
    },
  }
}

export type GrantGuard = ReturnType<typeof createGrantGuard>
