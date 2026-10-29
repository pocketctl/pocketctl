import { createHash } from 'node:crypto'

export interface DeliveryWithdrawal {
  teamId: string; teamSessionId: string; submissionId: string; decisionId: string
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 512
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/** Called only for authenticated Relay Feed data, never for model/user text. */
export function deliveryWithdrawal(input: {
  topic: string; source_kind: string; source_id: string; session_id: string | null
  event_type: string; data: Record<string, unknown>
}): DeliveryWithdrawal | null {
  const data = input.data
  if (!input.source_id.startsWith('team-delivery-withdraw:')
    && !(data.team_delivery_source_revoked === true && data.reason === 'artifact_revoked')) return null
  if (input.topic !== 'session.access.revoked.v1' || input.source_kind !== 'session_access_revoked'
    || input.event_type !== 'session_access_revoked' || data.team_delivery_source_revoked !== true || data.reason !== 'artifact_revoked'
    || !text(data.team_id) || !text(data.team_session_id) || !text(data.submission_id) || !uuid.test(data.submission_id)
    || !text(data.decision_id) || !uuid.test(data.decision_id) || !text(data.team_memory_binding_id)
    || !integer(data.team_memory_binding_revision) || !integer(data.participant_user_id) || !integer(data.participant_revision)) {
    throw new Error('invalid Team delivery withdrawal')
  }
  const sessionId = 'team_delivery_' + createHash('sha256').update(JSON.stringify([
    'team-accepted-delivery-v2', data.team_session_id, data.submission_id, data.decision_id,
    data.team_memory_binding_id, data.team_memory_binding_revision, data.participant_user_id, data.participant_revision,
  ])).digest('hex').slice(0, 32)
  if (input.session_id !== sessionId || input.source_id !== `team-delivery-withdraw:${sessionId}`) {
    throw new Error('inconsistent Team delivery withdrawal')
  }
  return { teamId: data.team_id, teamSessionId: data.team_session_id, submissionId: data.submission_id, decisionId: data.decision_id }
}

/** Used by current/historical reads and the final atomic Context consume SQL.
 * Retained audit rows do not become usable knowledge after source withdrawal. */
export function deliveryVersionAvailableSql(version = 'v'): string {
  return `memory_delivery_version_available(${version}.installation_id,${version}.version_id)`
}
