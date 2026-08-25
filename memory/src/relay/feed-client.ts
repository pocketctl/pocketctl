import type { FeedBatch } from './contracts.js'
import { validateFeedBatch } from './validation.js'
import type { RelayHttpClient } from './http-client.js'
import type { ProviderTokenClient } from './token-client.js'
import { withProviderAuthRetry } from './token-client.js'

export interface FeedClientOptions {
  http: RelayHttpClient
  tokens: ProviderTokenClient
}

/** Pull and ACK the extension feed for one installation. */
export function createFeedClient(options: FeedClientOptions) {
  const { http, tokens } = options

  return {
    async pullFeed(installationId: string, limit: number): Promise<FeedBatch> {
      const body = await withProviderAuthRetry(tokens, 'pull_feed', token =>
        http.request('GET', `/api/extensions/v1/feed?installation_id=${installationId}&limit=${limit}`, {
          operation: 'pull_feed',
          token,
        }))
      const decision = validateFeedBatch(body)
      if (!decision.ok) {
        // A malformed batch is never acked and never partially stored.
        throw new Error('pull_feed returned a malformed batch')
      }
      return decision.batch
    },

    async ackFeed(input: { installation_id: string; cursor: string; lease_token: string }): Promise<number> {
      const body = await withProviderAuthRetry(tokens, 'ack_feed', token =>
        http.request('POST', '/api/extensions/v1/feed/ack', {
          operation: 'ack_feed',
          token,
          body: input,
        })) as { ack_feed_id?: unknown } | null
      return Number(body?.ack_feed_id ?? 0)
    },
  }
}

export type FeedClient = ReturnType<typeof createFeedClient>
