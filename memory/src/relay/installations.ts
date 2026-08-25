import type { ProviderInstallationItem, ProviderInstallationPage } from './contracts.js'
import type { RelayHttpClient } from './http-client.js'
import type { ProviderTokenClient } from './token-client.js'
import { withProviderAuthRetry } from './token-client.js'

export interface InstallationsClientOptions {
  http: RelayHttpClient
  tokens: ProviderTokenClient
}

const INSTALLATION_STATUSES = new Set(['pending', 'active', 'paused', 'revoking', 'revoked'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseInstallationItem(input: unknown): ProviderInstallationItem | null {
  if (typeof input !== 'object' || input === null) return null
  const row = input as Record<string, unknown>
  if (typeof row.installation_id !== 'string' || !UUID_PATTERN.test(row.installation_id)) return null
  if (typeof row.status !== 'string' || !INSTALLATION_STATUSES.has(row.status)) return null
  if (typeof row.config_version !== 'string' || !/^[1-9][0-9]*$/.test(row.config_version)) return null
  if (!Array.isArray(row.granted_scopes) || !Array.isArray(row.subscriptions)
    || !Array.isArray(row.enabled_services)) return null
  if (typeof row.event_filter !== 'object' || row.event_filter === null || Array.isArray(row.event_filter)) return null
  if (typeof row.snapshot_required !== 'boolean') return null
  if (typeof row.created_at !== 'string' || typeof row.updated_at !== 'string') return null
  return {
    installation_id: row.installation_id,
    status: row.status as ProviderInstallationItem['status'],
    config_version: row.config_version,
    granted_scopes: row.granted_scopes as string[],
    subscriptions: row.subscriptions as ProviderInstallationItem['subscriptions'],
    enabled_services: row.enabled_services as string[],
    event_filter: row.event_filter as Record<string, unknown>,
    snapshot_required: row.snapshot_required,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/**
 * Provider installation inventory (R0). Response shapes are validated
 * strictly: anything malformed fails the page so discovery never commits a
 * partial generation.
 */
export function createInstallationsClient(options: InstallationsClientOptions) {
  const { http, tokens } = options

  return {
    async listInstallations(cursor?: string): Promise<ProviderInstallationPage> {
      const query = cursor ? `cursor=${encodeURIComponent(cursor)}` : ''
      const body = await withProviderAuthRetry(tokens, 'list_installations', token =>
        http.request('GET', `/api/extensions/v1/provider/installations${query ? `?${query}` : ''}`, {
          operation: 'list_installations',
          token,
        }))
      const parsed = body as {
        installations?: unknown
        next_cursor?: unknown
        has_more?: unknown
      } | null
      if (!Array.isArray(parsed?.installations)
        || typeof parsed?.next_cursor !== 'string'
          && parsed?.next_cursor !== null
        || typeof parsed?.has_more !== 'boolean') {
        throw new Error('list_installations returned a malformed page')
      }
      const installations: ProviderInstallationItem[] = []
      for (const entry of parsed.installations) {
        const parsedItem = parseInstallationItem(entry)
        if (!parsedItem) throw new Error('list_installations returned a malformed item')
        installations.push(parsedItem)
      }
      return {
        installations,
        next_cursor: parsed.next_cursor as string | null,
        has_more: parsed.has_more as boolean,
      }
    },
  }
}

export type InstallationsClient = ReturnType<typeof createInstallationsClient>
