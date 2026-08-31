import { createHash, randomUUID } from 'crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type pg from 'pg'

import type { ExtensionMode } from './types.js'
import { SCOPE_CONTROL_TOPICS, isScopeControlTopic } from './types.js'
import { ExtensionApiError } from './errors.js'
import { verifyProviderExtensionToken } from './provider-auth.js'
import { buildScopeFeedEnvelope } from './envelope.js'
import {
  decodeScopeFeedCursor,
  encodeScopeFeedCursor,
  leaseBindingHash,
  newLeaseToken,
} from './cursor.js'
import {
  ackCheckpoint,
  getSharedInstallationWithCheckpointForUpdate,
  markOutboxProjected,
  queryScopeOutboxRows,
  updateLease,
} from './feed-repository.js'
import {
  MembershipStateError,
  ScopeNotFoundError,
  ScopePermissionError,
  getSharedScope,
  requireScopePermission,
} from './scope-repository.js'
import {
  beginScopeIdempotency,
  commitScopeIdempotency,
  withScopeIdempotencyLock,
} from './scope-routes.js'
import { EXTENSION_PROVIDER_CATALOG } from './catalog.js'

/**
 * ADR-0005 Protocol v2 routes (§5.3): user-facing shared-scope installation
 * discovery/creation plus the provider-facing scope-control feed. Team/Org
 * installations subscribe only to control topics, never receive member
 * Session/Event feeds, and every cursor is fenced by the owning scope's
 * authorization epoch.
 */

export interface V2RouteDeps {
  pool: pg.Pool
  verifyAccessToken(token: string): Promise<{ userId: number } | null>
  v2Mode: ExtensionMode
  providerJwtSecret: string
  issuer: string
  cursorSecret: string
  leaseTtlSeconds: number
  maxResponseBytes?: number
  maxItems?: number
}

const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024
const DEFAULT_MAX_ITEMS = 100
const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CURSOR_TTL_SECONDS = 900
const ALLOWED_PROVIDERS = EXTENSION_PROVIDER_CATALOG.map(entry => entry.provider_id)
const ALLOWED_SERVICES = EXTENSION_PROVIDER_CATALOG.flatMap(entry =>
  entry.services.map(service => service.service_id))

interface ProviderIdentity {
  providerId: string
  credentialId: string
  tokenJti: string
}

function authenticateProvider(req: FastifyRequest, deps: V2RouteDeps): ProviderIdentity | null {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  return verifyProviderExtensionToken(header.slice(7), {
    secret: deps.providerJwtSecret,
    issuer: deps.issuer,
  })
}

function fail(reply: { code: (status: number) => unknown }, error: ExtensionApiError) {
  reply.code(error.httpStatus)
  return { error: { code: error.code, message: error.message, ...(error.details ?? {}) } }
}

function requestHashFor(method: string, url: string, body: unknown): string {
  const canonical = body === null || body === undefined
    ? ''
    : JSON.stringify(body, Object.keys(body as Record<string, unknown>).sort())
  return createHash('sha256').update(`${method} ${url} ${canonical}`).digest('hex')
}

export function registerV2Routes(app: FastifyInstance, deps: V2RouteDeps): void {
  const maxResponseBytes = deps.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const maxItems = deps.maxItems ?? DEFAULT_MAX_ITEMS

  // --- User-facing installation discovery -------------------------------------

  app.get('/api/extensions/v2/installations', async (req, reply) => {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      return fail(reply, new ExtensionApiError('unauthorized', 'authorization required'))
    }
    const payload = await deps.verifyAccessToken(header.slice(7))
    if (!payload) {
      return fail(reply, new ExtensionApiError('unauthorized', 'invalid token'))
    }
    if (deps.v2Mode === 'off') {
      return fail(reply, new ExtensionApiError('feature_disabled', 'v2 installations require RELAY_EXTENSION_V2=shadow or enabled'))
    }
    const userId = payload.userId
    const personal = await deps.pool.query<{
      installation_id: string
      provider_id: string
      status: string
      config_version: string | number
      owner_scope_id: string
      authorization_epoch: string | number
      created_at: Date
      updated_at: Date
    }>(`
      SELECT installation_id, provider_id, status, config_version,
             owner_scope_id, authorization_epoch, created_at, updated_at
      FROM extension_installations
      WHERE owner_user_id = $1 AND status IN ('pending', 'active', 'paused')
      ORDER BY created_at ASC
    `, [userId])
    const shared = await deps.pool.query<{
      installation_id: string
      provider_id: string
      status: string
      config_version: string | number
      owner_scope_kind: 'team' | 'organization'
      owner_scope_id: string
      authorization_epoch: string | number
      created_at: Date
      updated_at: Date
    }>(`
      SELECT i.installation_id, i.provider_id, i.status, i.config_version,
             i.owner_scope_kind, i.owner_scope_id,
             CASE i.owner_scope_kind
               WHEN 'team' THEN t.authorization_epoch
               WHEN 'organization' THEN o.authorization_epoch
               ELSE i.authorization_epoch
             END AS authorization_epoch,
             i.created_at, i.updated_at
      FROM extension_installations i
      JOIN extension_scope_memberships m
        ON m.scope_kind = i.owner_scope_kind AND m.scope_id = i.owner_scope_id
      LEFT JOIN extension_teams t
        ON i.owner_scope_kind = 'team' AND t.team_id = i.owner_scope_id
      LEFT JOIN extension_organizations o
        ON i.owner_scope_kind = 'organization' AND o.organization_id = i.owner_scope_id
      WHERE m.user_id = $1 AND m.state = 'active'
        AND i.status IN ('pending', 'active', 'paused')
        AND i.owner_scope_kind IN ('team', 'organization')
      ORDER BY i.created_at ASC
    `, [userId])

    const toView = (row: typeof personal.rows[number] | typeof shared.rows[number], kind: string) => ({
      installation_id: row.installation_id,
      provider_id: row.provider_id,
      status: row.status,
      config_version: String(row.config_version),
      owner_scope_kind: kind,
      owner_scope_id: row.owner_scope_id,
      authorization_epoch: String(row.authorization_epoch),
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
    })
    return {
      installations: [
        ...personal.rows.map(row => toView(row, 'personal')),
        ...shared.rows.map(row => toView(row, row.owner_scope_kind)),
      ],
    }
  })

  // --- Shared-scope installation creation --------------------------------------

  app.post('/api/extensions/v2/installations', { bodyLimit: 16 * 1024 }, async (req, reply) => {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      return fail(reply, new ExtensionApiError('unauthorized', 'authorization required'))
    }
    const payload = await deps.verifyAccessToken(header.slice(7))
    if (!payload) {
      return fail(reply, new ExtensionApiError('unauthorized', 'invalid token'))
    }
    if (deps.v2Mode !== 'enabled') {
      return fail(reply, new ExtensionApiError('feature_disabled', 'v2 installation creation requires RELAY_EXTENSION_V2=enabled'))
    }
    const userId = payload.userId
    const key = req.headers['idempotency-key']
    if (typeof key !== 'string' || key.length === 0 || key.length > 128) {
      return fail(reply, new ExtensionApiError('invalid_request', 'Idempotency-Key header of 1..128 characters is required'))
    }
    const body = req.body as Record<string, unknown> | null
    const providerId = body?.provider_id
    if (typeof providerId !== 'string' || !ALLOWED_PROVIDERS.includes(providerId)) {
      return fail(reply, new ExtensionApiError('invalid_request', 'provider_id must come from the provider catalog'))
    }
    const scopeKind = body?.owner_scope_kind
    if (scopeKind !== 'team' && scopeKind !== 'organization') {
      return fail(reply, new ExtensionApiError('invalid_request', 'owner_scope_kind must be team or organization'))
    }
    const scopeId = body?.owner_scope_id
    if (typeof scopeId !== 'string' || !INSTALLATION_ID_PATTERN.test(scopeId)) {
      return fail(reply, new ExtensionApiError('invalid_request', 'owner_scope_id must be a UUID'))
    }
    const rawSubscriptions = body?.subscriptions
    if (!Array.isArray(rawSubscriptions) || rawSubscriptions.length === 0
      || !rawSubscriptions.every(topic => typeof topic === 'string' && isScopeControlTopic(topic))) {
      return fail(reply, new ExtensionApiError('invalid_request', 'subscriptions must be a non-empty list of scope control topics'))
    }
    const subscriptions = [...new Set(rawSubscriptions as string[])]
    const rawServices = body?.enabled_services ?? []
    if (!Array.isArray(rawServices)
      || !rawServices.every(service => typeof service === 'string' && ALLOWED_SERVICES.includes(service))) {
      return fail(reply, new ExtensionApiError('invalid_request', 'enabled_services must come from the provider catalog'))
    }
    const enabledServices = [...new Set(rawServices as string[])]
    const expectedRevision = body?.expected_revision
    if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return fail(reply, new ExtensionApiError('invalid_request', 'expected_revision must be a positive integer'))
    }

    const requestHash = requestHashFor('POST', '/api/extensions/v2/installations', body)
    const lockKey = `v2.create_installation:${userId}:${createHash('sha256').update(key).digest('hex')}`
    return withScopeIdempotencyLock(deps.pool, lockKey, async () => {
      const client = await deps.pool.connect()
      try {
        await client.query('BEGIN')
        try {
        const lookup = await beginScopeIdempotency(client, {
          userId, operation: 'v2.create_installation', key, requestHash,
        })
        if (lookup.kind === 'replay') {
          const stored = lookup.response as { status?: number; body?: Record<string, unknown> }
          await client.query('COMMIT')
          reply.code(stored.status ?? 200)
          return stored.body ?? {}
        }
        if (lookup.kind === 'mismatch') {
          await client.query('COMMIT')
          return fail(reply, new ExtensionApiError('revision_conflict', 'Idempotency-Key was already used for a different request'))
        }
        await requireScopePermission(client, {
          scopeKind, scopeId, userId, permission: 'scope_admin',
        })
        const scope = await getSharedScope(client, scopeKind, scopeId)
        if (!scope) throw new ScopeNotFoundError()
        if (scope.revision !== expectedRevision) {
          throw new MembershipStateError('scope revision mismatch')
        }
        const installationId = randomUUID()
        const inserted = await client.query<{
          installation_id: string
          status: string
          config_version: string | number
          created_at: Date
          updated_at: Date
        }>(`
          INSERT INTO extension_installations
            (installation_id, provider_id, owner_user_id, owner_scope_kind, owner_scope_id,
             created_by_user_id, status, granted_scopes, subscriptions, enabled_services,
             start_policy, authorization_epoch)
          VALUES ($1, $2, NULL, $3, $4, $5, 'pending', ARRAY['scope:control:read'],
                  $6::text[], $7::text[], 'from_now', $8)
          RETURNING installation_id, status, config_version, created_at, updated_at
        `, [
          installationId, providerId, scopeKind, scopeId, userId,
          subscriptions, enabledServices, scope.authorization_epoch,
        ])
        await client.query(
          `INSERT INTO extension_scope_outbox (scope_kind, scope_id, topic, payload)
           VALUES ($1, $2, 'scope.installation.v2', $3::jsonb)`,
          [scopeKind, scopeId, JSON.stringify({
            event_type: 'installation_created',
            installation_id: installationId,
            authorization_epoch: scope.authorization_epoch,
            state: 'pending',
          })],
        )
        const responseBody = {
          installation: {
            installation_id: inserted.rows[0].installation_id,
            provider_id: providerId,
            owner_scope_kind: scopeKind,
            owner_scope_id: scopeId,
            status: inserted.rows[0].status,
            config_version: String(inserted.rows[0].config_version),
            subscriptions,
            enabled_services: enabledServices,
            created_at: new Date(inserted.rows[0].created_at).toISOString(),
            updated_at: new Date(inserted.rows[0].updated_at).toISOString(),
          },
        }
        await commitScopeIdempotency(client, {
          userId, operation: 'v2.create_installation', key, requestHash,
          response: { status: 201, body: responseBody },
        })
        await client.query('COMMIT')
        reply.code(201)
        return responseBody
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined)
          if (error instanceof ScopeNotFoundError) {
            return fail(reply, new ExtensionApiError('not_found', 'scope not found'))
          }
          if (error instanceof ScopePermissionError) {
            return fail(reply, new ExtensionApiError('forbidden', 'scope_admin permission required'))
          }
          if (error instanceof MembershipStateError) {
            return fail(reply, new ExtensionApiError('revision_conflict', error.message))
          }
          if (error instanceof ExtensionApiError) return fail(reply, error)
          throw error
        }
      } finally {
        client.release()
      }
    })
  })

  // --- Provider-facing scope-control feed ---------------------------------------

  app.get('/api/extensions/v2/feed', async (req, reply) => {
    if (deps.v2Mode !== 'enabled') {
      return fail(reply, new ExtensionApiError('feature_disabled', 'scope-control feed requires RELAY_EXTENSION_V2=enabled'))
    }
    const identity = authenticateProvider(req, deps)
    if (!identity) {
      return fail(reply, new ExtensionApiError('unauthorized', 'provider token required'))
    }
    const query = req.query as Record<string, unknown>
    const installationId = String(query.installation_id ?? '')
    if (!INSTALLATION_ID_PATTERN.test(installationId)) {
      return fail(reply, new ExtensionApiError('invalid_request', 'installation_id required'))
    }
    const rawLimit = Number(query.limit ?? maxItems)
    const limit = Number.isSafeInteger(rawLimit) ? Math.min(Math.max(1, rawLimit), maxItems) : maxItems
    const cursorToken = typeof query.cursor === 'string' && query.cursor.length > 0
      ? query.cursor
      : null

    const client = await deps.pool.connect()
    try {
      await client.query('BEGIN')
      try {
        const installation = await getSharedInstallationWithCheckpointForUpdate(
          client, installationId, identity.providerId,
        )
        if (!installation) {
          throw new ExtensionApiError('not_found', 'installation not found')
        }
        if (installation.status === 'paused') {
          throw new ExtensionApiError('installation_paused', 'installation is paused')
        }
        if (installation.status === 'revoking' || installation.status === 'revoked') {
          throw new ExtensionApiError('installation_revoked', 'installation is revoked')
        }
        // Feed-pull guard: shared installations may only ever consume control
        // topics — a Session/Event subscription is structurally rejected here
        // even if bad state made it into the row.
        if (!installation.subscriptions.every(topic => isScopeControlTopic(topic))) {
          throw new ExtensionApiError('forbidden', 'shared installations may only subscribe to scope control topics')
        }
        const scope = await getSharedScope(client, installation.owner_scope_kind, installation.owner_scope_id)
        if (!scope) {
          throw new ExtensionApiError('not_found', 'installation not found')
        }

        let afterOutboxId: number
        let leaseEpoch: number
        if (cursorToken) {
          const cursor = decodeScopeFeedCursor(cursorToken, deps.cursorSecret)
          if (!cursor
            || cursor.installation_id !== installationId
            || cursor.config_version !== String(installation.config_version)
            || cursor.authorization_epoch !== String(scope.authorization_epoch)) {
            throw new ExtensionApiError('cursor_expired', 'cursor no longer valid for this installation')
          }
          if (Number(cursor.lease_epoch) < Number(installation.lease_epoch)) {
            throw new ExtensionApiError('stale_lease', 'cursor predates the current lease epoch')
          }
          afterOutboxId = Number(cursor.feed_id)
          leaseEpoch = Number(cursor.lease_epoch)
        } else {
          afterOutboxId = Math.max(Number(installation.ack_feed_id), 0)
          leaseEpoch = Number(installation.lease_epoch) + 1
        }

        const rows = await queryScopeOutboxRows(client, {
          scopeKind: installation.owner_scope_kind,
          scopeId: installation.owner_scope_id,
          topics: installation.subscriptions.length > 0
            ? installation.subscriptions
            : [...SCOPE_CONTROL_TOPICS],
          afterOutboxId,
          limit,
        })

        const items: Array<Record<string, unknown>> = []
        const deliveredIds: number[] = []
        let budget = maxResponseBytes
        let lastOutboxId = afterOutboxId
        for (const row of rows) {
          const envelope = buildScopeFeedEnvelope({
            outbox_id: row.outbox_id,
            scope_kind: row.scope_kind,
            scope_id: row.scope_id,
            topic: row.topic,
            payload: row.payload,
            recorded_at: row.recorded_at,
          }, row.outbox_id)
          const size = Buffer.byteLength(JSON.stringify(envelope), 'utf8')
          if (size > maxResponseBytes) {
            throw new ExtensionApiError('invalid_request', 'feed item exceeds the response budget')
          }
          if (size > budget) break
          budget -= size
          items.push(envelope as unknown as Record<string, unknown>)
          deliveredIds.push(Number(row.outbox_id))
          lastOutboxId = Number(row.outbox_id)
        }

        const leaseToken = newLeaseToken()
        const leaseExpiresAt = new Date(Date.now() + deps.leaseTtlSeconds * 1000)
        const bindingHash = leaseBindingHash({
          installationId, leaseEpoch, leaseToken, cursorFeedId: lastOutboxId,
        })
        await updateLease(client, {
          installationId, leaseEpoch, leaseTokenHash: bindingHash, leaseExpiresAt,
        })
        await markOutboxProjected(client, deliveredIds)
        if (installation.status === 'pending') {
          await client.query(
            `UPDATE extension_installations SET status = 'active', updated_at = NOW()
             WHERE installation_id = $1 AND status = 'pending'`,
            [installationId],
          )
        }
        await client.query('COMMIT')

        const nextCursor = encodeScopeFeedCursor({
          v: 2,
          installation_id: installationId,
          feed_id: String(lastOutboxId),
          lease_epoch: String(leaseEpoch),
          config_version: String(installation.config_version),
          authorization_epoch: String(scope.authorization_epoch),
          exp: Math.floor(Date.now() / 1000) + CURSOR_TTL_SECONDS,
        }, deps.cursorSecret)
        return {
          installation_id: installationId,
          items,
          next_cursor: nextCursor,
          lease_token: leaseToken,
          lease_expires_at: leaseExpiresAt.toISOString(),
        }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        if (error instanceof ExtensionApiError) return fail(reply, error)
        throw error
      }
    } finally {
      client.release()
    }
  })

  app.post('/api/extensions/v2/feed/ack', { bodyLimit: 8192 }, async (req, reply) => {
    if (deps.v2Mode !== 'enabled') {
      return fail(reply, new ExtensionApiError('feature_disabled', 'scope-control feed requires RELAY_EXTENSION_V2=enabled'))
    }
    const identity = authenticateProvider(req, deps)
    if (!identity) {
      return fail(reply, new ExtensionApiError('unauthorized', 'provider token required'))
    }
    const body = req.body as Record<string, unknown> | null
    const installationId = typeof body?.installation_id === 'string' ? body.installation_id : ''
    const cursorToken = typeof body?.cursor === 'string' ? body.cursor : ''
    const leaseToken = typeof body?.lease_token === 'string' ? body.lease_token : ''
    if (!INSTALLATION_ID_PATTERN.test(installationId) || !cursorToken || !leaseToken) {
      return fail(reply, new ExtensionApiError('invalid_request', 'installation_id, cursor and lease_token required'))
    }

    const client = await deps.pool.connect()
    try {
      await client.query('BEGIN')
      let acked: number | null = null
      try {
        const cursor = decodeScopeFeedCursor(cursorToken, deps.cursorSecret)
        if (!cursor || cursor.installation_id !== installationId) {
          throw new ExtensionApiError('cursor_expired', 'cursor no longer valid')
        }
        const installation = await getSharedInstallationWithCheckpointForUpdate(
          client, installationId, identity.providerId,
        )
        if (!installation) {
          throw new ExtensionApiError('not_found', 'installation not found')
        }
        if (installation.status === 'revoking' || installation.status === 'revoked') {
          throw new ExtensionApiError('installation_revoked', 'installation is revoked')
        }
        const bindingHash = leaseBindingHash({
          installationId,
          leaseEpoch: Number(cursor.lease_epoch),
          leaseToken,
          cursorFeedId: Number(cursor.feed_id),
        })
        acked = await ackCheckpoint(client, {
          installationId,
          leaseEpoch: Number(cursor.lease_epoch),
          bindingHash,
          newAckFeedId: Number(cursor.feed_id),
        })
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        if (error instanceof ExtensionApiError) return fail(reply, error)
        throw error
      }
      if (acked === null) {
        return fail(reply, new ExtensionApiError('stale_lease', 'lease no longer current'))
      }
      return { installation_id: installationId, ack_feed_id: acked }
    } finally {
      client.release()
    }
  })
}
