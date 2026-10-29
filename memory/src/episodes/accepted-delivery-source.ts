import { createHash } from 'node:crypto'
import type { AdaptedTeamSource, TeamSourceAdapterInput, TeamSourceProvenance } from './team-source-adapter.js'

export interface AcceptedDeliveryProvenance {
  task_id: string
  spec_revision: number
  submission_id: string
  submission_version: number
  manifest_sha256: string
  decision_id: string
  decision: 'accepted'
  reviewer_user_id: number
  accepted_at: string
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function text(value: unknown, limit = 512): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit
}
function integer(value: unknown, minimum = 1): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

/** Reconstruct an allowlisted reference; never retain arbitrary feed fields. */
export function parseAcceptedDeliveryProvenance(value: unknown): AcceptedDeliveryProvenance | null {
  const delivery = object(value)
  if (!delivery || !text(delivery.task_id) || !integer(delivery.spec_revision)
    || !text(delivery.submission_id) || !uuid.test(delivery.submission_id)
    || !integer(delivery.submission_version) || !text(delivery.decision_id) || !uuid.test(delivery.decision_id)
    || delivery.decision !== 'accepted' || !integer(delivery.reviewer_user_id)
    || !text(delivery.manifest_sha256) || !/^[a-f0-9]{64}$/.test(delivery.manifest_sha256)
    || !timestamp(delivery.accepted_at)) return null
  return {
    task_id: delivery.task_id, spec_revision: delivery.spec_revision,
    submission_id: delivery.submission_id, submission_version: delivery.submission_version,
    manifest_sha256: delivery.manifest_sha256, decision_id: delivery.decision_id,
    decision: 'accepted', reviewer_user_id: delivery.reviewer_user_id, accepted_at: delivery.accepted_at,
  }
}

export function adaptAcceptedDeliverySource(input: TeamSourceAdapterInput): AdaptedTeamSource {
  const data = input.data
  const delivery = parseAcceptedDeliveryProvenance(data.accepted_delivery)
  const scope = object(data.read_scope)
  if (!delivery || input.event_type !== 'team_source' || data.team_source_version !== 2
    || !text(data.team_id) || !text(data.team_session_id) || !text(data.team_call_id)
    || !integer(data.context_version, 0) || !scope || scope.kind !== 'team_session'
    || scope.team_id !== data.team_id || scope.team_session_id !== data.team_session_id
    || !text(scope.team_memory_binding_id) || !integer(scope.team_memory_binding_revision)
    || !text(scope.target_installation_id) || !text(scope.target_owner_scope_id)
    || !['personal', 'team', 'organization'].includes(String(scope.target_owner_scope_kind))
    || !integer(scope.participant_user_id) || !integer(scope.participant_revision)
    || !timestamp(data.occurred_at) || data.occurred_at > delivery.accepted_at
    // Delivery records are not collaboration events. Reject invented event lineage.
    || data.team_event_ids !== undefined || data.team_event_seqs !== undefined) {
    throw new Error('invalid accepted delivery source identity')
  }
  const originalSourceId = `team-delivery:${delivery.submission_id}:${delivery.decision_id}`
  const sessionId = 'team_delivery_' + createHash('sha256').update(JSON.stringify([
    'team-accepted-delivery-v2', data.team_session_id, delivery.submission_id, delivery.decision_id,
    scope.team_memory_binding_id, scope.team_memory_binding_revision, scope.participant_user_id, scope.participant_revision,
  ])).digest('hex').slice(0, 32)
  const projectionId = `${scope.team_memory_binding_id}:${scope.team_memory_binding_revision}:${scope.participant_user_id}:${scope.participant_revision}`
  if (input.session_id !== sessionId || data.turn_id !== originalSourceId
    || (input.turn_id !== null && input.turn_id !== originalSourceId)
    || data.original_source_id !== originalSourceId || data.reader_projection_id !== projectionId
    || input.source_id !== `${originalSourceId}:${data.source_role}:${sessionId}:v2`) {
    throw new Error('inconsistent accepted delivery source identity')
  }
  let eventType: AdaptedTeamSource['eventType']
  let payload: Record<string, unknown>
  let actorScope: 'user' | 'root' | 'system'
  if (data.source_role === 'goal' && text(data.text, 49_000) && integer(data.author_user_id)) {
    eventType = 'user_goal'; actorScope = 'user'
    payload = { text: data.text, author_user_id: data.author_user_id }
  } else if (data.source_role === 'reply' && text(data.text, 32_000) && text(data.author_offer_id) && data.final === true) {
    eventType = 'agent_text'; actorScope = 'root'
    payload = { text: data.text, final: true, author_offer_id: data.author_offer_id }
  } else if (data.source_role === 'outcome' && data.status === 'completed' && data.turn_status === 'completed'
    && data.occurred_at === delivery.accepted_at && data.turn_reason === 'team_delivery_accepted') {
    eventType = 'turn_status'; actorScope = 'system'
    payload = { status: 'completed', turn_status: 'completed', turn_reason: 'team_delivery_accepted' }
  } else {
    throw new Error('invalid accepted delivery source event')
  }
  const provenance: TeamSourceProvenance = {
    source_kind: 'team_session', source_version: 2,
    original_source_id: originalSourceId, reader_projection_id: projectionId,
    team_id: data.team_id, team_session_id: data.team_session_id, team_call_id: data.team_call_id,
    context_version: data.context_version, accepted_delivery: delivery,
    ...(actorScope === 'user' ? { author_user_id: data.author_user_id as number } : {}),
    ...(actorScope === 'root' ? { author_offer_id: data.author_offer_id as string } : {}),
    read_scope: {
      kind: 'team_session', team_id: data.team_id, team_session_id: data.team_session_id,
      team_memory_binding_id: scope.team_memory_binding_id, team_memory_binding_revision: scope.team_memory_binding_revision,
      target_installation_id: scope.target_installation_id,
      target_owner_scope_kind: scope.target_owner_scope_kind as 'personal' | 'team' | 'organization',
      target_owner_scope_id: scope.target_owner_scope_id,
      participant_user_id: scope.participant_user_id, participant_revision: scope.participant_revision,
    },
  }
  return {
    origin: 'team', originPosition: input.source_id,
    canonicalEventKey: `${originalSourceId}:${data.source_role}:v2`,
    sessionId, turnId: originalSourceId, eventType, occurredAt: new Date(data.occurred_at),
    classification: { actor_scope: actorScope, flow_scope: 'main', content_class: 'dialogue', classifier_version: 'team-accepted-delivery-v2' },
    payload: { ...payload, team_source: provenance, agent_type: 'team_collaboration' }, provenance,
  }
}
