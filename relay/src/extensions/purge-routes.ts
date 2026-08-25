import type { FastifyInstance, FastifyRequest } from 'fastify'
import type pg from 'pg'
import type { ExtensionMode } from './types.js'
import { ExtensionApiError } from './errors.js'
import { verifyProviderExtensionToken } from './provider-auth.js'
import { boundedProviderLabel, extensionPurgePending } from '../metrics.js'

export interface PurgeRouteDeps {
  pool: pg.Pool
  mode: ExtensionMode
  providerJwtSecret: string
  issuer: string
  now?: () => Date
  rateLimiter?: { check(key: string): { allowed: boolean; retryAfterMs?: number } }
  ackRateLimiter?: { check(key: string): { allowed: boolean; retryAfterMs?: number } }
}

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_RECEIPT_LENGTH = 512

function fail(reply: { code: (status: number) => unknown }, error: ExtensionApiError) {
  reply.code(error.httpStatus)
  // Server-controlled details nest inside the envelope.
  return { error: { code: error.code, message: error.message, ...(error.details ?? {}) } }
}

function authenticateProvider(req: FastifyRequest, deps: PurgeRouteDeps) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  return verifyProviderExtensionToken(header.slice(7), {
    secret: deps.providerJwtSecret,
    issuer: deps.issuer,
  })
}

async function observePurgePending(pool: Pick<pg.Pool, 'query'>): Promise<void> {
  try {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM extension_purge_requests WHERE status = 'pending'`,
    )
    extensionPurgePending.set(Number(result.rows[0]?.count ?? 0))
  } catch {
    // Metrics must never break the control plane.
  }
}

type PurgeAckOutcome = 'acked' | 'not_found' | 'not_ackable'

async function ackPurgeRequest(
  pool: pg.Pool,
  requestId: string,
  providerId: string,
  receipt: string | null,
): Promise<PurgeAckOutcome> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // This first read does not lock the purge row. For uninstall requests the
    // installation row must be the first acquired lock, matching
    // ExtensionInstallationRepository.revokeInstallation.
    const existing = await client.query<{
      provider_id: string
      status: string
      installation_id: string | null
      reason: string
    }>(
      `SELECT provider_id, status, installation_id, reason
       FROM extension_purge_requests WHERE request_id = $1`,
      [requestId],
    )
    const row = existing.rows[0]
    if (!row || row.provider_id !== providerId) {
      await client.query('COMMIT')
      return 'not_found'
    }

    if (row.reason === 'uninstall' && row.installation_id) {
      await client.query(
        `SELECT status
         FROM extension_installations
         WHERE installation_id = $1 AND provider_id = $2
         FOR UPDATE`,
        [row.installation_id, providerId],
      )
    }

    const acked = await client.query<{ status: string }>(
      `UPDATE extension_purge_requests
       SET status = 'acked', acked_at = NOW(), provider_receipt = COALESCE($2, provider_receipt)
       WHERE request_id = $1 AND provider_id = $3 AND status = 'pending'
       RETURNING status`,
      [requestId, receipt, providerId],
    )
    if ((acked.rowCount ?? 0) > 0) {
      if (row.reason === 'uninstall' && row.installation_id) {
        await client.query(
          `UPDATE extension_installations
           SET status = 'revoked', config_version = config_version + 1, updated_at = NOW()
           WHERE installation_id = $1 AND provider_id = $2 AND status = 'revoking'`,
          [row.installation_id, providerId],
        )
      }
      await client.query('COMMIT')
      return 'acked'
    }

    // A concurrent or previous ACK is idempotent. Re-read after the guarded
    // update so READ COMMITTED observes the committed state.
    const current = await client.query<{ provider_id: string; status: string }>(
      `SELECT provider_id, status FROM extension_purge_requests WHERE request_id = $1`,
      [requestId],
    )
    const currentRow = current.rows[0]
    if (currentRow?.provider_id === providerId && currentRow.status === 'acked') {
      if (row.reason === 'uninstall' && row.installation_id) {
        await client.query(
          `UPDATE extension_installations
           SET status = 'revoked', config_version = config_version + 1, updated_at = NOW()
           WHERE installation_id = $1 AND provider_id = $2 AND status = 'revoking'`,
          [row.installation_id, providerId],
        )
      }
      await client.query('COMMIT')
      return 'acked'
    }
    await client.query('COMMIT')
    return 'not_ackable'
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

/**
 * Provider purge queue. Ordinary feed/grant capabilities are gone once an
 * installation is revoked, but the provider service principal can still list
 * and ack its own deletion requests — the rows carry no session content.
 */
export function registerPurgeRoutes(app: FastifyInstance, deps: PurgeRouteDeps): void {
  app.get('/api/extensions/v1/purges', async (req, reply) => {
    if (deps.rateLimiter) {
      const decision = deps.rateLimiter.check(`purge:${String(req.ip ?? '-')}`)
      if (!decision.allowed) {
        reply.code(429)
        return { error: { code: 'invalid_request', message: 'rate limit exceeded' } }
      }
    }
    if (deps.mode !== 'enabled') {
      return fail(reply, new ExtensionApiError('feature_disabled', 'purges require RELAY_EXTENSIONS=enabled'))
    }
    const identity = authenticateProvider(req, deps)
    if (!identity) return fail(reply, new ExtensionApiError('unauthorized', 'provider token required'))
    const result = await deps.pool.query(
      `SELECT request_id, installation_id, reason, status, requested_at, expires_at
       FROM extension_purge_requests
       WHERE provider_id = $1 AND status = 'pending' AND expires_at > $2
       ORDER BY requested_at ASC
       LIMIT 100`,
      [identity.providerId, (deps.now ?? (() => new Date()))()],
    )
    await observePurgePending(deps.pool)
    return { purges: result.rows }
  })

  app.post('/api/extensions/v1/purges/:requestId/ack', { bodyLimit: 2048 }, async (req, reply) => {
    const ackLimiter = deps.ackRateLimiter ?? deps.rateLimiter
    if (ackLimiter) {
      const decision = ackLimiter.check(`purge-ack:${String(req.ip ?? '-')}`)
      if (!decision.allowed) {
        reply.code(429)
        return { error: { code: 'invalid_request', message: 'rate limit exceeded' } }
      }
    }
    if (deps.mode !== 'enabled') {
      return fail(reply, new ExtensionApiError('feature_disabled', 'purges require RELAY_EXTENSIONS=enabled'))
    }
    const identity = authenticateProvider(req, deps)
    if (!identity) return fail(reply, new ExtensionApiError('unauthorized', 'provider token required'))
    const params = req.params as { requestId?: string }
    const requestId = params.requestId ?? ''
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      return fail(reply, new ExtensionApiError('invalid_request', 'request id required'))
    }
    const body = req.body as Record<string, unknown> | null
    let receipt: string | null = null
    if (body?.provider_receipt !== undefined && body?.provider_receipt !== null) {
      if (typeof body.provider_receipt !== 'string' || body.provider_receipt.length > MAX_RECEIPT_LENGTH) {
        return fail(reply, new ExtensionApiError('invalid_request', 'provider_receipt must be a bounded reference'))
      }
      receipt = body.provider_receipt
    }

    // Ownership is the provider_id on the request row: a provider can only
    // ever ack its own queue, regardless of installation status.
    const outcome = await ackPurgeRequest(deps.pool, requestId, identity.providerId, receipt)
    if (outcome === 'not_found') {
      return fail(reply, new ExtensionApiError('not_found', 'purge request not found'))
    }
    if (outcome === 'not_ackable') {
      return fail(reply, new ExtensionApiError('invalid_request', 'purge request is not ackable'))
    }
    await observePurgePending(deps.pool)
    return { request_id: requestId, status: 'acked' }
  })
}
