import type { RelayHttpClient } from './http-client.js'
import type { ProviderTokenClient } from './token-client.js'
import { withProviderAuthRetry } from './token-client.js'

export interface PurgeClientOptions {
  http: RelayHttpClient
  tokens: ProviderTokenClient
}

/** Provider purge queue: list pending requests and ack them with a receipt. */
export function createPurgeClient(options: PurgeClientOptions) {
  const { http, tokens } = options

  return {
    async listSessionDeletions():Promise<Array<Record<string,unknown>>>{
      const body=await withProviderAuthRetry(tokens,'list_session_deletions',token=>http.request('GET','/api/extensions/v1/session-deletions',{operation:'list_session_deletions',token}))
      const parsed=body as {deletions?:unknown}|null
      if(!Array.isArray(parsed?.deletions))throw new Error('session deletion queue returned malformed page')
      return parsed.deletions as Array<Record<string,unknown>>
    },
    async acknowledgeSessionDeletion(requestId:string,receipt:string):Promise<void>{
      await withProviderAuthRetry(tokens,'acknowledge_session_deletion',token=>http.request('POST',`/api/extensions/v1/session-deletions/${requestId}/ack`,
        {operation:'acknowledge_session_deletion',token,body:{provider_receipt:receipt}}))
    },
    async listPurges(): Promise<Array<Record<string, unknown>>> {
      const body = await withProviderAuthRetry(tokens, 'list_purges', token =>
        http.request('GET', '/api/extensions/v1/purges', {
          operation: 'list_purges',
          token,
        }))
      const parsed = body as { purges?: unknown } | null
      if (!Array.isArray(parsed?.purges)) {
        throw new Error('list_purges returned a malformed page')
      }
      return parsed.purges as Array<Record<string, unknown>>
    },

    async acknowledgePurge(requestId: string, receipt: string): Promise<void> {
      await withProviderAuthRetry(tokens, 'acknowledge_purge', token =>
        http.request('POST', `/api/extensions/v1/purges/${requestId}/ack`, {
          operation: 'acknowledge_purge',
          token,
          body: { provider_receipt: receipt },
        }))
    },
  }
}

export type PurgeClient = ReturnType<typeof createPurgeClient>
