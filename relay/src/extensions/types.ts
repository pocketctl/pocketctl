/**
 * Frozen public contracts for the Relay Extension Platform
 * (ADR-0003). Topics, scopes, service IDs, protocol versions, installation
 * statuses and error codes are code-owned allowlists: nothing here accepts
 * arbitrary provider-supplied strings.
 */

export type ExtensionMode = 'off' | 'shadow' | 'enabled'

export type ExtensionTopic =
  | 'session.event.v1'
  | 'session.lifecycle.v1'
  | 'turn.lifecycle.v1'
  | 'session.deleted.v1'
  | 'session.access.revoked.v1'

export type ExtensionScope =
  | 'session:events:read'
  | 'session:snapshot:read'
  | 'session:deletion:read'

/** First-party provider service identifiers (catalog allowlist). */
export type ExtensionServiceId =
  | 'memory.search'
  | 'memory.recall'
  | 'knowledge.query'
  | 'memory.mcp'
  | 'memory.manage'

export type InstallationStatus =
  | 'pending'
  | 'active'
  | 'paused'
  | 'revoking'
  | 'revoked'

export type ExtensionErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'invalid_request'
  | 'stale_lease'
  | 'cursor_expired'
  | 'installation_paused'
  | 'installation_revoked'
  | 'feature_disabled'

export const EXTENSION_TOPICS: readonly ExtensionTopic[] = Object.freeze([
  'session.event.v1',
  'session.lifecycle.v1',
  'turn.lifecycle.v1',
  'session.deleted.v1',
  'session.access.revoked.v1',
])

export const EXTENSION_SCOPES: readonly ExtensionScope[] = Object.freeze([
  'session:events:read',
  'session:snapshot:read',
  'session:deletion:read',
])

export const EXTENSION_SERVICE_IDS: readonly ExtensionServiceId[] = Object.freeze([
  'memory.search',
  'memory.recall',
  'knowledge.query',
  'memory.mcp',
  'memory.manage',
])

export const EXTENSION_ERROR_CODES: readonly ExtensionErrorCode[] = Object.freeze([
  'unauthorized',
  'forbidden',
  'not_found',
  'invalid_request',
  'stale_lease',
  'cursor_expired',
  'installation_paused',
  'installation_revoked',
  'feature_disabled',
])

export const EXTENSION_PROTOCOL_VERSIONS: readonly string[] = Object.freeze([
  'extension-feed.v1',
])

/**
 * Frozen provider-facing installation inventory fields. Routes pick exactly
 * these keys; owner identity is deliberately absent from the allowlist.
 */
export const PROVIDER_INSTALLATION_FIELDS: readonly string[] = Object.freeze([
  'installation_id',
  'status',
  'config_version',
  'granted_scopes',
  'subscriptions',
  'enabled_services',
  'event_filter',
  'snapshot_required',
  'created_at',
  'updated_at',
])

export function isExtensionTopic(value: unknown): value is ExtensionTopic {
  return typeof value === 'string' && (EXTENSION_TOPICS as readonly string[]).includes(value)
}

export function isExtensionScope(value: unknown): value is ExtensionScope {
  return typeof value === 'string' && (EXTENSION_SCOPES as readonly string[]).includes(value)
}

export function isExtensionServiceId(value: unknown): value is ExtensionServiceId {
  return typeof value === 'string' && (EXTENSION_SERVICE_IDS as readonly string[]).includes(value)
}

export function isInstallationStatus(value: unknown): value is InstallationStatus {
  return typeof value === 'string'
    && (['pending', 'active', 'paused', 'revoking', 'revoked'] as const).includes(
      value as InstallationStatus,
    )
}

export function isExtensionErrorCode(value: unknown): value is ExtensionErrorCode {
  return typeof value === 'string' && (EXTENSION_ERROR_CODES as readonly string[]).includes(value)
}

export function isExtensionMode(value: unknown): value is ExtensionMode {
  return value === 'off' || value === 'shadow' || value === 'enabled'
}

const TURN_LIFECYCLE_EVENT_TYPES: readonly string[] = ['turn_status']
const SESSION_LIFECYCLE_EVENT_TYPES: readonly string[] = [
  'session_created',
  'session_discovered',
  'session_status',
]

/**
 * Versioned pure topic mapping. Unknown event types fail open to
 * session.event.v1 — the projector must never silently drop a durable event
 * just because its type postdates this mapping.
 */
export function extensionTopicForEventType(eventType: string): ExtensionTopic {
  if (TURN_LIFECYCLE_EVENT_TYPES.includes(eventType)) return 'turn.lifecycle.v1'
  if (SESSION_LIFECYCLE_EVENT_TYPES.includes(eventType)) return 'session.lifecycle.v1'
  return 'session.event.v1'
}

/** Scope required to consume each public Feed topic. */
export function requiredExtensionScopeForTopic(topic: ExtensionTopic): ExtensionScope {
  return topic === 'session.deleted.v1' || topic === 'session.access.revoked.v1'
    ? 'session:deletion:read'
    : 'session:events:read'
}
