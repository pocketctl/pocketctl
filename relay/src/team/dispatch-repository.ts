import { createHash } from 'node:crypto'
import type pg from 'pg'

import { teamAccountsEnabled } from './access.js'
import { teamEventView } from './event-repository.js'
import type { TeamMemorySourceProjectorLike } from './memory-source-projector.js'
import type { TeamEvent, TeamProvider } from './types.js'

export const TEAM_DISPATCH_CAPABILITY = 'team_collaboration_dispatch_v1'
export const TEAM_RECONCILE_CAPABILITY = 'team_collaboration_reconcile_v1'
export const TEAM_COLLABORATION_PROTOCOL_VERSION = 1

export interface DispatchAuthorization {
  protocol_version: number
  operation: 'create' | 'message'
  call_id: string
  team_session_id: string
  binding_id: string
  binding_revision: number
  offer_id: string
  offer_revision: number
  owner_user_id: number
  daemon_id: string
}

export interface ClaimedDispatch {
  callId: string
  runId: string | null
  content: string
  provider: TeamProvider
  nativeSessionId: string | null
  providerRequestId: string
  authorization: DispatchAuthorization
}

export interface ProjectedDispatchEvent {
  event: TeamEvent
  participantUserIds: number[]
}

export function dispatchAuthorizationMatches(
  accounting: Record<string, unknown> | null | undefined,
  authorization: DispatchAuthorization,
  daemonId: string,
  ownerUserId: number,
): boolean {
  return Boolean(accounting && accounting.daemon_id === daemonId && Number(accounting.owner_user_id) === ownerUserId
    && accounting.binding_id === authorization.binding_id && accounting.offer_id === authorization.offer_id
    && Number(accounting.binding_revision) === authorization.binding_revision
    && Number(accounting.offer_revision) === authorization.offer_revision
    && authorization.protocol_version === TEAM_COLLABORATION_PROTOCOL_VERSION
    && authorization.daemon_id === daemonId && authorization.owner_user_id === ownerUserId)
}

export function dispatchProjectionKind(message: Record<string, unknown>): 'agent_message' | 'status' | null {
  if (message.type === 'agent_text' && typeof message.text === 'string' && message.text.length > 0) return 'agent_message'
  if (dispatchTerminalStatus(message) || message.type === 'interactive_prompt' || message.type === 'approval_request') return 'status'
  return null
}

function dispatchTerminalStatus(message: Record<string, unknown>): string | null {
  if ((message.type === 'error' && !message.operation) || (message.type === 'session_status' && message.status === 'error')) return 'failed'
  if (message.type !== 'turn_status') return null
  const status = String(message.turn_status ?? message.status ?? '')
  return ['completed', 'failed', 'interrupted', 'abandoned'].includes(status) ? status : null
}

function hasCapability(value: unknown, capability: string): boolean {
  return Array.isArray(value) && value.includes(capability)
}

export class TeamDispatchRepository {
  constructor(
    private readonly pool: pg.Pool,
    private readonly memorySources?: TeamMemorySourceProjectorLike,
  ) {}

  async listPendingCallIds(limit = 50): Promise<string[]> {
    const result = await this.pool.query<{ call_id: string }>(
      `SELECT call_id FROM collaboration_calls WHERE state = 'pending'
       ORDER BY created_at, call_id LIMIT $1`,
      [Math.max(1, Math.min(500, Math.trunc(limit)))],
    )
    return result.rows.map(row => row.call_id)
  }

  private async transaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await run(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async claim(callId: string): Promise<ClaimedDispatch | null> {
    return this.transaction(async client => {
      const result = await client.query(
        `SELECT call.*, event.content, COALESCE(run.initiator_user_id, event.author_user_id) AS initiator_user_id, session.state AS session_state, team.state AS team_state,
                binding.binding_id, binding.revision AS current_binding_revision, binding.state AS binding_state,
                binding.native_session_id AS binding_native_session_id, binding.owner_user_id AS binding_owner_user_id,
                offer.revision AS current_offer_revision, offer.state AS offer_state, offer.provider,
                offer.daemon_id, offer.owner_user_id, member.state AS membership_state,
                daemon.status AS daemon_status, daemon.collaboration_capabilities
         FROM collaboration_calls call
         JOIN collaboration_events event ON event.event_id = call.event_id
         LEFT JOIN collaboration_runs run ON run.run_id = call.run_id
         JOIN collaboration_sessions session ON session.team_session_id = call.team_session_id
         JOIN collaboration_teams team ON team.team_id = session.team_id
         JOIN collaboration_session_agent_bindings binding ON binding.binding_id = call.binding_id
         JOIN team_agent_offers offer ON offer.offer_id = call.offer_id
         JOIN collaboration_team_memberships member ON member.team_id = session.team_id AND member.user_id = offer.owner_user_id
         JOIN daemons daemon ON daemon.daemon_id = offer.daemon_id AND daemon.user_id = offer.owner_user_id
         WHERE call.call_id = $1 FOR UPDATE OF call, binding, offer`, [callId],
      )
      const row = result.rows[0]
      if (!row || row.state !== 'pending') return null
      if (!await teamAccountsEnabled(client, [Number(row.initiator_user_id), Number(row.owner_user_id)], true)) {
        await client.query(`UPDATE collaboration_calls SET state = 'blocked', outcome = 'team_access_revoked', updated_at = NOW(), finished_at = NOW() WHERE call_id = $1`, [callId])
        return null
      }
      const unavailable = row.session_state !== 'active' || row.team_state !== 'active' || row.binding_state !== 'active'
        || row.offer_state !== 'active' || row.membership_state !== 'active' || row.daemon_status !== 'online'
        || Number(row.binding_owner_user_id) !== Number(row.owner_user_id)
        || !hasCapability(row.collaboration_capabilities, TEAM_DISPATCH_CAPABILITY)
        || !hasCapability(row.collaboration_capabilities, 'team_collaboration_context_v1')
      if (unavailable) {
        await client.query(`UPDATE collaboration_calls SET state = 'blocked', outcome = 'agent_unavailable', updated_at = NOW(), finished_at = NOW() WHERE call_id = $1`, [callId])
        return null
      }
      const conflict = await client.query(
        `SELECT 1 FROM collaboration_calls
         WHERE binding_id = $1 AND call_id <> $2 AND state IN ('dispatched', 'accepted', 'uncertain') LIMIT 1`,
        [row.binding_id, callId],
      )
      if (conflict.rows[0]) {
        await client.query(`UPDATE collaboration_calls SET state = 'blocked', outcome = 'native_session_busy', updated_at = NOW(), finished_at = NOW() WHERE call_id = $1`, [callId])
        return null
      }
      const operation: 'create' | 'message' = row.binding_native_session_id ? 'message' : 'create'
      const providerRequestId = `team-${callId}`
      await client.query(
        `UPDATE collaboration_calls SET state = 'dispatched', operation = $2, provider_request_id = $3,
           binding_revision = $4, offer_revision = $5, native_session_id = $6,
           dispatched_at = NOW(), updated_at = NOW() WHERE call_id = $1`,
        [callId, operation, providerRequestId, Number(row.current_binding_revision), Number(row.current_offer_revision), row.binding_native_session_id],
      )
      return {
        callId,
        runId: row.run_id ?? null,
        content: String(row.content),
        provider: row.provider,
        nativeSessionId: row.binding_native_session_id,
        providerRequestId,
        authorization: {
          protocol_version: TEAM_COLLABORATION_PROTOCOL_VERSION,
          operation,
          call_id: callId,
          team_session_id: row.team_session_id,
          binding_id: row.binding_id,
          binding_revision: Number(row.current_binding_revision),
          offer_id: row.offer_id,
          offer_revision: Number(row.current_offer_revision),
          owner_user_id: Number(row.owner_user_id),
          daemon_id: row.daemon_id,
        },
      }
    })
  }

  // The synchronous transport handoff is the admission boundary. Hold the
  // account locks until it returns, so a committed revocation cannot race a
  // context/quota preparation that started earlier. Receipts never use this gate.
  async sendIfEnabled(callId: string, send: () => boolean): Promise<'sent' | 'unavailable' | 'access_denied'> {
    return this.transaction(async client => {
      const row = (await client.query(`SELECT call.state, offer.owner_user_id,
          COALESCE(run.initiator_user_id, event.author_user_id) AS initiator_user_id
        FROM collaboration_calls call
        JOIN team_agent_offers offer ON offer.offer_id = call.offer_id
        JOIN collaboration_events event ON event.event_id = call.event_id
        LEFT JOIN collaboration_runs run ON run.run_id = call.run_id
        WHERE call.call_id = $1 FOR UPDATE OF call`, [callId])).rows[0]
      if (!row || row.state !== 'dispatched') return 'unavailable'
      if (!await teamAccountsEnabled(client, [Number(row.initiator_user_id), Number(row.owner_user_id)], true)) return 'access_denied'
      return send() ? 'sent' : 'unavailable'
    })
  }

  async attachReservation(callId: string, reservationId: string | null): Promise<void> {
    await this.pool.query(`UPDATE collaboration_calls SET quota_reservation_id = $2::uuid, updated_at = NOW() WHERE call_id = $1 AND state = 'dispatched'`, [callId, reservationId])
  }

  async stop(callId: string, state: 'blocked' | 'failed' | 'uncertain', outcome: string): Promise<void> {
    await this.pool.query(
      `UPDATE collaboration_calls SET state = $2::varchar, outcome = $3, updated_at = NOW(),
         finished_at = CASE WHEN $2::varchar IN ('blocked', 'failed') THEN NOW() ELSE finished_at END
       WHERE call_id = $1 AND state IN ('dispatched', 'accepted')`,
      [callId, state, outcome],
    )
  }

  async markDaemonUncertain(daemonId: string): Promise<void> {
    await this.pool.query(
      `UPDATE collaboration_calls call SET state = 'uncertain', outcome = 'daemon_disconnected', updated_at = NOW()
       FROM team_agent_offers offer WHERE offer.offer_id = call.offer_id AND offer.daemon_id = $1
         AND call.state IN ('dispatched', 'accepted')`, [daemonId],
    )
  }

  async callAccounting(callId: string): Promise<any | null> {
    const result = await this.pool.query(
      `SELECT call.*, offer.daemon_id, offer.owner_user_id
       FROM collaboration_calls call JOIN team_agent_offers offer ON offer.offer_id = call.offer_id
       WHERE call.call_id = $1`, [callId],
    )
    return result.rows[0] ?? null
  }

  async bindNativeSession(callId: string, daemonId: string, ownerUserId: number, nativeSessionId: string): Promise<boolean> {
    return this.transaction(async client => {
      const row = (await client.query(
        `SELECT call.*, offer.daemon_id, offer.owner_user_id, binding.native_session_id AS bound_session
         FROM collaboration_calls call JOIN team_agent_offers offer ON offer.offer_id = call.offer_id
         JOIN collaboration_session_agent_bindings binding ON binding.binding_id = call.binding_id
         WHERE call.call_id = $1 FOR UPDATE OF call, binding`, [callId],
      )).rows[0]
      if (!row || row.daemon_id !== daemonId || Number(row.owner_user_id) !== ownerUserId || row.operation !== 'create'
        || (row.bound_session && row.bound_session !== nativeSessionId)) return false
      await client.query(
        `UPDATE collaboration_session_agent_bindings SET native_session_id = $2, updated_at = NOW()
         WHERE binding_id = $1 AND (native_session_id IS NULL OR native_session_id = $2)`, [row.binding_id, nativeSessionId],
      )
      await client.query(`UPDATE collaboration_calls SET native_session_id = $2, updated_at = NOW() WHERE call_id = $1`, [callId, nativeSessionId])
      return true
    })
  }

  async recordReceipt(callId: string, daemonId: string, ownerUserId: number, status: string, reason: string | null): Promise<boolean> {
    const state = status === 'accepted' ? 'accepted' : (reason === 'duplicate_request' ? 'uncertain' : 'failed')
    const result = await this.pool.query(
      `UPDATE collaboration_calls call SET state = $4::varchar, outcome = $5, updated_at = NOW(),
         accepted_at = CASE WHEN $4::varchar = 'accepted' THEN COALESCE(accepted_at, NOW()) ELSE accepted_at END,
         finished_at = CASE WHEN $4::varchar = 'failed' THEN NOW() ELSE finished_at END
       FROM team_agent_offers offer
       WHERE call.call_id = $1 AND offer.offer_id = call.offer_id AND offer.daemon_id = $2 AND offer.owner_user_id = $3
         AND call.state IN ('dispatched', 'accepted', 'uncertain') RETURNING call.call_id`,
      [callId, daemonId, ownerUserId, state, reason],
    )
    return Boolean(result.rows[0])
  }

  async projectDaemonEvent(daemonId: string, ownerUserId: number, message: Record<string, unknown>): Promise<ProjectedDispatchEvent | null> {
    const sessionId = typeof message.session_id === 'string' ? message.session_id : ''
    const seq = Number(message.seq)
    if (!sessionId || !Number.isSafeInteger(seq) || seq <= 0) return null
    const projectionKind = dispatchProjectionKind(message)
    if (!projectionKind) return null
    const terminal = dispatchTerminalStatus(message) !== null
    const agentText = projectionKind === 'agent_message'
    return this.transaction(async client => {
      const call = (await client.query(
        `SELECT call.*, offer.owner_user_id, offer.daemon_id
         FROM collaboration_calls call JOIN team_agent_offers offer ON offer.offer_id = call.offer_id
         WHERE call.native_session_id = $1 AND offer.daemon_id = $2 AND offer.owner_user_id = $3
           AND call.state IN ('dispatched', 'accepted')
         ORDER BY call.dispatched_at DESC LIMIT 1 FOR UPDATE OF call`, [sessionId, daemonId, ownerUserId],
      )).rows[0]
      if (!call) return null
      const projectionKey = `${daemonId}:${seq}`
      const duplicate = await client.query(`SELECT * FROM collaboration_events WHERE call_id = $1 AND request_id = $2`, [call.call_id, projectionKey])
      if (duplicate.rows[0]) return null
      const sequence = await client.query<{ latest_event_seq: string }>(
        `UPDATE collaboration_sessions SET latest_event_seq = latest_event_seq + 1, updated_at = NOW()
         WHERE team_session_id = $1 RETURNING latest_event_seq`, [call.team_session_id],
      )
      const digest = createHash('sha256').update(`${call.call_id}:${projectionKey}`).digest('hex').slice(0, 32)
      // Never copy private terminal diagnostics into the shared stream.
      const content = agentText ? String(message.text) : dispatchTerminalStatus(message) ?? 'waiting_owner'
      const inserted = await client.query(
        `INSERT INTO collaboration_events
          (event_id, team_session_id, event_seq, kind, author_offer_id, call_id, content, request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [`cev_${digest}`, call.team_session_id, Number(sequence.rows[0].latest_event_seq), agentText ? 'agent_message' : 'status',
          call.offer_id, call.call_id, content, projectionKey],
      )
      if (!terminal) {
        await client.query(`UPDATE collaboration_calls SET outcome = $2, updated_at = NOW() WHERE call_id = $1`,
          [call.call_id, agentText ? null : 'waiting_owner'])
      }
      if (terminal) {
        const completed = content === 'completed'
        await client.query(
          `UPDATE collaboration_calls SET state = $2, outcome = $3, finished_at = NOW(), updated_at = NOW() WHERE call_id = $1`,
          [call.call_id, completed ? 'completed' : 'failed', content],
        )
        await this.memorySources?.projectCompletedCall(
          client,
          call.call_id,
          teamEventView(inserted.rows[0]),
        )
      }
      const participants = await client.query<{ user_id: number }>(
        `SELECT user_id FROM collaboration_session_participants WHERE team_session_id = $1 AND state = 'active'`, [call.team_session_id],
      )
      return { event: teamEventView(inserted.rows[0]), participantUserIds: participants.rows.map(row => Number(row.user_id)) }
    })
  }
}
