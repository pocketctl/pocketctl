import { createHash } from 'node:crypto'
import type pg from 'pg'

import type { TeamEvent } from './types.js'

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
function legacyTeamSourceSessionId(input: {
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

export interface TeamMemorySourceProjectorLike {
  projectCompletedCall(client: Pick<pg.PoolClient, 'query'>, callId: string, outcome: TeamEvent): Promise<number>
  revokeReaderSession?(client: Pick<pg.PoolClient, 'query'>, input: {
    teamSessionId: string
    userId: number
    participantRevision: number
    bindingId?: string
    bindingRevision?: number
    reason: 'participant_removed' | 'binding_removed'
  }): Promise<number>
  revokeTeamBinding?(client: Pick<pg.PoolClient, 'query'>, input: {
    teamId: string
    bindingId: string
    bindingRevision: number
  }): Promise<number>
}

export class TeamMemorySourceProjector implements TeamMemorySourceProjectorLike {
  constructor(private readonly enabled: boolean) {}

  async projectCompletedCall(
    client: Pick<pg.PoolClient, 'query'>,
    callId: string,
    outcome: TeamEvent,
  ): Promise<number> {
    if (!this.enabled || outcome.kind !== 'status') return 0
    const call = await client.query<{
      call_id: string
      context_version: string | number
      team_session_id: string
      team_id: string
      goal_event_id: string
      goal_event_seq: string | number
      goal_content: string
      goal_author_user_id: string | number
      goal_created_at: Date
      binding_id: string
      binding_revision: string | number
      installation_id: string
      owner_scope_kind: 'personal' | 'team' | 'organization'
      owner_scope_id: string
    }>(`
      SELECT call.call_id, call.context_version, session.team_session_id, session.team_id,
             goal.event_id AS goal_event_id, goal.event_seq AS goal_event_seq,
             goal.content AS goal_content, goal.author_user_id AS goal_author_user_id,
             goal.created_at AS goal_created_at,
             memory.binding_id, memory.revision AS binding_revision,
             memory.installation_id, memory.owner_scope_kind, memory.owner_scope_id
      FROM collaboration_calls call
      JOIN collaboration_sessions session ON session.team_session_id = call.team_session_id
      JOIN collaboration_events goal ON goal.event_id = call.event_id
      JOIN team_memory_bindings memory ON memory.team_id = session.team_id AND memory.state = 'active'
      WHERE call.call_id = $1 AND goal.kind = 'member_message'
      FOR SHARE OF call, session, goal, memory
    `, [callId])
    const row = call.rows[0]
    if (!row || row.goal_author_user_id === null) return 0

    const [reply, readers] = await Promise.all([
      client.query<{
        event_id: string
        event_seq: string | number
        content: string
        author_offer_id: string
        created_at: Date
      }>(`
        SELECT event_id, event_seq, content, author_offer_id, created_at
        FROM collaboration_events
        WHERE call_id = $1 AND kind = 'agent_message'
        ORDER BY event_seq
      `, [callId]),
      client.query<{ user_id: string | number; participant_revision: string | number }>(`
        SELECT participant.user_id, participant.revision AS participant_revision
        FROM collaboration_session_participants participant
        JOIN collaboration_team_memberships membership
          ON membership.team_id = $2 AND membership.user_id = participant.user_id
         AND membership.state = 'active'
        JOIN extension_installations installation
          ON installation.owner_user_id = participant.user_id
         AND installation.provider_id = 'pocketctl-memory'
         AND installation.owner_scope_kind = 'personal'
         AND installation.status IN ('pending', 'active')
         AND installation.subscriptions @> ARRAY['session.event.v1']::text[]
         AND installation.enabled_services @> ARRAY['memory.manage']::text[]
        WHERE participant.team_session_id = $1 AND participant.state = 'active'
        ORDER BY participant.user_id
      `, [row.team_session_id, row.team_id]),
    ])
    if (reply.rows.length === 0 || readers.rows.length === 0) return 0
    const lastReply = reply.rows[reply.rows.length - 1]
    const records = buildTeamMemorySourceRecords({
      teamId: row.team_id,
      teamSessionId: row.team_session_id,
      callId: row.call_id,
      contextVersion: Number(row.context_version),
      binding: {
        id: row.binding_id,
        revision: Number(row.binding_revision),
        installationId: row.installation_id,
        ownerScopeKind: row.owner_scope_kind,
        ownerScopeId: row.owner_scope_id,
      },
      goal: {
        eventId: row.goal_event_id,
        eventSeq: Number(row.goal_event_seq),
        content: row.goal_content,
        authorUserId: Number(row.goal_author_user_id),
        occurredAt: row.goal_created_at,
      },
      reply: {
        eventIds: reply.rows.map(event => event.event_id),
        eventSeqs: reply.rows.map(event => Number(event.event_seq)),
        content: reply.rows.map(event => event.content).join(''),
        authorOfferId: lastReply.author_offer_id,
        occurredAt: lastReply.created_at,
      },
      outcome: {
        eventId: outcome.id,
        eventSeq: outcome.event_seq,
        status: outcome.content,
        occurredAt: new Date(outcome.created_at),
      },
      readers: readers.rows.map(reader => ({
        userId: Number(reader.user_id),
        participantRevision: Number(reader.participant_revision),
      })),
    })
    let inserted = 0
    for (const record of records) {
      const result = await client.query(`
        INSERT INTO extension_source_outbox
          (source_kind, source_id, owner_user_id, session_id, event_type, occurred_at, payload)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (source_kind, source_id) DO NOTHING
      `, [
        record.sourceKind, record.sourceId, record.ownerUserId, record.sessionId,
        record.eventType, record.occurredAt, JSON.stringify(record.payload),
      ])
      inserted += result.rowCount ?? 0
    }
    return inserted
  }

  async revokeReaderSession(
    client: Pick<pg.PoolClient, 'query'>,
    input: {
      teamSessionId: string
      userId: number
      participantRevision: number
      bindingId?: string
      bindingRevision?: number
      reason: 'participant_removed' | 'binding_removed'
    },
  ): Promise<number> {
    if (!this.enabled) return 0
    const access = await client.query<{ team_id: string; binding_id: string; binding_revision: string | number }>(`
      SELECT session.team_id, memory.binding_id, memory.revision AS binding_revision
      FROM collaboration_sessions session
      JOIN team_memory_bindings memory ON memory.team_id = session.team_id
      JOIN extension_installations installation
        ON installation.owner_user_id = $2
       AND installation.provider_id = 'pocketctl-memory'
       AND installation.owner_scope_kind = 'personal'
       AND installation.status IN ('pending', 'active')
      WHERE session.team_session_id = $1
        AND memory.revision = COALESCE($3::bigint, memory.revision)
        AND memory.binding_id = COALESCE($4::text, memory.binding_id)
      ORDER BY (memory.state = 'active') DESC, memory.created_at DESC
      LIMIT 1
    `, [input.teamSessionId, input.userId, input.bindingRevision ?? null, input.bindingId ?? null])
    const row = access.rows[0]
    if (!row) return 0
    const bindingRevision = Number(row.binding_revision)
    const identity = {
      teamSessionId: input.teamSessionId,
      bindingId: row.binding_id,
      bindingRevision,
      participantRevision: input.participantRevision,
    }
    const sourceId = `team-access:${input.teamSessionId}:u${input.userId}:b${bindingRevision}:p${input.participantRevision}`
    let inserted = 0
    for (const [revocationId, sessionId] of [
      [sourceId, legacyTeamSourceSessionId(identity)],
      [`${sourceId}:i${row.binding_id}`, teamSourceSessionId(identity)],
    ]) {
      const result = await client.query(`
        INSERT INTO extension_source_outbox
          (source_kind, source_id, owner_user_id, session_id, event_type, occurred_at, payload)
        VALUES ('session_access_revoked', $1, $2, $3, 'session_access_revoked', NOW(), $4::jsonb)
        ON CONFLICT (source_kind, source_id) DO NOTHING
      `, [
        revocationId, input.userId, sessionId,
        JSON.stringify({
          reason: input.reason,
          team_id: row.team_id,
          team_session_id: input.teamSessionId,
          team_memory_binding_id: row.binding_id,
          team_memory_binding_revision: bindingRevision,
          participant_user_id: input.userId,
          participant_revision: input.participantRevision,
        }),
      ])
      inserted += result.rowCount ?? 0
    }
    return inserted
  }

  async revokeTeamBinding(
    client: Pick<pg.PoolClient, 'query'>,
    input: { teamId: string; bindingId: string; bindingRevision: number },
  ): Promise<number> {
    if (!this.enabled) return 0
    const readers = await client.query<{
      team_session_id: string
      user_id: string | number
      participant_revision: string | number
    }>(`
      SELECT participant.team_session_id, participant.user_id,
             participant.revision AS participant_revision
      FROM collaboration_session_participants participant
      JOIN collaboration_sessions session
        ON session.team_session_id = participant.team_session_id AND session.team_id = $1
      WHERE participant.state = 'active'
      ORDER BY participant.team_session_id, participant.user_id
    `, [input.teamId])
    let inserted = 0
    for (const reader of readers.rows) {
      inserted += await this.revokeReaderSession(client, {
        teamSessionId: reader.team_session_id,
        userId: Number(reader.user_id),
        participantRevision: Number(reader.participant_revision),
        bindingId: input.bindingId,
        bindingRevision: input.bindingRevision,
        reason: 'binding_removed',
      })
    }
    return inserted
  }
}
