import { frozenTaskRequirementsText } from './task-requirements-snapshot.js'
import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'

import { createInitialTaskSpec } from './delivery-service.js'
import { validateReviewPolicy, validateMutation, positiveRevision, stableDigest, type TaskReviewPolicy } from './delivery-contract.js'
import { requireTeamAccess } from './access.js'
import { candidateForProvider, type DaemonAgentEvidence } from './agent-offers.js'
import { TeamReadStateService } from './read-state-service.js'
import { TeamAgentConfigService, bindingConfigView } from './agent-config-service.js'
import type { TeamRuntimeConfig, SessionAgentConfig } from './types.js'
import { TeamEventRepository } from './event-repository.js'
import { TeamRepositoryError } from './repository.js'
import type { TeamEvent, TeamMessageTargetMode, TeamProvider, TeamSessionState } from './types.js'
import type { TeamMemorySourceProjectorLike } from './memory-source-projector.js'
import type { TeamMemoryContextBridge } from './memory-context-bridge.js'

export interface TeamSessionView {
  current_user_role?: import('./types.js').TeamRole
  id: string
  team_id: string
  creator_user_id: number
  task_id: string | null
  title: string
  state: TeamSessionState
  revision: number
  latest_event_seq: number
  current_context_version: number
  read_event_seq?: number
  unread_count?: number
  preview?: string | null
  participants: Array<{ id: string; user_id: number; state: string; revision: number }>
  agent_bindings: Array<{ id: string; offer_id: string; owner_user_id: number; daemon_id: string; provider: TeamProvider; state: string; revision: number; native_session_id: string | null; availability: string; config?: SessionAgentConfig }>
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

  constructor(
    private readonly pool: pg.Pool,
    private readonly notifier: SessionNotifier = {},
    private readonly memorySources?: TeamMemorySourceProjectorLike,
    private readonly memoryContextBridge?: TeamMemoryContextBridge,
    private readonly deliveryEnabledForTeam: (teamId: string) => boolean = () => false,
    private readonly externalEnabledForTeam: (teamId: string) => boolean = () => false,
  ) {}

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

  private async idempotent(actorUserId: number, operation: string, requestId: string, payload: unknown, mutate: (client: pg.PoolClient) => Promise<TeamSessionView>, afterCommit?: () => void): Promise<TeamSessionView> {
    const requestHash = hash(payload)
    const result = await this.transaction(async client => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`team:${actorUserId}:${operation}:${requestId}`])
      const prior = await client.query<{ request_hash: string; response: TeamSessionView }>(
        `SELECT request_hash, response FROM collaboration_team_idempotency
         WHERE user_id = $1 AND operation = $2 AND request_id = $3`,
        [actorUserId, operation, requestId],
      )
      if (prior.rows[0]) {
        // A receipt preserves the old result, never the actor's old access.
        await this.sessionFor(client, prior.rows[0].response.id, actorUserId, true)
        if (prior.rows[0].request_hash !== requestHash) throw new TeamRepositoryError('idempotency_conflict', 'request_id was reused with different content')
        return { response: prior.rows[0].response, mutated: false }
      }
      const response = await mutate(client)
      await client.query(
        `INSERT INTO collaboration_team_idempotency (user_id, operation, request_id, request_hash, response)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [actorUserId, operation, requestId, requestHash, JSON.stringify(response)],
      )
      return { response, mutated: true }
    })
    // Only a committed mutation may publish effects; receipts retain data only.
    if (result.mutated) afterCommit?.()
    // Cached responses from older versions must obey the same owner boundary.
    return this.ownerView(result.response, actorUserId)
  }

  private async requireMember(db: Pick<pg.Pool, 'query'>, teamId: string, userId: number, lock = false): Promise<void> {
    await requireTeamAccess(db, userId, lock)
    const role = await this.requireActiveMembership(db, teamId, userId, lock)
    if (lock && role === 'viewer') throw new TeamRepositoryError('team_access_denied', 'read-only team member')
  }

  private async requireActiveMembership(db: Pick<pg.Pool, 'query'>, teamId: string, userId: number, lock = false): Promise<string | undefined> {
    if (lock) {
      const team = await db.query(`SELECT 1 FROM collaboration_teams WHERE team_id = $1 AND state = 'active' FOR SHARE`, [teamId])
      if (!team.rows[0]) throw new TeamRepositoryError('team_not_found', 'team not found')
      const member = await db.query(
        `SELECT role FROM collaboration_team_memberships WHERE team_id = $1 AND user_id = $2 AND state = 'active' FOR SHARE`, [teamId, userId],
      )
      if (!member.rows[0]) throw new TeamRepositoryError('team_not_found', 'team not found')
      return member.rows[0].role
    }
    const result = await db.query(
      `SELECT 1 FROM collaboration_teams team
       JOIN collaboration_team_memberships member ON member.team_id = team.team_id
       WHERE team.team_id = $1 AND team.state = 'active' AND member.user_id = $2 AND member.state = 'active'`,
      [teamId, userId],
    )
    if (!result.rows[0]) throw new TeamRepositoryError('team_not_found', 'team not found')
  }

  private async sessionFor(db: Pick<pg.Pool, 'query'>, sessionId: string, actorUserId: number, lock = false): Promise<any> {
    await requireTeamAccess(db, actorUserId, lock)
    const result = await db.query(
      `SELECT session.*, member.role AS actor_team_role FROM collaboration_sessions session
       JOIN collaboration_teams team ON team.team_id = session.team_id AND team.state = 'active'
       JOIN collaboration_team_memberships member
         ON member.team_id = session.team_id AND member.user_id = $2 AND member.state = 'active'
       JOIN collaboration_session_participants participant
         ON participant.team_session_id = session.team_session_id
        AND participant.user_id = $2 AND participant.state = 'active'
       WHERE session.team_session_id = $1${lock ? ' FOR UPDATE OF session FOR SHARE OF team, member, participant' : ''}`,
      [sessionId, actorUserId],
    )
    if (!result.rows[0]) throw new TeamRepositoryError('team_not_found', 'shared session not found')
    if (lock && result.rows[0].actor_team_role === 'viewer') throw new TeamRepositoryError('team_access_denied', 'read-only team member')
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
              binding.team_id AS occupied_team_id, member.state AS owner_membership_state, owner.team_enabled AS owner_team_enabled
       FROM team_agent_offers offer
       JOIN users owner ON owner.id = offer.owner_user_id
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
    if (row.state !== 'active' || row.owner_membership_state !== 'active' || row.owner_team_enabled !== true) return false
    return candidateForProvider({
      daemon_id: row.daemon_id,
      hostname: row.hostname,
      status: row.status,
      agents: row.agents,
      collaboration_capabilities: row.collaboration_capabilities,
      team_id: row.occupied_team_id,
    } satisfies DaemonAgentEvidence, row.provider, teamId, this.externalEnabledForTeam(teamId)).managed_callable
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
    return Promise.all(result.rows.map(async row => ({...await this.view(this.pool,row,actorUserId),...await new TeamReadStateService(this.pool).summary(row.team_session_id,actorUserId)})))
  }

  async getSession(sessionId: string, actorUserId: number): Promise<TeamSessionView> {
    return this.view(this.pool, await this.sessionFor(this.pool, sessionId, actorUserId), actorUserId)
  }

  async createSession(input: { teamId: string; actorUserId: number; title: string; taskId: string | null; offerIds: string[]; participantUserIds?: number[]; agentConfigs?: Record<string,{mode:'default'|'custom';override?:Partial<TeamRuntimeConfig>;capability_revision?:string}>; requestId: string }): Promise<TeamSessionView> {
    return this.idempotent(input.actorUserId, `team.session.create:${input.teamId}`, input.requestId, {
      ...(input.agentConfigs ? {agent_configs: Object.fromEntries(Object.entries(input.agentConfigs).sort())} : {}),
      title: input.title, task_id: input.taskId, offer_ids: [...new Set(input.offerIds)].sort(),
      ...((input.participantUserIds?.length ?? 0) ? { participant_user_ids: [...new Set(input.participantUserIds)].sort((a,b) => a-b) } : {}),
    }, async client => {
      await this.requireMember(client, input.teamId, input.actorUserId, true)
      if (input.taskId) {
        const task = await client.query<{ state: string }>(
          `SELECT state FROM team_tasks WHERE task_id = $1 AND team_id = $2 AND state <> 'deleted' FOR UPDATE`,
          [input.taskId, input.teamId],
        )
        if (!task.rows[0]) throw new TeamRepositoryError('team_not_found', 'task not found')
        if (task.rows[0].state === 'archived') throw new TeamRepositoryError('invalid_state', 'task must be restored before linking a new session')
      }
      const offers = await this.offers(client as unknown as pg.Pool, input.teamId, input.offerIds, true)
      if (offers.some(offer => !this.callable(offer, input.teamId))) {
        throw new TeamRepositoryError('no_callable_agent', 'at least one selected Agent is not callable')
      }
      for (const userId of [...new Set(input.participantUserIds ?? [])].sort((a,b) => a-b)) {
        if (!Number.isSafeInteger(userId) || userId < 1) throw new TeamRepositoryError('team_not_found', 'participant not found')
        await requireTeamAccess(client, userId, true)
        await this.requireActiveMembership(client, input.teamId, userId, true)
      }
      const sessionId = `css_${randomUUID()}`
      const inserted = await client.query(
        `INSERT INTO collaboration_sessions (team_session_id, team_id, creator_user_id, task_id, title)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [sessionId, input.teamId, input.actorUserId, input.taskId, input.title],
      )
      const participantIds = new Set<number>([input.actorUserId, ...(input.participantUserIds ?? []), ...offers.map(offer => Number(offer.owner_user_id))])
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
      if (Object.keys(input.agentConfigs ?? {}).some(id => !input.offerIds.includes(id))) throw new TeamRepositoryError('team_not_found','configuration requires selected Agent')
      for (const offer of offers) await new TeamAgentConfigService(this.pool).initialize(client,sessionId,offer.offer_id,input.actorUserId,input.agentConfigs?.[offer.offer_id])
      return this.view(client as unknown as pg.Pool, inserted.rows[0], input.actorUserId)
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
      return this.view(client as unknown as pg.Pool, updated.rows[0], input.actorUserId)
    })
  }

  async addParticipant(input: { sessionId: string; actorUserId: number; userId: number; expectedRevision: number; requestId: string }): Promise<TeamSessionView> {
    return this.changeParticipant({ ...input, active: true })
  }

  async removeParticipant(input: { sessionId: string; actorUserId: number; userId: number; expectedRevision: number; requestId: string }): Promise<TeamSessionView> {
    return this.changeParticipant({ ...input, active: false })
  }

  private async changeParticipant(input: { sessionId: string; actorUserId: number; userId: number; active: boolean; expectedRevision: number; requestId: string }): Promise<TeamSessionView> {
    return this.idempotent(input.actorUserId, `team.session.participant:${input.sessionId}:${input.userId}`, input.requestId, {
      active: input.active, expected_revision: input.expectedRevision,
    }, async client => {
      const session = await this.sessionFor(client as unknown as pg.Pool, input.sessionId, input.actorUserId, true)
      if (Number(session.creator_user_id) !== input.actorUserId) throw new TeamRepositoryError('creator_required', 'shared session creator authority required')
      this.expectRevision(session, input.expectedRevision)
      if (input.userId === Number(session.creator_user_id) && !input.active) throw new TeamRepositoryError('invalid_state', 'shared session creator cannot be removed')
      if (input.active) await this.requireMember(client, session.team_id, input.userId)
      else await this.requireActiveMembership(client, session.team_id, input.userId)
      if (input.active) {
        // Context writers take this same Session lock. Validate the Context
        // committed before our lock was acquired, before admitting its reader.
        await this.memoryContextBridge?.validateParticipantAddition({
          sessionId: input.sessionId,
          actorUserId: input.actorUserId,
          participantUserId: input.userId,
        })
      }
      const current = await client.query(
        `SELECT * FROM collaboration_session_participants WHERE team_session_id = $1 AND user_id = $2 FOR UPDATE`,
        [input.sessionId, input.userId],
      )
      if (!input.active) {
        // Access removal and binding retirement share the Session transaction.
        // In-flight calls retain identity for reconciliation; pending work stops.
        await client.query(`UPDATE collaboration_session_agent_bindings SET state='removed', revision=revision+1,
          removed_at=NOW(),updated_at=NOW() WHERE team_session_id=$1 AND owner_user_id=$2 AND state='active'`, [input.sessionId,input.userId])
        await client.query(`UPDATE collaboration_calls SET state='cancelled',outcome='participant_removed',finished_at=NOW(),updated_at=NOW()
          WHERE team_session_id=$1 AND state='pending' AND offer_id IN (SELECT offer_id FROM team_agent_offers WHERE owner_user_id=$2)`, [input.sessionId,input.userId])
        await client.query(`UPDATE collaboration_runs SET stop_requested=true,next_wake_at=NOW(),updated_at=NOW()
          WHERE team_session_id=$1 AND state IN ('ready','running','waiting_input','blocked','paused')`, [input.sessionId])
      }
      if (current.rows[0]) {
        if (!input.active && current.rows[0].state === 'active') {
          await this.memorySources?.revokeReaderSession?.(client, {
            teamSessionId: input.sessionId,
            userId: input.userId,
            participantRevision: Number(current.rows[0].revision),
            reason: 'participant_removed',
          })
        }
        await client.query(
          // Reader generation changes only when access changes. Re-adding an
          // active reader must retain the identity of its existing sources.
          `UPDATE collaboration_session_participants SET state = $3::varchar,
             revision = CASE WHEN state = $3::varchar THEN revision ELSE revision + 1 END,
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
      return this.view(client as unknown as pg.Pool, updated.rows[0], input.actorUserId)
    }, input.active ? undefined : () => this.notifier.revoked?.(input.sessionId, input.userId))
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
      if (input.active) {
        // The Agent owner joins as a participant in the same transaction.
        // Hold the session lock while checking its current shared references.
        await this.memoryContextBridge?.validateParticipantAddition({
          sessionId: input.sessionId,
          actorUserId: input.actorUserId,
          participantUserId: Number(offer.owner_user_id),
        })
      }
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
           ON CONFLICT (team_session_id, user_id) DO UPDATE SET state = 'active',
             revision = CASE WHEN collaboration_session_participants.state = 'active'
               THEN collaboration_session_participants.revision ELSE collaboration_session_participants.revision + 1 END,
             updated_at = NOW(), removed_at = NULL`,
          [`csp_${randomUUID()}`, input.sessionId, offer.owner_user_id, input.actorUserId],
        )
      }
      const updated = await client.query(
        `UPDATE collaboration_sessions SET revision = revision + 1, updated_at = NOW()
         WHERE team_session_id = $1 RETURNING *`, [input.sessionId],
      )
      return this.view(client as unknown as pg.Pool, updated.rows[0], input.actorUserId)
    })
  }

  async appendMessage(input: { sessionId: string; actorUserId: number; requestId: string; content: string; targetMode: TeamMessageTargetMode; targetOfferIds: string[]; referenceEventId: string | null; contextVersion?:number }, transactionClient?:pg.PoolClient): Promise<{ event: TeamEvent; call_ids: string[] }> {
    const transact = transactionClient ? async <T>(run:(client:pg.PoolClient)=>Promise<T>)=>run(transactionClient) : this.transaction.bind(this)
    const result = await transact(async client => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`team:event:${input.sessionId}:${input.actorUserId}:${input.requestId}`])
      const session = await this.sessionFor(client as unknown as pg.Pool, input.sessionId, input.actorUserId, true)
      if (session.state !== 'active') throw new TeamRepositoryError('invalid_state', 'shared session is not writable')
      const prior = await this.events.findMemberEventReceipt(client, {
        teamSessionId: input.sessionId,
        authorUserId: input.actorUserId,
        requestId: input.requestId,
        content: input.content,
        targetMode: input.targetMode,
        targetOfferIds: input.targetOfferIds,
        referenceEventId: input.referenceEventId,
      })
      if (prior) return { appended: prior, participantUserIds: [], replayed: true }
      const bindingRows = await client.query(
        `SELECT binding.offer_id, offer.*, daemon.hostname, daemon.status, daemon.agents,
                daemon.collaboration_capabilities, team_binding.team_id AS occupied_team_id,
                member.state AS owner_membership_state, owner.team_enabled AS owner_team_enabled
         FROM collaboration_session_agent_bindings binding
         JOIN team_agent_offers offer ON offer.offer_id = binding.offer_id
         JOIN users owner ON owner.id = offer.owner_user_id
         JOIN daemons daemon ON daemon.daemon_id = offer.daemon_id AND daemon.user_id = offer.owner_user_id
         JOIN collaboration_team_memberships member ON member.team_id = offer.team_id AND member.user_id = offer.owner_user_id
         LEFT JOIN collaboration_team_daemon_bindings team_binding ON team_binding.daemon_id = offer.daemon_id
         WHERE binding.team_session_id = $1 AND binding.state = 'active'`,
        [input.sessionId],
      )
      const callable = bindingRows.rows.filter(row => this.callable(row, session.team_id))
      if (input.targetMode !== 'discussion' && callable.length === 0) throw new TeamRepositoryError('no_callable_agent', 'no callable Agent is available')
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
        contextVersion: input.contextVersion ?? Number(session.current_context_version),
      })
      const participants = await client.query<{ user_id: number }>(
        `SELECT participant.user_id FROM collaboration_session_participants participant
         JOIN collaboration_team_memberships member
           ON member.team_id = $2 AND member.user_id = participant.user_id AND member.state = 'active'
         WHERE participant.team_session_id = $1 AND participant.state = 'active'`,
        [input.sessionId, session.team_id],
      )
      return { appended, participantUserIds: participants.rows.map(row => Number(row.user_id)), replayed: false }
    }).catch(error => {
      if (error instanceof Error && error.message === 'event_idempotency_conflict') throw new TeamRepositoryError('idempotency_conflict', 'request_id was reused with different message content')
      if (error instanceof Error && error.message === 'reference_not_found') throw new TeamRepositoryError('team_not_found', 'referenced event not found')
      throw error
    })
    if (!result.replayed && !transactionClient) {
      this.notifier.event?.(input.sessionId, result.participantUserIds, result.appended.event)
      this.notifier.dispatch?.(result.appended.call_ids)
    }
    return result.appended
  }

  async assignTask(input:{sessionId:string;actorUserId:number;requestId:string;instruction:string;acceptance:string;targetOfferIds:string[];contextVersion:number;referenceEventId?:string|null;reviewPolicy?:TaskReviewPolicy}) {
    if (input.reviewPolicy) validateReviewPolicy(input.reviewPolicy)
    if(!input.instruction.trim()||!input.acceptance.trim()||input.instruction.length>32000||input.acceptance.length>16000||input.targetOfferIds.length<1||input.targetOfferIds.length>16)throw new TeamRepositoryError('invalid_state','task instruction, acceptance and targets required')
    const result=await this.transaction(async client=>{
      const operation=`team.task.dispatch:${input.sessionId}`
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`${operation}:${input.actorUserId}:${input.requestId}`])
      const session=await this.sessionFor(client,input.sessionId,input.actorUserId,true)
      const fingerprint=hash({...input,targetOfferIds:[...new Set(input.targetOfferIds)].sort()})
      const prior=(await client.query(`SELECT request_hash,response FROM collaboration_team_idempotency WHERE user_id=$1 AND operation=$2 AND request_id=$3`,[input.actorUserId,operation,input.requestId])).rows[0]
      if(prior){if(prior.request_hash!==fingerprint)throw new TeamRepositoryError('idempotency_conflict','task request reused with different content');return {...prior.response,replayed:true}}
      if(input.contextVersion!==Number(session.current_context_version))throw new TeamRepositoryError('context_revision_conflict','selected materials changed',Number(session.current_context_version))
      if (input.reviewPolicy && (!this.deliveryEnabledForTeam(session.team_id) || !input.targetOfferIds.includes(input.reviewPolicy.primary_offer_id))) throw new TeamRepositoryError('team_feature_disabled', 'delivery unavailable for Team or primary Agent not among targets')
      const taskId=`ctk_${randomUUID()}`
      await client.query(`INSERT INTO team_tasks(task_id,team_id,creator_user_id,title,background) VALUES($1,$2,$3,$4,$5)`,[taskId,session.team_id,input.actorUserId,input.instruction.split('\n')[0].slice(0,240),input.instruction+'\n\n交付与验收：\n'+input.acceptance])
      if (input.reviewPolicy) await createInitialTaskSpec(client, taskId, input.actorUserId, input.instruction, input.acceptance, input.reviewPolicy)
      await client.query(`INSERT INTO team_task_holders(task_id,user_id) VALUES($1,$2)`,[taskId,input.actorUserId])
      // Internal source events do not consume the direct-message request ID
      // namespace. The operation receipt is the sole task deduplication key.
      const message=await this.appendMessage({sessionId:input.sessionId,actorUserId:input.actorUserId,requestId:`task-${randomUUID()}`,content:input.instruction+'\n\n交付与验收：\n'+input.acceptance,targetMode:'offers',targetOfferIds:input.targetOfferIds,referenceEventId:input.referenceEventId??null,contextVersion:input.contextVersion},client)
      await client.query('UPDATE collaboration_events SET request_id=NULL WHERE event_id=$1',[message.event.id])
      message.event.request_id=null
      await client.query('UPDATE collaboration_calls SET task_id=$2 WHERE call_id=ANY($1::text[])',[message.call_ids,taskId])
      if (input.reviewPolicy) await client.query('INSERT INTO team_call_delivery_specs(call_id,task_id,spec_revision) SELECT unnest($1::text[]),$2,1', [message.call_ids, taskId])
      const response={task_id:taskId,...message}
      await client.query(`INSERT INTO collaboration_team_idempotency(user_id,operation,request_id,request_hash,response) VALUES($1,$2,$3,$4,$5::jsonb)`,[input.actorUserId,operation,input.requestId,fingerprint,JSON.stringify(response)])
      return {...response,replayed:false}
    })
    if(!result.replayed)this.notifier.dispatch?.(result.call_ids)
    return {task_id:result.task_id,event:result.event,call_ids:result.call_ids}
  }

  async taskByRequest(sessionId: string, actorUserId: number, requestId: string) {
    if (!requestId || requestId.length > 128) throw new TeamRepositoryError('invalid_request', 'valid request_id is required')
    return this.transaction(async client => {
      const session = await this.sessionFor(client, sessionId, actorUserId)
      const base = { operation: 'assign_task' as const, request_id: requestId, team_session_id: sessionId }
      const receipt = (await client.query(`SELECT response FROM collaboration_team_idempotency
        WHERE user_id=$1 AND operation=$2 AND request_id=$3`, [actorUserId, `team.task.dispatch:${sessionId}`, requestId])).rows[0]
      // An authenticated absence has an explicit response; a 404 can never be
      // mistaken for permission to recreate an unknown task.
      if (!receipt) return { ...base, found: false, response: null }
      const task = (await client.query("SELECT 1 FROM team_tasks WHERE task_id=$1 AND team_id=$2 AND state<>'deleted'", [receipt.response.task_id, session.team_id])).rows[0]
      if (!task) throw new TeamRepositoryError('team_not_found', 'assigned task is no longer readable')
      await this.sessionFor(client, sessionId, actorUserId)
      return { ...base, found: true, response: receipt.response }
    })
  }

  async executeTask(input: { sessionId: string; taskId: string; actorUserId: number; request_id: string; expected_revision: number; expected_task_revision?: number; spec_revision: number; context_version: number; target_offer_ids: string[] }) {
    validateMutation(input); positiveRevision(input.spec_revision)
    if (input.expected_task_revision !== undefined) positiveRevision(input.expected_task_revision)
    if (!Number.isSafeInteger(input.context_version) || input.context_version < 0 || !Array.isArray(input.target_offer_ids)
      || !input.target_offer_ids.length || input.target_offer_ids.length > 16 || input.target_offer_ids.some(id => typeof id !== 'string' || !id || id.length > 128)) throw new TeamRepositoryError('invalid_request', 'context and targets required')
    const fingerprint = stableDigest({ ...input, target_offer_ids: [...new Set(input.target_offer_ids)].sort() })
    const result = await this.transaction(async client => {
      // Keep the existing session -> task lock order; appendMessage owns dispatch.
      const session = await this.sessionFor(client, input.sessionId, input.actorUserId, true)
      const task = (await client.query('SELECT * FROM team_tasks WHERE task_id=$1 AND team_id=$2 FOR UPDATE', [input.taskId, session.team_id])).rows[0]
      if (!task || task.state === 'deleted') throw new TeamRepositoryError('team_not_found', 'task not found')
      if (!this.deliveryEnabledForTeam(session.team_id)) throw new TeamRepositoryError('team_feature_disabled', 'task delivery disabled')
      if (Number(task.creator_user_id) !== input.actorUserId && session.actor_team_role !== 'admin') throw new TeamRepositoryError('creator_required', 'task creator or Team admin required')
      const prior = (await client.query('SELECT request_hash,response FROM team_delivery_receipts WHERE task_id=$1 AND actor_user_id=$2 AND request_id=$3', [input.taskId, input.actorUserId, input.request_id])).rows[0]
      if (prior) {
        if (prior.request_hash !== fingerprint) throw new TeamRepositoryError('idempotency_conflict', 'request ID reused')
        return { response: prior.response, replayed: true }
      }
      if (task.requirements != null && input.expected_task_revision === undefined) throw new TeamRepositoryError('revision_conflict', 'saved task requirements require a confirmed task version; refresh or update the client', Number(task.revision))
      if (input.expected_task_revision !== undefined && Number(task.revision) !== input.expected_task_revision) throw new TeamRepositoryError('revision_conflict', 'task requirements or ownership changed; review before executing', Number(task.revision))
      if ((await client.query('SELECT 1 FROM team_task_plan_runtime WHERE task_id=$1 UNION ALL SELECT 1 FROM team_task_template_sources WHERE task_id=$1 LIMIT 1', [input.taskId])).rows[0]) throw new TeamRepositoryError('invalid_state', 'template and activated plans require step execution controls')
      if (!['open', 'in_progress'].includes(task.state) || session.state !== 'active') throw new TeamRepositoryError('invalid_state', 'task and session must be writable')
      const head = (await client.query('SELECT * FROM team_task_delivery_heads WHERE task_id=$1', [input.taskId])).rows[0]
      if (!head) throw new TeamRepositoryError('capability_not_supported', 'task has no delivery contract')
      if (Number(head.revision) !== input.expected_revision || Number(head.spec_revision) !== input.spec_revision) throw new TeamRepositoryError('revision_conflict', 'delivery specification changed', Number(head.revision))
      if (Number(session.current_context_version) !== input.context_version) throw new TeamRepositoryError('context_revision_conflict', 'shared context changed', Number(session.current_context_version))
      const spec = (await client.query('SELECT * FROM team_task_specs WHERE task_id=$1 AND revision=$2', [input.taskId, head.spec_revision])).rows[0]
      if (!input.target_offer_ids.includes(spec.primary_offer_id)) throw new TeamRepositoryError('invalid_request', 'include the selected primary Agent')
      // Unknown execution is deliberately not permission to create another call.
      if ((await client.query("SELECT 1 FROM collaboration_calls WHERE task_id=$1 AND state IN ('pending','dispatched','accepted','uncertain') LIMIT 1", [input.taskId])).rows[0]) throw new TeamRepositoryError('invalid_state', 'reconcile outstanding execution before dispatching again')
      if ((await client.query("SELECT 1 FROM team_acceptance_decisions WHERE submission_id=$1 AND spec_revision=$2 AND decision='accepted'", [head.latest_submission_id, head.spec_revision])).rows[0]) throw new TeamRepositoryError('invalid_state', 'accepted delivery needs an explicit specification revision')
      const previousReview = head.latest_submission_id ? (await client.query(`SELECT s.submission_id,s.version,s.spec_revision,d.decision,d.reason
        FROM team_task_submissions s LEFT JOIN team_acceptance_decisions d USING(submission_id)
        WHERE s.submission_id=$1 AND s.task_id=$2`, [head.latest_submission_id, input.taskId])).rows[0] : null
      // Freeze the human's new execution intent and the review it responds to
      // in the immutable source event. Repeating the goal alone lets a resumed
      // model reasonably answer that its previous delivery is already done.
      const execution = '这是本任务的新一次显式执行。请按当前冻结规格重新完成工作，并将交付文件写入本次调用指定的新目录。历史目录中的文件不能代替本次交付；不要覆盖历史版本。此前执行中的“写完即停止”仅结束此前那次执行，本次需要新的交付。工具权限和人工验收要求保持不变。'
      const review = previousReview ? `\n\n上一版交付与审核意见（历史参考，不能替代当前规格）：\n${JSON.stringify(previousReview)}` : ''
      const message = await this.appendMessage({ sessionId: input.sessionId, actorUserId: input.actorUserId, requestId: `task-${randomUUID()}`,
        content: `${execution}${review}\n\n任务目标：\n${spec.goal}\n\n交付与验收：\n${spec.acceptance}${frozenTaskRequirementsText(task)}`, targetMode: 'offers', targetOfferIds: input.target_offer_ids, referenceEventId: null, contextVersion: input.context_version }, client)
      await client.query('UPDATE collaboration_events SET request_id=NULL WHERE event_id=$1', [message.event.id]); message.event.request_id = null
      await client.query('UPDATE collaboration_calls SET task_id=$2 WHERE call_id=ANY($1::text[])', [message.call_ids, input.taskId])
      await client.query('INSERT INTO team_call_delivery_specs(call_id,task_id,spec_revision) SELECT unnest($1::text[]),$2,$3', [message.call_ids, input.taskId, head.spec_revision])
      await client.query('UPDATE team_task_delivery_heads SET revision=revision+1 WHERE task_id=$1', [input.taskId])
      await client.query("UPDATE team_tasks SET state='in_progress',revision=revision+1,updated_at=NOW() WHERE task_id=$1", [input.taskId])
      const response = { task_id: input.taskId, spec_revision: input.spec_revision, revision: Number(head.revision) + 1, ...message }
      await client.query('INSERT INTO team_delivery_receipts(task_id,actor_user_id,request_id,request_hash,operation,response) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [input.taskId, input.actorUserId, input.request_id, fingerprint, 'execute_task', JSON.stringify(response)])
      await client.query('INSERT INTO team_delivery_outbox(event_id,task_id,kind,payload) VALUES($1,$2,$3,$4::jsonb)', [randomUUID(), input.taskId, 'execution_requested', JSON.stringify({ call_ids: message.call_ids, spec_revision: input.spec_revision })])
      return { response, replayed: false }
    })
    if (!result.replayed) this.notifier.dispatch?.(result.response.call_ids)
    return result.response
  }

  async listEvents(sessionId: string, actorUserId: number, afterSeq: number, limit: number) {
    const session = await this.sessionFor(this.pool, sessionId, actorUserId)
    const highWater = Number(session.latest_event_seq), floor = Number(session.retained_after_seq ?? 0)
    const reset = afterSeq < floor || afterSeq > highWater
    const page = await this.events.listEvents(this.pool, sessionId, reset ? floor : afterSeq, limit, highWater)
    return {...page, shared_high_water:highWater,completed_through:page.next_cursor ?? highWater,reset_required:reset,retained_after_seq:floor}
  }

  async messageByRequest(sessionId:string,actorUserId:number,requestId:string) {
    await this.sessionFor(this.pool,sessionId,actorUserId)
    const row=(await this.pool.query(`SELECT * FROM collaboration_events WHERE team_session_id=$1 AND author_user_id=$2 AND request_id=$3`,[sessionId,actorUserId,requestId])).rows[0]
    if (!row) throw new TeamRepositoryError('team_not_found','message not found')
    const {teamEventView}=await import('./event-repository.js')
    const calls=await this.pool.query(`SELECT call_id FROM collaboration_calls WHERE event_id=$1 ORDER BY offer_id`,[row.event_id])
    return {event:teamEventView(row),call_ids:calls.rows.map(c=>c.call_id)}
  }
  async sharedHighWater(userId:number,sessionId:string):Promise<number> {
    return Number((await this.sessionFor(this.pool,sessionId,userId)).latest_event_seq)
  }
  async listCalls(sessionId: string, actorUserId: number) {
    await this.sessionFor(this.pool, sessionId, actorUserId)
    const result = await this.pool.query(
      `SELECT c.call_id AS id, c.event_id, c.offer_id, c.state,
         CASE WHEN c.outcome = 'waiting_owner' THEN 'waiting_owner'
              WHEN c.state = 'failed' AND d.outcome = 'team_memory_context_unsupported_adapter'
                THEN 'memory_adapter_unsupported'
              WHEN c.state = 'failed' AND c.outcome IN ('start_fail', 'codex_project_skills_invalid')
                THEN c.outcome
              ELSE NULL END AS outcome,
         c.created_at, c.updated_at
       FROM collaboration_calls c
       LEFT JOIN collaboration_context_deliveries d ON d.call_id = c.call_id
       WHERE c.team_session_id = $1
       ORDER BY c.created_at DESC, c.call_id DESC LIMIT 100`, [sessionId],
    )
    return result.rows
  }

  async canSubscribe(userId: number, sessionId: string): Promise<boolean> {
    try { await this.sessionFor(this.pool, sessionId, userId); return true } catch { return false }
  }

  private ownerView(view: TeamSessionView, actorUserId: number): TeamSessionView {
    return { ...view, agent_bindings: view.agent_bindings.map(binding => ({
      ...binding, native_session_id: binding.owner_user_id === actorUserId ? binding.native_session_id : null,
    })) }
  }

  private async view(db: Pick<pg.Pool, 'query'>, row: any, actorUserId: number): Promise<TeamSessionView> {
    const [participants, bindings, actorRole] = await Promise.all([
      db.query(`SELECT participant.participant_id, participant.user_id, participant.state, participant.revision
        FROM collaboration_session_participants participant
        JOIN collaboration_team_memberships member ON member.team_id = $2
          AND member.user_id = participant.user_id AND member.state = 'active'
        WHERE participant.team_session_id = $1 AND participant.state = 'active'
        ORDER BY participant.created_at`, [row.team_session_id, row.team_id]),
      db.query(
        `SELECT binding.*, offer.daemon_id, offer.provider, owner.team_enabled AS owner_team_enabled, daemon.hostname, daemon.status, daemon.agents,
                daemon.collaboration_capabilities, team_binding.team_id AS occupied_team_id
         FROM collaboration_session_agent_bindings binding
         JOIN team_agent_offers offer ON offer.offer_id = binding.offer_id
         JOIN users owner ON owner.id = offer.owner_user_id
         JOIN daemons daemon ON daemon.daemon_id = offer.daemon_id
         LEFT JOIN collaboration_team_daemon_bindings team_binding ON team_binding.daemon_id = offer.daemon_id
         WHERE binding.team_session_id = $1 AND binding.state = 'active' ORDER BY binding.created_at`,
        [row.team_session_id],
      ),
      row.actor_team_role !== undefined
        ? Promise.resolve({ rows: [{ role: row.actor_team_role }] })
        : db.query<{role: string}>(`SELECT role FROM collaboration_team_memberships
            WHERE team_id = $1 AND user_id = $2 AND state = 'active'`, [row.team_id, actorUserId]),
    ])
    if (!actorRole.rows[0]) throw new TeamRepositoryError('team_not_found', 'team not found')
    return {
      id: row.team_session_id,
      current_user_role: actorRole.rows[0].role,
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
        config: bindingConfigView(binding),
        id: binding.binding_id,
        offer_id: binding.offer_id,
        owner_user_id: Number(binding.owner_user_id),
        daemon_id: binding.daemon_id,
        provider: binding.provider,
        state: binding.state,
        revision: Number(binding.revision),
        native_session_id: Number(binding.owner_user_id) === actorUserId ? binding.native_session_id : null,
        availability: binding.owner_team_enabled !== true ? 'access_disabled' : candidateForProvider({
          daemon_id: binding.daemon_id, hostname: binding.hostname, status: binding.status,
          agents: binding.agents, collaboration_capabilities: binding.collaboration_capabilities,
          team_id: binding.occupied_team_id,
        }, binding.provider, row.team_id, this.externalEnabledForTeam(row.team_id)).availability,
      })),
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    }
  }
}
