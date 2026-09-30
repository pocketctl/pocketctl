import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'

import type {
  ExtensionInstallationRepository,
  ScopedExtensionInstallation,
} from '../extensions/installation-repository.js'
import type { ScopeBindingV2 } from '../extensions/capability-grant.js'
import type { V2GrantMintResult, V2GrantService } from '../extensions/v2-grant-service.js'
import { TeamRepositoryError } from './repository.js'
import type { TeamMemoryAccessState, TeamMemoryBinding } from './types.js'
import type { TeamMemorySourceProjectorLike } from './memory-source-projector.js'

type Queryable = Pick<pg.PoolClient, 'query'>

interface BindingRow {
  binding_id: string
  team_id: string
  owner_scope_kind: 'personal' | 'team' | 'organization'
  owner_scope_id: string
  installation_id: string
  revision: string | number
  created_by_user_id: string | number
  created_at: Date | string
  updated_at: Date | string
}

export interface TeamMemoryBindingServiceOptions {
  memoryBridgeEnabled: boolean
  memorySources?: TeamMemorySourceProjectorLike
}

export interface TeamMemoryBindingGrantService {
  mint(input: {
    userId: number
    installationIds: string[]
    callerType: 'web'
  }, database?: Queryable): Promise<V2GrantMintResult>
}

export interface TeamMemoryInstallationReader {
  getScopedInstallation(installationId: string, database?: Queryable): Promise<ScopedExtensionInstallation | null>
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function hash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function grantAccess(result: V2GrantMintResult, installationId: string): {
  state: TeamMemoryAccessState
  binding: ScopeBindingV2 | null
} {
  if (!result.ok) {
    if (result.code === 'feature_disabled') return { state: 'feature_disabled', binding: null }
    if (result.code === 'installation_paused') return { state: 'installation_paused', binding: null }
    return { state: 'forbidden', binding: null }
  }
  const binding = result.bindings.find(candidate => candidate.installation_id === installationId) ?? null
  if (!binding || !binding.permissions.includes('read')) return { state: 'forbidden', binding }
  return { state: 'available', binding }
}

export class TeamMemoryBindingService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly installations: TeamMemoryInstallationReader,
    private readonly grants: TeamMemoryBindingGrantService,
    private readonly options: TeamMemoryBindingServiceOptions,
  ) {}

  async getBinding(teamId: string, actorUserId: number): Promise<TeamMemoryBinding | null> {
    await this.requireTeam(this.pool, teamId, actorUserId)
    const result = await this.pool.query<BindingRow>(
      `SELECT binding_id, team_id, owner_scope_kind, owner_scope_id, installation_id,
              revision, created_by_user_id, created_at, updated_at
       FROM team_memory_bindings
       WHERE team_id = $1 AND state = 'active'`,
      [teamId],
    )
    const row = result.rows[0]
    if (!row) return null
    return this.view(row, await this.currentAccess(actorUserId, row.installation_id))
  }

  async bind(input: {
    teamId: string
    actorUserId: number
    installationId: string
    expectedRevision: number
    requestId: string
  }): Promise<TeamMemoryBinding> {
    if (!this.options.memoryBridgeEnabled) {
      throw new TeamRepositoryError('team_feature_disabled', 'Team Memory bridge is disabled')
    }
    await this.requireTeam(this.pool, input.teamId, input.actorUserId, true)
    const initial = await this.bindingAuthority(input.actorUserId, input.installationId)
    let authority = initial

    return this.idempotent(input.actorUserId, `team.memory.bind:${input.teamId}`, input.requestId, {
      installation_id: input.installationId,
      expected_revision: input.expectedRevision,
    }, async client => {
      const current = await this.activeBinding(client, input.teamId, true)
      const currentRevision = current ? Number(current.revision) : 0
      if (currentRevision !== input.expectedRevision) {
        throw new TeamRepositoryError('revision_conflict', 'Memory binding revision mismatch', currentRevision)
      }
      if (current?.installation_id === input.installationId) {
        return this.view(current, {
          state: 'available',
          binding: authority.authorized.binding,
        })
      }
      if (current) {
        await this.options.memorySources?.revokeTeamBinding?.(client, {
          teamId: input.teamId,
          bindingId: current.binding_id,
          bindingRevision: Number(current.revision),
        })
        await client.query(
          `UPDATE team_memory_bindings
           SET state = 'removed', revision = revision + 1, removed_at = NOW(), updated_at = NOW()
           WHERE binding_id = $1`,
          [current.binding_id],
        )
      }
      const inserted = await client.query<BindingRow>(
        `INSERT INTO team_memory_bindings
           (binding_id, team_id, owner_scope_kind, owner_scope_id, installation_id,
            revision, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING binding_id, team_id, owner_scope_kind, owner_scope_id, installation_id,
                   revision, created_by_user_id, created_at, updated_at`,
        [
          `cmbd_${randomUUID()}`,
          input.teamId,
          authority.installation.owner_scope_kind,
          authority.installation.owner_scope_id,
          authority.installation.installation_id,
          currentRevision + 1,
          input.actorUserId,
        ],
      )
      return this.view(inserted.rows[0], {
        state: 'available',
        binding: authority.authorized.binding,
      })
    }, async client => {
      await this.requireTeam(client, input.teamId, input.actorUserId, true, true)
      await this.lockBindingAuthority(client, input.actorUserId, initial.installation)
      authority = await this.bindingAuthority(input.actorUserId, input.installationId, client)
    })
  }

  async remove(input: {
    teamId: string
    actorUserId: number
    expectedRevision: number
    requestId: string
  }): Promise<null> {
    return this.idempotent(input.actorUserId, `team.memory.remove:${input.teamId}`, input.requestId, {
      expected_revision: input.expectedRevision,
    }, async client => {
      const current = await this.activeBinding(client, input.teamId, true)
      if (!current) throw new TeamRepositoryError('invalid_state', 'Team has no active Memory binding')
      const currentRevision = Number(current.revision)
      if (currentRevision !== input.expectedRevision) {
        throw new TeamRepositoryError('revision_conflict', 'Memory binding revision mismatch', currentRevision)
      }
      await this.options.memorySources?.revokeTeamBinding?.(client, {
        teamId: input.teamId,
        bindingId: current.binding_id,
        bindingRevision: currentRevision,
      })
      await client.query(
        `UPDATE team_memory_bindings
         SET state = 'removed', revision = revision + 1, removed_at = NOW(), updated_at = NOW()
         WHERE binding_id = $1`,
        [current.binding_id],
      )
      return null
    }, client => this.requireTeam(client, input.teamId, input.actorUserId, true, true))
  }

  private async bindingAuthority(actorUserId: number, installationId: string, database?: Queryable) {
    const installation = await this.installations.getScopedInstallation(installationId, database)
    if (!installation || installation.provider_id !== 'pocketctl-memory') {
      throw new TeamRepositoryError('memory_grant_required', 'Memory installation administration permission required')
    }
    const access = await this.grants.mint({
      userId: actorUserId,
      installationIds: [installationId],
      callerType: 'web',
    }, database)
    const authorized = grantAccess(access, installationId)
    if (authorized.state === 'installation_paused') {
      throw new TeamRepositoryError('invalid_state', 'Memory installation is not active')
    }
    if (authorized.state !== 'available'
      || !authorized.binding?.permissions.includes('scope_admin')
      || authorized.binding.owner_scope_kind !== installation.owner_scope_kind
      || authorized.binding.owner_scope_id !== installation.owner_scope_id) {
      throw new TeamRepositoryError('memory_grant_required', 'Memory installation administration permission required')
    }

    return { installation, authorized }
  }

  private async lockBindingAuthority(client: Queryable, actorUserId: number, installation: ScopedExtensionInstallation): Promise<void> {
    const denied = () => new TeamRepositoryError('memory_grant_required', 'Memory installation administration permission required')
    if (installation.owner_scope_kind !== 'personal') {
      // Membership mutations lock the member before bumping the scope epoch.
      // Match that order and hold all authorization rows until the receipt commits.
      const member = await client.query(
        `SELECT 1 FROM extension_scope_memberships
         WHERE scope_kind=$1 AND scope_id=$2 AND user_id=$3 AND state='active' FOR SHARE`,
        [installation.owner_scope_kind, installation.owner_scope_id, actorUserId],
      )
      if (!member.rows[0]) throw denied()
      const table = installation.owner_scope_kind === 'team' ? 'extension_teams' : 'extension_organizations'
      const column = installation.owner_scope_kind === 'team' ? 'team_id' : 'organization_id'
      const scope = await client.query(
        `SELECT 1 FROM ${table} WHERE ${column}=$1 AND state='active' FOR SHARE`,
        [installation.owner_scope_id],
      )
      if (!scope.rows[0]) throw denied()
    }
    const result = await client.query<{
      status: string; provider_id: string; owner_user_id: string | number | null;
      owner_scope_kind: string; owner_scope_id: string;
    }>(
      `SELECT status,provider_id,owner_user_id,owner_scope_kind,owner_scope_id
       FROM extension_installations WHERE installation_id=$1 FOR SHARE`, [installation.installation_id],
    )
    const row = result.rows[0]
    if (!row || row.provider_id !== 'pocketctl-memory'
      || row.owner_scope_kind !== installation.owner_scope_kind || row.owner_scope_id !== installation.owner_scope_id
      || (row.owner_scope_kind === 'personal' && Number(row.owner_user_id) !== actorUserId)) throw denied()
    if (row.status === 'paused' || row.status === 'pending') {
      throw new TeamRepositoryError('invalid_state', 'Memory installation is not active')
    }
    if (row.status !== 'active') throw denied()
  }

  private async currentAccess(actorUserId: number, installationId: string): Promise<{
    state: TeamMemoryAccessState
    binding: ScopeBindingV2 | null
  }> {
    if (!this.options.memoryBridgeEnabled) return { state: 'feature_disabled', binding: null }
    return grantAccess(await this.grants.mint({
      userId: actorUserId,
      installationIds: [installationId],
      callerType: 'web',
    }), installationId)
  }

  private view(row: BindingRow, access: { state: TeamMemoryAccessState; binding: ScopeBindingV2 | null }): TeamMemoryBinding {
    const permissions = access.binding?.permissions ?? []
    return {
      id: row.binding_id,
      team_id: row.team_id,
      owner_scope_kind: row.owner_scope_kind,
      owner_scope_id: row.owner_scope_id,
      installation_id: row.installation_id,
      revision: Number(row.revision),
      created_by_user_id: Number(row.created_by_user_id),
      access_state: access.state,
      permissions: [...permissions],
      manageable: access.state === 'available' && permissions.includes('scope_admin'),
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    }
  }

  private async activeBinding(client: Queryable, teamId: string, lock = false): Promise<BindingRow | null> {
    const result = await client.query<BindingRow>(
      `SELECT binding_id, team_id, owner_scope_kind, owner_scope_id, installation_id,
              revision, created_by_user_id, created_at, updated_at
       FROM team_memory_bindings
       WHERE team_id = $1 AND state = 'active'${lock ? ' FOR UPDATE' : ''}`,
      [teamId],
    )
    return result.rows[0] ?? null
  }

  private async requireTeam(
    client: Queryable,
    teamId: string,
    actorUserId: number,
    creator = false,
    lock = false,
  ): Promise<void> {
    const result = await client.query<{ creator_user_id: string | number; state: string }>(
      `SELECT team.creator_user_id, team.state
       FROM collaboration_teams team
       JOIN collaboration_team_memberships membership
         ON membership.team_id = team.team_id
        AND membership.user_id = $2
        AND membership.state = 'active'
       WHERE team.team_id = $1${lock ? ' FOR UPDATE OF team FOR SHARE OF membership' : ''}`,
      [teamId, actorUserId],
    )
    const team = result.rows[0]
    if (!team) throw new TeamRepositoryError('team_not_found', 'team not found')
    if (team.state !== 'active') throw new TeamRepositoryError('invalid_state', 'team is not active')
    if (creator && Number(team.creator_user_id) !== actorUserId) {
      throw new TeamRepositoryError('creator_required', 'team creator authority required')
    }
  }

  private async idempotent<T>(
    actorUserId: number,
    operation: string,
    requestId: string,
    payload: unknown,
    mutate: (client: pg.PoolClient) => Promise<T>,
    authorize: (client: pg.PoolClient) => Promise<void>,
  ): Promise<T> {
    const requestHash = hash(payload)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `team:${actorUserId}:${operation}:${requestId}`,
      ])
      await authorize(client)
      const prior = await client.query<{ request_hash: string; response: T }>(
        `SELECT request_hash, response FROM collaboration_team_idempotency
         WHERE user_id = $1 AND operation = $2 AND request_id = $3`,
        [actorUserId, operation, requestId],
      )
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash) {
          throw new TeamRepositoryError('idempotency_conflict', 'request_id was reused with different content')
        }
        await client.query('COMMIT')
        return prior.rows[0].response
      }
      const response = await mutate(client)
      await client.query(
        `INSERT INTO collaboration_team_idempotency
           (user_id, operation, request_id, request_hash, response)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [actorUserId, operation, requestId, requestHash, JSON.stringify(response)],
      )
      await client.query('COMMIT')
      return response
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}

export function createTeamMemoryBindingService(
  pool: pg.Pool,
  installations: ExtensionInstallationRepository,
  grants: Pick<V2GrantService, 'mint'>,
  options: TeamMemoryBindingServiceOptions,
): TeamMemoryBindingService {
  return new TeamMemoryBindingService(pool, installations, grants, options)
}
