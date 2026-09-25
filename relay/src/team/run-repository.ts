import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'

import { candidateForProvider, type DaemonAgentEvidence } from './agent-offers.js'
import { teamEventView } from './event-repository.js'
import { TeamRepositoryError } from './repository.js'
import type { TeamEvent, TeamRun, TeamRunBudget, TeamRunState } from './types.js'

export interface TeamRunMutation {
  run: TeamRun
  event: TeamEvent
  participantUserIds: number[]
}

export interface TeamRunLease {
  run: TeamRun
  leaseToken: number
}

export interface TeamRunBinding {
  bindingId: string
  offerId: string
  callable: boolean
}

export interface TeamRunCallSnapshot {
  callId: string
  runStep: number
  runRole: 'coordinator' | 'worker'
  offerId: string
  state: string
  outcome: string | null
  response: string | null
}

export interface TeamRunWorkSnapshot {
  run: TeamRun
  bindings: TeamRunBinding[]
  latestCall: TeamRunCallSnapshot | null
  latestMemberInput: string | null
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function budget(value: unknown): TeamRunBudget {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    max_calls: Number(raw.max_calls),
    max_concurrent_calls: Number(raw.max_concurrent_calls),
    max_duration_seconds: Number(raw.max_duration_seconds),
  }
}

export function teamRunView(row: any): TeamRun {
  return {
    id: row.run_id,
    team_session_id: row.team_session_id,
    initiator_user_id: Number(row.initiator_user_id),
    coordinator_offer_id: row.coordinator_offer_id,
    context_version: Number(row.context_version),
    state: row.state,
    stop_requested: row.stop_requested === true,
    budget: budget(row.budget),
    calls_used: Number(row.calls_used),
    next_step: Number(row.next_step),
    processed_call_step: Number(row.processed_call_step),
    revision: Number(row.revision),
    waiting_question: row.waiting_question ?? null,
    terminal_reason: row.terminal_reason ?? null,
    started_at: iso(row.started_at),
    deadline_at: iso(row.deadline_at)!,
    finished_at: iso(row.finished_at),
    created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at)!,
  }
}

function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export class TeamRunRepository {
  constructor(private readonly pool: pg.Pool) {}

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

  private async participants(db: Pick<pg.Pool, 'query'>, sessionId: string): Promise<number[]> {
    const result = await db.query<{ user_id: number }>(
      `SELECT user_id FROM collaboration_session_participants WHERE team_session_id = $1 AND state = 'active'`, [sessionId],
    )
    return result.rows.map(row => Number(row.user_id))
  }

  private async appendEvent(client: pg.PoolClient, input: {
    sessionId: string
    contextVersion: number
    content: string
    authorUserId?: number
    requestId?: string
  }): Promise<TeamEvent> {
    const sequence = await client.query<{ latest_event_seq: string }>(
      `UPDATE collaboration_sessions SET latest_event_seq = latest_event_seq + 1, updated_at = NOW()
       WHERE team_session_id = $1 RETURNING latest_event_seq`, [input.sessionId],
    )
    const inserted = await client.query(
      `INSERT INTO collaboration_events
        (event_id, team_session_id, event_seq, kind, author_user_id, context_version, content, request_id)
       VALUES ($1, $2, $3, 'run', $4, $5, $6, $7) RETURNING *`,
      [`cev_${randomUUID()}`, input.sessionId, Number(sequence.rows[0].latest_event_seq), input.authorUserId ?? null,
        input.contextVersion, input.content, input.requestId ?? null],
    )
    return teamEventView(inserted.rows[0])
  }

  private callable(row: any, teamId: string): boolean {
    if (row.binding_state !== 'active' || row.offer_state !== 'active' || row.membership_state !== 'active') return false
    return candidateForProvider({
      daemon_id: row.daemon_id, hostname: row.hostname, status: row.daemon_status,
      agents: row.agents, collaboration_capabilities: row.collaboration_capabilities,
      team_id: row.occupied_team_id,
    } satisfies DaemonAgentEvidence, row.provider, teamId).managed_callable
  }

  async create(input: {
    sessionId: string
    actorUserId: number
    coordinatorOfferId: string
    contextVersion: number
    budget: TeamRunBudget
    requestId: string
  }): Promise<TeamRunMutation> {
    return this.transaction(async client => {
      const operation = `team.run.create:${input.sessionId}`
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${input.actorUserId}:${operation}:${input.requestId}`])
      const requestHash = canonicalHash({ coordinator_offer_id: input.coordinatorOfferId, context_version: input.contextVersion, budget: input.budget })
      const prior = await client.query<{ request_hash: string; response: TeamRunMutation }>(
        `SELECT request_hash, response FROM collaboration_team_idempotency WHERE user_id = $1 AND operation = $2 AND request_id = $3`,
        [input.actorUserId, operation, input.requestId],
      )
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash) throw new TeamRepositoryError('idempotency_conflict', 'request_id was reused with different run content')
        return prior.rows[0].response
      }
      const session = (await client.query(
        `SELECT session.* FROM collaboration_sessions session
         JOIN collaboration_session_participants participant ON participant.team_session_id = session.team_session_id
           AND participant.user_id = $2 AND participant.state = 'active'
         JOIN collaboration_team_memberships member ON member.team_id = session.team_id
           AND member.user_id = $2 AND member.state = 'active'
         WHERE session.team_session_id = $1 FOR UPDATE OF session`, [input.sessionId, input.actorUserId],
      )).rows[0]
      if (!session) throw new TeamRepositoryError('team_not_found', 'shared session not found')
      if (Number(session.creator_user_id) !== input.actorUserId) throw new TeamRepositoryError('creator_required', 'shared session creator authority required')
      if (session.state !== 'active') throw new TeamRepositoryError('invalid_state', 'shared session is not active')
      if (Number(session.current_context_version) !== input.contextVersion) {
        throw new TeamRepositoryError('context_revision_conflict', 'context changed before run creation', Number(session.current_context_version))
      }
      const coordinator = (await client.query(
        `SELECT binding.state AS binding_state, offer.state AS offer_state, offer.provider, offer.daemon_id,
                member.state AS membership_state, daemon.hostname, daemon.status AS daemon_status, daemon.agents,
                daemon.collaboration_capabilities, occupied.team_id AS occupied_team_id
         FROM collaboration_session_agent_bindings binding
         JOIN team_agent_offers offer ON offer.offer_id = binding.offer_id
         JOIN collaboration_team_memberships member ON member.team_id = offer.team_id AND member.user_id = offer.owner_user_id
         JOIN daemons daemon ON daemon.daemon_id = offer.daemon_id AND daemon.user_id = offer.owner_user_id
         LEFT JOIN collaboration_team_daemon_bindings occupied ON occupied.daemon_id = offer.daemon_id
         WHERE binding.team_session_id = $1 AND binding.offer_id = $2`, [input.sessionId, input.coordinatorOfferId],
      )).rows[0]
      if (!coordinator) throw new TeamRepositoryError('team_not_found', 'coordinator Agent binding not found')
      if (!this.callable(coordinator, session.team_id)) throw new TeamRepositoryError('agent_unavailable', 'coordinator Agent is not callable')
      const runId = `crn_${randomUUID()}`
      const inserted = await client.query(
        `INSERT INTO collaboration_runs
          (run_id, team_session_id, initiator_user_id, coordinator_offer_id, context_version, budget, deadline_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW() + ($7 * INTERVAL '1 second')) RETURNING *`,
        [runId, input.sessionId, input.actorUserId, input.coordinatorOfferId, input.contextVersion,
          JSON.stringify(input.budget), input.budget.max_duration_seconds],
      ).catch(error => {
        if ((error as { code?: string }).code === '23505') throw new TeamRepositoryError('invalid_state', 'shared session already has an active run')
        throw error
      })
      const event = await this.appendEvent(client, {
        sessionId: input.sessionId, contextVersion: input.contextVersion, authorUserId: input.actorUserId,
        requestId: `run:create:${input.requestId}`, content: `Automatic collaboration run ${runId} created with a frozen budget of ${input.budget.max_calls} calls.`,
      })
      const response = { run: teamRunView(inserted.rows[0]), event, participantUserIds: await this.participants(client, input.sessionId) }
      await client.query(
        `INSERT INTO collaboration_team_idempotency (user_id, operation, request_id, request_hash, response)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [input.actorUserId, operation, input.requestId, requestHash, JSON.stringify(response)],
      )
      return response
    })
  }

  async list(sessionId: string, actorUserId: number): Promise<TeamRun[]> {
    const result = await this.pool.query(
      `SELECT run.* FROM collaboration_runs run
       JOIN collaboration_session_participants participant ON participant.team_session_id = run.team_session_id
         AND participant.user_id = $2 AND participant.state = 'active'
       JOIN collaboration_sessions session ON session.team_session_id = run.team_session_id
       JOIN collaboration_team_memberships member ON member.team_id = session.team_id
         AND member.user_id = $2 AND member.state = 'active'
       WHERE run.team_session_id = $1 ORDER BY run.created_at DESC`, [sessionId, actorUserId],
    )
    return result.rows.map(teamRunView)
  }

  async get(runId: string, actorUserId: number): Promise<TeamRun> {
    const result = await this.pool.query(
      `SELECT run.* FROM collaboration_runs run
       JOIN collaboration_sessions session ON session.team_session_id = run.team_session_id
       JOIN collaboration_session_participants participant ON participant.team_session_id = run.team_session_id
         AND participant.user_id = $2 AND participant.state = 'active'
       JOIN collaboration_team_memberships member ON member.team_id = session.team_id
         AND member.user_id = $2 AND member.state = 'active'
       WHERE run.run_id = $1`, [runId, actorUserId],
    )
    if (!result.rows[0]) throw new TeamRepositoryError('team_not_found', 'collaboration run not found')
    return teamRunView(result.rows[0])
  }

  async control(input: { runId: string; actorUserId: number; action: 'pause' | 'resume' | 'cancel'; expectedRevision: number; requestId: string }): Promise<TeamRunMutation> {
    return this.transaction(async client => {
      const operation = `team.run.${input.action}:${input.runId}`
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${input.actorUserId}:${operation}:${input.requestId}`])
      const requestHash = canonicalHash({ expected_revision: input.expectedRevision })
      const prior = await client.query<{ request_hash: string; response: TeamRunMutation }>(
        `SELECT request_hash, response FROM collaboration_team_idempotency WHERE user_id = $1 AND operation = $2 AND request_id = $3`,
        [input.actorUserId, operation, input.requestId],
      )
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash) throw new TeamRepositoryError('idempotency_conflict', 'request_id was reused with different run control content')
        return prior.rows[0].response
      }
      const run = (await client.query(
        `SELECT run.*, session.creator_user_id FROM collaboration_runs run
         JOIN collaboration_sessions session ON session.team_session_id = run.team_session_id
         JOIN collaboration_session_participants participant ON participant.team_session_id = run.team_session_id
           AND participant.user_id = $2 AND participant.state = 'active'
         WHERE run.run_id = $1 FOR UPDATE OF run`, [input.runId, input.actorUserId],
      )).rows[0]
      if (!run) throw new TeamRepositoryError('team_not_found', 'collaboration run not found')
      if (Number(run.creator_user_id) !== input.actorUserId) throw new TeamRepositoryError('creator_required', 'shared session creator authority required')
      if (Number(run.revision) !== input.expectedRevision) throw new TeamRepositoryError('revision_conflict', 'revision mismatch', Number(run.revision))
      if (['completed', 'failed', 'cancelled'].includes(run.state)) throw new TeamRepositoryError('invalid_state', 'collaboration run is terminal')
      if (input.action === 'resume') {
        if (!['waiting_input', 'blocked', 'paused'].includes(run.state)) throw new TeamRepositoryError('invalid_state', 'collaboration run cannot resume from its current state')
        const uncertain = await client.query(`SELECT 1 FROM collaboration_calls WHERE run_id = $1 AND state = 'uncertain' LIMIT 1`, [input.runId])
        if (uncertain.rows[0]) throw new TeamRepositoryError('dispatch_uncertain', 'uncertain calls must be reconciled before resume')
      }
      const nextState = input.action === 'pause' ? 'paused' : input.action === 'resume' ? 'running' : run.state
      const stopRequested = input.action === 'cancel' ? true : input.action === 'resume' ? false : run.stop_requested
      const updated = await client.query(
        `UPDATE collaboration_runs SET state = $2::varchar, stop_requested = $3, revision = revision + 1,
           waiting_question = CASE WHEN $2::varchar = 'running' THEN NULL ELSE waiting_question END,
           terminal_reason = CASE WHEN $2::varchar = 'running' THEN NULL ELSE terminal_reason END,
           next_wake_at = NOW(), lease_owner = NULL, lease_token = lease_token + 1,
           lease_expires_at = NULL, updated_at = NOW()
         WHERE run_id = $1 RETURNING *`, [input.runId, nextState, stopRequested],
      )
      const event = await this.appendEvent(client, {
        sessionId: run.team_session_id, contextVersion: Number(run.context_version), authorUserId: input.actorUserId,
        requestId: `run:${input.action}:${input.requestId}`,
        content: input.action === 'cancel' ? 'Run stop requested; accepted calls will be reconciled before cancellation.' : `Run ${input.action} requested.`,
      })
      const response = { run: teamRunView(updated.rows[0]), event, participantUserIds: await this.participants(client, run.team_session_id) }
      await client.query(
        `INSERT INTO collaboration_team_idempotency (user_id, operation, request_id, request_hash, response)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [input.actorUserId, operation, input.requestId, requestHash, JSON.stringify(response)],
      )
      return response
    })
  }

  async supplement(input: { runId: string; actorUserId: number; content: string; expectedRevision: number; requestId: string }): Promise<TeamRunMutation> {
    return this.transaction(async client => {
      const operation = `team.run.input:${input.runId}`
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${input.actorUserId}:${operation}:${input.requestId}`])
      const requestHash = canonicalHash({ content: input.content, expected_revision: input.expectedRevision })
      const prior = await client.query<{ request_hash: string; response: TeamRunMutation }>(
        `SELECT request_hash, response FROM collaboration_team_idempotency WHERE user_id = $1 AND operation = $2 AND request_id = $3`,
        [input.actorUserId, operation, input.requestId],
      )
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash) throw new TeamRepositoryError('idempotency_conflict', 'request_id was reused with different run input')
        return prior.rows[0].response
      }
      const run = (await client.query(
        `SELECT run.* FROM collaboration_runs run
         JOIN collaboration_sessions session ON session.team_session_id = run.team_session_id
         JOIN collaboration_session_participants participant ON participant.team_session_id = run.team_session_id
           AND participant.user_id = $2 AND participant.state = 'active'
         JOIN collaboration_team_memberships member ON member.team_id = session.team_id
           AND member.user_id = $2 AND member.state = 'active'
         WHERE run.run_id = $1 FOR UPDATE OF run`, [input.runId, input.actorUserId],
      )).rows[0]
      if (!run) throw new TeamRepositoryError('team_not_found', 'collaboration run not found')
      if (run.state !== 'waiting_input') throw new TeamRepositoryError('invalid_state', 'collaboration run is not waiting for input')
      if (Number(run.revision) !== input.expectedRevision) throw new TeamRepositoryError('revision_conflict', 'revision mismatch', Number(run.revision))
      const sequence = await client.query<{ latest_event_seq: string }>(
        `UPDATE collaboration_sessions SET latest_event_seq = latest_event_seq + 1, updated_at = NOW()
         WHERE team_session_id = $1 RETURNING latest_event_seq`, [run.team_session_id],
      )
      const insertedEvent = await client.query(
        `INSERT INTO collaboration_events
          (event_id, team_session_id, event_seq, kind, author_user_id, target_mode, context_version, content, request_id)
         VALUES ($1, $2, $3, 'member_message', $4, 'discussion', $5, $6, $7) RETURNING *`,
        [`cev_${randomUUID()}`, run.team_session_id, Number(sequence.rows[0].latest_event_seq), input.actorUserId,
          Number(run.context_version), input.content, `run:input:${input.requestId}`],
      )
      const updated = await client.query(
        `UPDATE collaboration_runs SET state = 'running', waiting_question = NULL, terminal_reason = NULL,
           revision = revision + 1, next_wake_at = NOW(), lease_owner = NULL,
           lease_token = lease_token + 1, lease_expires_at = NULL, updated_at = NOW()
         WHERE run_id = $1 RETURNING *`, [input.runId],
      )
      const response = { run: teamRunView(updated.rows[0]), event: teamEventView(insertedEvent.rows[0]), participantUserIds: await this.participants(client, run.team_session_id) }
      await client.query(
        `INSERT INTO collaboration_team_idempotency (user_id, operation, request_id, request_hash, response)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [input.actorUserId, operation, input.requestId, requestHash, JSON.stringify(response)],
      )
      return response
    })
  }

  async claimNext(workerId: string, leaseMs: number): Promise<TeamRunLease | null> {
    return this.transaction(async client => {
      const selected = await client.query(
        `SELECT * FROM collaboration_runs
         WHERE (state IN ('ready', 'running') OR (stop_requested AND state IN ('waiting_input', 'blocked', 'paused')))
           AND next_wake_at <= NOW()
           AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
         ORDER BY next_wake_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
      )
      if (!selected.rows[0]) return null
      const updated = await client.query(
        `UPDATE collaboration_runs SET lease_owner = $2, lease_token = lease_token + 1,
           lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'), updated_at = NOW()
         WHERE run_id = $1 RETURNING *`, [selected.rows[0].run_id, workerId, leaseMs],
      )
      return { run: teamRunView(updated.rows[0]), leaseToken: Number(updated.rows[0].lease_token) }
    })
  }

  async loadWork(runId: string, leaseToken: number): Promise<TeamRunWorkSnapshot | null> {
    const run = (await this.pool.query(`SELECT * FROM collaboration_runs WHERE run_id = $1 AND lease_token = $2`, [runId, leaseToken])).rows[0]
    if (!run) return null
    const session = (await this.pool.query(`SELECT team_id FROM collaboration_sessions WHERE team_session_id = $1`, [run.team_session_id])).rows[0]
    if (!session) return null
    const bindings = await this.pool.query(
      `SELECT binding.binding_id, binding.offer_id, binding.state AS binding_state,
              offer.state AS offer_state, offer.provider, offer.daemon_id,
              member.state AS membership_state, daemon.hostname, daemon.status AS daemon_status, daemon.agents,
              daemon.collaboration_capabilities, occupied.team_id AS occupied_team_id
       FROM collaboration_session_agent_bindings binding
       JOIN team_agent_offers offer ON offer.offer_id = binding.offer_id
       JOIN collaboration_team_memberships member ON member.team_id = offer.team_id AND member.user_id = offer.owner_user_id
       JOIN daemons daemon ON daemon.daemon_id = offer.daemon_id AND daemon.user_id = offer.owner_user_id
       LEFT JOIN collaboration_team_daemon_bindings occupied ON occupied.daemon_id = offer.daemon_id
       WHERE binding.team_session_id = $1`, [run.team_session_id],
    )
    const latest = (await this.pool.query(
      `SELECT call.call_id, call.run_step, call.run_role, call.offer_id, call.state, call.outcome,
              response.content AS response
       FROM collaboration_calls call
       LEFT JOIN LATERAL (
         SELECT string_agg(content, '' ORDER BY event_seq) AS content
         FROM collaboration_events WHERE call_id = call.call_id AND kind = 'agent_message'
       ) response ON true
       WHERE call.run_id = $1 ORDER BY call.run_step DESC LIMIT 1`, [runId],
    )).rows[0]
    const latestMember = (await this.pool.query(
      `SELECT content FROM collaboration_events WHERE team_session_id = $1 AND kind = 'member_message'
       ORDER BY event_seq DESC LIMIT 1`, [run.team_session_id],
    )).rows[0]
    return {
      run: teamRunView(run),
      bindings: bindings.rows.map(row => ({ bindingId: row.binding_id, offerId: row.offer_id, callable: this.callable(row, session.team_id) })),
      latestCall: latest ? {
        callId: latest.call_id, runStep: Number(latest.run_step), runRole: latest.run_role,
        offerId: latest.offer_id, state: latest.state, outcome: latest.outcome, response: latest.response,
      } : null,
      latestMemberInput: latestMember?.content ?? null,
    }
  }

  async scheduleCall(input: {
    runId: string
    leaseToken: number
    offerId: string
    role: 'coordinator' | 'worker'
    content: string
    processedCallStep: number
  }): Promise<{ callId: string; teamSessionId: string; event: TeamEvent; participantUserIds: number[] }> {
    return this.transaction(async client => {
      const run = (await client.query(`SELECT * FROM collaboration_runs WHERE run_id = $1 FOR UPDATE`, [input.runId])).rows[0]
      if (!run || Number(run.lease_token) !== input.leaseToken) throw new Error('run lease lost')
      if (!['ready', 'running'].includes(run.state) || run.stop_requested) throw new TeamRepositoryError('invalid_state', 'run no longer accepts calls')
      const frozenBudget = budget(run.budget)
      if (Number(run.calls_used) >= frozenBudget.max_calls || new Date(run.deadline_at).getTime() <= Date.now()) {
        throw new TeamRepositoryError('budget_exhausted', 'run budget exhausted')
      }
      const active = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM collaboration_calls WHERE run_id = $1 AND state IN ('pending','dispatched','accepted','uncertain')`, [input.runId],
      )
      if (Number(active.rows[0].count) >= frozenBudget.max_concurrent_calls) throw new TeamRepositoryError('budget_exhausted', 'run concurrency budget exhausted')
      const binding = (await client.query(
        `SELECT binding.binding_id FROM collaboration_session_agent_bindings binding
         WHERE binding.team_session_id = $1 AND binding.offer_id = $2 AND binding.state = 'active'`,
        [run.team_session_id, input.offerId],
      )).rows[0]
      if (!binding) throw new TeamRepositoryError('agent_unavailable', 'run target Agent binding is unavailable')
      const step = Number(run.next_step)
      const event = await this.appendEvent(client, {
        sessionId: run.team_session_id, contextVersion: Number(run.context_version),
        content: input.content,
      })
      const callId = `ccl_${randomUUID()}`
      await client.query(
        `INSERT INTO collaboration_calls
          (call_id, team_session_id, run_id, run_step, run_role, event_id, offer_id, binding_id,
           context_version, history_through_event_seq)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [callId, run.team_session_id, input.runId, step, input.role, event.id, input.offerId, binding.binding_id,
          Number(run.context_version), event.event_seq],
      )
      await client.query(
        `UPDATE collaboration_runs SET state = 'running', calls_used = calls_used + 1, next_step = next_step + 1,
           processed_call_step = GREATEST(processed_call_step, $2), started_at = COALESCE(started_at, NOW()),
           revision = revision + 1, lease_owner = NULL, lease_expires_at = NULL,
           next_wake_at = NOW() + INTERVAL '500 milliseconds', updated_at = NOW() WHERE run_id = $1`,
        [input.runId, input.processedCallStep],
      )
      return { callId, teamSessionId: run.team_session_id, event, participantUserIds: await this.participants(client, run.team_session_id) }
    })
  }

  async transition(input: {
    runId: string
    leaseToken: number
    state: TeamRunState
    content: string
    terminalReason?: string | null
    waitingQuestion?: string | null
    processedCallStep?: number
  }): Promise<TeamRunMutation> {
    return this.transaction(async client => {
      const run = (await client.query(`SELECT * FROM collaboration_runs WHERE run_id = $1 FOR UPDATE`, [input.runId])).rows[0]
      if (!run || Number(run.lease_token) !== input.leaseToken) throw new Error('run lease lost')
      const terminal = ['completed', 'failed', 'cancelled'].includes(input.state)
      const updated = await client.query(
        `UPDATE collaboration_runs SET state = $2::varchar, terminal_reason = $3, waiting_question = $4,
           processed_call_step = GREATEST(processed_call_step, $5), revision = revision + 1,
           finished_at = CASE WHEN $6 THEN NOW() ELSE NULL END,
           lease_owner = NULL, lease_expires_at = NULL,
           next_wake_at = CASE WHEN $2::varchar IN ('ready','running') THEN NOW() ELSE next_wake_at END,
           updated_at = NOW() WHERE run_id = $1 RETURNING *`,
        [input.runId, input.state, input.terminalReason ?? null, input.waitingQuestion ?? null,
          input.processedCallStep ?? 0, terminal],
      )
      const event = await this.appendEvent(client, {
        sessionId: run.team_session_id, contextVersion: Number(run.context_version), content: input.content,
      })
      return { run: teamRunView(updated.rows[0]), event, participantUserIds: await this.participants(client, run.team_session_id) }
    })
  }

  async cancelPending(runId: string, leaseToken: number): Promise<number> {
    const result = await this.pool.query(
      `UPDATE collaboration_calls SET state = 'cancelled', outcome = 'run_stop_requested', finished_at = NOW(), updated_at = NOW()
       WHERE run_id = $1 AND state = 'pending'
         AND EXISTS (SELECT 1 FROM collaboration_runs WHERE run_id = $1 AND lease_token = $2)`, [runId, leaseToken],
    )
    return result.rowCount ?? 0
  }

  async defer(runId: string, leaseToken: number, delayMs: number): Promise<void> {
    await this.pool.query(
      `UPDATE collaboration_runs SET lease_owner = NULL, lease_expires_at = NULL,
         next_wake_at = NOW() + ($3 * INTERVAL '1 millisecond'), updated_at = NOW()
       WHERE run_id = $1 AND lease_token = $2`, [runId, leaseToken, delayMs],
    )
  }
}
