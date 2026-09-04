import type pg from 'pg'
import { createCapabilityVerifier } from '../relay/capability-verifier.js'
import { createScopeAuthorization } from '../governance/authorization.js'
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

export interface VerifiedMemoryGrantV1 {
  installationId: string
  services: string[]
  configVersion: string
  /** 'web' | 'daemon' | ... as minted by Relay; agent routes require daemon. */
  callerType: string
  sessionId?: string
}

/** Discriminated union (§8.1): v1 stays byte-compatible; v2 adds bindings. */
export type VerifiedMemoryGrant =
  | VerifiedMemoryGrantV1
  | import('../governance/authorization.js').RouteV2Grant

export function createGrantGuard(deps: GrantGuardDeps) {
  const scopeAuthorization = createScopeAuthorization(deps.pool)
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
        callerType: verified.callerType,
        ...(verified.sessionId ? { sessionId: verified.sessionId } : {}),
      }
    },

    /**
     * v2 guard for governance and federated routes: verifies the federated
     * scope grant cryptographically, then revalidates every binding against
     * the local scope mirror. Stale bindings drop; a failed primary or
     * service rejects the whole request with one bounded error.
     */
    async guardV2(input: {
      authorization: string | undefined
      requiredService: string
    }): Promise<import('../governance/authorization.js').RouteV2Grant> {
      const reject = () => new MemoryApiError('unauthorized', 'grant rejected')
      const header = input.authorization
      if (!header?.startsWith('Bearer ')) throw reject()
      const verified = await verifier.verifyV2(header.slice(7), input.requiredService)
      if (!verified) throw reject()
      const validated = await scopeAuthorization.validateV2Grant({
        primaryInstallationId: verified.installationId,
        configVersion: verified.configVersion,
        scopeBindings: verified.scopeBindings,
      })
      if (!validated) throw reject()
      return {
        version: 'v2',
        installationId: validated.primaryInstallationId,
        primaryInstallationId: validated.primaryInstallationId,
        services: verified.services,
        configVersion: validated.configVersion,
        callerType: verified.callerType,
        scopeBindings: validated.scopeBindings,
      }
    },

    /** Narrow disposition grant: permits a dissolving scope only for transfer. */
    async guardV2Disposition(input: {
      authorization: string | undefined
      requiredService: 'memory.manage'
    }): Promise<import('../governance/authorization.js').RouteV2Grant> {
      const reject = () => new MemoryApiError('unauthorized', 'grant rejected')
      const header = input.authorization
      if (!header?.startsWith('Bearer ')) throw reject()
      const verified = await verifier.verifyV2(header.slice(7), input.requiredService)
      if (!verified) throw reject()
      const validated = await scopeAuthorization.validateV2Grant({
        primaryInstallationId: verified.installationId,
        configVersion: verified.configVersion,
        scopeBindings: verified.scopeBindings,
      }, { allowedSharedStates: ['active', 'dissolving'] })
      if (!validated) throw reject()
      return {
        version: 'v2',
        installationId: validated.primaryInstallationId,
        primaryInstallationId: validated.primaryInstallationId,
        services: verified.services,
        configVersion: validated.configVersion,
        callerType: verified.callerType,
        scopeBindings: validated.scopeBindings,
      }
    },

    /** MCP accepts legacy personal grants and explicit federated v2 grants. */
    async guardMcp(input: {
      authorization: string | undefined
      requiredService: string
    }): Promise<VerifiedMemoryGrant> {
      const reject = () => new MemoryApiError('unauthorized', 'grant rejected')
      const header = input.authorization
      if (!header?.startsWith('Bearer ')) throw reject()
      const token = header.slice(7)
      const verifiedV2 = await verifier.verifyV2(token, input.requiredService)
      if (verifiedV2) {
        const validated = await scopeAuthorization.validateV2Grant({
          primaryInstallationId: verifiedV2.installationId,
          configVersion: verifiedV2.configVersion,
          scopeBindings: verifiedV2.scopeBindings,
        })
        if (!validated) throw reject()
        return {
          version: 'v2',
          installationId: validated.primaryInstallationId,
          primaryInstallationId: validated.primaryInstallationId,
          services: verifiedV2.services,
          configVersion: validated.configVersion,
          callerType: verifiedV2.callerType,
          scopeBindings: validated.scopeBindings,
        }
      }
      const verified = await verifier.verify(token, input.requiredService)
      if (!verified) throw reject()
      return {
        installationId: verified.installationId,
        services: verified.services,
        configVersion: verified.configVersion,
        callerType: verified.callerType,
        ...(verified.sessionId ? { sessionId: verified.sessionId } : {}),
      }
    },
  }
}

export type GrantGuard = ReturnType<typeof createGrantGuard>
