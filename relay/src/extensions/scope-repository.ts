import { randomUUID } from 'crypto'
import type pg from 'pg'

import {
  appendLifecycleEvent,
  appendMembershipEvent,
} from './scope-journal.js'
import {
  type MembershipState,
  type ScopePermission,
  type ScopeRole,
  type SharedScopeKind,
  type SharedScopeState,
  isMembershipState,
  isSharedScopeState,
  canTransitionSharedScope,
  normalizeScopeRoles,
  permissionsForRoles,
} from './scope-types.js'

/**
 * ADR-0005 Relay owner-scope repository. Relay is the identity authority for
 * Organization/Team existence, membership state, roles, authorization epochs,
 * and revisions (ADR-P3-03). Every membership mutation runs in one
 * transaction and advances both the membership revision and the owning
 * scope's authorization epoch so already-minted v2 grants fail immediately
 * (ADR-P3-09).
 */

export interface ExtensionOrganization {
  organization_id: string
  name: string
  state: SharedScopeState
  authorization_epoch: number
  revision: number
  created_by_user_id: number | null
  created_at: Date
  updated_at: Date
}

export interface ExtensionTeam {
  team_id: string
  organization_id: string
  name: string
  state: SharedScopeState
  authorization_epoch: number
  revision: number
  created_by_user_id: number | null
  created_at: Date
  updated_at: Date
}

export interface ExtensionScopeMembership {
  membership_id: string
  scope_kind: SharedScopeKind
  scope_id: string
  user_id: number | null
  roles: ScopeRole[]
  state: MembershipState
  membership_revision: number
  created_at: Date
  updated_at: Date
  revoked_at: Date | null
}

export type ExtensionSharedScope = ExtensionOrganization | ExtensionTeam

export class ScopeNotFoundError extends Error {
  constructor() {
    super('shared scope not found')
    this.name = 'ScopeNotFoundError'
  }
}

export class MembershipNotFoundError extends Error {
  constructor() {
    super('scope membership not found')
    this.name = 'MembershipNotFoundError'
  }
}

export class MembershipConflictError extends Error {
  constructor() {
    super('membership already exists for this user and scope')
    this.name = 'MembershipConflictError'
  }
}

export class MembershipRevisionConflictError extends Error {
  readonly currentRevision?: number
  readonly currentState?: MembershipState

  constructor(current?: { revision: number; state: MembershipState }) {
    super('membership revision mismatch')
    this.name = 'MembershipRevisionConflictError'
    this.currentRevision = current?.revision
    this.currentState = current?.state
  }
}

export class ScopePermissionError extends Error {
  constructor() {
    super('actor lacks the required scope permission')
    this.name = 'ScopePermissionError'
  }
}

export class MembershipStateError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'MembershipStateError'
  }
}

interface OrganizationRow {
  organization_id: string
  name: string
  state: SharedScopeState
  authorization_epoch: string | number
  revision: string | number
  created_by_user_id: number | null
  created_at: Date
  updated_at: Date
}

interface TeamRow {
  team_id: string
  organization_id: string
  name: string
  state: SharedScopeState
  authorization_epoch: string | number
  revision: string | number
  created_by_user_id: number | null
  created_at: Date
  updated_at: Date
}

interface MembershipRow {
  membership_id: string
  scope_kind: SharedScopeKind
  scope_id: string
  user_id: number | null
  roles: ScopeRole[]
  state: MembershipState
  membership_revision: string | number
  created_at: Date
  updated_at: Date
  revoked_at: Date | null
}

function toOrganization(row: OrganizationRow): ExtensionOrganization {
  return {
    organization_id: row.organization_id,
    name: row.name,
    state: row.state,
    authorization_epoch: Number(row.authorization_epoch),
    revision: Number(row.revision),
    created_by_user_id: row.created_by_user_id === null ? null : Number(row.created_by_user_id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function toTeam(row: TeamRow): ExtensionTeam {
  return {
    team_id: row.team_id,
    organization_id: row.organization_id,
    name: row.name,
    state: row.state,
    authorization_epoch: Number(row.authorization_epoch),
    revision: Number(row.revision),
    created_by_user_id: row.created_by_user_id === null ? null : Number(row.created_by_user_id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function toMembership(row: MembershipRow): ExtensionScopeMembership {
  return {
    membership_id: row.membership_id,
    scope_kind: row.scope_kind,
    scope_id: row.scope_id,
    user_id: row.user_id === null ? null : Number(row.user_id),
    roles: normalizeScopeRoles(row.roles) ?? [],
    state: row.state,
    membership_revision: Number(row.membership_revision),
    created_at: row.created_at,
    updated_at: row.updated_at,
    revoked_at: row.revoked_at,
  }
}

type ScopeClient = Pick<pg.PoolClient, 'query'>
type ScopeDb = Pick<pg.Pool, 'query' | 'connect'> | ScopeClient

/**
 * One-transaction helper: runs `body` between BEGIN/COMMIT on the given
 * connection. Exported so route services can compose repository primitives
 * (which assume the caller owns the transaction via their `*InTx` cores)
 * inside one atomic unit without nesting BEGIN statements.
 */
export async function runInScopeTransaction<T>(
  db: ScopeDb,
  body: (client: ScopeClient) => Promise<T>,
): Promise<T> {
  const ownsClient = 'connect' in db
  const client = ownsClient ? await db.connect() : db
  await client.query('BEGIN')
  try {
    const result = await body(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    if (ownsClient) (client as pg.PoolClient).release()
  }
}

const SCOPE_TABLE: Record<SharedScopeKind, string> = {
  organization: 'extension_organizations',
  team: 'extension_teams',
}

/** Advance the owning scope's authorization epoch and revision by one. */
async function bumpScopeFence(
  db: ScopeDb,
  scopeKind: SharedScopeKind,
  scopeId: string,
): Promise<number> {
  const table = SCOPE_TABLE[scopeKind]
  const column = scopeKind === 'organization' ? 'organization_id' : 'team_id'
  const result = await db.query<{ authorization_epoch: string | number }>(
    `UPDATE ${table}
     SET authorization_epoch = authorization_epoch + 1, revision = revision + 1, updated_at = NOW()
     WHERE ${column} = $1
     RETURNING authorization_epoch`,
    [scopeId],
  )
  if ((result.rowCount ?? 0) === 0) throw new ScopeNotFoundError()
  return Number(result.rows[0].authorization_epoch)
}

export async function createOrganization(
  db: ScopeDb,
  input: { organizationId?: string; name: string; createdByUserId: number },
): Promise<ExtensionOrganization> {
  const organizationId = input.organizationId ?? randomUUID()
  const result = await db.query<OrganizationRow>(
    `INSERT INTO extension_organizations (organization_id, name, created_by_user_id)
     VALUES ($1, $2, $3)
     RETURNING organization_id, name, state, authorization_epoch, revision, created_by_user_id, created_at, updated_at`,
    [organizationId, input.name, input.createdByUserId],
  )
  return toOrganization(result.rows[0])
}

export async function createTeam(
  db: ScopeDb,
  input: { teamId?: string; organizationId: string; name: string; createdByUserId: number },
): Promise<ExtensionTeam> {
  const teamId = input.teamId ?? randomUUID()
  const result = await db.query<TeamRow>(
    `INSERT INTO extension_teams (team_id, organization_id, name, created_by_user_id)
     VALUES ($1, $2, $3, $4)
     RETURNING team_id, organization_id, name, state, authorization_epoch, revision, created_by_user_id, created_at, updated_at`,
    [teamId, input.organizationId, input.name, input.createdByUserId],
  )
  return toTeam(result.rows[0])
}

/**
 * Route-level atomic creation: an Organization and its creator's
 * scope_administrator membership appear in one transaction with both control
 * events, so a crash can never leave an unadministerable scope behind.
 * No epoch bump: no grant could exist before the scope itself existed.
 */
export async function createOrganizationWithCreator(
  db: ScopeDb,
  input: { organizationId?: string; name: string; createdByUserId: number },
): Promise<{ organization: ExtensionOrganization; creatorMembership: ExtensionScopeMembership }> {
  return runInScopeTransaction(db, async client => {
    const organization = await createOrganization(client, input)
    await appendLifecycleEvent(client, {
      scopeKind: 'organization',
      scopeId: organization.organization_id,
      data: {
        event_type: 'scope_created',
        authorization_epoch: organization.authorization_epoch,
        revision: organization.revision,
        state: organization.state,
      },
    })
    const creatorMembership = await insertMembershipDirect(client, {
      scopeKind: 'organization',
      scopeId: organization.organization_id,
      userId: input.createdByUserId,
      roles: ['scope_administrator'],
    })
    await appendMembershipEvent(client, {
      scopeKind: 'organization',
      scopeId: organization.organization_id,
      data: {
        membership_id: creatorMembership.membership_id,
        event_type: 'membership_created',
        membership_revision: creatorMembership.membership_revision,
        state: creatorMembership.state,
        roles: creatorMembership.roles,
        authorization_epoch: organization.authorization_epoch,
      },
    })
    return { organization, creatorMembership }
  })
}

/** Same atomic creation for a Team: creator becomes the team scope_administrator. */
export async function createTeamWithCreator(
  db: ScopeDb,
  input: { teamId?: string; organizationId: string; name: string; createdByUserId: number },
): Promise<{ team: ExtensionTeam; creatorMembership: ExtensionScopeMembership }> {
  return runInScopeTransaction(db, async client => {
    const team = await createTeam(client, input)
    await appendLifecycleEvent(client, {
      scopeKind: 'team',
      scopeId: team.team_id,
      data: {
        event_type: 'scope_created',
        authorization_epoch: team.authorization_epoch,
        revision: team.revision,
        state: team.state,
      },
    })
    const creatorMembership = await insertMembershipDirect(client, {
      scopeKind: 'team',
      scopeId: team.team_id,
      userId: input.createdByUserId,
      roles: ['scope_administrator'],
    })
    await appendMembershipEvent(client, {
      scopeKind: 'team',
      scopeId: team.team_id,
      data: {
        membership_id: creatorMembership.membership_id,
        event_type: 'membership_created',
        membership_revision: creatorMembership.membership_revision,
        state: creatorMembership.state,
        roles: creatorMembership.roles,
        authorization_epoch: team.authorization_epoch,
      },
    })
    return { team, creatorMembership }
  })
}

/** Insert a membership row without fencing; callers journal and own the tx. */
async function insertMembershipDirect(
  db: ScopeDb,
  input: {
    scopeKind: SharedScopeKind
    scopeId: string
    userId: number
    roles: readonly string[]
  },
): Promise<ExtensionScopeMembership> {
  const roles = normalizeScopeRoles(input.roles)
  if (roles === null) throw new MembershipStateError('roles must be a non-empty allowlist role array')
  let inserted: pg.QueryResult<MembershipRow>
  try {
    inserted = await db.query<MembershipRow>(
      `INSERT INTO extension_scope_memberships (membership_id, scope_kind, scope_id, user_id, roles)
       VALUES ($1, $2, $3, $4, $5::text[])
       RETURNING membership_id, scope_kind, scope_id, user_id, roles, state, membership_revision, created_at, updated_at, revoked_at`,
      [randomUUID(), input.scopeKind, input.scopeId, input.userId, roles],
    )
  } catch (error) {
    if (
      typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: string }).code === '23505'
    ) {
      throw new MembershipConflictError()
    }
    throw error
  }
  return toMembership(inserted.rows[0])
}

export async function getSharedScope(
  db: ScopeDb,
  scopeKind: SharedScopeKind,
  scopeId: string,
): Promise<ExtensionSharedScope | null> {
  if (scopeKind === 'organization') {
    const result = await db.query<OrganizationRow>(
      `SELECT organization_id, name, state, authorization_epoch, revision, created_by_user_id, created_at, updated_at
       FROM extension_organizations WHERE organization_id = $1`,
      [scopeId],
    )
    return result.rows[0] ? toOrganization(result.rows[0]) : null
  }
  const result = await db.query<TeamRow>(
    `SELECT team_id, organization_id, name, state, authorization_epoch, revision, created_by_user_id, created_at, updated_at
     FROM extension_teams WHERE team_id = $1`,
    [scopeId],
  )
  return result.rows[0] ? toTeam(result.rows[0]) : null
}

export async function addScopeMembershipInTx(
  db: ScopeDb,
  input: {
    scopeKind: SharedScopeKind
    scopeId: string
    userId: number
    roles: readonly string[]
  },
): Promise<ExtensionScopeMembership> {
  const roles = normalizeScopeRoles(input.roles)
  if (roles === null) throw new MembershipStateError('roles must be a non-empty allowlist role array')

  // The fence bump doubles as scope existence validation.
  const epoch = await bumpScopeFence(db, input.scopeKind, input.scopeId)
  let inserted: pg.QueryResult<MembershipRow>
  try {
    inserted = await db.query<MembershipRow>(
      `INSERT INTO extension_scope_memberships (membership_id, scope_kind, scope_id, user_id, roles)
       VALUES ($1, $2, $3, $4, $5::text[])
       RETURNING membership_id, scope_kind, scope_id, user_id, roles, state, membership_revision, created_at, updated_at, revoked_at`,
      [randomUUID(), input.scopeKind, input.scopeId, input.userId, roles],
    )
  } catch (error) {
    if (
      typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: string }).code === '23505'
    ) {
      throw new MembershipConflictError()
    }
    throw error
  }
  const membership = toMembership(inserted.rows[0])
  await appendMembershipEvent(db as Pick<pg.PoolClient, 'query'>, {
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    data: {
      membership_id: membership.membership_id,
      event_type: 'membership_created',
      membership_revision: membership.membership_revision,
      state: membership.state,
      roles: membership.roles,
      authorization_epoch: epoch,
    },
  })
  return membership
}

export async function addScopeMembership(
  db: ScopeDb,
  input: {
    scopeKind: SharedScopeKind
    scopeId: string
    userId: number
    roles: readonly string[]
  },
): Promise<ExtensionScopeMembership> {
  return runInScopeTransaction(db, client => addScopeMembershipInTx(client, input))
}

export async function updateScopeMembershipInTx(
  db: ScopeDb,
  input: {
    membershipId: string
    expectedRevision: number
    roles?: readonly string[]
    state?: string
  },
): Promise<ExtensionScopeMembership> {
  const roles = input.roles === undefined ? undefined : normalizeScopeRoles(input.roles)
  if (input.roles !== undefined && roles === null) {
    throw new MembershipStateError('roles must be a non-empty allowlist role array')
  }
  if (input.state !== undefined && !isMembershipState(input.state)) {
    throw new MembershipStateError('unknown membership state')
  }

  const current = await db.query<MembershipRow>(
    `SELECT membership_id, scope_kind, scope_id, user_id, roles, state, membership_revision, created_at, updated_at, revoked_at
     FROM extension_scope_memberships WHERE membership_id = $1 FOR UPDATE`,
    [input.membershipId],
  )
  const row = current.rows[0]
  if (!row) throw new MembershipNotFoundError()
  if (Number(row.membership_revision) !== input.expectedRevision) {
    throw new MembershipRevisionConflictError({
      revision: Number(row.membership_revision),
      state: row.state,
    })
  }
  if (row.state === 'revoked') {
    throw new MembershipStateError('revoked membership is terminal')
  }
  if (input.state !== undefined && row.state !== input.state && row.state !== 'active'
    && input.state !== 'active' && input.state !== 'revoked') {
    throw new MembershipStateError(`illegal membership transition ${row.state} -> ${input.state}`)
  }

  const nextState = input.state ?? row.state
  const nextRoles = roles ?? normalizeScopeRoles(row.roles) ?? []
  const revokedAt = nextState === 'revoked' ? 'NOW()' : 'NULL'
  const updated = await db.query<MembershipRow>(
    `UPDATE extension_scope_memberships
     SET roles = $2::text[], state = $3, membership_revision = membership_revision + 1,
         revoked_at = ${revokedAt}, updated_at = NOW()
     WHERE membership_id = $1 AND membership_revision = $4
     RETURNING membership_id, scope_kind, scope_id, user_id, roles, state, membership_revision, created_at, updated_at, revoked_at`,
    [input.membershipId, nextRoles, nextState, input.expectedRevision],
  )
  if ((updated.rowCount ?? 0) === 0) {
    throw new MembershipRevisionConflictError({
      revision: Number(row.membership_revision),
      state: row.state,
    })
  }
  const epoch = await bumpScopeFence(db, row.scope_kind, row.scope_id)
  const membership = toMembership(updated.rows[0])
  await appendMembershipEvent(db as Pick<pg.PoolClient, 'query'>, {
    scopeKind: membership.scope_kind,
    scopeId: membership.scope_id,
    data: {
      membership_id: membership.membership_id,
      event_type: input.state === undefined ? 'membership_roles_changed' : 'membership_state_changed',
      membership_revision: membership.membership_revision,
      state: membership.state,
      roles: membership.roles,
      authorization_epoch: epoch,
    },
  })
  return membership
}

export async function updateScopeMembership(
  db: ScopeDb,
  input: {
    membershipId: string
    expectedRevision: number
    roles?: readonly string[]
    state?: string
  },
): Promise<ExtensionScopeMembership> {
  return runInScopeTransaction(db, client => updateScopeMembershipInTx(client, input))
}

export async function listScopeMembers(
  db: ScopeDb,
  scopeKind: SharedScopeKind,
  scopeId: string,
  limit = 50,
): Promise<ExtensionScopeMembership[]> {
  const result = await db.query<MembershipRow>(
    `SELECT membership_id, scope_kind, scope_id, user_id, roles, state, membership_revision, created_at, updated_at, revoked_at
     FROM extension_scope_memberships
     WHERE scope_kind = $1 AND scope_id = $2
     ORDER BY created_at ASC, membership_id ASC
     LIMIT $3`,
    [scopeKind, scopeId, Math.min(Math.max(limit, 1), 200)],
  )
  return result.rows.map(toMembership)
}

export async function listUserScopeMemberships(
  db: ScopeDb,
  userId: number,
): Promise<ExtensionScopeMembership[]> {
  const result = await db.query<MembershipRow>(
    `SELECT membership_id, scope_kind, scope_id, user_id, roles, state, membership_revision, created_at, updated_at, revoked_at
     FROM extension_scope_memberships
     WHERE user_id = $1 AND state IN ('active', 'suspended')
     ORDER BY created_at ASC, membership_id ASC`,
    [userId],
  )
  return result.rows.map(toMembership)
}

/**
 * Suspend or dissolve a shared scope with CAS on `expectedRevision`. Both
 * transitions advance the authorization epoch so every outstanding v2 grant
 * for the scope is rejected at the next mirror comparison.
 */
export async function updateSharedScopeStateInTx(
  db: ScopeDb,
  input: {
    scopeKind: SharedScopeKind
    scopeId: string
    expectedRevision: number
    state: string
  },
): Promise<ExtensionSharedScope> {
  if (!isSharedScopeState(input.state)) throw new MembershipStateError('unknown scope state')
  const table = SCOPE_TABLE[input.scopeKind]
  const column = input.scopeKind === 'organization' ? 'organization_id' : 'team_id'
  const current = await db.query<{ state: SharedScopeState; revision: string | number }>(
    `SELECT state, revision FROM ${table} WHERE ${column} = $1 FOR UPDATE`,
    [input.scopeId],
  )
  const row = current.rows[0]
  if (!row) throw new ScopeNotFoundError()
  if (Number(row.revision) !== input.expectedRevision) throw new ScopeNotFoundError()
  if (!canTransitionSharedScope(row.state, input.state as SharedScopeState)) {
    throw new MembershipStateError(`illegal scope transition ${row.state} -> ${input.state}`)
  }
  const updated = await db.query(
    `UPDATE ${table}
     SET state = $2, authorization_epoch = authorization_epoch + 1, revision = revision + 1, updated_at = NOW()
     WHERE ${column} = $1 AND revision = $3
     RETURNING ${column}`,
    [input.scopeId, input.state, input.expectedRevision],
  )
  if ((updated.rowCount ?? 0) === 0) throw new ScopeNotFoundError()
  const scope = await getSharedScope(db, input.scopeKind, input.scopeId)
  if (!scope) throw new ScopeNotFoundError()
  await appendLifecycleEvent(db as Pick<pg.PoolClient, 'query'>, {
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    data: {
      event_type: input.state === 'suspended' ? 'scope_suspended'
        : input.state === 'dissolving' ? 'scope_dissolving'
          : input.state === 'dissolved' ? 'scope_dissolved' : 'scope_created',
      authorization_epoch: scope.authorization_epoch,
      revision: scope.revision,
      state: scope.state,
    },
  })
  return scope
}

export async function updateSharedScopeState(
  db: ScopeDb,
  input: {
    scopeKind: SharedScopeKind
    scopeId: string
    expectedRevision: number
    state: string
  },
): Promise<ExtensionSharedScope> {
  return runInScopeTransaction(db, client => updateSharedScopeStateInTx(client, input))
}

/**
 * Authorization gate for v2 scope administration: resolve the actor's active
 * membership on the scope and confirm the requested permission is carried by
 * one of its roles (ADR-P3-04/05). Missing scopes, foreign scopes, and
 * missing permissions stay distinguishable to the caller only as 404/403.
 */
export async function requireScopePermission(
  db: ScopeDb,
  input: {
    scopeKind: SharedScopeKind
    scopeId: string
    userId: number
    permission: ScopePermission
  },
): Promise<ExtensionScopeMembership> {
  const scope = await getSharedScope(db, input.scopeKind, input.scopeId)
  if (!scope) throw new ScopeNotFoundError()
  const result = await db.query<MembershipRow>(
    `SELECT membership_id, scope_kind, scope_id, user_id, roles, state, membership_revision, created_at, updated_at, revoked_at
     FROM extension_scope_memberships
     WHERE scope_kind = $1 AND scope_id = $2 AND user_id = $3 AND state = 'active'`,
    [input.scopeKind, input.scopeId, input.userId],
  )
  const membership = result.rows[0]
  if (!membership) throw new ScopeNotFoundError()
  const permissions = permissionsForRoles(normalizeScopeRoles(membership.roles) ?? [])
  if (!permissions.includes(input.permission)) throw new ScopePermissionError()
  return toMembership(membership)
}
