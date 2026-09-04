import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { ExtensionApiError, extensionErrorStatus, isExtensionApiError } from './errors.js'
import type { ExtensionMode, InstallationStatus } from './types.js'
import {
  EXTENSION_PROVIDER_CATALOG,
  validateInstallationGrant,
} from './catalog.js'
import { decodeFeedCursor } from './cursor.js'
import { resetCheckpointForReplay } from './feed-repository.js'
import {
  ExtensionInstallationConflictError,
  ExtensionInstallationNotFoundError,
  ExtensionInstallationTransitionError,
  ExtensionInstallationVersionConflictError,
  ExtensionInstallationRepository,
} from './installation-repository.js'

export interface ExtensionInstallationRouteDeps {
  pool: pg.Pool
  verifyAccessToken(token: string): Promise<{ userId: number } | null>
  mode: ExtensionMode
  repository?: ExtensionInstallationRepository
  cursorSecret?: string
}

const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function fail(reply: { code: (status: number) => unknown }, code: Parameters<typeof extensionErrorStatus>[0], message: string, statusOverride?: number, details?: Record<string, unknown>) {
  reply.code(statusOverride ?? extensionErrorStatus(code))
  // Server-controlled details nest inside the envelope.
  return { error: { code, message, ...(details ?? {}) } }
}

type Authentication =
  | { ok: true; userId: number }
  | { ok: false; body: unknown }

async function authenticate(
  req: { headers: { authorization?: string } },
  reply: { code: (status: number) => unknown },
  deps: ExtensionInstallationRouteDeps,
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

function mapRepositoryError(error: unknown, reply: { code: (status: number) => unknown }): unknown {
  if (error instanceof ExtensionInstallationNotFoundError) {
    // Cross-user and missing resources are indistinguishable 404s.
    return fail(reply, 'not_found', 'installation not found')
  }
  if (error instanceof ExtensionInstallationVersionConflictError) {
    return fail(reply, 'invalid_request', 'config version mismatch', 409)
  }
  if (error instanceof ExtensionInstallationTransitionError) {
    return fail(reply, 'invalid_request', 'illegal installation transition', 409)
  }
  if (error instanceof ExtensionInstallationConflictError) {
    return fail(reply, 'invalid_request', 'provider already installed', 409)
  }
  if (isExtensionApiError(error)) {
    return fail(reply, error.code, error.message, undefined, error.details)
  }
  throw error
}

/**
 * User-facing installation and scope management. Every query is
 * owner-scoped in SQL; cross-user ids resolve to a uniform 404.
 */
export function registerExtensionInstallationRoutes(
  app: FastifyInstance,
  deps: ExtensionInstallationRouteDeps,
): void {
  const repository = deps.repository ?? new ExtensionInstallationRepository(deps.pool)

  app.get('/api/extensions/v1/providers', async (req, reply) => {
    const auth = await authenticate(req, reply, deps)
    if (!auth.ok) return auth.body
    const userId = auth.userId
    return {
      providers: EXTENSION_PROVIDER_CATALOG,
      capability: {
        mode: deps.mode,
        can_install: deps.mode === 'enabled',
      },
    }
  })

  app.get('/api/extensions/v1/installations', async (req, reply) => {
    const auth = await authenticate(req, reply, deps)
    if (!auth.ok) return auth.body
    const userId = auth.userId
    const installations = await repository.listInstallations(userId)
    return { installations }
  })

  app.post('/api/extensions/v1/installations', async (req, reply) => {
    const auth = await authenticate(req, reply, deps)
    if (!auth.ok) return auth.body
    const userId = auth.userId
    if (deps.mode !== 'enabled') {
      return fail(reply, 'feature_disabled', 'extension installations require RELAY_EXTENSIONS=enabled')
    }
    const body = req.body as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return fail(reply, 'invalid_request', 'request body required')
    }
    const providerId = body.provider_id
    if (typeof providerId !== 'string' || providerId.length > 64) {
      return fail(reply, 'invalid_request', 'provider_id required')
    }
    const startPolicy = body.start_policy ?? 'from_now'
    if (startPolicy !== 'from_now' && startPolicy !== 'retained_history') {
      return fail(reply, 'invalid_request', 'start_policy must be from_now or retained_history')
    }
    const grant = validateInstallationGrant(providerId, {
      granted_scopes: body.granted_scopes,
      subscriptions: body.subscriptions,
      enabled_services: body.enabled_services,
      event_filter: body.event_filter,
    })
    if (!grant.valid) {
      return fail(reply, 'invalid_request', 'grants must be subsets of the provider manifest')
    }
    try {
      const installation = await repository.createInstallation({
        ownerUserId: userId,
        providerId,
        grantedScopes: grant.granted_scopes!,
        subscriptions: grant.subscriptions!,
        enabledServices: grant.enabled_services!,
        eventFilter: grant.event_filter ?? {},
        startPolicy,
      })
      reply.code(201)
      return { installation }
    } catch (error) {
      return mapRepositoryError(error, reply)
    }
  })

  app.patch('/api/extensions/v1/installations/:installationId', async (req, reply) => {
    const auth = await authenticate(req, reply, deps)
    if (!auth.ok) return auth.body
    const userId = auth.userId
    const params = req.params as { installationId?: string }
    const installationId = params.installationId ?? ''
    if (!INSTALLATION_ID_PATTERN.test(installationId)) {
      return fail(reply, 'invalid_request', 'installation id required')
    }
    const body = req.body as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return fail(reply, 'invalid_request', 'request body required')
    }
    const expected = body.expected_config_version
    if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 1) {
      return fail(reply, 'invalid_request', 'expected_config_version required')
    }
    const patch: {
      status?: InstallationStatus
      granted_scopes?: string[]
      subscriptions?: string[]
      enabled_services?: string[]
      event_filter?: Record<string, unknown>
    } = {}
    if (body.status !== undefined) {
      if (typeof body.status !== 'string'
        || !['active', 'paused'].includes(body.status)) {
        return fail(reply, 'invalid_request', 'status may only be set to active or paused')
      }
      patch.status = body.status as InstallationStatus
    }
    const wantsGrants = body.granted_scopes !== undefined
      || body.subscriptions !== undefined
      || body.enabled_services !== undefined
    if (wantsGrants || body.event_filter !== undefined) {
      const current = await repository.getInstallationForUser(userId, installationId)
      if (!current) {
        return fail(reply, 'not_found', 'installation not found')
      }
      const grant = validateInstallationGrant(current.provider_id, {
        granted_scopes: body.granted_scopes ?? current.granted_scopes,
        subscriptions: body.subscriptions ?? current.subscriptions,
        enabled_services: body.enabled_services ?? current.enabled_services,
        event_filter: body.event_filter ?? current.event_filter,
      })
      if (!grant.valid) {
        return fail(
          reply,
          'invalid_request',
          body.event_filter !== undefined
            ? 'event_filter only supports daemon_ids and agent_types'
            : 'grants must be subsets of the provider manifest',
        )
      }
      if (wantsGrants) {
        patch.granted_scopes = grant.granted_scopes
        patch.subscriptions = grant.subscriptions
        patch.enabled_services = grant.enabled_services
      }
      if (body.event_filter !== undefined) {
        patch.event_filter = grant.event_filter
      }
    }
    try {
      const installation = await repository.updateInstallation(
        userId, installationId, expected, patch,
      )
      return { installation }
    } catch (error) {
      return mapRepositoryError(error, reply)
    }
  })

  app.delete('/api/extensions/v1/installations/:installationId', async (req, reply) => {
    const auth = await authenticate(req, reply, deps)
    if (!auth.ok) return auth.body
    const userId = auth.userId
    const params = req.params as { installationId?: string }
    const installationId = params.installationId ?? ''
    if (!INSTALLATION_ID_PATTERN.test(installationId)) {
      return fail(reply, 'invalid_request', 'installation id required')
    }
    try {
      const result = await repository.revokeInstallation(userId, installationId)
      return { installation: result.installation, purge_request_id: result.purge_request_id }
    } catch (error) {
      return mapRepositoryError(error, reply)
    }
  })

  /**
   * User-controlled replay: pause, rewind the checkpoint to a retained
   * position, fence every outstanding lease/cursor, then resume. Providers
   * can never rewind their own checkpoint, and revoking/revoked
   * installations can never be resurrected through this route.
   */
  app.post('/api/extensions/v1/installations/:installationId/replay', async (req, reply) => {
    if (deps.mode !== 'enabled') {
      return fail(reply, 'feature_disabled', 'replay requires RELAY_EXTENSIONS=enabled')
    }
    const auth = await authenticate(req, reply, deps)
    if (!auth.ok) return auth.body
    const userId = auth.userId
    const params = req.params as { installationId?: string }
    const installationId = params.installationId ?? ''
    if (!INSTALLATION_ID_PATTERN.test(installationId)) {
      return fail(reply, 'invalid_request', 'installation id required')
    }
    const body = req.body as Record<string, unknown> | null
    const from = body?.from
    if (from !== 'retention_start' && from !== 'cursor') {
      return fail(reply, 'invalid_request', "from must be 'retention_start' or 'cursor'")
    }
    const installation = await repository.getInstallationForUser(userId, installationId)
    if (!installation) {
      return fail(reply, 'not_found', 'installation not found')
    }
    // Terminal/uninstall states are final; pending/active/paused (including
    // a paused installation replaying itself) stay replayable. The guarded
    // UPDATE below is the race-safe authority for this boundary.
    if (installation.status === 'revoking' || installation.status === 'revoked') {
      return fail(reply, 'invalid_request', `replay is not allowed from status ${installation.status}`, 409)
    }

    let ackFeedId = 0
    if (from === 'cursor') {
      if (typeof body?.cursor !== 'string' || !deps.cursorSecret) {
        return fail(reply, 'invalid_request', 'cursor required for cursor replay')
      }
      const cursor = decodeFeedCursor(body.cursor, deps.cursorSecret)
      if (!cursor || cursor.installation_id !== installationId) {
        return fail(reply, 'cursor_expired', 'cursor no longer valid')
      }
      // The rewind target must still be inside the retained window.
      const retained = await deps.pool.query<{ min_feed_id: string | null }>(
        `SELECT MIN(feed_id)::text AS min_feed_id FROM extension_feed WHERE owner_user_id = $1`,
        [installation.owner_user_id],
      )
      const oldestRetained = Number(retained.rows[0]?.min_feed_id ?? 0)
      if (Number(cursor.feed_id) < oldestRetained) {
        return fail(reply, 'cursor_expired', 'cursor precedes the retained feed window')
      }
      ackFeedId = Number(cursor.feed_id)
    }

    const client = await deps.pool.connect()
    try {
      await client.query('BEGIN')
      const paused = await client.query<{ status: string }>(
        `UPDATE extension_installations
         SET status = 'paused', updated_at = NOW()
         WHERE installation_id = $1 AND owner_user_id = $2
           AND status IN ('pending', 'active', 'paused')
         RETURNING status`,
        [installationId, userId],
      )
      if ((paused.rowCount ?? 0) === 0) {
        // Re-check under the write lock: a concurrent revoke wins, or the
        // installation is gone. Both fail closed without side effects.
        const current = await client.query<{ status: string }>(
          `SELECT status FROM extension_installations WHERE installation_id = $1 AND owner_user_id = $2`,
          [installationId, userId],
        )
        await client.query('ROLLBACK')
        if ((current.rowCount ?? 0) === 0) {
          return fail(reply, 'not_found', 'installation not found')
        }
        return fail(reply, 'invalid_request', `replay is not allowed from status ${current.rows[0].status}`, 409)
      }
      await resetCheckpointForReplay(client, {
        installationId,
        ackFeedId,
        startFeedId: ackFeedId,
      })
      await client.query(
        `UPDATE extension_installations
         SET status = 'active', config_version = config_version + 1, updated_at = NOW()
         WHERE installation_id = $1 AND owner_user_id = $2 AND status = 'paused'`,
        [installationId, userId],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
    // Audit records no content and no cursor material.
    await deps.pool.query(
      `INSERT INTO audit_log (user_id, action, details) VALUES ($1, $2, $3::jsonb)`,
      [userId, 'extension_installation_replay', JSON.stringify({
        installation_id: installationId, from,
      })],
    ).catch(() => undefined)
    return { installation_id: installationId, from }
  })
}

export { ExtensionApiError }
