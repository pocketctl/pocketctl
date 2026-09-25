import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'

import { candidateForProvider, type DaemonAgentEvidence } from './agent-offers.js'
import { TeamEventRepository } from './event-repository.js'
import { TeamRepositoryError } from './repository.js'
import type { TeamEvent, TeamMessageTargetMode, TeamProvider, TeamSessionState } from './types.js'

export interface TeamSessionView {
  id: string
  team_id: string
  creator_user_id: number
  task_id: string | null
  title: string
  state: TeamSessionState
  revision: number
  latest_event_seq: number
  current_context_version: number
  participants: Array<{ id: string; user_id: number; state: string; revision: number }>
  agent_bindings: Array<{ id: string; offer_id: string; owner_user_id: number; daemon_id: string; provider: TeamProvider; state: string; revision: number; native_session_id: string | null; availability: string }>
  created_at: string
  updated_at: string
}

interface SessionNotifier {
  event?(sessionId: string, participantUserIds: number[], event: TeamEvent): void
  revoked?(sessionId: string, userId: number): void
  dispatch?(callIds: string[]): void
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export class TeamSessionService {
  private readonly events = new TeamEventRepository()

  constructor(private readonly pool: pg.Pool, private readonly notifier: SessionNotifier = {}) {}

  private async transaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await run(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { /* Preserve the domain error. */ }
      throw error
    } finally { client.release() }
  }

  private async idempotent<T>(actorUserId: number, operation: string, requestId: string, payload: unknown, mutate: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const requestHash = hash(payload)
    return this.transaction(async client => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`team:${actorUserId}:${operation}:${requestId}`])
      const prior = await client.query<{ request_hash: string; response: T }>(
        `SELECT request_hash, response FROM collaboration_team_idempotency
         WHERE user_id = $1 AND operation = $2 AND request_id = $3`,
        [actorUserId, operation, requestId],
      )
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash) throw new TeamRepositoryError('idempotency_conflict', 'request_id was reused with different content')
        return prior.rows[0].response
      }
      const response = await mutate(client)
      await client.query(
        `INSERT INTO collaboration_team_idempotency (user_id, operation, request_id, request_hash, response)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [actorUserId, operation, requestId, requestHash, JSON.stringify(response)],
      )
      return response
    })
  }

  private async requireMember(db: Pick<pg.Pool, 'query'>, teamId: string, userId: number): Promise<void> {
    const result = await db.query(
      `SELECT 1 FROM collaboration_teams team
       JOIN collaboration_team_memberships member ON member.team_id = team.team_id
       WHERE team.team_id = $1 AND team.state = 'active' AND member.user_id = $2 AND member.state = 'active'`,
      [teamId, userId],
    )
    if (!result.rows[0]) throw new TeamRepositoryError('team_not_found', 'team not found')
  }

  private async sessionFor(db: Pick<pg.Pool, 'query'>, sessionId: string, actorUserId: number, lock = false): Promise<any> {
    const result = await db.query(
      `SELECT session.* FROM collaboration_sessions session
       JOIN collaboration_teams team ON team.team_id = session.team_id AND team.state = 'active'
       JOIN collaboration_team_memberships member
         ON member.team_id = session.team_id AND member.user_id = $2 AND member.state = 'active'
       JOIN collaboration_session_participants participant
         ON participant.team_session_id = session.team_session_id
        AND participant.user_id = $2 AND participant.state = 'active'
       WHERE session.team_session_id = $1${lock ? ' FOR UPDATE OF session' : ''}`,
      [sessionId, actorUserId],
    )
    if (!result.rows[0]) throw new TeamRepositoryError('team_not_found', 'shared session not found')
    return result.rows[0]
  }

  private expectRevision(row: any, expected: number): void {
    const current = Number(row.revision)
    if (current !== expected) throw new TeamRepositoryError('revision_conflict', 'revision mismatch', current)
  }

  private async offers(db: Pick<pg.Pool, 'query'>, teamId: string, offerIds: string[], lock = false): Promise<any[]> {
    if (offerIds.length === 0) return []
    const result = await db.query(
      `SELECT offer.*, daemon.hostname, daemon.status, daemon.agents, daemon.collaboration_capabilities,
              binding.team_id AS occupied_team_id, member.state AS owner_membership_state
       FROM team_agent_offers offer
       JOIN daemons daemon ON daemon.daemon_id = offer.daemon_id AND daemon.user_id = offer.owner_user_id
       JOIN collaboration_team_memberships member
         ON member.team_id = offer.team_id AND member.user_id = offer.owner_user_id
       LEFT JOIN collaboration_team_daemon_bindings binding ON binding.daemon_id = offer.daemon_id
       WHERE offer.team_id = $1 AND offer.offer_id = ANY($2::text[])${lock ? ' FOR UPDATE OF offer' : ''}`,
      [teamId, offerIds],
    )
    if (result.rows.length !== new Set(offerIds).size) throw new TeamRepositoryError('team_not_found', 'Agent offer not found')
    return result.rows
  }

  private callable(row: any, teamId: string): boolean {
    if (row.state !== 'active' || row.owner_membership_state !== 'active') return false
    return candidateForProvider({
      daemon_id: row.daemon_id,
      hostname: row.hostname,
      status: row.status,
      agents: row.agents,
      collaboration_capabilities: row.collaboration_capabilities,
      team_id: row.occupied_team_id,
    } satisfies DaemonAgentEvidence, row.provider, teamId).managed_callable
  }

  async listSessions(teamId: string, actorUserId: number, filters: { daemonId?: string; provider?: TeamProvider } = {}): Promise<TeamSessionView[]> {
    await this.requireMember(this.pool, teamId, actorUserId)
    const result = await this.pool.query(
      `SELECT DISTINCT session.* FROM collaboration_sessions session
       JOIN collaboration_session_participants participant
         ON participant.team_session_id = session.team_session_id
        AND participant.user_id = $2 AND participant.state = 'active'
       WHERE session.team_id = $1
         AND ($3::text IS NULL OR EXISTS (
           SELECT 1 FROM collaboration_session_agent_bindings sb
           JOIN team_agent_offers offer ON offer.offer_id = sb.offer_id
           WHERE sb.team_session_id = session.team_session_id AND sb.state = 'active'
             AND offer.daemon_id = $3
             AND ($4::text IS NULL OR offer.provider = $4)
         ))
         AND ($3::text IS NOT NULL OR $4::text IS NULL OR EXISTS (
           SELECT 1 FROM collaboration_session_agent_bindings sb
           JOIN team_agent_offers offer ON offer.offer_id = sb.offer_id
           WHERE sb.team_session_id = session.team_session_id AND sb.state = 'active' AND offer.provider = $4
         ))
       ORDER BY session.updated_at DESC`,
      [teamId, actorUserId, filters.daemonId ?? null, filters.provider ?? null],
    )
    return Promise.all(result.rows.map(row => this.view(this.pool, row)))
  }

  async getSession(sessionId: string, actorUserId: number): Promise<TeamSessionView> {
    return this.view(this.pool, await this.sessionFor(this.pool, sessionId, actorUserId))
  }

  async createSession(input: { teamId: string; actorUserId: number; title: string; taskId: string | null; offerIds: string[]; requestId: string }): Promise<TeamSessionView> {
    return this.idempotent(input.actorUserId, `team.session.create:${input.teamId}`, input.requestId, {
      title: input.title, task_id: input.taskId, offer_ids: [...input.offerIds].sort(),
    }, async client => {
      await this.requireMember(client as unknown as pg.Pool, input.teamId, input.actorUserId)
      if (input.taskId) {
        const task = await client.query(`SELECT 1 FROM team_tasks WHERE task_id = $1 AND team_id = $2 AND state <> 'deleted'`, [input.taskId, input.teamId])
        if (!task.rows[0]) throw new TeamRepositoryError('team_not_found', 'task not found')
      }
      const offers = await this.offers(client as unknown as pg.Pool, input.teamId, input.offerIds, true)
      if (offers.length === 0 || offers.some(offer => !this.callable(offer, input.teamId))) {
        throw new TeamRepositoryError('no_callable_agent', 'at least one selected Agent is not callable')
      }
      const sessionId = `css_${randomUUID()}`
      const inserted = await client.query(
        `INSERT INTO collaboration_sessions (team_session_id, team_id, creator_user_id, task_id, title)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [sessionId, input.teamId, input.actorUserId, input.taskId, input.title],
      )
      const participantIds = new Set<number>([input.actorUserId, ...offers.map(offer => Number(offer.owner_user_id))])
      for (const userId of participantIds) {
        await client.query(
          `INSERT INTO collaboration_session_participants
            (participant_id, team_session_id, user_id, added_by_user_id)
           VALUES ($1, $2, $3, $4)`,
          [`csp_${randomUUID()}`, sessionId, userId, input.actorUserId],
        )
      }
      for (const offer of offers) {
        await client.query(
          `INSERT INTO collaboration_session_agent_bindings
            (binding_id, team_session_id, offer_id, owner_user_id)
           VALUES ($1, $2, $3, $4)`,
          [`cab_${randomUUID()}`, sessionId, offer.offer_id, offer.owner_user_id],
        )
      }
      return this.view(client as unknown as pg.Pool, inserted.rows[0])
    })
  }

  async updateSession(input: { sessionId: string; actorUserId: number; title?: string; state?: TeamSessionState; expectedRevision: number; requestId: string }): Promise<TeamSessionView> {
    return this.idempotent(input.actorUserId, `team.session.update:${input.sessionId}`, input.requestId, input, async client => {
      const session = await this.sessionFor(client as unknown as pg.Pool, input.sessionId, input.actorUserId, true)
      if (Number(session.creator_user_id) !== input.actorUserId) throw new TeamRepositoryError('creator_required', 'shared session creator authority required')
      this.expectRevision(session, input.expectedRevision)
      const nextState = input.state ?? session.state
      const allowed = session.state === nextState
        || (session.state === 'active' && ['paused', 'ended', 'archived'].includes(nextState))
        || (session.state === 'paused' && ['active', 'ended', 'archived'].includes(nextState))
        || (session.state === 'ended' && nextState === 'archived')
      if (!allowed) throw new TeamRepositoryError('invalid_state', `cannot transition shared session from ${session.state} to ${nextState}`)
      const updated = await client.query(
        `UPDATE collaboration_sessions SET title = COALESCE($2, title), state = $3,
           revision = revision + 1, updated_at = NOW() WHERE team_session_id = $1 RETURNING *`,
        [input.sessionId, input.title ?? null, nextState],
      )
      return this.view(client as unknown as pg.Pool, updated.rows[0])
    })
  }

  async addParticipant(input: { sessionId: string; actorUserId: number; userId: number; expectedRevision: number; requestId: string }): Promise<TeamSessionView> {
    return this.changeParticipant({ ...input, active: true })
  }

  async removeParticipant(input: { sessionId: string; actorUserId: number; userId: number; expectedRevision: number; requestId: string }): Promise<TeamSessionView> {
    const result = await this.changeParticipant({ ...input, active: false })
    this.notifier.revoked?.(input.sessionId, input.userId)
    return result
  }

  private async changeParticipant(input: { sessionId: string; actorUserId: number; userId: number; active: boolean; expectedRevision: number; requestId: string }): Promise<TeamSessionView> {
    return this.idempotent(input.actorUserId, `team.session.participant:${input.sessionId}:${input.userId}`, input.requestId, {
      active: input.active, expected_revision: input.expectedRevision,
    }, async client => {
      const session = await this.sessionFor(client as unknown as pg.Pool, input.sessionId, input.actorUserId, true)
      if (Number(session.creator_user_id) !== input.actorUserId) throw new TeamRepositoryError('creator_required', 'shared session creator authority required')
      this.expectRevision(session, input.expectedRevision)
      if (input.userId === Number(session.creator_user_id) && !input.active) throw new TeamRepositoryError('invalid_state', 'shared session creator cannot be removed')
      await this.requireMember(client as unknown as pg.Pool, session.team_id, input.userId)
      const current = await client.query(
        `SELECT * FROM collaboration_session_participants WHERE team_session_id = $1 AND user_id = $2 FOR UPDATE`,
        [input.sessionId, input.userId],
      )
      if (!input.active) {
        const ownsBinding = await client.query(
          `SELECT 1 FROM collaboration_session_agent_bindings WHERE team_session_id = $1 AND owner_user_id = $2 AND state = 'active'`,
          [input.sessionId, input.userId],
        )
        if (ownsBinding.rows[0]) throw new TeamRepositoryError('invalid_state', 'remove the member Agent bindings first')
      }
      if (current.rows[0]) {
        await client.query(
          `UPDATE collaboration_session_participants SET state = $3::varchar, revision = revision + 1,
             updated_at = NOW(), removed_at = CASE WHEN $3::varchar = 'removed' THEN NOW() ELSE NULL END
           WHERE team_session_id = $1 AND user_id = $2`,
          [input.sessionId, input.userId, input.active ? 'active' : 'removed'],
        )
      } else if (input.active) {
        await client.query(
          `INSERT INTO collaboration_session_participants
            (participant_id, team_session_id, user_id, added_by_user_id) VALUES ($1, $2, $3, $4)`,
          [`csp_${randomUUID()}`, input.sessionId, input.userId, input.actorUserId],
        )
      } else throw new TeamRepositoryError('team_not_found', 'participant not found')
      const updated = await client.query(
        `UPDATE collaboration_sessions SET revision = revision + 1, updated_at = NOW()
         WHERE team_session_id = $1 RETURNING *`, [input.sessionId],
      )
      return this.view(client as unknown as pg.Pool, updated.rows[0])
    })
  }

  async changeBinding(input: { sessionId: string; actorUserId: number; offerId: string; active: boolean; expectedRevision: number; requestId: string }): Promise<TeamSessionView> {
    return this.idempotent(input.actorUserId, `team.session.binding:${input.sessionId}:${input.offerId}`, input.requestId, {
      active: input.active, expected_revision: input.expectedRevision,
    }, async client => {
      const session = await this.sessionFor(client as unknown as pg.Pool, input.sessionId, input.actorUserId, true)
      this.expectRevision(session, input.expectedRevision)
      if (session.state !== 'active' && session.state !== 'paused') throw new TeamRepositoryError('invalid_state', 'shared session no longer accepts Agent changes')
      const offers = await this.offers(client as unknown as pg.Pool, session.team_id, [input.offerId], true)
      const offer = offers[0]
      if (Number(offer.owner_user_id) !== input.actorUserId && Number(session.creator_user_id) !== input.actorUserId) {
        throw new TeamRepositoryError('creator_required', 'only the Agent owner or session creator may add it')
      }
      if (!input.active && Number(offer.owner_user_id) !== input.actorUserId) {
        throw new TeamRepositoryError('offer_owner_required', 'only the Agent owner may remove it')
      }
      if (input.active && !this.callable(offer, session.team_id)) throw new TeamRepositoryError('agent_unavailable', 'Agent is not callable')
      const current = await client.query(
        `SELECT * FROM collaboration_session_agent_bindings WHERE team_session_id = $1 AND offer_id = $2 FOR UPDATE`,
        [input.sessionId, input.offerId],
      )
      if (current.rows[0]) {
        await client.query(
          `UPDATE collaboration_session_agent_bindings SET state = $3::varchar, revision = revision + 1,
             updated_at = NOW(), removed_at = CASE WHEN $3::varchar = 'removed' THEN NOW() ELSE NULL END
           WHERE team_session_id = $1 AND offer_id = $2`,
          [input.sessionId, input.offerId, input.active ? 'active' : 'removed'],
        )
      } else if (input.active) {
        await client.query(
          `INSERT INTO collaboration_session_agent_bindings
            (binding_id, team_session_id, offer_id, owner_user_id) VALUES ($1, $2, $3, $4)`,
          [`cab_${randomUUID()}`, input.sessionId, input.offerId, offer.owner_user_id],
        )
      } else throw new TeamRepositoryError('team_not_found', 'Agent binding not found')
      if (input.active) {
        await client.query(
          `INSERT INTO collaboration_session_participants
            (participant_id, team_session_id, user_id, added_by_user_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (team_session_id, user_id) DO UPDATE SET state = 'active', revision = collaboration_session_participants.revision + 1, updated_at = NOW(), removed_at = NULL`,
          [`csp_${randomUUID()}`, input.sessionId, offer.owner_user_id, input.actorUserId],
        )
      }
      const updated = await client.query(
        `UPDATE collaboration_sessions SET revision = revision + 1, updated_at = NOW()
         WHERE team_session_id = $1 RETURNING *`, [input.sessionId],
      )
      return this.view(client as unknown as pg.Pool, updated.rows[0])
    })
  }

  async appendMessage(input: { sessionId: string; actorUserId: number; requestId: string; content: string; targetMode: TeamMessageTargetMode; targetOfferIds: string[]; referenceEventId: string | null }): Promise<{ event: TeamEvent; call_ids: string[] }> {
    const result = await this.transaction(async client => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`team:event:${input.sessionId}:${input.actorUserId}:${input.requestId}`])
      const session = await this.sessionFor(client as unknown as pg.Pool, input.sessionId, input.actorUserId, true)
      if (session.state !== 'active') throw new TeamRepositoryError('invalid_state', 'shared session is not writable')
      const bindingRows = await client.query(
        `SELECT binding.offer_id, offer.*, daemon.hostname, daemon.status, daemon.agents,
                daemon.collaboration_capabilities, team_binding.team_id AS occupied_team_id,
                member.state AS owner_membership_state
         FROM collaboration_session_agent_bindings binding
         JOIN team_agent_offers offer ON offer.offer_id = binding.offer_id
         JOIN daemons daemon ON daemon.daemon_id = offer.daemon_id AND daemon.user_id = offer.owner_user_id
         JOIN collaboration_team_memberships member ON member.team_id = offer.team_id AND member.user_id = offer.owner_user_id
         LEFT JOIN collaboration_team_daemon_bindings team_binding ON team_binding.daemon_id = offer.daemon_id
         WHERE binding.team_session_id = $1 AND binding.state = 'active'`,
        [input.sessionId],
      )
      const callable = bindingRows.rows.filter(row => this.callable(row, session.team_id))
      if (callable.length === 0) throw new TeamRepositoryError('no_callable_agent', 'no callable Agent is available')
      let targets: string[] = []
      if (input.targetMode === 'all') targets = callable.map(row => row.offer_id)
      if (input.targetMode === 'offers') {
        const allowed = new Set(callable.map(row => row.offer_id))
        targets = [...new Set(input.targetOfferIds)]
        if (targets.length === 0 || targets.some(offerId => !allowed.has(offerId))) throw new TeamRepositoryError('agent_unavailable', 'selected Agent is not callable')
      }
      const appended = await this.events.appendMemberEvent(client, {
        teamSessionId: input.sessionId,
        authorUserId: input.actorUserId,
        requestId: input.requestId,
        content: input.content,
        targetMode: input.targetMode,
        targetOfferIds: targets,
        referenceEventId: input.referenceEventId,
        contextVersion: Number(session.current_context_version),
      }).catch(error => {
        if (error instanceof Error && error.message === 'event_idempotency_conflict') throw new TeamRepositoryError('idempotency_conflict', 'request_id was reused with different message content')
        if (error instanceof Error && error.message === 'reference_not_found') throw new TeamRepositoryError('team_not_found', 'referenced event not found')
        throw error
      })
      const participants = await client.query<{ user_id: number }>(
        `SELECT participant.user_id FROM collaboration_session_participants participant
         JOIN collaboration_team_memberships member
           ON member.team_id = $2 AND member.user_id = participant.user_id AND member.state = 'active'
         WHERE participant.team_session_id = $1 AND participant.state = 'active'`,
        [input.sessionId, session.team_id],
      )
      return { appended, participantUserIds: participants.rows.map(row => Number(row.user_id)) }
    })
    this.notifier.event?.(input.sessionId, result.participantUserIds, result.appended.event)
    this.notifier.dispatch?.(result.appended.call_ids)
    return result.appended
  }

  async listEvents(sessionId: string, actorUserId: number, afterSeq: number, limit: number) {
    await this.sessionFor(this.pool, sessionId, actorUserId)
    return this.events.listEvents(this.pool, sessionId, afterSeq, limit)
  }

  async canSubscribe(userId: number, sessionId: string): Promise<boolean> {
    try { await this.sessionFor(this.pool, sessionId, userId); return true } catch { return false }
  }

  private async view(db: Pick<pg.Pool, 'query'>, row: any): Promise<TeamSessionView> {
    const [participants, bindings] = await Promise.all([
      db.query(`SELECT participant_id, user_id, state, revision FROM collaboration_session_participants WHERE team_session_id = $1 AND state = 'active' ORDER BY created_at`, [row.team_session_id]),
      db.query(
        `SELECT binding.*, offer.daemon_id, offer.provider, daemon.hostname, daemon.status, daemon.agents,
                daemon.collaboration_capabilities, team_binding.team_id AS occupied_team_id
         FROM collaboration_session_agent_bindings binding
         JOIN team_agent_offers offer ON offer.offer_id = binding.offer_id
         JOIN daemons daemon ON daemon.daemon_id = offer.daemon_id
         LEFT JOIN collaboration_team_daemon_bindings team_binding ON team_binding.daemon_id = offer.daemon_id
         WHERE binding.team_session_id = $1 AND binding.state = 'active' ORDER BY binding.created_at`,
        [row.team_session_id],
      ),
    ])
    return {
      id: row.team_session_id,
      team_id: row.team_id,
      creator_user_id: Number(row.creator_user_id),
      task_id: row.task_id,
      title: row.title,
      state: row.state,
      revision: Number(row.revision),
      latest_event_seq: Number(row.latest_event_seq),
      current_context_version: Number(row.current_context_version),
      participants: participants.rows.map(participant => ({ id: participant.participant_id, user_id: Number(participant.user_id), state: participant.state, revision: Number(participant.revision) })),
      agent_bindings: bindings.rows.map(binding => ({
        id: binding.binding_id,
        offer_id: binding.offer_id,
        owner_user_id: Number(binding.owner_user_id),
        daemon_id: binding.daemon_id,
        provider: binding.provider,
        state: binding.state,
        revision: Number(binding.revision),
        native_session_id: binding.native_session_id,
        availability: candidateForProvider({
          daemon_id: binding.daemon_id, hostname: binding.hostname, status: binding.status,
          agents: binding.agents, collaboration_capabilities: binding.collaboration_capabilities,
          team_id: binding.occupied_team_id,
        }, binding.provider, row.team_id).availability,
      })),
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    }
  }
}
