import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'

import { teamEventView } from './event-repository.js'
import { TeamRepositoryError } from './repository.js'
import type { TeamContextReference, TeamContextSnapshot, TeamEvent } from './types.js'

interface ContextNotifier {
  event?(sessionId: string, participantUserIds: number[], event: TeamEvent): void
}

function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function snapshot(row: any): TeamContextSnapshot {
  return {
    id: row.context_version_id,
    team_session_id: row.team_session_id,
    version: Number(row.version),
    revision: Number(row.revision),
    goal: row.goal,
    consensus: Array.isArray(row.consensus) ? row.consensus : [],
    open_questions: Array.isArray(row.open_questions) ? row.open_questions : [],
    references: Array.isArray(row.context_references) ? row.context_references : [],
    content_hash: row.content_hash,
    created_by_user_id: Number(row.created_by_user_id),
    created_at: new Date(row.created_at).toISOString(),
  }
}

export class TeamContextService {
  constructor(private readonly pool: pg.Pool, private readonly notifier: ContextNotifier = {}) {}

  private async accessible(db: Pick<pg.Pool, 'query'>, sessionId: string, actorUserId: number, lock = false): Promise<any> {
    const result = await db.query(
      `SELECT session.* FROM collaboration_sessions session
       JOIN collaboration_session_participants participant
         ON participant.team_session_id = session.team_session_id AND participant.user_id = $2 AND participant.state = 'active'
       JOIN collaboration_team_memberships member
         ON member.team_id = session.team_id AND member.user_id = $2 AND member.state = 'active'
       JOIN collaboration_teams team ON team.team_id = session.team_id AND team.state = 'active'
       WHERE session.team_session_id = $1${lock ? ' FOR UPDATE OF session' : ''}`,
      [sessionId, actorUserId],
    )
    if (!result.rows[0]) throw new TeamRepositoryError('team_not_found', 'shared session not found')
    return result.rows[0]
  }

  async get(sessionId: string, actorUserId: number, version?: number): Promise<TeamContextSnapshot | null> {
    const session = await this.accessible(this.pool, sessionId, actorUserId)
    const selected = version ?? Number(session.current_context_version)
    if (selected === 0) return null
    const result = await this.pool.query(
      `SELECT * FROM collaboration_context_versions WHERE team_session_id = $1 AND version = $2`,
      [sessionId, selected],
    )
    if (!result.rows[0]) throw new TeamRepositoryError('team_not_found', 'context version not found')
    return snapshot(result.rows[0])
  }

  async create(input: {
    sessionId: string
    actorUserId: number
    expectedRevision: number
    requestId: string
    goal: string
    consensus: string[]
    openQuestions: string[]
    references: TeamContextReference[]
  }): Promise<{ context: TeamContextSnapshot; event: TeamEvent }> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`team:context:${input.sessionId}:${input.actorUserId}:${input.requestId}`])
      const requestPayload = {
        expected_revision: input.expectedRevision, goal: input.goal, consensus: input.consensus,
        open_questions: input.openQuestions, references: input.references,
      }
      const requestHash = canonicalHash(requestPayload)
      const prior = await client.query(
        `SELECT request_hash, response FROM collaboration_team_idempotency
         WHERE user_id = $1 AND operation = $2 AND request_id = $3`,
        [input.actorUserId, `team.context.create:${input.sessionId}`, input.requestId],
      )
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash) throw new TeamRepositoryError('idempotency_conflict', 'request_id was reused with different context')
        await client.query('COMMIT')
        return prior.rows[0].response
      }
      const session = await this.accessible(client as unknown as pg.Pool, input.sessionId, input.actorUserId, true)
      if (Number(session.creator_user_id) !== input.actorUserId) throw new TeamRepositoryError('creator_required', 'shared session creator authority required')
      if (!['active', 'paused'].includes(session.state)) throw new TeamRepositoryError('invalid_state', 'shared session no longer accepts context versions')
      const currentRevision = Number(session.current_context_version)
      if (currentRevision !== input.expectedRevision) {
        throw new TeamRepositoryError('context_revision_conflict', 'context changed; reload before creating another version', currentRevision)
      }
      for (const reference of input.references) {
        if (reference.source_kind !== 'team_event' || reference.owner_scope_id !== null || reference.installation_id !== null) {
          throw new TeamRepositoryError('invalid_state', 'only shared-session event references are available before the Memory bridge')
        }
        const referenced = await client.query(
          `SELECT event_seq FROM collaboration_events WHERE team_session_id = $1 AND event_id = $2`,
          [input.sessionId, reference.source_id],
        )
        if (!referenced.rows[0] || String(referenced.rows[0].event_seq) !== reference.source_version) {
          throw new TeamRepositoryError('team_not_found', 'context reference not found')
        }
      }
      const version = currentRevision + 1
      const content = {
        goal: input.goal,
        consensus: input.consensus,
        open_questions: input.openQuestions,
        references: input.references,
      }
      const contentHash = canonicalHash(content)
      const inserted = await client.query(
        `INSERT INTO collaboration_context_versions
          (context_version_id, team_session_id, version, revision, goal, consensus, open_questions,
           context_references, content_hash, created_by_user_id)
         VALUES ($1, $2, $3, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9) RETURNING *`,
        [`ccv_${randomUUID()}`, input.sessionId, version, input.goal, JSON.stringify(input.consensus),
          JSON.stringify(input.openQuestions), JSON.stringify(input.references), contentHash, input.actorUserId],
      )
      const sequence = await client.query<{ latest_event_seq: string }>(
        `UPDATE collaboration_sessions SET current_context_version = $2,
           latest_event_seq = latest_event_seq + 1, updated_at = NOW()
         WHERE team_session_id = $1 RETURNING latest_event_seq`, [input.sessionId, version],
      )
      const event = await client.query(
        `INSERT INTO collaboration_events
          (event_id, team_session_id, event_seq, kind, author_user_id, context_version, content, request_id)
         VALUES ($1, $2, $3, 'context', $4, $5, $6, $7) RETURNING *`,
        [`cev_${randomUUID()}`, input.sessionId, Number(sequence.rows[0].latest_event_seq), input.actorUserId,
          version, `Context v${version} updated`, `context:${canonicalHash(input.requestId).slice(0, 40)}`],
      )
      const response = { context: snapshot(inserted.rows[0]), event: teamEventView(event.rows[0]) }
      await client.query(
        `INSERT INTO collaboration_team_idempotency (user_id, operation, request_id, request_hash, response)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [input.actorUserId, `team.context.create:${input.sessionId}`, input.requestId, requestHash, JSON.stringify(response)],
      )
      const participants = await client.query<{ user_id: number }>(
        `SELECT user_id FROM collaboration_session_participants WHERE team_session_id = $1 AND state = 'active'`, [input.sessionId],
      )
      await client.query('COMMIT')
      this.notifier.event?.(input.sessionId, participants.rows.map(row => Number(row.user_id)), response.event)
      return response
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }
}
