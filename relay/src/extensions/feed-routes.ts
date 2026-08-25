import type { FastifyInstance, FastifyRequest } from 'fastify'
import type pg from 'pg'
import { requiredExtensionScopeForTopic, type ExtensionMode, type ExtensionTopic } from './types.js'
import { ExtensionApiError } from './errors.js'
import { verifyProviderExtensionToken } from './provider-auth.js'
import {
  decodeFeedCursor,
  encodeFeedCursor,
  filterHashForInstallation,
  leaseBindingHash,
  newLeaseToken,
} from './cursor.js'
import {
  ackCheckpoint,
  getInstallationWithCheckpointForUpdate,
  queryFeedRows,
  updateLease,
} from './feed-repository.js'
import { boundedProviderLabel, extensionFeedAcks, extensionFeedPulls } from '../metrics.js'

export interface FeedRouteDeps {
  pool: pg.Pool
  mode: ExtensionMode
  providerJwtSecret: string
  issuer: string
  cursorSecret: string
  leaseTtlSeconds: number
  maxResponseBytes?: number
  maxItems?: number
  rateLimiter?: { check(key: string): { allowed: boolean; retryAfterMs?: number } }
  ackRateLimiter?: { check(key: string): { allowed: boolean; retryAfterMs?: number } }
}

const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024
const DEFAULT_MAX_ITEMS = 100
const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CURSOR_TTL_SECONDS = 900

interface ProviderIdentity {
  providerId: string
  credentialId: string
  tokenJti: string
}

function authenticateProvider(
  req: FastifyRequest,
  deps: FeedRouteDeps,
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
  // Server-controlled details nest inside the envelope (after code/message,
  // whose names this code owns).
  return { error: { code: error.code, message: error.message, ...(error.details ?? {}) } }
}

function rateLimited(reply: { code: (status: number) => unknown; header: (name: string, value: string) => unknown }, retryAfterMs?: number) {
  reply.code(429)
  if (retryAfterMs !== undefined) reply.header('retry-after', String(Math.ceil(retryAfterMs / 1000)))
  return { error: { code: 'invalid_request', message: 'rate limit exceeded' } }
}

/**
 * Provider feed delivery: GET pulls one bounded batch under an atomic lease
 * acquisition/renewal; POST acknowledges a Relay-issued cursor under the
 * exact lease binding. Cross-provider installation ids and foreign owners
 * never surface data.
 */
export function registerFeedRoutes(app: FastifyInstance, deps: FeedRouteDeps): void {
  const maxResponseBytes = deps.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const maxItems = deps.maxItems ?? DEFAULT_MAX_ITEMS

  app.get('/api/extensions/v1/feed', async (req, reply) => {
    if (deps.rateLimiter) {
      const decision = deps.rateLimiter.check(`feed:${String(req.ip ?? '-')}`)
      if (!decision.allowed) return rateLimited(reply, decision.retryAfterMs)
    }
    if (deps.mode !== 'enabled') {
      return fail(reply, new ExtensionApiError('feature_disabled', 'extension feed requires RELAY_EXTENSIONS=enabled'))
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
        const installation = await getInstallationWithCheckpointForUpdate(
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
        if (installation.snapshot_required_at) {
          // Retention passed this installation's position: only a snapshot
          // reconciliation can rebuild its state. The flag distinguishes a
          // mandatory rebuild from ordinary cursor invalidation.
          throw new ExtensionApiError(
            'cursor_expired',
            'feed retention passed the checkpoint; snapshot reconciliation required',
            { snapshot_required: true },
          )
        }
        if (installation.subscriptions.length === 0) {
          throw new ExtensionApiError('invalid_request', 'installation has no topic subscriptions')
        }
        if (!installation.subscriptions.every(topic => installation.granted_scopes.includes(
          requiredExtensionScopeForTopic(topic as ExtensionTopic),
        ))) {
          throw new ExtensionApiError('forbidden', 'installation lacks a scope required by its topic subscriptions')
        }

        const currentFilterHash = filterHashForInstallation(installation.event_filter ?? {})
        let afterFeedId: number
        let leaseEpoch: number
        if (cursorToken) {
          const cursor = decodeFeedCursor(cursorToken, deps.cursorSecret)
          if (!cursor
            || cursor.installation_id !== installationId
            || cursor.filter_hash !== currentFilterHash
            || cursor.config_version !== String(installation.config_version)) {
            throw new ExtensionApiError('cursor_expired', 'cursor no longer valid for this installation')
          }
          // A cursor from an older lease epoch must never wind the stored
          // epoch back: after a takeover, the previous instance's GET would
          // otherwise fence the new holder out with stale_lease ping-pong.
          if (Number(cursor.lease_epoch) < Number(installation.lease_epoch)) {
            throw new ExtensionApiError('stale_lease', 'cursor predates the current lease epoch')
          }
          afterFeedId = Number(cursor.feed_id)
          leaseEpoch = Number(cursor.lease_epoch)
        } else {
          afterFeedId = Math.max(
            Number(installation.ack_feed_id),
            Number(installation.start_feed_id),
          )
          // Fresh acquisition or takeover bumps the epoch so the previous
          // holder's acks fail closed.
          leaseEpoch = Number(installation.lease_epoch) + 1
        }

        const daemonIds = Array.isArray((installation.event_filter as Record<string, unknown>)?.daemon_ids)
          ? (installation.event_filter as Record<string, unknown>).daemon_ids as string[]
          : undefined
        const agentTypes = Array.isArray((installation.event_filter as Record<string, unknown>)?.agent_types)
          ? (installation.event_filter as Record<string, unknown>).agent_types as string[]
          : undefined

        const rows = await queryFeedRows(client, {
          ownerUserId: Number(installation.owner_user_id),
          topics: installation.subscriptions,
          afterFeedId,
          limit,
          daemonIds,
          agentTypes,
        })

        // Bounded response: cut before exceeding the byte budget; a single
        // oversized item is a typed error rather than an unbounded reply.
        const items: Array<Record<string, unknown>> = []
        let budget = maxResponseBytes
        let lastFeedId = afterFeedId
        for (const row of rows) {
          const envelope = {
            ...(row.payload as Record<string, unknown>),
            feed_id: String(row.feed_id),
          }
          const size = Buffer.byteLength(JSON.stringify(envelope), 'utf8')
          if (size > maxResponseBytes) {
            throw new ExtensionApiError('invalid_request', 'feed item exceeds the response budget')
          }
          if (size > budget) break
          budget -= size
          items.push(envelope)
          lastFeedId = Number(row.feed_id)
        }

        const leaseToken = newLeaseToken()
        const leaseExpiresAt = new Date(Date.now() + deps.leaseTtlSeconds * 1000)
        const bindingHash = leaseBindingHash({
          installationId, leaseEpoch, leaseToken, cursorFeedId: lastFeedId,
        })
        await updateLease(client, {
          installationId, leaseEpoch, leaseTokenHash: bindingHash, leaseExpiresAt,
        })
        if (installation.status === 'pending') {
          // First successful authenticated pull activates the installation.
          await client.query(
            `UPDATE extension_installations SET status = 'active', updated_at = NOW()
             WHERE installation_id = $1 AND status = 'pending'`,
            [installationId],
          )
        }
        await client.query('COMMIT')

        extensionFeedPulls.inc({ provider: boundedProviderLabel(identity.providerId), result: 'delivered' })
        const nextCursor = encodeFeedCursor({
          v: 1,
          installation_id: installationId,
          feed_id: String(lastFeedId),
          lease_epoch: String(leaseEpoch),
          config_version: String(installation.config_version),
          filter_hash: currentFilterHash,
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

  app.post('/api/extensions/v1/feed/ack', { bodyLimit: 8192 }, async (req, reply) => {
    const ackLimiter = deps.ackRateLimiter ?? deps.rateLimiter
    if (ackLimiter) {
      const decision = ackLimiter.check(`ack:${String(req.ip ?? '-')}`)
      if (!decision.allowed) return rateLimited(reply, decision.retryAfterMs)
    }
    if (deps.mode !== 'enabled') {
      return fail(reply, new ExtensionApiError('feature_disabled', 'extension feed requires RELAY_EXTENSIONS=enabled'))
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
        const cursor = decodeFeedCursor(cursorToken, deps.cursorSecret)
        if (!cursor || cursor.installation_id !== installationId) {
          throw new ExtensionApiError('cursor_expired', 'cursor no longer valid')
        }
        const installation = await getInstallationWithCheckpointForUpdate(
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
        if (cursor.config_version !== String(installation.config_version)
          || cursor.filter_hash !== filterHashForInstallation(installation.event_filter ?? {})) {
          throw new ExtensionApiError('cursor_expired', 'cursor no longer valid for this installation')
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
        extensionFeedAcks.inc({ provider: boundedProviderLabel(identity.providerId), result: 'stale_lease' })
        return fail(reply, new ExtensionApiError('stale_lease', 'lease no longer current'))
      }
      extensionFeedAcks.inc({ provider: boundedProviderLabel(identity.providerId), result: 'acked' })
      return { installation_id: installationId, ack_feed_id: acked }
    } finally {
      client.release()
    }
  })
}
