import type { RelayHttpClient } from './http-client.js'
import type { ProviderTokenClient } from './token-client.js'
import { withProviderAuthRetry } from './token-client.js'

export interface ReportingClientOptions {
  http: RelayHttpClient
  tokens: ProviderTokenClient
}

/** Per-installation status heartbeat and usage fact batches. */
export function createReportingClient(options: ReportingClientOptions) {
  const { http, tokens } = options

  return {
    async reportStatus(input: Record<string, unknown>): Promise<void> {
      await withProviderAuthRetry(tokens, 'report_status', token =>
        http.request('POST', '/api/extensions/v1/status', {
          operation: 'report_status',
          token,
          body: input,
        }))
    },

    async reportUsage(installationId: string, facts: Array<Record<string, unknown>>): Promise<number> {
      const body = await withProviderAuthRetry(tokens, 'report_usage', token =>
        http.request('POST', '/api/extensions/v1/usage/batch', {
          operation: 'report_usage',
          token,
          body: { installation_id: installationId, facts },
        })) as { ingested?: unknown } | null
      return Number(body?.ingested ?? facts.length)
    },
  }
}

export type ReportingClient = ReturnType<typeof createReportingClient>
