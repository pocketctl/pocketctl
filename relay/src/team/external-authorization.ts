import type pg from 'pg'
import { dispatchAuthorizationMatches, type DispatchAuthorization } from './dispatch-repository.js'
import { runtimeConfigHash } from './agent-config-service.js'
import { TeamRepositoryError } from './repository.js'

export interface ExternalAuthorizationRequest {
  authorization: DispatchAuthorization
  request_id: string
  native_session_id: string
  phase: 'prepare' | 'execute' | 'observe' | 'account'
}

// A current observation, never a reusable lease. The daemon checks again after
// remote I/O; artifact publication retains its own current authorization gate.
export class TeamExternalAuthorizationService {
  constructor(
    private readonly pool: Pick<pg.Pool, 'query'>,
    private readonly enabledForTeam: (teamId: string) => boolean = () => false,
    private readonly stepsEnabledForTeam: (teamId: string) => boolean = () => false,
  ) {}

  async authorize(actor: number, daemonId: string, callId: string, input: ExternalAuthorizationRequest) {
    const deny = (): never => { throw new TeamRepositoryError('team_access_denied', 'External execution is not authorized') }
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['authorization', 'request_id', 'native_session_id', 'phase'].includes(key))
      || !['prepare', 'execute', 'observe', 'account'].includes(input.phase)
      || typeof input.request_id !== 'string' || !input.request_id || input.request_id.length > 256
      || typeof input.native_session_id !== 'string' || input.native_session_id.length > 256
      || !input.authorization || typeof input.authorization !== 'object' || Array.isArray(input.authorization)) {
      throw new TeamRepositoryError('invalid_request', 'Invalid external authorization request')
    }
    const auth = input.authorization
    // One SQL statement observes Call, membership, account and ownership from
    // the same snapshot. No remote activity or capability change occurs here.
    const row = (await this.pool.query(`SELECT c.*, s.team_id,
        s.state AS session_state,t.state AS team_state,o.provider,o.daemon_id,o.owner_user_id,
        o.state AS offer_state,o.revision AS current_offer_revision,
        b.state AS binding_state,b.revision AS current_binding_revision,
        b.owner_user_id AS binding_owner,b.native_session_id AS binding_native,
        b.team_session_id AS binding_session,b.offer_id AS binding_offer,
        b.config_revision AS current_config_revision,b.requested_config AS current_config,
        d.user_id AS daemon_owner,d.status AS daemon_status,d.collaboration_capabilities,
        owner.team_enabled AS owner_enabled,initiator.team_enabled AS initiator_enabled,
        om.state AS owner_membership,om.role AS owner_role,im.state AS initiator_membership,im.role AS initiator_role,
        frozen.task_id AS delivery_task_id,frozen.spec_revision AS delivery_spec_revision,
        attempt.attempt_id AS delivery_attempt_id,attempt.state AS attempt_state
      FROM collaboration_calls c
      JOIN collaboration_sessions s ON s.team_session_id=c.team_session_id
      JOIN collaboration_teams t ON t.team_id=s.team_id
      JOIN team_agent_offers o ON o.offer_id=c.offer_id AND o.team_id=s.team_id
      JOIN collaboration_session_agent_bindings b ON b.binding_id=c.binding_id
      JOIN daemons d ON d.daemon_id=o.daemon_id
      JOIN collaboration_events e ON e.event_id=c.event_id
      LEFT JOIN collaboration_runs run ON run.run_id=c.run_id
      JOIN users owner ON owner.id=o.owner_user_id
      JOIN users initiator ON initiator.id=COALESCE(run.initiator_user_id,e.author_user_id)
      LEFT JOIN collaboration_team_memberships om ON om.team_id=s.team_id AND om.user_id=owner.id
      LEFT JOIN collaboration_team_memberships im ON im.team_id=s.team_id AND im.user_id=initiator.id
      LEFT JOIN team_call_delivery_specs frozen ON frozen.call_id=c.call_id
      LEFT JOIN team_task_step_attempts attempt ON attempt.call_id=c.call_id
      WHERE c.call_id=$1`, [callId])).rows[0]
    if (!row || !this.enabledForTeam(row.team_id) || row.provider !== 'agentteams'
      || !dispatchAuthorizationMatches(row, auth, daemonId, actor)
      || auth.call_id !== callId || auth.team_session_id !== row.team_session_id || auth.operation !== row.operation
      || input.request_id !== row.provider_request_id
      || Number(row.daemon_owner) !== actor || Number(row.binding_owner) !== actor
      || row.binding_session !== row.team_session_id || row.binding_offer !== row.offer_id
      || Number(row.current_binding_revision) !== auth.binding_revision || Number(row.current_offer_revision) !== auth.offer_revision
      || row.session_state !== 'active' || row.team_state !== 'active' || row.offer_state !== 'active' || row.binding_state !== 'active'
      || row.owner_enabled !== true || row.initiator_enabled !== true
      || row.owner_membership !== 'active' || row.initiator_membership !== 'active' || row.owner_role === 'viewer' || row.initiator_role === 'viewer'
      || row.daemon_status !== 'online'
      || !['team_collaboration_dispatch_v1', 'team_collaboration_context_v1', 'team_external_agentteams_v1'].every(cap => Array.isArray(row.collaboration_capabilities) && row.collaboration_capabilities.includes(cap))
      || (row.delivery_attempt_id && (!this.stepsEnabledForTeam(row.team_id) || (input.phase !== 'account' && !['completed', 'failed'].includes(row.state) && !['reserved', 'dispatched', 'running', 'unknown'].includes(row.attempt_state))))) deny()
    if (input.phase !== 'account' && ['completed', 'failed'].includes(row.state)) throw new TeamRepositoryError('external_call_settled', 'Original Call has settled')
    if (!(input.phase === 'account' ? ['accepted', 'uncertain', 'completed', 'failed'] : ['dispatched', 'accepted', 'uncertain']).includes(row.state)) deny()
    if (row.delivery_task_id) {
      if (auth.delivery?.task_id !== row.delivery_task_id || auth.delivery?.spec_revision !== Number(row.delivery_spec_revision)
        || (auth.delivery?.attempt_id ?? '') !== (row.delivery_attempt_id ?? '')
        || !row.collaboration_capabilities.includes('team_task_delivery_v1')
        || (row.delivery_attempt_id && (!row.collaboration_capabilities.includes('team_task_steps_v1') || !row.collaboration_capabilities.includes('team_external_agentteams_steps_v1')))) deny()
    } else if (auth.delivery) deny()
    if (row.config_hash) {
      if (!auth.requested_config || runtimeConfigHash(auth.requested_config) !== row.config_hash
        || Number(row.current_config_revision) !== Number(row.config_revision)
        || !row.current_config || runtimeConfigHash(row.current_config) !== row.config_hash) deny()
    } else if (auth.requested_config || auth.config_hash || auth.config_revision || auth.capability_revision) deny()
    if ((auth.execution_mode ?? '') !== (row.execution_mode ?? '')) deny()
    if (input.phase !== 'prepare') {
      if ((row.native_session_id && row.native_session_id !== input.native_session_id)
        || (row.binding_native && row.binding_native !== input.native_session_id)) deny()
      if (!input.native_session_id || row.native_session_id !== input.native_session_id || row.binding_native !== input.native_session_id
        || !row.accepted_at || (input.phase === 'execute' && row.state !== 'accepted')) {
        throw new TeamRepositoryError('external_call_not_ready', 'Original dispatch acceptance is not ready')
      }
    } else if (row.state !== 'dispatched' || (input.native_session_id && input.native_session_id !== row.native_session_id)) deny()
    return { authorized: true as const, call_id: callId, request_id: input.request_id, native_session_id: input.native_session_id, phase: input.phase, provider: 'agentteams' as const }
  }
}
