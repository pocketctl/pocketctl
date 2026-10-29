import { createHash } from 'node:crypto'
import type { TeamMemorySourceProjectionInput, TeamMemorySourceRecord } from './memory-source-projector.js'

export const ACCEPTED_DELIVERY_SOURCE_VERSION = 2 as const

/** Only immutable, shared delivery data belongs here. Never pass native transcripts or file bytes. */
export interface AcceptedDeliveryMemoryInput {
  teamId: string
  teamSessionId: string
  callId: string
  contextVersion: number
  binding: TeamMemorySourceProjectionInput['binding']
  readers: TeamMemorySourceProjectionInput['readers']
  taskId: string
  spec: { revision: number; goal: string; acceptance: string; authorUserId: number; createdAt: Date }
  submission: {
    id: string; version: number; summary: string; manifestSha256: string
    authorOfferId: string; publishedAt: Date
  }
  decision: { id: string; decision: 'accepted'; reviewerUserId: number; createdAt: Date }
}

export function acceptedDeliverySourceSessionId(input: {
  teamSessionId: string; submissionId: string; decisionId: string
  bindingId: string; bindingRevision: number; userId: number; participantRevision: number
}): string {
  return 'team_delivery_' + createHash('sha256').update(JSON.stringify([
    'team-accepted-delivery-v2', input.teamSessionId, input.submissionId, input.decisionId,
    input.bindingId, input.bindingRevision, input.userId, input.participantRevision,
  ])).digest('hex').slice(0, 32)
}

function text(value: unknown, limit: number): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit
}
function integer(value: unknown, minimum = 1): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function buildAcceptedDeliveryMemorySourceRecords(input: AcceptedDeliveryMemoryInput): TeamMemorySourceRecord[] {
  const { spec, submission, decision, binding } = input
  if (![input.teamId, input.teamSessionId, input.callId, input.taskId, binding.id,
    binding.installationId, binding.ownerScopeId, submission.authorOfferId].every(id => text(id, 512))
    || !['personal', 'team', 'organization'].includes(binding.ownerScopeKind)
    || !integer(input.contextVersion, 0) || !integer(spec.revision) || !integer(spec.authorUserId)
    || !integer(submission.version) || !integer(decision.reviewerUserId) || !integer(binding.revision)
    || !uuid.test(submission.id) || !uuid.test(decision.id) || !/^[a-f0-9]{64}$/.test(submission.manifestSha256)
    || !text(spec.goal, 32_000) || !text(spec.acceptance, 16_000) || !text(submission.summary, 32_000)
    || decision.decision !== 'accepted'
    || ![spec.createdAt, submission.publishedAt, decision.createdAt].every(date => date instanceof Date && Number.isFinite(date.getTime()))
    || spec.createdAt > submission.publishedAt || submission.publishedAt > decision.createdAt
    || !input.readers.every(reader => integer(reader.userId) && integer(reader.participantRevision))) {
    throw new Error('invalid accepted delivery Memory source')
  }
  const originalSourceId = `team-delivery:${submission.id}:${decision.id}`
  const acceptedDelivery = {
    task_id: input.taskId, spec_revision: spec.revision,
    submission_id: submission.id, submission_version: submission.version,
    manifest_sha256: submission.manifestSha256, decision_id: decision.id,
    decision: 'accepted', reviewer_user_id: decision.reviewerUserId,
    accepted_at: decision.createdAt.toISOString(),
  }
  const readers = new Map<number, number>()
  for (const reader of input.readers) {
    if (readers.has(reader.userId) && readers.get(reader.userId) !== reader.participantRevision) {
      throw new Error('conflicting accepted delivery reader revision')
    }
    readers.set(reader.userId, reader.participantRevision)
  }
  const records: TeamMemorySourceRecord[] = []
  for (const [userId, participantRevision] of readers) {
    const sessionId = acceptedDeliverySourceSessionId({
      teamSessionId: input.teamSessionId, submissionId: submission.id, decisionId: decision.id,
      bindingId: binding.id, bindingRevision: binding.revision, userId, participantRevision,
    })
    const common = {
      original_source_id: originalSourceId, turn_id: originalSourceId,
      reader_projection_id: `${binding.id}:${binding.revision}:${userId}:${participantRevision}`,
      team_source_version: ACCEPTED_DELIVERY_SOURCE_VERSION,
      team_id: input.teamId, team_session_id: input.teamSessionId, team_call_id: input.callId,
      context_version: input.contextVersion, accepted_delivery: acceptedDelivery,
      read_scope: {
        kind: 'team_session', team_id: input.teamId, team_session_id: input.teamSessionId,
        team_memory_binding_id: binding.id, team_memory_binding_revision: binding.revision,
        target_installation_id: binding.installationId, target_owner_scope_kind: binding.ownerScopeKind,
        target_owner_scope_id: binding.ownerScopeId, participant_user_id: userId,
        participant_revision: participantRevision,
      },
      classifier_version: 'team-accepted-delivery-v2', flow_scope: 'main', content_class: 'dialogue',
    }
    const events = [
      { role: 'goal', at: spec.createdAt, data: {
        actor_scope: 'user', text: `${spec.goal}\n\nAcceptance criteria:\n${spec.acceptance}`,
        author_user_id: spec.authorUserId,
      } },
      { role: 'reply', at: submission.publishedAt, data: {
        actor_scope: 'root', text: submission.summary, final: true, author_offer_id: submission.authorOfferId,
      } },
      { role: 'outcome', at: decision.createdAt, data: {
        actor_scope: 'system', status: 'completed', turn_status: 'completed', turn_reason: 'team_delivery_accepted',
      } },
    ]
    for (const event of events) records.push({
      sourceKind: 'team_collaboration_event', sourceId: `${originalSourceId}:${event.role}:${sessionId}:v2`,
      ownerUserId: userId, sessionId, eventType: 'team_source', occurredAt: event.at,
      payload: { ...common, ...event.data, source_role: event.role, occurred_at: event.at.toISOString() },
    })
  }
  return records
}
