import type { RelayHttpClient } from './http-client.js'
import type { ProviderTokenClient } from './token-client.js'
import { withProviderAuthRetry } from './token-client.js'

export interface SnapshotClientOptions {
  http: RelayHttpClient
  tokens: ProviderTokenClient
}

/** Inventory sessions, page one session's snapshot, and ACK reconciliation. */
export function createSnapshotClient(options: SnapshotClientOptions) {
  const { http, tokens } = options

  return {
    async listSessions(installationId: string, cursor?: string): Promise<{
      sessions: Array<Record<string, unknown>>
      next_cursor: string
    }> {
      const query = cursor
        ? `installation_id=${installationId}&cursor=${encodeURIComponent(cursor)}`
        : `installation_id=${installationId}`
      const body = await withProviderAuthRetry(tokens, 'list_sessions', token =>
        http.request('GET', `/api/extensions/v1/sessions?${query}`, {
          operation: 'list_sessions',
          token,
        }))
      const parsed = body as { sessions?: unknown; next_cursor?: unknown } | null
      if (!Array.isArray(parsed?.sessions) || typeof parsed?.next_cursor !== 'string') {
        throw new Error('list_sessions returned a malformed page')
      }
      return { sessions: parsed.sessions as Array<Record<string, unknown>>, next_cursor: parsed.next_cursor }
    },

    async getSnapshot(installationId: string, sessionId: string, cursor?: string): Promise<{
      events: Array<Record<string, unknown>>
      next_cursor: string
    }> {
      const query = cursor
        ? `installation_id=${installationId}&cursor=${encodeURIComponent(cursor)}`
        : `installation_id=${installationId}`
      const body = await withProviderAuthRetry(tokens, 'get_snapshot', token =>
        http.request('GET', `/api/extensions/v1/sessions/${encodeURIComponent(sessionId)}/snapshot?${query}`, {
          operation: 'get_snapshot',
          token,
        }))
      const parsed = body as { events?: unknown; next_cursor?: unknown } | null
      if (!Array.isArray(parsed?.events) || typeof parsed?.next_cursor !== 'string') {
        throw new Error('get_snapshot returned a malformed page')
      }
      return { events: parsed.events as Array<Record<string, unknown>>, next_cursor: parsed.next_cursor }
    },

    async acknowledgeReconcile(installationId: string): Promise<void> {
      await withProviderAuthRetry(tokens, 'acknowledge_reconcile', token =>
        http.request('POST', `/api/extensions/v1/provider/installations/${installationId}/reconciled`, {
          operation: 'acknowledge_reconcile',
          token,
        }))
    },
  }
}

export type SnapshotClient = ReturnType<typeof createSnapshotClient>
