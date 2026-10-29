import type { RelayHttpClient } from './http-client.js'
import type { ProviderTokenClient } from './token-client.js'
import { withProviderAuthRetry } from './token-client.js'

export interface DeliveryWithdrawalItem {
  sequence: string; team_id: string; team_session_id: string
  submission_id: string; decision_id: string; recorded_at: string
}
export interface DeliveryWithdrawalBatch {
  version: 1; consumer_id: string; items: DeliveryWithdrawalItem[]; through_sequence: string
  next_cursor: string; lease_token: string; lease_expires_at: string
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const decimal = (n: unknown): n is string => typeof n === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(n) && BigInt(n) <= 9223372036854775807n
const text = (s: unknown, max: number): s is string => typeof s === 'string' && s.trim().length > 0 && s.length <= max
const timestamp = (s: unknown): s is string => typeof s === 'string' && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => key in value)

/** Control records fail closed as a whole. Never quarantine-and-ACK a malformed
 * source invalidation or allow arbitrary content into the provider stream. */
export function validateDeliveryWithdrawalBatch(value: unknown, consumerId: string): DeliveryWithdrawalBatch {
  const invalid = () => new Error('invalid delivery withdrawal batch')
  if (!object(value) || !exact(value, ['version','consumer_id','items','through_sequence','next_cursor','lease_token','lease_expires_at'])
    || value.version !== 1 || value.consumer_id !== consumerId || !uuid.test(consumerId)
    || !Array.isArray(value.items) || value.items.length > 100 || !decimal(value.through_sequence)
    || !text(value.next_cursor, 2048) || !text(value.lease_token, 128) || !timestamp(value.lease_expires_at)) throw invalid()
  let last = 0n
  const items = value.items.map(item => {
    if (!object(item) || !exact(item, ['sequence','team_id','team_session_id','submission_id','decision_id','recorded_at'])
      || !decimal(item.sequence) || BigInt(item.sequence) <= last
      || !text(item.team_id, 512) || !text(item.team_session_id, 512)
      || typeof item.submission_id !== 'string' || !uuid.test(item.submission_id)
      || typeof item.decision_id !== 'string' || !uuid.test(item.decision_id) || !timestamp(item.recorded_at)) throw invalid()
    last = BigInt(item.sequence)
    return { sequence: item.sequence, team_id: item.team_id, team_session_id: item.team_session_id,
      submission_id: item.submission_id, decision_id: item.decision_id, recorded_at: item.recorded_at }
  })
  if (items.length && last !== BigInt(value.through_sequence)) throw invalid()
  return { version: 1, consumer_id: consumerId, items, through_sequence: value.through_sequence,
    next_cursor: value.next_cursor, lease_token: value.lease_token, lease_expires_at: value.lease_expires_at }
}

export function createDeliveryWithdrawalClient(options: { http: RelayHttpClient; tokens: ProviderTokenClient }) {
  const endpoint = '/api/extensions/v1/team-delivery-withdrawals'
  return {
    async pull(consumerId: string, lastSequence: string): Promise<DeliveryWithdrawalBatch> {
      const response = await withProviderAuthRetry(options.tokens, 'pull_delivery_withdrawals', token =>
        options.http.request('GET', `${endpoint}?consumer_id=${consumerId}&after_sequence=${lastSequence}&limit=100`, { token, operation: 'pull_delivery_withdrawals' }))
      return validateDeliveryWithdrawalBatch(response, consumerId)
    },
    async ack(batch: DeliveryWithdrawalBatch): Promise<string> {
      const response = await withProviderAuthRetry(options.tokens, 'ack_delivery_withdrawals', token =>
        options.http.request('POST', `${endpoint}/ack`, { token, operation: 'ack_delivery_withdrawals', body: {
          consumer_id: batch.consumer_id, cursor: batch.next_cursor, lease_token: batch.lease_token,
        } }))
      if (!object(response) || !decimal(response.ack_sequence) || BigInt(response.ack_sequence) < BigInt(batch.through_sequence)) {
        throw new Error('invalid delivery withdrawal ACK')
      }
      return response.ack_sequence
    },
  }
}
