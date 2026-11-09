import {createHash} from 'node:crypto'
export const TEAM_MEMORY_SOURCE_KIND = 'team_collaboration_event'
export const TEAM_MEMORY_SOURCE_VERSION = 1 as const

export type TeamMemorySourceRole = 'goal' | 'reply' | 'outcome'

export interface TeamMemorySourceRecord {
  sourceKind: typeof TEAM_MEMORY_SOURCE_KIND
  sourceId: string
  ownerUserId: number
  sessionId: string
  eventType: 'team_source'
  occurredAt: Date
  payload: Record<string, unknown>
}

export interface TeamMemorySourceProjectionInput {
  teamId: string
  teamSessionId: string
  callId: string
  contextVersion: number
  binding: {
    id: string
    revision: number
    installationId: string
    ownerScopeKind: 'personal' | 'team' | 'organization'
    ownerScopeId: string
  }
  goal: {
    eventId: string
    eventSeq: number
    content: string
    authorUserId: number
    occurredAt: Date
  }
  reply: {
    eventIds: string[]
    eventSeqs: number[]
    content: string
    authorOfferId: string
    occurredAt: Date
  }
  outcome: {
    eventId: string
    eventSeq: number
    status: string
    occurredAt: Date
  }
  readers: Array<{ userId: number; participantRevision: number }>
}

export function teamSourceSessionId(input: {
  teamSessionId: string
  bindingId: string
  bindingRevision: number
  participantRevision: number
}): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      'team-source-binding-v1', input.teamSessionId, input.bindingId,
      input.bindingRevision, input.participantRevision,
    ]))
    .digest('hex')
    .slice(0, 32)
  return `team_${digest}`
}

// Pre-binding-ID sources can still be in the feed or retained in Memory.
// Keep their revocation fence alongside the current binding's identity.
export function legacyTeamSourceSessionId(input: {
  teamSessionId: string
  bindingRevision: number
  participantRevision: number
}): string {
  return 'team_' + createHash('sha256')
    .update(`${input.teamSessionId}:${input.bindingRevision}:${input.participantRevision}`)
    .digest('hex').slice(0, 32)
}

function sourceId(input: TeamMemorySourceProjectionInput, readerUserId: number, role: TeamMemorySourceRole): string {
  return `team:${input.callId}:${role}:u${readerUserId}:b${input.binding.revision}:v${TEAM_MEMORY_SOURCE_VERSION}`
}

export function buildTeamMemorySourceRecords(
  input: TeamMemorySourceProjectionInput,
): TeamMemorySourceRecord[] {
  if (input.reply.eventIds.length === 0 || input.reply.content.length === 0) return []
  const records: TeamMemorySourceRecord[] = []
  for (const reader of input.readers) {
    const sessionId = teamSourceSessionId({
      teamSessionId: input.teamSessionId,
      bindingId: input.binding.id,
      bindingRevision: input.binding.revision,
      participantRevision: reader.participantRevision,
    })
    const readScope = {
      kind: 'team_session',
      team_id: input.teamId,
      team_session_id: input.teamSessionId,
      team_memory_binding_id: input.binding.id,
      team_memory_binding_revision: input.binding.revision,
      target_installation_id: input.binding.installationId,
      target_owner_scope_kind: input.binding.ownerScopeKind,
      target_owner_scope_id: input.binding.ownerScopeId,
      participant_user_id: reader.userId,
      participant_revision: reader.participantRevision,
    }
    const common = {
      original_source_id: `team:${input.teamId}:${input.teamSessionId}:${input.callId}`,
      reader_projection_id: `${input.binding.id}:${input.binding.revision}:${reader.userId}:${reader.participantRevision}`,
      team_source_version: TEAM_MEMORY_SOURCE_VERSION,
      team_id: input.teamId,
      team_session_id: input.teamSessionId,
      team_call_id: input.callId,
      context_version: input.contextVersion,
      turn_id: `team-call:${input.callId}`,
      read_scope: readScope,
      classifier_version: 'team-source-v1',
      flow_scope: 'main',
      content_class: 'dialogue',
    }
    records.push({
      sourceKind: TEAM_MEMORY_SOURCE_KIND,
      sourceId: sourceId(input, reader.userId, 'goal'),
      ownerUserId: reader.userId,
      sessionId,
      eventType: 'team_source',
      occurredAt: input.goal.occurredAt,
      payload: {
        ...common,
        source_role: 'goal',
        actor_scope: 'user',
        text: input.goal.content,
        team_event_ids: [input.goal.eventId],
        team_event_seqs: [input.goal.eventSeq],
        author_user_id: input.goal.authorUserId,
        occurred_at: input.goal.occurredAt.toISOString(),
      },
    }, {
      sourceKind: TEAM_MEMORY_SOURCE_KIND,
      sourceId: sourceId(input, reader.userId, 'reply'),
      ownerUserId: reader.userId,
      sessionId,
      eventType: 'team_source',
      occurredAt: input.reply.occurredAt,
      payload: {
        ...common,
        source_role: 'reply',
        actor_scope: 'root',
        text: input.reply.content,
        final: true,
        team_event_ids: input.reply.eventIds,
        team_event_seqs: input.reply.eventSeqs,
        author_offer_id: input.reply.authorOfferId,
        occurred_at: input.reply.occurredAt.toISOString(),
      },
    }, {
      sourceKind: TEAM_MEMORY_SOURCE_KIND,
      sourceId: sourceId(input, reader.userId, 'outcome'),
      ownerUserId: reader.userId,
      sessionId,
      eventType: 'team_source',
      occurredAt: input.outcome.occurredAt,
      payload: {
        ...common,
        source_role: 'outcome',
        actor_scope: 'system',
        status: input.outcome.status,
        turn_status: input.outcome.status,
        turn_reason: 'team_agent_call_terminal',
        team_event_ids: [input.outcome.eventId],
        team_event_seqs: [input.outcome.eventSeq],
        occurred_at: input.outcome.occurredAt.toISOString(),
      },
    })
  }
  return records
}

