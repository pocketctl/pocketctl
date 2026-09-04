import { createHash } from 'crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type pg from 'pg'
import type { ExtensionMode } from './types.js'
import { ExtensionApiError } from './errors.js'
import { verifyProviderExtensionToken } from './provider-auth.js'
import { getInstallationWithCheckpointForUpdate } from './feed-repository.js'

export interface ProviderInstallationRouteDeps {
  pool: pg.Pool
  mode: ExtensionMode
  providerJwtSecret: string
  issuer: string
  cursorSecret: string
  maxPageSize?: number
  defaultPageSize?: number
  rateLimiter?: { check(key: string): { allowed: boolean; retryAfterMs?: number } }
}

const DEFAULT_MAX_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 50
const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CURSOR_TTL_SECONDS = 900

interface ProviderIdentity {
  providerId: string
  credentialId: string
  tokenJti: string
}

function authenticateProvider(
  req: FastifyRequest,
  deps: ProviderInstallationRouteDeps,
): ProviderIdentity | null {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  return verifyProviderExtensionToken(header.slice(7), {
    secret: deps.providerJwtSecret,
    issuer: deps.issuer,
  })
}

function fail(reply: { code: (status: number) => unknown }, error: ExtensionApiError) {
  reply.code(error.httpStatus)
  return { error: { code: error.code, message: error.message } }
}

function rateLimited(
  reply: { code: (status: number) => unknown; header: (name: string, value: string) => unknown },
  retryAfterMs?: number,
) {
  reply.code(429)
  if (retryAfterMs !== undefined) reply.header('retry-after', String(Math.ceil(retryAfterMs / 1000)))
  return { error: { code: 'invalid_request', message: 'rate limit exceeded' } }
}

// --- Signed, provider-bound pagination cursor ---------------------------------

interface ProviderInstallationCursorV1 {
  v: 1
  provider_id: string
  after_installation_id: string
  exp: number
}

function cursorHmac(secret: string, payload: string): string {
  return createHash('sha256').update(`${secret}:provider-installations:${payload}`).digest('base64url')
}

export function encodeProviderInstallationCursor(
  cursor: ProviderInstallationCursorV1,
  secret: string,
): string {
  const payload = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
  return `${payload}.${cursorHmac(secret, payload)}`
}

export function decodeProviderInstallationCursor(
  token: string,
  secret: string,
  providerId: string,
  now: number = Date.now(),
): ProviderInstallationCursorV1 | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return null
  const separator = token.lastIndexOf('.')
  if (separator <= 0) return null
  const payload = token.slice(0, separator)
  const signature = token.slice(separator + 1)
  const expected = cursorHmac(secret, payload)
  if (signature.length !== expected.length) return null
  let diff = 0
  for (let index = 0; index < expected.length; index++) {
    diff |= signature.charCodeAt(index) ^ expected.charCodeAt(index)
  }
  if (diff !== 0) return null
  let cursor: ProviderInstallationCursorV1
  try {
    cursor = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (cursor.v !== 1
    || cursor.provider_id !== providerId
    || !INSTALLATION_ID_PATTERN.test(cursor.after_installation_id)
    || typeof cursor.exp !== 'number' || !Number.isFinite(cursor.exp)) {
    return null
  }
  if (cursor.exp * 1000 <= now) return null
  return cursor
}

// --- Routes -------------------------------------------------------------------

interface InventoryRow {
  installation_id: string
  status: string
  config_version: string | number
  granted_scopes: string[]
  subscriptions: string[]
  enabled_services: string[]
  event_filter: Record<string, unknown>
  created_at: Date
  updated_at: Date
  snapshot_required: boolean
}

/**
 * Provider installation discovery and snapshot-reconcile completion. Both
 * endpoints are provider-authenticated, body-free control-plane calls: the
 * inventory never exposes owner identity, and the ACK only ever clears the
 * provider's own checkpoint flag.
 */
export function registerProviderInstallationRoutes(
  app: FastifyInstance,
  deps: ProviderInstallationRouteDeps,
): void {
  const maxPageSize = deps.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE
  const defaultPageSize = deps.defaultPageSize ?? DEFAULT_PAGE_SIZE

  app.get('/api/extensions/v1/provider/installations', async (req, reply) => {
    if (deps.rateLimiter) {
      const decision = deps.rateLimiter.check(`installations:${String(req.ip ?? '-')}`)
      if (!decision.allowed) return rateLimited(reply, decision.retryAfterMs)
    }
    if (deps.mode !== 'enabled') {
      return fail(reply, new ExtensionApiError('feature_disabled', 'installation discovery requires RELAY_EXTENSIONS=enabled'))
    }
    const identity = authenticateProvider(req, deps)
    if (!identity) {
      return fail(reply, new ExtensionApiError('unauthorized', 'provider token required'))
    }
    const query = req.query as Record<string, unknown>
    const rawLimit = Number(query.limit ?? defaultPageSize)
    const limit = Number.isSafeInteger(rawLimit)
      ? Math.min(Math.max(1, rawLimit), maxPageSize)
      : defaultPageSize

    let afterInstallationId: string | null = null
    const rawCursor = typeof query.cursor === 'string' && query.cursor.length > 0 ? query.cursor : null
    if (rawCursor) {
      const cursor = decodeProviderInstallationCursor(rawCursor, deps.cursorSecret, identity.providerId)
      if (!cursor) {
        return fail(reply, new ExtensionApiError('cursor_expired', 'cursor no longer valid'))
      }
      afterInstallationId = cursor.after_installation_id
    }

    // Keyset pagination over the UUID primary key: unlike a timestamptz
    // position it round-trips losslessly, so a page can never re-serve the
    // row its cursor points at. Discovery only needs a complete enumeration,
    // not creation order.
    const result = await deps.pool.query<InventoryRow>(`
      SELECT i.installation_id, i.status, i.config_version, i.granted_scopes,
             i.subscriptions, i.enabled_services, i.event_filter,
             i.created_at, i.updated_at,
             (c.snapshot_required_at IS NOT NULL) AS snapshot_required
      FROM extension_installations i
      LEFT JOIN extension_checkpoints c ON c.installation_id = i.installation_id
      WHERE i.provider_id = $1
        AND ($2::uuid IS NULL OR i.installation_id > $2::uuid)
      ORDER BY i.installation_id
      LIMIT $3
    `, [identity.providerId, afterInstallationId, limit])

    const rows = result.rows
    const hasMore = rows.length === limit
    const last = rows[rows.length - 1]
    const nextCursor = hasMore && last
      ? encodeProviderInstallationCursor({
        v: 1,
        provider_id: identity.providerId,
        after_installation_id: last.installation_id,
        exp: Math.floor(Date.now() / 1000) + CURSOR_TTL_SECONDS,
      }, deps.cursorSecret)
      : null

    return {
      installations: rows.map(row => ({
        installation_id: row.installation_id,
        status: row.status,
        config_version: String(row.config_version),
        granted_scopes: row.granted_scopes ?? [],
        subscriptions: row.subscriptions ?? [],
        enabled_services: row.enabled_services ?? [],
        event_filter: row.event_filter ?? {},
        snapshot_required: row.snapshot_required === true,
        created_at: new Date(row.created_at).toISOString(),
        updated_at: new Date(row.updated_at).toISOString(),
      })),
      next_cursor: nextCursor,
      has_more: hasMore,
    }
  })


  // --- v2 provider inventory (ADR-P3-02) ---------------------------------------
  // Same keyset pagination and provider binding as v1, plus owner-scope
  // metadata. Still zero user PII: owner identity remains absent from the
  // provider surface.

  app.get('/api/extensions/v2/provider/installations', async (req, reply) => {
    if (deps.rateLimiter) {
      const decision = deps.rateLimiter.check(`installations:${String(req.ip ?? '-')}`)
      if (!decision.allowed) return rateLimited(reply, decision.retryAfterMs)
    }
    if (deps.mode !== 'enabled') {
      return fail(reply, new ExtensionApiError('feature_disabled', 'installation discovery requires RELAY_EXTENSIONS=enabled'))
    }
    const identity = authenticateProvider(req, deps)
    if (!identity) {
      return fail(reply, new ExtensionApiError('unauthorized', 'provider token required'))
    }
    const query = req.query as Record<string, unknown>
    const rawLimit = Number(query.limit ?? defaultPageSize)
    const limit = Number.isSafeInteger(rawLimit)
      ? Math.min(Math.max(1, rawLimit), maxPageSize)
      : defaultPageSize
    const scopeKindFilter = typeof query.owner_scope_kind === 'string'
      && ['personal', 'team', 'organization'].includes(query.owner_scope_kind)
      ? query.owner_scope_kind
      : null

    let afterInstallationId: string | null = null
    const rawCursor = typeof query.cursor === 'string' && query.cursor.length > 0 ? query.cursor : null
    if (rawCursor) {
      const cursor = decodeProviderInstallationCursor(rawCursor, deps.cursorSecret, identity.providerId)
      if (!cursor) {
        return fail(reply, new ExtensionApiError('cursor_expired', 'cursor no longer valid'))
      }
      afterInstallationId = cursor.after_installation_id
    }

    const result = await deps.pool.query<InventoryRow & {
      owner_scope_kind: string
      owner_scope_id: string
      parent_organization_id: string | null
      authorization_epoch: string | number
    }>(`
      SELECT i.installation_id, i.status, i.config_version, i.granted_scopes,
             i.subscriptions, i.enabled_services, i.event_filter,
             i.created_at, i.updated_at,
             i.owner_scope_kind, i.owner_scope_id,
             CASE WHEN i.owner_scope_kind = 'team' THEN t.organization_id ELSE NULL END
               AS parent_organization_id,
             CASE i.owner_scope_kind
               WHEN 'team' THEN t.authorization_epoch
               WHEN 'organization' THEN o.authorization_epoch
               ELSE i.authorization_epoch
             END AS authorization_epoch,
             (c.snapshot_required_at IS NOT NULL) AS snapshot_required
      FROM extension_installations i
      LEFT JOIN extension_checkpoints c ON c.installation_id = i.installation_id
      LEFT JOIN extension_teams t
        ON i.owner_scope_kind = 'team' AND t.team_id = i.owner_scope_id
      LEFT JOIN extension_organizations o
        ON i.owner_scope_kind = 'organization' AND o.organization_id = i.owner_scope_id
      WHERE i.provider_id = $1
        AND ($2::uuid IS NULL OR i.installation_id > $2::uuid)
        AND ($3::text IS NULL OR i.owner_scope_kind = $3::text)
      ORDER BY i.installation_id
      LIMIT $4
    `, [identity.providerId, afterInstallationId, scopeKindFilter, limit])

    const rows = result.rows
    const hasMore = rows.length === limit
    const last = rows[rows.length - 1]
    const nextCursor = hasMore && last
      ? encodeProviderInstallationCursor({
        v: 1,
        provider_id: identity.providerId,
        after_installation_id: last.installation_id,
        exp: Math.floor(Date.now() / 1000) + CURSOR_TTL_SECONDS,
      }, deps.cursorSecret)
      : null

    return {
      installations: rows.map(row => ({
        installation_id: row.installation_id,
        status: row.status,
        config_version: String(row.config_version),
        owner_scope_kind: row.owner_scope_kind,
        owner_scope_id: row.owner_scope_id,
        parent_organization_id: row.parent_organization_id,
        authorization_epoch: String(row.authorization_epoch),
        granted_scopes: row.granted_scopes ?? [],
        subscriptions: row.subscriptions ?? [],
        enabled_services: row.enabled_services ?? [],
        event_filter: row.event_filter ?? {},
        snapshot_required: row.snapshot_required === true,
        created_at: new Date(row.created_at).toISOString(),
        updated_at: new Date(row.updated_at).toISOString(),
      })),
      next_cursor: nextCursor,
      has_more: hasMore,
    }
  })

  app.post('/api/extensions/v1/provider/installations/:installationId/reconciled', async (req, reply) => {    if (deps.rateLimiter) {
      const decision = deps.rateLimiter.check(`installations:${String(req.ip ?? '-')}`)
      if (!decision.allowed) return rateLimited(reply, decision.retryAfterMs)
    }
    if (deps.mode !== 'enabled') {
      return fail(reply, new ExtensionApiError('feature_disabled', 'installation discovery requires RELAY_EXTENSIONS=enabled'))
    }
    const identity = authenticateProvider(req, deps)
    if (!identity) {
      return fail(reply, new ExtensionApiError('unauthorized', 'provider token required'))
    }
    const params = req.params as { installationId?: string }
    const installationId = params.installationId ?? ''
    if (!INSTALLATION_ID_PATTERN.test(installationId)) {
      return fail(reply, new ExtensionApiError('invalid_request', 'installation id required'))
    }

    const client = await deps.pool.connect()
    try {
      await client.query('BEGIN')
      try {
        const installation = await getInstallationWithCheckpointForUpdate(
          client, installationId, identity.providerId,
        )
        if (!installation) {
          throw new ExtensionApiError('not_found', 'installation not found')
        }
        if (installation.status === 'revoking' || installation.status === 'revoked') {
          throw new ExtensionApiError('installation_revoked', 'installation is revoked')
        }
        // Idempotent completion: clearing an already-clear flag is a success.
        await client.query(
          `UPDATE extension_checkpoints
           SET snapshot_required_at = NULL, updated_at = NOW()
           WHERE installation_id = $1`,
          [installationId],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        if (error instanceof ExtensionApiError) return fail(reply, error)
        throw error
      }
      return { installation_id: installationId, reconciled: true }
    } finally {
      client.release()
    }
  })
}
