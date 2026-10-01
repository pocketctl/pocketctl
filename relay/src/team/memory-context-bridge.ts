import type pg from 'pg'

import type { V2GrantMintResult } from '../extensions/v2-grant-service.js'
import { TeamRepositoryError } from './repository.js'
import type { TeamContextReference } from './types.js'

export interface TeamMemoryContextSelection {
  schema_version: 1
  installation_id: string
  owner_scope_id: string
  references: TeamContextReference[]
}

export interface TeamMemoryContextGrantService {
  mint(input: {
    userId: number
    installationIds: string[]
    callerType: 'web' | 'daemon'
    services?: string[]
  }): Promise<V2GrantMintResult>
}

interface SessionScopeRow {
  team_id: string
  participant_user_ids: Array<string | number>
  installation_id: string | null
  owner_scope_id: string | null
  owner_scope_kind: string | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function memoryReferences(references: TeamContextReference[]): TeamContextReference[] {
  return references.filter(reference => reference.source_kind !== 'team_event')
}

function exactReference(reference: TeamContextReference): boolean {
  return ['memory_claim', 'memory_evidence', 'wiki_section'].includes(reference.source_kind)
    && UUID_RE.test(reference.source_id)
    && UUID_RE.test(reference.source_version)
    && typeof reference.owner_scope_id === 'string'
    && reference.owner_scope_id.length > 0
    && typeof reference.installation_id === 'string'
    && UUID_RE.test(reference.installation_id)
}

export class TeamMemoryContextBridge {
  constructor(
    private readonly pool: pg.Pool,
    private readonly grants: TeamMemoryContextGrantService,
    private readonly options: {
      enabled: boolean
      fetchImpl?: typeof fetch
    },
  ) {}

  async validateSnapshot(input: {
    sessionId: string
    actorUserId: number
    references: TeamContextReference[]
  }): Promise<TeamMemoryContextSelection | null> {
    return this.validate(input.sessionId, input.actorUserId, input.references)
  }

  async prepareDispatch(input: {
    callId: string
    receiverUserId: number
  }): Promise<TeamMemoryContextSelection | null> {
    const result = await this.pool.query<{
      team_session_id: string
      created_by_user_id: string | number
      context_references: TeamContextReference[]
    }>(`
      SELECT call.team_session_id, context.created_by_user_id, context.context_references
      FROM collaboration_calls call
      JOIN collaboration_context_versions context
        ON context.team_session_id = call.team_session_id AND context.version = call.context_version
      WHERE call.call_id = $1
    `, [input.callId])
    const row = result.rows[0]
    if (!row) return null
    return this.validate(
      row.team_session_id,
      Number(row.created_by_user_id),
      Array.isArray(row.context_references) ? row.context_references : [],
      input.receiverUserId,
    )
  }

  async validateParticipantAddition(input: {
    sessionId: string
    actorUserId: number
    participantUserId: number
  }): Promise<void> {
    const result = await this.pool.query<{ context_references: TeamContextReference[] }>(`
      SELECT context.context_references
      FROM collaboration_sessions session
      JOIN collaboration_context_versions context
        ON context.team_session_id = session.team_session_id
       AND context.version = session.current_context_version
      WHERE session.team_session_id = $1
    `, [input.sessionId])
    const references = result.rows[0]?.context_references
    if (!Array.isArray(references) || memoryReferences(references).length === 0) return
    await this.validate(input.sessionId, input.actorUserId, references, input.participantUserId)
  }

  private async validate(
    sessionId: string,
    actorUserId: number,
    references: TeamContextReference[],
    receiverUserId?: number,
  ): Promise<TeamMemoryContextSelection | null> {
    const selected = memoryReferences(references)
    if (selected.length === 0) return null
    if (!this.options.enabled) {
      throw new TeamRepositoryError('team_feature_disabled', 'Team Memory bridge is disabled')
    }
    if (selected.some(reference => !exactReference(reference))) {
      throw new TeamRepositoryError('invalid_state', 'Memory Context references must identify an exact published version')
    }

    const scope = await this.sessionScope(sessionId)
    if (!scope.installation_id || !scope.owner_scope_id || scope.owner_scope_kind === 'personal') {
      throw new TeamRepositoryError('memory_grant_required', 'The Team session has no shared Memory scope')
    }
    if (selected.some(reference => reference.installation_id !== scope.installation_id
      || reference.owner_scope_id !== scope.owner_scope_id)) {
      throw new TeamRepositoryError('memory_grant_required', 'Private or foreign Memory knowledge cannot enter shared Context')
    }

    const users = new Set(scope.participant_user_ids.map(Number))
    users.add(actorUserId)
    if (receiverUserId !== undefined) users.add(receiverUserId)
    let verificationGrant: Extract<V2GrantMintResult, { ok: true }> | null = null
    for (const userId of users) {
      const grant = await this.grants.mint({
        userId,
        installationIds: [scope.installation_id],
        callerType: userId === actorUserId ? 'web' : 'daemon',
        services: ['memory.context'],
      })
      const binding = grant.ok ? grant.bindings.find(item => item.installation_id === scope.installation_id) : null
      if (!grant.ok || !binding?.permissions.includes('read')
        || binding.owner_scope_id !== scope.owner_scope_id) {
        throw new TeamRepositoryError('memory_grant_required', 'Every active participant and execution receiver must retain read access')
      }
      if (userId === actorUserId) verificationGrant = grant
    }
    if (!verificationGrant) {
      throw new TeamRepositoryError('memory_grant_required', 'Memory reference verification grant unavailable')
    }
    await this.verifyPublishedSources(verificationGrant, scope.installation_id, selected)
    return {
      schema_version: 1,
      installation_id: scope.installation_id,
      owner_scope_id: scope.owner_scope_id,
      references: selected,
    }
  }

  private async sessionScope(sessionId: string): Promise<SessionScopeRow> {
    const result = await this.pool.query<SessionScopeRow>(`
      SELECT session.team_id,
             ARRAY(SELECT participant.user_id
                   FROM collaboration_session_participants participant
                   JOIN collaboration_team_memberships membership
                     ON membership.team_id = session.team_id
                    AND membership.user_id = participant.user_id
                    AND membership.state = 'active'
                   WHERE participant.team_session_id = session.team_session_id
                     AND participant.state = 'active') AS participant_user_ids,
             binding.installation_id::text, binding.owner_scope_id, binding.owner_scope_kind
      FROM collaboration_sessions session
      LEFT JOIN team_memory_bindings binding
        ON binding.team_id = session.team_id AND binding.state = 'active'
      WHERE session.team_session_id = $1 AND session.state IN ('active', 'paused')
    `, [sessionId])
    const row = result.rows[0]
    if (!row) throw new TeamRepositoryError('team_not_found', 'shared session not found')
    return row
  }

  private async verifyPublishedSources(
    grant: Extract<V2GrantMintResult, { ok: true }>,
    installationId: string,
    references: TeamContextReference[],
  ): Promise<void> {
    const origin = grant.providerPublicOrigin
    if (!origin) throw new TeamRepositoryError('memory_grant_required', 'Memory provider origin unavailable')
    const fetchImpl = this.options.fetchImpl ?? fetch
    let response: Response
    try {
      response = await fetchImpl(`${origin}/api/v1/memory/context/references/validate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installation_id: installationId, references }),
        signal: AbortSignal.timeout(2_000),
      })
    } catch {
      throw new TeamRepositoryError('invalid_state', 'Memory references could not be verified')
    }
    if (!response.ok) {
      throw new TeamRepositoryError('invalid_state', response.status === 404
        ? 'Memory reference source is missing or no longer published'
        : 'Memory references are not readable in the shared scope')
    }
  }
}
