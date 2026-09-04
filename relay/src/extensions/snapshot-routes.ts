import type { FastifyInstance, FastifyRequest } from 'fastify'
import type pg from 'pg'
import type { ExtensionMode } from './types.js'
import { ExtensionApiError } from './errors.js'
import { verifyProviderExtensionToken } from './provider-auth.js'
import {
  decodeSnapshotCursor,
  encodeSnapshotCursor,
  getSnapshotEventPage,
  listInventorySessions,
  snapshotSessionExists,
} from './snapshot-repository.js'
import { filterHashForInstallation } from './cursor.js'
import { getInstallationWithCheckpointForUpdate } from './feed-repository.js'

export interface SnapshotRouteDeps {
  pool: pg.Pool
  mode: ExtensionMode
  providerJwtSecret: string
  issuer: string
  cursorSecret: string
  maxPageEvents?: number
  maxPageBytes?: number
  rateLimiter?: { check(key: string): { allowed: boolean; retryAfterMs?: number } }
}

const DEFAULT_MAX_PAGE_EVENTS = 100
const DEFAULT_MAX_PAGE_BYTES = 1024 * 1024
const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SNAPSHOT_CURSOR_TTL_SECONDS = 900

function authenticateProvider(req: FastifyRequest, deps: SnapshotRouteDeps) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  return verifyProviderExtensionToken(header.slice(7), {
    secret: deps.providerJwtSecret,
    issuer: deps.issuer,
  })
}

function snapshotCursor(
  kind: 'inventory' | 'snapshot',
  installationId: string,
  position: string | number,
  binding: { configVersion: number | string; filterHash: string },
  secret: string,
): string {
  return encodeSnapshotCursor({
    v: 1,
    k: kind,
    installation_id: installationId,
    position: String(position),
    config_version: String(binding.configVersion),
    filter_hash: binding.filterHash,
    exp: Math.floor(Date.now() / 1000) + SNAPSHOT_CURSOR_TTL_SECONDS,
  }, secret)
}

function fail(reply: { code: (status: number) => unknown }, error: ExtensionApiError) {
  reply.code(error.httpStatus)
  // Server-controlled details nest inside the envelope.
  return { error: { code: error.code, message: error.message, ...(error.details ?? {}) } }
}

function rateLimited(reply: { code: (status: number) => unknown; header: (name: string, value: string) => unknown }, retryAfterMs?: number) {
  reply.code(429)
  if (retryAfterMs !== undefined) reply.header('retry-after', String(Math.ceil(retryAfterMs / 1000)))
  return { error: { code: 'invalid_request', message: 'rate limit exceeded' } }
}

/** Resolve + authorize an installation for a provider token (shared read path). */
async function installationScopeFor(
  deps: SnapshotRouteDeps,
  identity: { providerId: string },
  installationId: string,
): Promise<Awaited<ReturnType<typeof getInstallationWithCheckpointForUpdate>>> {
  const client = await deps.pool.connect()
  try {
    await client.query('BEGIN')
    try {
      const installation = await getInstallationWithCheckpointForUpdate(
        client, installationId, identity.providerId,
      )
      await client.query('COMMIT')
      return installation
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    }
  } finally {
    client.release()
  }
}

/**
 * Provider-facing inventory + snapshot reads. Both enforce installation
 * scope, status and the session:snapshot:read grant; snapshots page through
 * event ids under a signed, installation-bound cursor.
 */
export function registerSnapshotRoutes(app: FastifyInstance, deps: SnapshotRouteDeps): void {
  const maxPageEvents = deps.maxPageEvents ?? DEFAULT_MAX_PAGE_EVENTS
  const maxPageBytes = deps.maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES

  app.get('/api/extensions/v1/sessions', async (req, reply) => {
    if (deps.rateLimiter) {
      const decision = deps.rateLimiter.check(`snapshot:${String(req.ip ?? '-')}`)
      if (!decision.allowed) return rateLimited(reply, decision.retryAfterMs)
    }
    if (deps.mode !== 'enabled') {
      return fail(reply, new ExtensionApiError('feature_disabled', 'snapshots require RELAY_EXTENSIONS=enabled'))
    }
    const identity = authenticateProvider(req, deps)
    if (!identity) return fail(reply, new ExtensionApiError('unauthorized', 'provider token required'))
    const query = req.query as Record<string, unknown>
    const installationId = String(query.installation_id ?? '')
    if (!INSTALLATION_ID_PATTERN.test(installationId)) {
      return fail(reply, new ExtensionApiError('invalid_request', 'installation_id required'))
    }
    const installation = await installationScopeFor(deps, identity, installationId)
    if (!installation) return fail(reply, new ExtensionApiError('not_found', 'installation not found'))
    if (installation.status === 'paused') {
      return fail(reply, new ExtensionApiError('installation_paused', 'installation is paused'))
    }
    if (installation.status === 'revoking' || installation.status === 'revoked') {
      return fail(reply, new ExtensionApiError('installation_revoked', 'installation is revoked'))
    }
    if (!(installation.granted_scopes ?? []).includes('session:snapshot:read')) {
      return fail(reply, new ExtensionApiError('forbidden', 'installation lacks session:snapshot:read'))
    }

    const cursorBinding = {
      configVersion: installation.config_version,
      filterHash: filterHashForInstallation(installation.event_filter ?? {}),
    }
    let afterRowId = 0
    const rawCursor = typeof query.cursor === 'string' ? query.cursor : ''
    if (rawCursor) {
      const cursor = decodeSnapshotCursor(rawCursor, deps.cursorSecret, installationId, cursorBinding)
      if (!cursor || cursor.k !== 'inventory') {
        return fail(reply, new ExtensionApiError('cursor_expired', 'cursor no longer valid'))
      }
      afterRowId = Number(cursor.position)
    }
    const rawLimit = Number(query.limit ?? 50)
    const limit = Number.isSafeInteger(rawLimit)
      ? Math.min(Math.max(1, rawLimit), maxPageEvents)
      : 50

    const sessions = await listInventorySessions(deps.pool, {
      installationId,
      providerId: identity.providerId,
      ownerUserId: Number(installation.owner_user_id),
      eventFilter: installation.event_filter ?? {},
    }, { afterSessionRowId: afterRowId, limit })

    const lastPosition = sessions.length > 0
      ? sessions[sessions.length - 1].cursor
      : String(afterRowId)
    return {
      installation_id: installationId,
      sessions,
      next_cursor: snapshotCursor('inventory', installationId, lastPosition, cursorBinding, deps.cursorSecret),
    }
  })

  app.get('/api/extensions/v1/sessions/:sessionId/snapshot', async (req, reply) => {
    if (deps.rateLimiter) {
      const decision = deps.rateLimiter.check(`snapshot:${String(req.ip ?? '-')}`)
      if (!decision.allowed) return rateLimited(reply, decision.retryAfterMs)
    }
    if (deps.mode !== 'enabled') {
      return fail(reply, new ExtensionApiError('feature_disabled', 'snapshots require RELAY_EXTENSIONS=enabled'))
    }
    const identity = authenticateProvider(req, deps)
    if (!identity) return fail(reply, new ExtensionApiError('unauthorized', 'provider token required'))
    const params = req.params as { sessionId?: string }
    const sessionId = params.sessionId ?? ''
    if (!sessionId || sessionId.length > 64) {
      return fail(reply, new ExtensionApiError('invalid_request', 'sessionId required'))
    }
    const query = req.query as Record<string, unknown>
    const installationId = String(query.installation_id ?? '')
    if (!INSTALLATION_ID_PATTERN.test(installationId)) {
      return fail(reply, new ExtensionApiError('invalid_request', 'installation_id required'))
    }
    const installation = await installationScopeFor(deps, identity, installationId)
    if (!installation) return fail(reply, new ExtensionApiError('not_found', 'installation not found'))
    if (installation.status === 'paused') {
      return fail(reply, new ExtensionApiError('installation_paused', 'installation is paused'))
    }
    if (installation.status === 'revoking' || installation.status === 'revoked') {
      return fail(reply, new ExtensionApiError('installation_revoked', 'installation is revoked'))
    }
    if (!(installation.granted_scopes ?? []).includes('session:snapshot:read')) {
      return fail(reply, new ExtensionApiError('forbidden', 'installation lacks session:snapshot:read'))
    }

    // Existence probe stays inside the ownership join: a missing and a
    // foreign session are the same 404, with no unrestricted read helper.
    const snapshotScope = {
      installationId,
      providerId: identity.providerId,
      ownerUserId: Number(installation.owner_user_id),
      eventFilter: installation.event_filter ?? {},
    }
    if (!await snapshotSessionExists(deps.pool, snapshotScope, sessionId)) {
      return fail(reply, new ExtensionApiError('not_found', 'session not found or not owned'))
    }

    const cursorBinding = {
      configVersion: installation.config_version,
      filterHash: filterHashForInstallation(installation.event_filter ?? {}),
    }
    let afterEventId = 0
    const rawCursor = typeof query.cursor === 'string' ? query.cursor : ''
    if (rawCursor) {
      const cursor = decodeSnapshotCursor(rawCursor, deps.cursorSecret, installationId, cursorBinding)
      if (!cursor || cursor.k !== 'snapshot') {
        return fail(reply, new ExtensionApiError('cursor_expired', 'cursor no longer valid'))
      }
      afterEventId = Number(cursor.position)
    }
    const rawLimit = Number(query.limit ?? maxPageEvents)
    const limit = Number.isSafeInteger(rawLimit)
      ? Math.min(Math.max(1, rawLimit), maxPageEvents)
      : maxPageEvents

    const events = await getSnapshotEventPage(
      deps.pool, snapshotScope, sessionId, { afterEventId, limit },
    )

    // Bounded page: stop before the byte budget. A single event that can
    // never fit is a typed error — silently skipping it would leave a
    // permanent gap in the provider's reconciliation.
    const bounded: typeof events = []
    let budget = maxPageBytes
    for (const event of events) {
      const size = Buffer.byteLength(JSON.stringify(event.payload ?? {}), 'utf8')
      if (size > maxPageBytes) {
        return fail(reply, new ExtensionApiError(
          'invalid_request',
          'snapshot event exceeds the page budget',
          { event_id: event.event_id },
        ))
      }
      if (size > budget && bounded.length > 0) break
      budget -= size
      bounded.push(event)
    }

    const lastEventId = bounded.length > 0 ? bounded[bounded.length - 1].event_id : afterEventId
    return {
      installation_id: installationId,
      session_id: sessionId,
      events: bounded,
      next_cursor: snapshotCursor('snapshot', installationId, lastEventId, cursorBinding, deps.cursorSecret),
    }
  })
}
