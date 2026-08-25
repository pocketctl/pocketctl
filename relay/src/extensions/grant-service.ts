import type { WebSocket } from 'ws'
import type pg from 'pg'
import type { ExtensionMode } from './types.js'
import {
  createCapabilityGrantService,
  type CapabilityRouteDeps,
} from './capability-routes.js'
import { ExtensionApiError } from './errors.js'

/**
 * Agent MCP grant broker (plan Task 12): daemon-authenticated callers ask
 * Relay for a short `memory.mcp` Capability Grant for the user's own active
 * PocketCtl Memory installation. Authorization derives the user from the
 * AUTHENTICATED daemon connection — never from the request payload — and the
 * same shared mint service as the HTTP route performs every check. The
 * response carries the operator-configured provider origin; nothing secret
 * is logged or persisted.
 */

export interface MemoryMcpGrantRequestMessage {
  type: 'memory_mcp_grant'
  /** Caller-supplied correlation id echoed verbatim. */
  request_id?: string
}

export interface MemoryMcpGrantResult {
  type: 'memory_mcp_grant_result'
  request_id?: string
  grant: string
  expires_in: number
  token_type: 'extension_capability'
  installation_id: string
  provider_public_origin: string
  services: string[]
}

export interface MemoryMcpGrantError {
  type: 'memory_mcp_grant_error'
  request_id?: string
  code:
    | 'unauthenticated'
    | 'no_installation'
    | 'service_disabled'
    | 'installation_not_active'
    | 'feature_disabled'
    | 'internal_error'
}

export interface MemoryMcpGrantBrokerDeps {
  pool: pg.Pool
  issuer: string
  mode: ExtensionMode
  providerPublicOrigins: ReadonlyMap<string, string>
  grantKeys: NonNullable<CapabilityRouteDeps['grantKeys']>
  ttlSeconds?: number
}

interface AuthenticatedDaemon {
  userId: number | null
  ws?: WebSocket
}

export function createMemoryMcpGrantBroker(deps: MemoryMcpGrantBrokerDeps) {
  const routeDeps: CapabilityRouteDeps = {
    pool: deps.pool,
    verifyAccessToken: async () => null, // mint() takes an authenticated userId
    mode: deps.mode,
    issuer: deps.issuer,
    providerPublicOrigins: deps.providerPublicOrigins,
    ...(deps.ttlSeconds !== undefined ? { ttlSeconds: deps.ttlSeconds } : {}),
  }
  const mint = createCapabilityGrantService(routeDeps, deps.grantKeys)

  return {
    async resolveInstallation(userId: number): Promise<{
    installationId: string
    services: string[]
  } | { error: 'no_installation' | 'service_disabled' | 'installation_not_active' }> {
    const rows = await deps.pool.query<{
      installation_id: string
      status: string
      enabled_services: string[]
    }>(`
      SELECT installation_id::text, status, enabled_services
      FROM extension_installations
      WHERE owner_user_id = $1 AND provider_id = 'pocketctl-memory'
      ORDER BY created_at
    `, [userId])
    const candidates = rows.rows.filter(row => !['revoking', 'revoked'].includes(row.status))
    if (candidates.length === 0) {
      return rows.rows.length > 0 ? { error: 'installation_not_active' } : { error: 'no_installation' }
    }
    if (candidates.length > 1) {
      // One active installation is the frozen Phase 1 resolution rule.
      const active = candidates.filter(row => row.status === 'active')
      if (active.length !== 1) return { error: 'no_installation' }
      const target = active[0].enabled_services.includes('memory.mcp')
        ? active[0]
        : undefined
      if (!target) return { error: 'service_disabled' }
      return { installationId: target.installation_id, services: ['memory.mcp'] }
    }
    const only = candidates[0]
      if (only.status !== 'active') return { error: 'installation_not_active' }
      if (!only.enabled_services.includes('memory.mcp')) return { error: 'service_disabled' }
      return { installationId: only.installation_id, services: ['memory.mcp'] }
    },

    async requestGrant(
    daemon: AuthenticatedDaemon,
  ): Promise<MemoryMcpGrantResult | MemoryMcpGrantError> {
    if (daemon.userId === null || !Number.isInteger(daemon.userId) || daemon.userId <= 0) {
      return { type: 'memory_mcp_grant_error', code: 'unauthenticated' }
    }
      const resolved = await this.resolveInstallation(daemon.userId)
    if ('error' in resolved) {
      return { type: 'memory_mcp_grant_error', code: resolved.error }
    }
    const minted = await mint.mint({
      userId: daemon.userId,
      installationId: resolved.installationId,
      callerType: 'agent',
      services: resolved.services,
      sessionId: null,
    })
    if (!minted.ok) {
      const code = minted.error.code === 'feature_disabled' ? 'feature_disabled' : 'internal_error'
      return { type: 'memory_mcp_grant_error', code }
    }
    return {
      type: 'memory_mcp_grant_result',
      grant: minted.token,
      expires_in: minted.expiresInSeconds,
      token_type: 'extension_capability',
      installation_id: resolved.installationId,
      provider_public_origin: minted.providerPublicOrigin ?? '',
      services: resolved.services,
    }
    },
  }
}

export type MemoryMcpGrantBroker = ReturnType<typeof createMemoryMcpGrantBroker>

/**
 * Handle one daemon WS message: correlate request_id, answer on the daemon
 * socket, and never let an error escape to the connection loop.
 */
export async function handleMemoryMcpGrantMessage(
  broker: MemoryMcpGrantBroker,
  daemon: AuthenticatedDaemon,
  msg: unknown,
  send: (payload: string) => void,
): Promise<void> {
  const message = msg as Partial<MemoryMcpGrantRequestMessage>
  const requestId = typeof message?.request_id === 'string'
    ? message.request_id.slice(0, 128)
    : undefined
  try {
    const result = await broker.requestGrant(daemon)
    send(JSON.stringify(
      'grant' in result ? { ...result, ...(requestId ? { request_id: requestId } : {}) }
        : { ...result, ...(requestId ? { request_id: requestId } : {}) },
    ))
  } catch (error) {
    if (error instanceof ExtensionApiError) {
      const code = error.code === 'feature_disabled' ? 'feature_disabled' : 'internal_error'
      send(JSON.stringify({ type: 'memory_mcp_grant_error', ...(requestId ? { request_id: requestId } : {}), code }))
      return
    }
    // Bounded code only — never the error message or stack.
    send(JSON.stringify({ type: 'memory_mcp_grant_error', ...(requestId ? { request_id: requestId } : {}), code: 'internal_error' }))
  }
}
