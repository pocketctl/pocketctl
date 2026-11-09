import type pg from 'pg'

import type { TeamEvent } from './types.js'
import { projectAcceptedDeliveryMemory, revokeAcceptedDeliveryMemory } from './delivery-memory-projector.js'

export { buildAcceptedDeliveryMemorySourceRecords, acceptedDeliverySourceSessionId,
  ACCEPTED_DELIVERY_SOURCE_VERSION, type AcceptedDeliveryMemoryInput } from './accepted-delivery-memory-source.js'

export {TEAM_MEMORY_SOURCE_KIND,TEAM_MEMORY_SOURCE_VERSION,teamSourceSessionId,buildTeamMemorySourceRecords,type TeamMemorySourceRole,type TeamMemorySourceRecord,type TeamMemorySourceProjectionInput} from '@pocketctl/session-source'
import {teamSourceSessionId,legacyTeamSourceSessionId,buildTeamMemorySourceRecords} from '@pocketctl/session-source'
export interface TeamMemorySourceProjectorLike {
  projectAcceptedDelivery?(client: Pick<pg.PoolClient, 'query'>, input: { teamId: string; decisionId: string }): Promise<number>
  revokeAcceptedDelivery?(client: Pick<pg.PoolClient, 'query'>, submissionId: string): Promise<number>
  projectCompletedCall(client: Pick<pg.PoolClient, 'query'>, callId: string, outcome: TeamEvent): Promise<number>
  revokeReaderSession?(client: Pick<pg.PoolClient, 'query'>, input: {
    teamSessionId: string
    userId: number
    participantRevision: number
    bindingId?: string
    bindingRevision?: number
    reason: 'participant_removed' | 'binding_removed' | 'team_member_left' | 'team_member_removed' | 'team_dissolved'
  }): Promise<number>
  revokeTeamBinding?(client: Pick<pg.PoolClient, 'query'>, input: {
    teamId: string
    bindingId: string
    bindingRevision: number
  }): Promise<number>
}

export class TeamMemorySourceProjector implements TeamMemorySourceProjectorLike {
  constructor(private readonly enabled: boolean,
    private readonly options: { acceptedDeliveriesEnabledForTeam?: (teamId: string) => boolean } = {}) {}

  async projectAcceptedDelivery(client: Pick<pg.PoolClient, 'query'>, input: { teamId: string; decisionId: string }): Promise<number> {
    if (!this.enabled || !this.options.acceptedDeliveriesEnabledForTeam?.(input.teamId)) return 0
    return projectAcceptedDeliveryMemory(client, input.decisionId, input.teamId)
  }

  async revokeAcceptedDelivery(client: Pick<pg.PoolClient, 'query'>, submissionId: string): Promise<number> {
    return revokeAcceptedDeliveryMemory(client, { submissionId, reason: 'artifact_revoked' })
  }

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
      reason: 'participant_removed' | 'binding_removed' | 'team_member_left' | 'team_member_removed' | 'team_dissolved'
    },
  ): Promise<number> {
    // Capture can be disabled while previously delivered sources still need revocation.
    const deliveryRevocations = await revokeAcceptedDeliveryMemory(client, input)
    // A paused (or revoking) recipient may still retain prior sources. Cleanup
    // must be durable now so it is delivered when that installation resumes.
    const access = await client.query<{ team_id: string; binding_id: string; binding_revision: string | number }>(`
      SELECT session.team_id, memory.binding_id, memory.revision AS binding_revision
      FROM collaboration_sessions session
      JOIN team_memory_bindings memory ON memory.team_id = session.team_id
      JOIN extension_installations installation
        ON installation.owner_user_id = $2
       AND installation.provider_id = 'pocketctl-memory'
       AND installation.owner_scope_kind = 'personal'
      WHERE session.team_session_id = $1
        AND memory.revision = COALESCE($3::bigint, memory.revision)
        AND memory.binding_id = COALESCE($4::text, memory.binding_id)
      ORDER BY (memory.state = 'active') DESC, memory.created_at DESC
      LIMIT 1
    `, [input.teamSessionId, input.userId, input.bindingRevision ?? null, input.bindingId ?? null])
    const row = access.rows[0]
    if (!row) return deliveryRevocations
    const bindingRevision = Number(row.binding_revision)
    const identity = {
      teamSessionId: input.teamSessionId,
      bindingId: row.binding_id,
      bindingRevision,
      participantRevision: input.participantRevision,
    }
    const sourceId = `team-access:${input.teamSessionId}:u${input.userId}:b${bindingRevision}:p${input.participantRevision}`
    let inserted = deliveryRevocations
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
    // Cleanup is a lifecycle obligation even after disabling new source capture.
    const deliveryRevocations = await revokeAcceptedDeliveryMemory(client, { ...input, reason: 'binding_removed' })
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
    let inserted = deliveryRevocations
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
