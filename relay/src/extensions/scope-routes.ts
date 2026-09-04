import { createHash } from 'crypto'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

import { ExtensionApiError, extensionErrorStatus, isExtensionApiError } from './errors.js'
import type { ExtensionMode } from './types.js'
import {
  type ExtensionOrganization,
  type ExtensionScopeMembership,
  type ExtensionSharedScope,
  type ExtensionTeam,
  MembershipConflictError,
  MembershipNotFoundError,
  MembershipRevisionConflictError,
  MembershipStateError,
  ScopeNotFoundError,
  ScopePermissionError,
  addScopeMembershipInTx,
  createOrganizationWithCreator,
  createTeamWithCreator,
  getSharedScope,
  listScopeMembers,
  listUserScopeMemberships,
  requireScopePermission,
  runInScopeTransaction,
  updateScopeMembershipInTx,
  updateSharedScopeStateInTx,
} from './scope-repository.js'
import {
  type OwnerScopeKind,
  type ScopeRole,
  type SharedScopeKind,
  isSharedScopeKind,
  isSharedScopeState,
  normalizeScopeRoles,
  permissionsForRoles,
} from './scope-types.js'

/**
 * ADR-0005 v2 scope administration surface (§5.3). Relay is the identity
 * authority: these routes create fixture-capable Organizations/Teams, manage
 * memberships against the code-owned role allowlist, and drive scope
 * lifecycle with CAS. Every mutation requires an Idempotency-Key; foreign and
 * missing resources answer with the same 404; no invitation email, billing,
 * SCIM, or pending-account provisioning exists here.
 */

export interface ScopeMemberView {
  membership_id: string
  roles: ScopeRole[]
  state: string
  membership_revision: number
  display_label: string
  created_at: Date
  updated_at: Date
  revoked_at: Date | null
}

export interface ScopeListEntry {
  owner_scope_kind: OwnerScopeKind
  owner_scope_id: string
  parent_organization_id: string | null
  name: string
  state: string
  authorization_epoch: number
  revision: number
  membership_id: string | null
  membership_revision: number | null
  roles: ScopeRole[]
  permissions: string[]
}

export interface IdempotencyLookup {
  kind: 'fresh' | 'replay' | 'mismatch'
  response?: unknown
}

export interface ExtensionScopeRouteService {
  listScopesForUser(userId: number): Promise<ScopeListEntry[]>
  createOrganization(input: { name: string; actorUserId: number }): Promise<{
    organization: ExtensionOrganization
    creatorMembership: ExtensionScopeMembership
  }>
  createTeam(input: { organizationId: string; name: string; actorUserId: number }): Promise<{
    team: ExtensionTeam
    creatorMembership: ExtensionScopeMembership
  }>
  listMembers(input: { scopeKind: SharedScopeKind; scopeId: string; actorUserId: number }): Promise<ScopeMemberView[]>
  addMember(input: {
    scopeKind: SharedScopeKind
    scopeId: string
    actorUserId: number
    email: string
    roles: readonly string[]
  }): Promise<ScopeMemberView>
  updateMember(input: {
    scopeKind: SharedScopeKind
    scopeId: string
    membershipId: string
    actorUserId: number
    expectedRevision: number
    roles?: readonly string[]
    state?: string
  }): Promise<ScopeMemberView>
  updateLifecycle(input: {
    scopeKind: SharedScopeKind
    scopeId: string
    actorUserId: number
    expectedRevision: number
    state: string
  }): Promise<ScopeListEntry>
  beginIdempotency(input: {
    userId: number
    operation: string
    key: string
    requestHash: string
  }): Promise<IdempotencyLookup>
  commitIdempotency(input: {
    userId: number
    operation: string
    key: string
    requestHash: string
    response: unknown
  }): Promise<void>
  withIdempotencyLock?<T>(lockKey: string, run: () => Promise<T>): Promise<T>
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@.]{1,63}(\.[^\s@.]{1,63})+$/
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60

function fail(
  reply: { code: (status: number) => unknown },
  code: Parameters<typeof extensionErrorStatus>[0],
  message: string,
  statusOverride?: number,
  details?: Record<string, unknown>,
) {
  reply.code(statusOverride ?? extensionErrorStatus(code))
  return { error: { code, message, ...(details ?? {}) } }
}

type Authentication =
  | { ok: true; userId: number }
  | { ok: false; body: unknown }

async function authenticate(
  req: { headers: { authorization?: string } },
  reply: { code: (status: number) => unknown },
  deps: ExtensionScopeRouteDeps,
): Promise<Authentication> {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return { ok: false, body: fail(reply, 'unauthorized', 'authorization required') }
  }
  const payload = await deps.verifyAccessToken(header.slice(7))
  if (!payload) {
    return { ok: false, body: fail(reply, 'unauthorized', 'invalid token') }
  }
  return { ok: true, userId: payload.userId }
}

function mapScopeError(error: unknown, reply: { code: (status: number) => unknown }): unknown {
  if (error instanceof ScopeNotFoundError) {
    // Foreign and missing scopes/memberships are indistinguishable 404s.
    return fail(reply, 'not_found', 'scope not found')
  }
  if (error instanceof ScopePermissionError) {
    return fail(reply, 'forbidden', 'scope_admin permission required')
  }
  if (error instanceof MembershipNotFoundError) {
    return fail(reply, 'not_found', 'membership not found')
  }
  if (error instanceof MembershipRevisionConflictError) {
    const details: Record<string, unknown> = {}
    if (error.currentRevision !== undefined) details.current_revision = error.currentRevision
    if (error.currentState !== undefined) details.current_state = error.currentState
    return fail(reply, 'revision_conflict', 'revision mismatch', undefined, details)
  }
  if (error instanceof MembershipConflictError) {
    return fail(reply, 'invalid_request', 'membership already exists for this user and scope', 409)
  }
  if (error instanceof MembershipStateError) {
    return fail(reply, 'invalid_request', error.message)
  }
  if (isExtensionApiError(error)) {
    return fail(reply, error.code, error.message, undefined, error.details)
  }
  throw error
}

/** PII-bounded display label: display name when set, otherwise a masked email. */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@')
  if (!local || !domain) return 'member'
  const domainHead = domain.split('.')[0] ?? ''
  return `${local.slice(0, 1)}***@${domainHead.slice(0, 1)}***`
}

async function displayLabelsFor(
  db: Pick<pg.Pool, 'query'>,
  memberships: ExtensionScopeMembership[],
): Promise<Map<number, string>> {
  const labels = new Map<number, string>()
  const userIds = [...new Set(memberships.map(m => m.user_id).filter((id): id is number => id !== null))]
  if (userIds.length === 0) return labels
  const result = await db.query<{ id: number; display_name: string | null; email: string }>(
    `SELECT id, display_name, email FROM users WHERE id = ANY($1::int[])`,
    [userIds],
  )
  for (const row of result.rows) {
    labels.set(Number(row.id), row.display_name?.trim() ? row.display_name.trim() : maskEmail(row.email))
  }
  return labels
}

function toMemberView(membership: ExtensionScopeMembership, label: string): ScopeMemberView {
  return {
    membership_id: membership.membership_id,
    roles: membership.roles,
    state: membership.state,
    membership_revision: membership.membership_revision,
    display_label: label,
    created_at: membership.created_at,
    updated_at: membership.updated_at,
    revoked_at: membership.revoked_at,
  }
}

function scopeListEntry(
  scope: ExtensionSharedScope,
  membership: ExtensionScopeMembership | null,
): ScopeListEntry {
  const roles = membership?.roles ?? []
  return {
    owner_scope_kind: 'team_id' in scope ? 'team' : 'organization',
    owner_scope_id: 'team_id' in scope ? scope.team_id : scope.organization_id,
    parent_organization_id: 'team_id' in scope ? scope.organization_id : null,
    name: scope.name,
    state: scope.state,
    authorization_epoch: scope.authorization_epoch,
    revision: scope.revision,
    membership_id: membership?.membership_id ?? null,
    membership_revision: membership?.membership_revision ?? null,
    roles,
    permissions: [...permissionsForRoles(roles)],
  }
}

export function createExtensionScopeRouteService(pool: pg.Pool): ExtensionScopeRouteService {
  const db = pool as unknown as Pick<pg.PoolClient, 'query'>

  async function resolveUserIdByEmail(email: string): Promise<number> {
    const result = await db.query<{ id: number }>(
      `SELECT id FROM users WHERE LOWER(email) = LOWER($1)`,
      [email],
    )
    const id = result.rows[0]?.id
    if (id === undefined) throw new ScopeNotFoundError()
    return Number(id)
  }

  return {
    async listScopesForUser(userId) {
      const entries: ScopeListEntry[] = []
      // Personal scopes: the caller's own installations.
      const personal = await db.query<{
        installation_id: string
        status: string
        authorization_epoch: string | number
        config_version: string | number
      }>(
        `SELECT installation_id, status, authorization_epoch, config_version
         FROM extension_installations
         WHERE owner_user_id = $1 AND status IN ('pending', 'active', 'paused')
         ORDER BY created_at ASC`,
        [userId],
      )
      for (const row of personal.rows) {
        entries.push({
          owner_scope_kind: 'personal',
          owner_scope_id: row.installation_id,
          parent_organization_id: null,
          name: 'personal',
          state: row.status,
          authorization_epoch: Number(row.authorization_epoch),
          revision: Number(row.config_version),
          membership_id: null,
          membership_revision: null,
          roles: [],
          permissions: [],
        })
      }
      // Shared scopes through active memberships.
      const memberships = await listUserScopeMemberships(pool, userId)
      for (const membership of memberships) {
        const scope = await getSharedScope(pool, membership.scope_kind, membership.scope_id)
        if (!scope) continue
        entries.push(scopeListEntry(scope, membership))
      }
      return entries
    },

    async createOrganization(input) {
      return createOrganizationWithCreator(pool, {
        name: input.name,
        createdByUserId: input.actorUserId,
      })
    },

    async createTeam(input) {
      // Only an Organization scope_administrator may create its Teams.
      await requireScopePermission(pool, {
        scopeKind: 'organization',
        scopeId: input.organizationId,
        userId: input.actorUserId,
        permission: 'scope_admin',
      })
      return createTeamWithCreator(pool, {
        organizationId: input.organizationId,
        name: input.name,
        createdByUserId: input.actorUserId,
      })
    },

    async listMembers(input) {
      await requireScopePermission(pool, {
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        userId: input.actorUserId,
        permission: 'scope_admin',
      })
      const memberships = await listScopeMembers(pool, input.scopeKind, input.scopeId)
      const labels = await displayLabelsFor(pool, memberships)
      return memberships.map(membership =>
        toMemberView(membership, membership.user_id !== null
          ? labels.get(membership.user_id) ?? 'member'
          : 'former member'))
    },

    async addMember(input) {
      await requireScopePermission(pool, {
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        userId: input.actorUserId,
        permission: 'scope_admin',
      })
      const userId = await resolveUserIdByEmail(input.email)
      const membership = await runInScopeTransaction(pool, client =>
        addScopeMembershipInTx(client, {
          scopeKind: input.scopeKind,
          scopeId: input.scopeId,
          userId,
          roles: input.roles,
        }))
      const labels = await displayLabelsFor(pool, [membership])
      return toMemberView(membership, labels.get(userId) ?? 'member')
    },

    async updateMember(input) {
      await requireScopePermission(pool, {
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        userId: input.actorUserId,
        permission: 'scope_admin',
      })
      // The membership must belong to the addressed scope.
      const membership = await db.query< { scope_kind: string; scope_id: string } >(
        `SELECT scope_kind, scope_id FROM extension_scope_memberships WHERE membership_id = $1`,
        [input.membershipId],
      )
      const row = membership.rows[0]
      if (!row || row.scope_kind !== input.scopeKind || row.scope_id !== input.scopeId) {
        throw new MembershipNotFoundError()
      }
      const updated = await runInScopeTransaction(pool, client =>
        updateScopeMembershipInTx(client, {
          membershipId: input.membershipId,
          expectedRevision: input.expectedRevision,
          roles: input.roles,
          state: input.state,
        }))
      const labels = await displayLabelsFor(pool, [updated])
      return toMemberView(
        updated,
        updated.user_id !== null ? labels.get(updated.user_id) ?? 'member' : 'former member',
      )
    },

    async updateLifecycle(input) {
      await requireScopePermission(pool, {
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        userId: input.actorUserId,
        permission: 'scope_admin',
      })
      const scope = await runInScopeTransaction(pool, client =>
        updateSharedScopeStateInTx(client, input))
      return scopeListEntry(scope, null)
    },

    async beginIdempotency(input) {
      return beginScopeIdempotency(pool, input)
    },

    async commitIdempotency(input) {
      await commitScopeIdempotency(pool, input)
    },

    async withIdempotencyLock(lockKey, run) {
      return withScopeIdempotencyLock(pool, lockKey, run)
    },
  }
}

/** Serialize one key across Relay processes while its mutation and receipt run. */
export async function withScopeIdempotencyLock<T>(
  pool: Pick<pg.Pool, 'connect'>,
  lockKey: string,
  run: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey])
    return await run()
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey])
      .catch(() => undefined)
    client.release()
  }
}

/** One commit boundary for the idempotency lookup, business write and receipt. */
export async function runInScopeIdempotencyTransaction<T>(
  pool: Pick<pg.Pool, 'connect'>,
  lockKey: string,
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey])
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

/** Standalone idempotency lookup shared by every v2 mutation route. */
export async function beginScopeIdempotency(
  pool: Pick<pg.Pool, 'query'>,
  input: {
    userId: number
    operation: string
    key: string
    requestHash: string
  },
): Promise<IdempotencyLookup> {
  const keyHash = createHash('sha256').update(input.key).digest('hex')
  const result = await pool.query<{ request_hash: string; response_metadata: unknown }>(
    `SELECT request_hash, response_metadata FROM extension_scope_idempotency
     WHERE user_id = $1 AND operation = $2 AND key_hash = $3 AND expires_at > NOW()`,
    [input.userId, input.operation, keyHash],
  )
  const row = result.rows[0]
  if (!row) return { kind: 'fresh' as const }
  if (row.request_hash !== input.requestHash) return { kind: 'mismatch' as const }
  return { kind: 'replay' as const, response: row.response_metadata }
}

export async function commitScopeIdempotency(
  pool: Pick<pg.Pool, 'query'>,
  input: {
    userId: number
    operation: string
    key: string
    requestHash: string
    response: unknown
  },
): Promise<void> {
  const keyHash = createHash('sha256').update(input.key).digest('hex')
  await pool.query(
    `INSERT INTO extension_scope_idempotency
       (user_id, operation, key_hash, request_hash, response_metadata, expires_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NOW() + ($6 || ' seconds')::interval)
     ON CONFLICT (user_id, operation, key_hash) DO NOTHING`,
    [
      input.userId,
      input.operation,
      keyHash,
      input.requestHash,
      JSON.stringify(input.response ?? {}),
      String(IDEMPOTENCY_TTL_SECONDS),
    ],
  )
}

export interface ExtensionScopeRouteDeps {
  pool: pg.Pool
  verifyAccessToken(token: string): Promise<{ userId: number } | null>
  v2Mode: ExtensionMode
  service?: ExtensionScopeRouteService
}

function requestHashFor(method: string, url: string, body: unknown): string {
  const canonical = body === null || body === undefined
    ? ''
    : JSON.stringify(body, Object.keys(body as Record<string, unknown>).sort())
  return createHash('sha256').update(`${method} ${url} ${canonical}`).digest('hex')
}

/** Wrap a mutation with the Idempotency-Key contract (§5.3). */
async function withIdempotency(
  deps: ExtensionScopeRouteDeps,
  req: { method: string; url?: string; headers: { [key: string]: unknown }; body: unknown },
  url: string,
  operation: string,
  reply: { code: (status: number) => unknown },
  run: (service: ExtensionScopeRouteService) => Promise<{ status: number; body: Record<string, unknown> }>,
): Promise<unknown> {
  const key = req.headers['idempotency-key']
  if (typeof key !== 'string' || key.length === 0 || key.length > 128) {
    return fail(reply, 'invalid_request', 'Idempotency-Key header of 1..128 characters is required')
  }
  const requestHash = requestHashFor(req.method, url, req.body)
  const userId = (req as { userId?: number }).userId!
  const execute = async (service: ExtensionScopeRouteService) => {
    const lookup = await service.beginIdempotency({
      userId,
      operation,
      key,
      requestHash,
    })
    if (lookup.kind === 'replay') {
      const response = lookup.response as { status?: number; body?: Record<string, unknown> }
      reply.code(response.status ?? 200)
      return response.body ?? {}
    }
    if (lookup.kind === 'mismatch') {
      return fail(reply, 'revision_conflict', 'Idempotency-Key was already used for a different request')
    }
    const result = await run(service)
    await service.commitIdempotency({
      userId,
      operation,
      key,
      requestHash,
      response: { status: result.status, body: result.body },
    })
    reply.code(result.status)
    return result.body
  }
  if (deps.service) {
    return deps.service.withIdempotencyLock
      ? deps.service.withIdempotencyLock(`${userId}:${operation}:${key}`, () => execute(deps.service!))
      : execute(deps.service)
  }

  // Production path: the mutation and its replay receipt share one commit.
  // The transaction-scoped advisory lock serializes the first lookup as well,
  // while the bound Pool turns repository-owned transactions into savepoints.
  return runInScopeIdempotencyTransaction(
    deps.pool,
    `${userId}:${operation}:${key}`,
    async client => {
    const transactionPool = createScopeTransactionBoundPool(client)
      return execute(createExtensionScopeRouteService(transactionPool))
    },
  )
}

function createScopeTransactionBoundPool(client: pg.PoolClient): pg.Pool {
  let sequence = 0
  return {
    query: client.query.bind(client),
    async connect() {
      const savepoint = `extension_scope_${++sequence}`
      let active = false
      return {
        query: (async (text: unknown, values?: unknown[]) => {
          if (typeof text === 'string') {
            const command = text.trim().toUpperCase()
            if (command === 'BEGIN') {
              await client.query(`SAVEPOINT ${savepoint}`)
              active = true
              return { rows: [], rowCount: null }
            }
            if (command === 'COMMIT') {
              if (active) await client.query(`RELEASE SAVEPOINT ${savepoint}`)
              active = false
              return { rows: [], rowCount: null }
            }
            if (command === 'ROLLBACK') {
              if (active) {
                await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
                await client.query(`RELEASE SAVEPOINT ${savepoint}`)
              }
              active = false
              return { rows: [], rowCount: null }
            }
          }
          return client.query(text as never, values as never)
        }) as pg.PoolClient['query'],
        release() {},
      } as pg.PoolClient
    },
  } as unknown as pg.Pool
}

export function registerExtensionScopeRoutes(
  app: FastifyInstance,
  deps: ExtensionScopeRouteDeps,
): void {
  const service = deps.service ?? createExtensionScopeRouteService(deps.pool)

  const parseSharedScopeParams = (
    params: unknown,
    reply: { code: (status: number) => unknown },
  ): { ok: true; scopeKind: SharedScopeKind; scopeId: string } | { ok: false; body: unknown } => {
    const { kind, id } = params as { kind?: string; id?: string }
    if (!isSharedScopeKind(kind) || !UUID_PATTERN.test(id ?? '')) {
      return {
        ok: false,
        body: fail(reply, 'invalid_request', 'scope kind must be team or organization and id must be a UUID'),
      }
    }
    return { ok: true, scopeKind: kind, scopeId: id! }
  }

  app.get('/api/extensions/v2/scopes', async (req, reply) => {
    const auth = await authenticate(req, reply, deps)
    if (!auth.ok) return auth.body
    if (deps.v2Mode === 'off') {
      return fail(reply, 'feature_disabled', 'scope reads require RELAY_EXTENSION_V2=shadow or enabled')
    }
    try {
      const scopes = await service.listScopesForUser(auth.userId)
      return { scopes }
    } catch (error) {
      return mapScopeError(error, reply)
    }
  })

  app.post('/api/extensions/v2/organizations', async (req, reply) => {
    const auth = await authenticate(req, reply, deps)
    if (!auth.ok) return auth.body
    if (deps.v2Mode !== 'enabled') {
      return fail(reply, 'feature_disabled', 'scope mutations require RELAY_EXTENSION_V2=enabled')
    }
    const body = req.body as Record<string, unknown> | null
    const name = body?.name
    if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 128) {
      return fail(reply, 'invalid_request', 'name must be 1..128 characters')
    }
    ;(req as unknown as { userId?: number }).userId = auth.userId
    return withIdempotency(deps, req, '/api/extensions/v2/organizations', 'scope.create_organization', reply, async mutationService => {
      const { organization, creatorMembership } = await mutationService.createOrganization({
        name: name.trim(),
        actorUserId: auth.userId,
      })
      return {
        status: 201,
        body: { organization, creator_membership: { membership_id: creatorMembership.membership_id, roles: creatorMembership.roles } },
      }
    }).catch(error => mapScopeError(error, reply))
  })

  app.post('/api/extensions/v2/organizations/:id/teams', async (req, reply) => {
    const auth = await authenticate(req, reply, deps)
    if (!auth.ok) return auth.body
    if (deps.v2Mode !== 'enabled') {
      return fail(reply, 'feature_disabled', 'scope mutations require RELAY_EXTENSION_V2=enabled')
    }
    const params = req.params as { id?: string }
    if (!UUID_PATTERN.test(params.id ?? '')) {
      return fail(reply, 'invalid_request', 'organization id must be a UUID')
    }
    const body = req.body as Record<string, unknown> | null
    const name = body?.name
    if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 128) {
      return fail(reply, 'invalid_request', 'name must be 1..128 characters')
    }
    ;(req as unknown as { userId?: number }).userId = auth.userId
    return withIdempotency(deps, req, `/api/extensions/v2/organizations/${params.id}/teams`, 'scope.create_team', reply, async mutationService => {
      const { team, creatorMembership } = await mutationService.createTeam({
        organizationId: params.id!,
        name: name.trim(),
        actorUserId: auth.userId,
      })
      return {
        status: 201,
        body: { team, creator_membership: { membership_id: creatorMembership.membership_id, roles: creatorMembership.roles } },
      }
    }).catch(error => mapScopeError(error, reply))
  })

  app.get('/api/extensions/v2/scopes/:kind/:id/members', async (req, reply) => {
    const auth = await authenticate(req, reply, deps)
    if (!auth.ok) return auth.body
    if (deps.v2Mode === 'off') {
      return fail(reply, 'feature_disabled', 'scope reads require RELAY_EXTENSION_V2=shadow or enabled')
    }
    const parsed = parseSharedScopeParams(req.params, reply)
    if (!parsed.ok) return parsed.body
    try {
      const members = await service.listMembers({ scopeKind: parsed.scopeKind, scopeId: parsed.scopeId, actorUserId: auth.userId })
      return { members }
    } catch (error) {
      return mapScopeError(error, reply)
    }
  })

  app.post('/api/extensions/v2/scopes/:kind/:id/members', async (req, reply) => {
    const auth = await authenticate(req, reply, deps)
    if (!auth.ok) return auth.body
    if (deps.v2Mode !== 'enabled') {
      return fail(reply, 'feature_disabled', 'scope mutations require RELAY_EXTENSION_V2=enabled')
    }
    const parsed = parseSharedScopeParams(req.params, reply)
    if (!parsed.ok) return parsed.body
    const body = req.body as Record<string, unknown> | null
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    if (!EMAIL_PATTERN.test(email) || email.length > 254) {
      return fail(reply, 'invalid_request', 'email must address an existing Relay user')
    }
    const roles = normalizeScopeRoles(body?.roles)
    if (roles === null) {
      return fail(reply, 'invalid_request', 'roles must be a non-empty array from the role allowlist')
    }
    ;(req as unknown as { userId?: number }).userId = auth.userId
    return withIdempotency(deps, req, `/api/extensions/v2/scopes/${parsed.scopeKind}/${parsed.scopeId}/members`, 'scope.add_member', reply, async mutationService => {
      const member = await mutationService.addMember({ scopeKind: parsed.scopeKind, scopeId: parsed.scopeId, actorUserId: auth.userId, email, roles })
      return { status: 201, body: { membership: member } }
    }).catch(error => mapScopeError(error, reply))
  })

  app.patch('/api/extensions/v2/scopes/:kind/:id/members/:membershipId', async (req, reply) => {
    const auth = await authenticate(req, reply, deps)
    if (!auth.ok) return auth.body
    if (deps.v2Mode !== 'enabled') {
      return fail(reply, 'feature_disabled', 'scope mutations require RELAY_EXTENSION_V2=enabled')
    }
    const parsed = parseSharedScopeParams(req.params, reply)
    if (!parsed.ok) return parsed.body
    const membershipId = (req.params as { membershipId?: string }).membershipId ?? ''
    if (!UUID_PATTERN.test(membershipId)) {
      return fail(reply, 'invalid_request', 'membership id must be a UUID')
    }
    const body = req.body as Record<string, unknown> | null
    const expected = body?.expected_revision
    if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 1) {
      return fail(reply, 'invalid_request', 'expected_revision must be a positive integer')
    }
    let roles: readonly string[] | undefined
    if (body?.roles !== undefined) {
      const parsedRoles = normalizeScopeRoles(body.roles)
      if (parsedRoles === null) {
        return fail(reply, 'invalid_request', 'roles must be a non-empty array from the role allowlist')
      }
      roles = parsedRoles
    }
    let state: string | undefined
    if (body?.state !== undefined) {
      if (typeof body.state !== 'string' || !['active', 'suspended', 'revoked'].includes(body.state)) {
        return fail(reply, 'invalid_request', 'state must be active, suspended, or revoked')
      }
      state = body.state
    }
    if (roles === undefined && state === undefined) {
      return fail(reply, 'invalid_request', 'roles or state change required')
    }
    ;(req as unknown as { userId?: number }).userId = auth.userId
    return withIdempotency(deps, req, `/api/extensions/v2/scopes/${parsed.scopeKind}/${parsed.scopeId}/members/${membershipId}`, 'scope.update_member', reply, async mutationService => {
      const member = await mutationService.updateMember({
        scopeKind: parsed.scopeKind,
        scopeId: parsed.scopeId,
        membershipId,
        actorUserId: auth.userId,
        expectedRevision: expected,
        roles,
        state,
      })
      return { status: 200, body: { membership: member } }
    }).catch(error => mapScopeError(error, reply))
  })

  app.post('/api/extensions/v2/scopes/:kind/:id/lifecycle', async (req, reply) => {
    const auth = await authenticate(req, reply, deps)
    if (!auth.ok) return auth.body
    if (deps.v2Mode !== 'enabled') {
      return fail(reply, 'feature_disabled', 'scope mutations require RELAY_EXTENSION_V2=enabled')
    }
    const parsed = parseSharedScopeParams(req.params, reply)
    if (!parsed.ok) return parsed.body
    const body = req.body as Record<string, unknown> | null
    const state = body?.state
    if (typeof state !== 'string' || !isSharedScopeState(state) || state === 'active') {
      return fail(reply, 'invalid_request', 'state must be suspended, dissolving, or dissolved')
    }
    const expected = body?.expected_revision
    if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 1) {
      return fail(reply, 'invalid_request', 'expected_revision must be a positive integer')
    }
    ;(req as unknown as { userId?: number }).userId = auth.userId
    return withIdempotency(deps, req, `/api/extensions/v2/scopes/${parsed.scopeKind}/${parsed.scopeId}/lifecycle`, 'scope.lifecycle', reply, async mutationService => {
      const scope = await mutationService.updateLifecycle({
        scopeKind: parsed.scopeKind,
        scopeId: parsed.scopeId,
        actorUserId: auth.userId,
        expectedRevision: expected,
        state,
      })
      return { status: 200, body: { scope } }
    }).catch(error => mapScopeError(error, reply))
  })
}

export { ExtensionApiError }
