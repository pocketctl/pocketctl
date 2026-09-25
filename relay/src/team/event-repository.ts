import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'

import type { TeamEvent, TeamMessageTargetMode } from './types.js'

export interface AppendMemberEventInput {
  teamSessionId: string
  authorUserId: number
  requestId: string
  content: string
  targetMode: TeamMessageTargetMode
  targetOfferIds: string[]
  referenceEventId: string | null
  contextVersion: number
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export function teamEventView(row: any): TeamEvent {
  return {
    id: row.event_id,
    team_session_id: row.team_session_id,
    event_seq: Number(row.event_seq),
    kind: row.kind,
    author_user_id: row.author_user_id === null ? null : Number(row.author_user_id),
    author_offer_id: row.author_offer_id,
    target_mode: row.target_mode,
    target_offer_ids: Array.isArray(row.target_offer_ids) ? row.target_offer_ids : [],
    reference: row.reference_event_id === null ? null : {
      event_id: row.reference_event_id,
      event_seq: Number(row.reference_event_seq),
    },
    context_version: row.context_version === null ? null : Number(row.context_version),
    call_id: row.call_id,
    content: row.content,
    created_at: iso(row.created_at),
  }
}

export class TeamEventRepository {
  async appendMemberEvent(client: pg.PoolClient, input: AppendMemberEventInput): Promise<{ event: TeamEvent; call_ids: string[] }> {
    const fingerprint = createHash('sha256').update(JSON.stringify({
      content: input.content,
      target_mode: input.targetMode,
      target_offer_ids: input.targetOfferIds,
      reference_event_id: input.referenceEventId,
      context_version: input.contextVersion,
    })).digest('hex')
    const duplicate = await client.query(
      `SELECT * FROM collaboration_events
       WHERE team_session_id = $1 AND author_user_id = $2 AND request_id = $3 FOR UPDATE`,
      [input.teamSessionId, input.authorUserId, input.requestId],
    )
    if (duplicate.rows[0]) {
      if (duplicate.rows[0].request_hash !== fingerprint) throw new Error('event_idempotency_conflict')
      const calls = await client.query<{ call_id: string }>(
        `SELECT call_id FROM collaboration_calls WHERE event_id = $1 ORDER BY offer_id`,
        [duplicate.rows[0].event_id],
      )
      return { event: teamEventView(duplicate.rows[0]), call_ids: calls.rows.map(row => row.call_id) }
    }
    let reference: { event_id: string; event_seq: string } | undefined
    if (input.referenceEventId) {
      const found = await client.query<{ event_id: string; event_seq: string }>(
        `SELECT event_id, event_seq FROM collaboration_events
         WHERE event_id = $1 AND team_session_id = $2`,
        [input.referenceEventId, input.teamSessionId],
      )
      reference = found.rows[0]
      if (!reference) throw new Error('reference_not_found')
    }
    const sequence = await client.query<{ latest_event_seq: string }>(
      `UPDATE collaboration_sessions
       SET latest_event_seq = latest_event_seq + 1, updated_at = NOW()
       WHERE team_session_id = $1 RETURNING latest_event_seq`,
      [input.teamSessionId],
    )
    const eventId = `cev_${randomUUID()}`
    const inserted = await client.query(
      `INSERT INTO collaboration_events
        (event_id, team_session_id, event_seq, kind, author_user_id, target_mode,
         target_offer_ids, reference_event_id, reference_event_seq, context_version,
         content, request_id, request_hash)
       VALUES ($1, $2, $3, 'member_message', $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [eventId, input.teamSessionId, Number(sequence.rows[0].latest_event_seq), input.authorUserId,
        input.targetMode, JSON.stringify(input.targetOfferIds), reference?.event_id ?? null,
        reference ? Number(reference.event_seq) : null, input.contextVersion, input.content,
        input.requestId, fingerprint],
    )
    const callIds: string[] = []
    for (const offerId of input.targetOfferIds) {
      const callId = `ccl_${randomUUID()}`
      await client.query(
        `INSERT INTO collaboration_calls
          (call_id, team_session_id, event_id, offer_id, binding_id, context_version,
           context_snapshot_hash, history_through_event_seq)
         SELECT $1, $2, $3, $4, binding.binding_id, $5, context.content_hash, GREATEST($6::bigint - 1, 0)
         FROM collaboration_session_agent_bindings
           binding
         LEFT JOIN collaboration_context_versions context
           ON context.team_session_id = binding.team_session_id AND context.version = $5
         WHERE binding.team_session_id = $2 AND binding.offer_id = $4 AND binding.state = 'active'`,
        [callId, input.teamSessionId, eventId, offerId, input.contextVersion, Number(sequence.rows[0].latest_event_seq)],
      )
      callIds.push(callId)
    }
    return { event: teamEventView(inserted.rows[0]), call_ids: callIds }
  }

  async listEvents(db: Pick<pg.Pool, 'query'>, teamSessionId: string, afterSeq: number, limit: number): Promise<{ events: TeamEvent[]; next_cursor: number | null }> {
    const result = await db.query(
      `SELECT * FROM collaboration_events
       WHERE team_session_id = $1 AND event_seq > $2
       ORDER BY event_seq ASC LIMIT $3`,
      [teamSessionId, afterSeq, limit + 1],
    )
    const hasMore = result.rows.length > limit
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows
    return {
      events: rows.map(teamEventView),
      next_cursor: hasMore ? Number(rows[rows.length - 1].event_seq) : null,
    }
  }
}
