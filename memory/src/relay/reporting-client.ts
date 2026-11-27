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
    async reportMaintenance(input: Record<string, unknown>): Promise<void> {
      await withProviderAuthRetry(tokens, 'report_maintenance', token => http.request('POST', '/api/extensions/v1/maintenance', {
        operation: 'report_maintenance', token, body: input,
      }))
    },
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
        })) as { installation_id?:unknown;ingested?:unknown;acknowledged_usage_ids?:unknown } | null
      const ids=new Set(facts.map(f=>f.usage_id)),count=body?.ingested,ack=body?.acknowledged_usage_ids
      const exact=Array.isArray(ack) && ack.length===facts.length && new Set(ack).size===ids.size && ack.every(id=>ids.has(id))
      // Older Relays can prove a wholly new batch by its insert count. Their
      // duplicate-only/partial count cannot prove that the prior fees match.
      if(ids.size!==facts.length || body?.installation_id!==installationId || typeof count!=='number' || !Number.isSafeInteger(count)
        || count<0 || count>facts.length || (!exact && !(ack===undefined && count===facts.length))) {
        throw Object.assign(new Error('usage_receipt_unverified'),{code:'usage_receipt_unverified'})
      }
      return count
    },
  }
}

export type ReportingClient = ReturnType<typeof createReportingClient>
