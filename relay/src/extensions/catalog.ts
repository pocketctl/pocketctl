import type pg from 'pg'
import {
  isScopeControlTopic,
  requiredExtensionScopeForTopic,
  type ExtensionMode,
  type ExtensionScope,
  type ExtensionTopicV2,
} from './types.js'

/**
 * First-party provider allowlist. Version one is entirely code-owned: the
 * database stores only the enabled flag and the current manifest version,
 * and a remote provider can never submit endpoints or widen permissions.
 */
export interface ExtensionProviderService {
  readonly service_id: string
  readonly mode: 'read' | 'write' | 'agent_tool' | 'mcp'
  readonly metered: boolean
}

export interface ExtensionProviderManifest {
  readonly provider_id: string
  /**
   * Manifest revision stored in extension_providers.manifest_version. Bump it
   * whenever the manifest changes; the bump must never rewrite existing
   * installations — users opt into new services explicitly.
   */
  readonly manifest_version: number
  readonly display_name: string
  readonly provider_version: string
  readonly protocol_versions: readonly string[]
  readonly subscriptions: readonly ExtensionTopicV2[]
  readonly requested_scopes: readonly ExtensionScope[]
  readonly services: readonly ExtensionProviderService[]
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

const POCKETCTL_MEMORY_MANIFEST: ExtensionProviderManifest = deepFreeze({
  provider_id: 'pocketctl-memory',
  // v3 adds memory.context. v4 adds the v2 scope-control topics/scope for
  // shared Team/Organization installations. v5 adds the Phase 4
  // least-privilege source-sync service. Existing installations are never
  // widened by the catalog upsert; users must explicitly include new grants.
  manifest_version: 5,
  display_name: 'PocketCtl Memory',
  provider_version: '1.0.0',
  protocol_versions: Object.freeze(['extension-feed.v1', 'extension-feed.v2']),
  subscriptions: Object.freeze([
    'session.event.v1',
    'session.lifecycle.v1',
    'turn.lifecycle.v1',
    'session.deleted.v1',
    'session.access.revoked.v1',
    'scope.membership.v2',
    'scope.lifecycle.v2',
    'scope.installation.v2',
  ]),
  requested_scopes: Object.freeze([
    'session:events:read',
    'session:snapshot:read',
    'session:deletion:read',
    'scope:control:read',
  ]),
  services: Object.freeze([
    Object.freeze({ service_id: 'memory.search', mode: 'read', metered: true }),
    Object.freeze({ service_id: 'memory.recall', mode: 'read', metered: true }),
    Object.freeze({ service_id: 'knowledge.query', mode: 'read', metered: true }),
    Object.freeze({ service_id: 'memory.mcp', mode: 'mcp', metered: true }),
    Object.freeze({ service_id: 'memory.manage', mode: 'write', metered: false }),
    Object.freeze({ service_id: 'memory.context', mode: 'agent_tool', metered: true }),
    Object.freeze({ service_id: 'memory.codegraph.write', mode: 'write', metered: false }),
  ]),
})

export const EXTENSION_PROVIDER_CATALOG: readonly ExtensionProviderManifest[] = Object.freeze([
  POCKETCTL_MEMORY_MANIFEST,
])

export function getExtensionProviderManifest(
  providerId: string,
): ExtensionProviderManifest | undefined {
  return EXTENSION_PROVIDER_CATALOG.find(entry => entry.provider_id === providerId)
}

/**
 * Upsert catalog definitions at startup. The operational status column is
 * deliberately excluded from the update so an operator-disabled provider
 * stays disabled across upgrades.
 */
export async function upsertProviderDefinitions(pool: Pick<pg.Pool, 'query'>): Promise<void> {
  for (const manifest of EXTENSION_PROVIDER_CATALOG) {
    await pool.query(
      `INSERT INTO extension_providers (provider_id, manifest_version, manifest)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (provider_id) DO UPDATE SET
         manifest_version = EXCLUDED.manifest_version,
         manifest = EXCLUDED.manifest,
         updated_at = NOW()`,
      [manifest.provider_id, manifest.manifest_version, JSON.stringify(manifest)],
    )
  }
}

/** Seed the code-owned catalog only after its schema exists. */
export async function initializeExtensionProviderCatalog(
  pool: Pick<pg.Pool, 'query'>,
  mode: ExtensionMode,
): Promise<boolean> {
  try {
    await upsertProviderDefinitions(pool)
    return true
  } catch (error) {
    if (mode !== 'off') throw error
    return false
  }
}

export interface InstallationGrantInput {
  granted_scopes: unknown
  subscriptions: unknown
  enabled_services: unknown
  event_filter?: unknown
}

export interface InstallationGrantValidation {
  valid: boolean
  granted_scopes?: ExtensionScope[]
  subscriptions?: ExtensionTopicV2[]
  enabled_services?: string[]
  event_filter?: Record<string, unknown>
}

const MAX_SCOPES = 8
const MAX_TOPICS = 16
const MAX_SERVICES = 16
const MAX_FILTER_ITEMS = 64

function stringArray(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value)) return null
  if (value.length === 0 || value.length > max) return null
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 128) return null
    if (seen.has(entry)) return null
    seen.add(entry)
  }
  return [...seen]
}

function validateEventFilter(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const filter = value as Record<string, unknown>
  const allowed: Record<string, unknown> = {}
  for (const key of ['daemon_ids', 'agent_types'] as const) {
    if (filter[key] === undefined) continue
    const items = filter[key]
    if (!Array.isArray(items) || items.length > MAX_FILTER_ITEMS) return null
    for (const item of items) {
      if (typeof item !== 'string' || item.length === 0 || item.length > 128) return null
    }
    allowed[key] = [...items as string[]]
  }
  for (const key of Object.keys(filter)) {
    if (key !== 'daemon_ids' && key !== 'agent_types') return null
  }
  return allowed
}

/**
 * A user may only grant subsets of what the manifest requests; event filters
 * are limited to daemon_ids/agent_types until stable repository identity
 * exists.
 */
export function validateInstallationGrant(
  providerId: string,
  input: InstallationGrantInput,
): InstallationGrantValidation {
  const manifest = getExtensionProviderManifest(providerId)
  if (!manifest) return { valid: false }
  const scopes = stringArray(input.granted_scopes, MAX_SCOPES)
  const topics = stringArray(input.subscriptions, MAX_TOPICS)
  const services = stringArray(input.enabled_services, MAX_SERVICES)
  if (!scopes || !topics || !services) return { valid: false }
  if (!scopes.every(scope => (manifest.requested_scopes as readonly string[]).includes(scope))) {
    return { valid: false }
  }
  if (!topics.every(topic => (manifest.subscriptions as readonly string[]).includes(topic))) {
    return { valid: false }
  }
  if (!topics.every(topic => typeof topic === 'string'
    && (isScopeControlTopic(topic)
      ? scopes.includes('scope:control:read')
      : scopes.includes(requiredExtensionScopeForTopic(topic as ExtensionTopicV2))))) {
    return { valid: false }
  }
  if (!services.every(service => manifest.services.some(entry => entry.service_id === service))) {
    return { valid: false }
  }
  const eventFilter = validateEventFilter(input.event_filter)
  if (eventFilter === null) return { valid: false }
  return {
    valid: true,
    granted_scopes: scopes as ExtensionScope[],
    subscriptions: topics as ExtensionTopicV2[],
    enabled_services: services,
    event_filter: eventFilter,
  }
}
