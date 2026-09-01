import type { WebSocket } from 'ws'
import type pg from 'pg'
import type { ExtensionMode } from './types.js'
import {
  createCapabilityGrantService,
  type CapabilityRouteDeps,
} from './capability-routes.js'
import { createV2GrantService } from './v2-grant-service.js'
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
  /**
   * ADR-P3-05 explicit bounded scope selection (1..16 installation ids).
   * Absent keeps the frozen personal-only v1 grant; the daemon never
   * parses the resulting JWT and persists neither token nor scope list.
   */
  scope_installation_ids?: string[]
}

export interface MemoryMcpGrantResult {
  type: 'memory_mcp_grant_result'
  request_id?: string
  grant: string
  expires_in: number
  token_type: 'extension_capability' | 'extension_capability_v2'
  installation_id: string
  provider_public_origin: string
  services: string[]
}

export interface MemoryMcpGrantError {
  type: 'memory_mcp_grant_error'
  request_id?: string
  code:
    | 'unauthenticated'
    | 'invalid_request'
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
  /** ADR-P3-13 independent v2 flag; enables explicit scope selections. */
  v2Mode?: ExtensionMode
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
    scopeInstallationIds?: string[],
  ): Promise<MemoryMcpGrantResult | MemoryMcpGrantError> {
    if (daemon.userId === null || !Number.isInteger(daemon.userId) || daemon.userId <= 0) {
      return { type: 'memory_mcp_grant_error', code: 'unauthenticated' }
    }
    if (scopeInstallationIds !== undefined) {
      // Explicit bounded selection mints a federated v2 grant; every binding
      // still derives from the authenticated user inside the mint service.
      if (!Array.isArray(scopeInstallationIds)
        || scopeInstallationIds.length === 0
        || scopeInstallationIds.length > 16
        || scopeInstallationIds.some(id => typeof id !== 'string')) {
        return { type: 'memory_mcp_grant_error', code: 'invalid_request' }
      }
      const v2 = createV2GrantService({
        pool: deps.pool,
        issuer: deps.issuer,
        v2Mode: deps.v2Mode ?? 'off',
        grantKeys: deps.grantKeys,
        ttlSeconds: 60,
      })
      const mintedV2 = await v2.mint({
        userId: daemon.userId,
        installationIds: scopeInstallationIds,
        callerType: 'agent',
        services: ['memory.mcp'],
      })
      if (!mintedV2.ok) {
        const code = mintedV2.code === 'feature_disabled' ? 'feature_disabled'
          : mintedV2.code === 'not_found' ? 'no_installation'
            : 'internal_error'
        return { type: 'memory_mcp_grant_error', code }
      }
      return {
        type: 'memory_mcp_grant_result',
        grant: mintedV2.token,
        expires_in: mintedV2.expiresInSeconds,
        token_type: 'extension_capability_v2',
        installation_id: scopeInstallationIds[0],
        provider_public_origin: deps.providerPublicOrigins.get('pocketctl-memory') ?? '',
        services: ['memory.mcp'],
      }
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
 * Phase 4 least-privilege source-sync grant broker (ADR-0006 §2). The daemon
 * asks for a `memory.codegraph.write` Capability Grant before uploading a
 * committed snapshot to Memory. The request payload carries no identity, path,
 * commit, or repository facts — Relay derives the user from the AUTHENTICATED
 * connection and resolves the target installation itself:
 *
 * - No scope selection: the user's one active PERSONAL installation with the
 *   service enabled mints a v1 grant.
 * - Exactly one explicit installation id: a federated v2 grant whose binding
 *   must carry `contribute`; publication rights are deliberately absent and
 *   stay with the Memory publication flow.
 *
 * TTL is at most 60 seconds; the client refreshes between batches.
 */
export interface MemoryCodegraphGrantRequestMessage {
  type: 'memory_codegraph_grant'
  /** Caller-supplied correlation id echoed verbatim. */
  request_id?: string
  /** Optional explicit shared target: exactly one installation id. */
  scope_installation_ids?: string[]
}

export interface MemoryCodegraphGrantResult {
  type: 'memory_codegraph_grant_result'
  request_id?: string
  grant: string
  expires_in: number
  token_type: 'extension_capability' | 'extension_capability_v2'
  installation_id: string
  provider_public_origin: string
  services: string[]
}

export interface MemoryCodegraphGrantError {
  type: 'memory_codegraph_grant_error'
  request_id?: string
  code:
    | 'unauthenticated'
    | 'invalid_request'
    | 'no_installation'
    | 'service_disabled'
    | 'installation_not_active'
    | 'not_contributor'
    | 'feature_disabled'
    | 'internal_error'
}

const CODEGRAPH_SERVICE = 'memory.codegraph.write'
const CODEGRAPH_REQUEST_KEYS = new Set(['type', 'request_id', 'scope_installation_ids'])

export function createMemoryCodegraphGrantBroker(deps: MemoryMcpGrantBrokerDeps) {
  const routeDeps: CapabilityRouteDeps = {
    pool: deps.pool,
    verifyAccessToken: async () => null,
    mode: deps.mode,
    issuer: deps.issuer,
    providerPublicOrigins: deps.providerPublicOrigins,
    ttlSeconds: Math.min(deps.ttlSeconds ?? 60, 60),
  }
  const mint = createCapabilityGrantService(routeDeps, deps.grantKeys)

  return {
    /** Resolve the user's one active personal installation carrying the service. */
    async resolvePersonalInstallation(userId: number): Promise<{
      installationId: string
    } | { error: 'no_installation' | 'service_disabled' | 'installation_not_active' }> {
      const rows = await deps.pool.query<{
        installation_id: string
        status: string
        enabled_services: string[]
        owner_scope_kind: string
      }>(`
        SELECT installation_id::text, status, enabled_services, owner_scope_kind
        FROM extension_installations
        WHERE owner_user_id = $1 AND provider_id = 'pocketctl-memory'
        ORDER BY created_at
      `, [userId])
      // Only personal installations qualify for the implicit target; shared
      // installations must be selected explicitly and mint through v2.
      const personalAll = rows.rows.filter(row => row.owner_scope_kind === 'personal')
      const personal = personalAll.filter(row => !['revoking', 'revoked'].includes(row.status))
      if (personal.length === 0) {
        return personalAll.length > 0 ? { error: 'installation_not_active' } : { error: 'no_installation' }
      }
      const active = personal.filter(row => row.status === 'active')
      if (active.length !== 1) return { error: 'installation_not_active' }
      if (!active[0].enabled_services.includes(CODEGRAPH_SERVICE)) {
        return { error: 'service_disabled' }
      }
      return { installationId: active[0].installation_id }
    },

    async requestGrant(
      daemon: { userId: number | null },
      scopeInstallationIds?: string[],
    ): Promise<MemoryCodegraphGrantResult | MemoryCodegraphGrantError> {
      if (daemon.userId === null || !Number.isInteger(daemon.userId) || daemon.userId <= 0) {
        return { type: 'memory_codegraph_grant_error', code: 'unauthenticated' }
      }
      if (scopeInstallationIds !== undefined) {
        // Exactly one explicit shared target; duplicates and lists are refused
        // before any database work.
        if (!Array.isArray(scopeInstallationIds)
          || scopeInstallationIds.length !== 1
          || typeof scopeInstallationIds[0] !== 'string'
          || scopeInstallationIds[0].length === 0
          || scopeInstallationIds[0].length > 64) {
          return { type: 'memory_codegraph_grant_error', code: 'invalid_request' }
        }
        const v2 = createV2GrantService({
          pool: deps.pool,
          issuer: deps.issuer,
          v2Mode: deps.v2Mode ?? 'off',
          grantKeys: deps.grantKeys,
          ttlSeconds: 60,
        })
        const minted = await v2.mint({
          userId: daemon.userId,
          installationIds: scopeInstallationIds,
          callerType: 'agent',
          services: [CODEGRAPH_SERVICE],
        })
        if (!minted.ok) {
          const code = minted.code === 'feature_disabled' ? 'feature_disabled'
            : minted.code === 'not_found' ? 'no_installation'
              : minted.code === 'forbidden' ? 'service_disabled'
                : minted.code === 'installation_paused' ? 'installation_not_active'
                  : 'internal_error'
          return { type: 'memory_codegraph_grant_error', code }
        }
        // The upload mutation requires contribute; publication is a separate
        // Memory-side action and its permission is deliberately not minted.
        const binding = minted.bindings[0]
        if (!binding || !binding.permissions.includes('contribute')) {
          return { type: 'memory_codegraph_grant_error', code: 'not_contributor' }
        }
        return {
          type: 'memory_codegraph_grant_result',
          grant: minted.token,
          expires_in: minted.expiresInSeconds,
          token_type: 'extension_capability_v2',
          installation_id: scopeInstallationIds[0],
          provider_public_origin: deps.providerPublicOrigins.get('pocketctl-memory') ?? '',
          services: [CODEGRAPH_SERVICE],
        }
      }
      const resolved = await this.resolvePersonalInstallation(daemon.userId)
      if ('error' in resolved) {
        return { type: 'memory_codegraph_grant_error', code: resolved.error }
      }
      const minted = await mint.mint({
        userId: daemon.userId,
        installationId: resolved.installationId,
        callerType: 'agent',
        services: [CODEGRAPH_SERVICE],
        sessionId: null,
      })
      if (!minted.ok) {
        const code = minted.error.code === 'feature_disabled' ? 'feature_disabled' : 'internal_error'
        return { type: 'memory_codegraph_grant_error', code }
      }
      return {
        type: 'memory_codegraph_grant_result',
        grant: minted.token,
        expires_in: minted.expiresInSeconds,
        token_type: 'extension_capability',
        installation_id: resolved.installationId,
        provider_public_origin: minted.providerPublicOrigin ?? '',
        services: [CODEGRAPH_SERVICE],
      }
    },
  }
}

export type MemoryCodegraphGrantBroker = ReturnType<typeof createMemoryCodegraphGrantBroker>

/**
 * Handle one daemon WS message for the Phase 4 source-sync grant. The request
 * shape is a strict allowlist: any identity-, path-, or commit-bearing field
 * is rejected with invalid_request before a mint is attempted.
 */
export async function handleMemoryCodegraphGrantMessage(
  broker: MemoryCodegraphGrantBroker,
  daemon: { userId: number | null },
  msg: unknown,
  send: (payload: string) => void,
): Promise<void> {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    send(JSON.stringify({ type: 'memory_codegraph_grant_error', code: 'invalid_request' }))
    return
  }
  const message = msg as Record<string, unknown>
  if (message.type !== 'memory_codegraph_grant') {
    send(JSON.stringify({ type: 'memory_codegraph_grant_error', code: 'invalid_request' }))
    return
  }
  for (const key of Object.keys(message)) {
    if (!CODEGRAPH_REQUEST_KEYS.has(key)) {
      send(JSON.stringify({ type: 'memory_codegraph_grant_error', code: 'invalid_request' }))
      return
    }
  }
  const requestId = typeof message.request_id === 'string'
    ? message.request_id.slice(0, 128)
    : undefined
  let scopeInstallationIds: string[] | undefined
  if (message.scope_installation_ids !== undefined) {
    if (!Array.isArray(message.scope_installation_ids)) {
      send(JSON.stringify({ type: 'memory_codegraph_grant_error', code: 'invalid_request' }))
      return
    }
    scopeInstallationIds = message.scope_installation_ids as string[]
  }
  try {
    const result = await broker.requestGrant(daemon, scopeInstallationIds)
    send(JSON.stringify(
      'grant' in result ? { ...result, ...(requestId ? { request_id: requestId } : {}) }
        : { ...result, ...(requestId ? { request_id: requestId } : {}) },
    ))
  } catch {
    // Bounded code only — never the error message, stack, or echo of input.
    send(JSON.stringify({
      type: 'memory_codegraph_grant_error',
      ...(requestId ? { request_id: requestId } : {}),
      code: 'internal_error',
    }))
  }
}

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
  const scopeInstallationIds = Array.isArray(message?.scope_installation_ids)
    ? (message.scope_installation_ids as string[])
    : undefined
  try {
    const result = await broker.requestGrant(daemon, scopeInstallationIds)
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

/**
 * Phase 2 session-bound context grant broker (plan 10.1). The daemon asks
 * for a `memory.context` grant bound to one of its OWN sessions; Relay
 * derives the user from the authenticated connection and verifies session
 * ownership + exactly one active Memory installation + the enabled service
 * inside one SQL authorization boundary. Existing installations never get
 * the service implicitly — the operator enables it explicitly.
 */
export interface MemoryContextGrantRequestMessage {
  type: 'memory_context_grant'
  request_id?: string
  session_id: string
}

export interface MemoryContextGrantResult {
  type: 'memory_context_grant_result'
  request_id?: string
  grant: string
  expires_in: number
  token_type: 'extension_capability'
  installation_id: string
  session_id: string
  provider_public_origin: string
  services: string[]
}

export interface MemoryContextGrantError {
  type: 'memory_context_grant_error'
  request_id?: string
  code:
    | 'unauthenticated'
    | 'invalid_request'
    | 'no_installation'
    | 'service_disabled'
    | 'installation_not_active'
    | 'session_not_owned'
    | 'feature_disabled'
    | 'internal_error'
}

export interface ContextGrantResolution {
  installationId: string
}

export function createMemoryContextGrantBroker(deps: MemoryMcpGrantBrokerDeps & {
  ttlSeconds?: number
}) {
  const ttl = Math.min(deps.ttlSeconds ?? 300, 300)
  const routeDeps: CapabilityRouteDeps = {
    pool: deps.pool,
    verifyAccessToken: async () => null,
    mode: deps.mode,
    issuer: deps.issuer,
    providerPublicOrigins: deps.providerPublicOrigins,
    ttlSeconds: ttl,
  }
  const mint = createCapabilityGrantService(routeDeps, deps.grantKeys)

  return {
    /**
     * Resolve (installation, session ownership) in ONE query: the session
     * must belong to the authenticated user and exactly one active Memory
     * installation must carry memory.context.
     */
    async resolveForSession(input: {
      userId: number
      sessionId: string
    }): Promise<ContextGrantResolution | {
      error: 'no_installation' | 'service_disabled' | 'installation_not_active' | 'session_not_owned'
    }> {
      const result = await deps.pool.query<{
        installation_id: string
        status: string
        enabled_services: string[]
        session_owned: boolean
      }>(`
        SELECT i.installation_id::text, i.status, i.enabled_services,
               EXISTS (
                 SELECT 1 FROM sessions s
                 WHERE s.session_id = $2 AND s.user_id = $1
               ) AS session_owned
        FROM extension_installations i
        WHERE i.owner_user_id = $1 AND i.provider_id = 'pocketctl-memory'
        ORDER BY i.created_at
      `, [input.userId, input.sessionId])
      const rows = result.rows
      if (rows.length === 0) return { error: 'no_installation' }
      if (!rows.some(row => row.session_owned)) return { error: 'session_not_owned' }
      const active = rows.filter(row => row.status === 'active')
      if (active.length === 0) return { error: 'installation_not_active' }
      if (active.length !== 1) return { error: 'no_installation' }
      if (!active[0].enabled_services.includes('memory.context')) return { error: 'service_disabled' }
      return { installationId: active[0].installation_id }
    },

    async requestGrant(daemon: {
      userId: number | null
    }, sessionId: string): Promise<MemoryContextGrantResult | MemoryContextGrantError> {
      if (daemon.userId === null || !Number.isInteger(daemon.userId) || daemon.userId <= 0) {
        return { type: 'memory_context_grant_error', code: 'unauthenticated' }
      }
      if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 64) {
        return { type: 'memory_context_grant_error', code: 'invalid_request' }
      }
      const resolved = await this.resolveForSession({ userId: daemon.userId, sessionId })
      if ('error' in resolved) {
        return { type: 'memory_context_grant_error', code: resolved.error }
      }
      const minted = await mint.mint({
        userId: daemon.userId,
        installationId: resolved.installationId,
        callerType: 'daemon',
        services: ['memory.context'],
        sessionId,
      })
      if (!minted.ok) {
        const code = minted.error.code === 'feature_disabled' ? 'feature_disabled' : 'internal_error'
        return { type: 'memory_context_grant_error', code }
      }
      return {
        type: 'memory_context_grant_result',
        grant: minted.token,
        expires_in: Math.min(minted.expiresInSeconds, ttl),
        token_type: 'extension_capability',
        installation_id: resolved.installationId,
        session_id: sessionId,
        provider_public_origin: minted.providerPublicOrigin ?? '',
        services: ['memory.context'],
      }
    },
  }
}

export type MemoryContextGrantBroker = ReturnType<typeof createMemoryContextGrantBroker>

export async function handleMemoryContextGrantMessage(
  broker: MemoryContextGrantBroker,
  daemon: { userId: number | null },
  msg: unknown,
  send: (payload: string) => void,
): Promise<void> {
  const message = msg as Partial<MemoryContextGrantRequestMessage>
  const requestId = typeof message?.request_id === 'string'
    ? message.request_id.slice(0, 128)
    : undefined
  const sessionId = typeof message?.session_id === 'string' ? message.session_id : ''
  try {
    const result = await broker.requestGrant(daemon, sessionId)
    send(JSON.stringify(
      'grant' in result ? { ...result, ...(requestId ? { request_id: requestId } : {}) }
        : { ...result, ...(requestId ? { request_id: requestId } : {}) },
    ))
  } catch {
    send(JSON.stringify({
      type: 'memory_context_grant_error',
      ...(requestId ? { request_id: requestId } : {}),
      code: 'internal_error',
    }))
  }
}

/**
 * Two-phase managed-session registration (plan 10.1): Relay durably
 * registers the daemon-created session BEFORE the initial prompt dispatch,
 * then answers a bounded ack. The ack is a readiness signal, never an
 * authorization token.
 */
export interface SessionRegistrationMessage {
  type: 'session_registration'
  request_id?: string
  session_id: string
}

export interface SessionRegistrationAck {
  type: 'session_registration_ack'
  request_id?: string
  session_id: string
  status: 'ready'
}

export async function handleSessionRegistrationMessage(
  deps: { pool: pg.Pool },
  daemon: { userId: number; daemonId?: string },
  msg: unknown,
  send: (payload: string) => void,
): Promise<void> {
  const message = msg as Partial<SessionRegistrationMessage>
  const requestId = typeof message?.request_id === 'string'
    ? message.request_id.slice(0, 128)
    : undefined
  const sessionId = typeof message?.session_id === 'string' ? message.session_id : ''
  if (!sessionId || sessionId.length > 64 || !daemon.daemonId) {
    send(JSON.stringify({
      type: 'session_registration_error',
      ...(requestId ? { request_id: requestId } : {}),
      code: 'invalid_request',
    }))
    return
  }
  // Durable write first: an owned session row exists before the ack fires.
  const registered = await deps.pool.query<{ session_id: string }>(`
    INSERT INTO sessions (session_id, user_id, daemon_id, source, status, created_at, updated_at)
    VALUES ($1, $2, $3, 'daemon', 'active', NOW(), NOW())
    ON CONFLICT (session_id) DO UPDATE
      SET updated_at = NOW(), last_activity_at = NOW()
      WHERE sessions.user_id = EXCLUDED.user_id
        AND sessions.daemon_id = EXCLUDED.daemon_id
    RETURNING session_id
  `, [sessionId, daemon.userId, daemon.daemonId])
  if (registered.rows.length !== 1) {
    send(JSON.stringify({
      type: 'session_registration_error',
      ...(requestId ? { request_id: requestId } : {}),
      code: 'forbidden',
    }))
    return
  }
  const ack: SessionRegistrationAck = {
    type: 'session_registration_ack',
    session_id: sessionId,
    status: 'ready',
    ...(requestId ? { request_id: requestId } : {}),
  }
  send(JSON.stringify(ack))
}
