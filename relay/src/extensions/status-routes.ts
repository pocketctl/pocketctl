import type { FastifyInstance, FastifyRequest } from 'fastify'
import type pg from 'pg'
import type { ExtensionMode } from './types.js'
import { ExtensionApiError } from './errors.js'
import { verifyProviderExtensionToken } from './provider-auth.js'
import { boundedProviderLabel, extensionProviderStatusReports } from '../metrics.js'

export interface StatusRouteDeps {
  pool: pg.Pool
  mode: ExtensionMode
  providerJwtSecret: string
  issuer: string
  verifyAccessToken(token: string): Promise<{ userId: number } | null>
  /** Heartbeat TTL used to derive offline; never persisted as a state. */
  offlineAfterSeconds?: number
  rateLimiter?: { check(key: string): { allowed: boolean; retryAfterMs?: number } }
}

const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATUS_STATES = ['ready', 'syncing', 'degraded', 'error'] as const
const MAX_STRING = 64
const DEFAULT_OFFLINE_AFTER_SECONDS = 300

type ProviderAuth = { providerId: string } | null

function authenticateProvider(req: FastifyRequest, deps: StatusRouteDeps): ProviderAuth {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  return verifyProviderExtensionToken(header.slice(7), {
    secret: deps.providerJwtSecret,
    issuer: deps.issuer,
  })
}

function fail(reply: { code: (status: number) => unknown }, error: ExtensionApiError) {
  reply.code(error.httpStatus)
  // Server-controlled details nest inside the envelope.
  return { error: { code: error.code, message: error.message, ...(error.details ?? {}) } }
}

function parseOptionalCount(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return NaN as never
  return value
}

/**
 * Provider status is a last-known-snapshot, never a Relay health input. The
 * body allowlist is closed: no error message, stack, prompt or content.
 */
export function registerStatusRoutes(app: FastifyInstance, deps: StatusRouteDeps): void {
  app.post('/api/extensions/v1/status', { bodyLimit: 4096 }, async (req, reply) => {
    if (deps.rateLimiter) {
      const decision = deps.rateLimiter.check(`status:${String(req.ip ?? '-')}`)
      if (!decision.allowed) {
        reply.code(429)
        return { error: { code: 'invalid_request', message: 'rate limit exceeded' } }
      }
    }
    if (deps.mode !== 'enabled') {
      return fail(reply, new ExtensionApiError('feature_disabled', 'status requires RELAY_EXTENSIONS=enabled'))
    }
    const identity = authenticateProvider(req, deps)
    if (!identity) return fail(reply, new ExtensionApiError('unauthorized', 'provider token required'))
    const body = req.body as Record<string, unknown> | null
    const installationId = typeof body?.installation_id === 'string' ? body.installation_id : ''
    if (!INSTALLATION_ID_PATTERN.test(installationId)) {
      return fail(reply, new ExtensionApiError('invalid_request', 'installation_id required'))
    }
    const state = body?.state
    if (typeof state !== 'string' || !(STATUS_STATES as readonly string[]).includes(state)) {
      return fail(reply, new ExtensionApiError('invalid_request', 'state must be ready|syncing|degraded|error'))
    }
    const providerVersion = body?.provider_version
    if (typeof providerVersion !== 'string' || providerVersion.length === 0
      || providerVersion.length > MAX_STRING) {
      return fail(reply, new ExtensionApiError('invalid_request', 'provider_version required (<=64 chars)'))
    }
    const counts = {
      last_feed_id: parseOptionalCount(body?.last_feed_id),
      feed_lag_seconds: parseOptionalCount(body?.feed_lag_seconds),
      pending_jobs: parseOptionalCount(body?.pending_jobs),
      failed_jobs_24h: parseOptionalCount(body?.failed_jobs_24h),
    }
    for (const value of Object.values(counts)) {
      if (value !== null && !Number.isSafeInteger(value)) {
        return fail(reply, new ExtensionApiError('invalid_request', 'counters must be non-negative integers'))
      }
    }
    const lastError = body?.last_error_code
    if (lastError !== undefined && lastError !== null
      && (typeof lastError !== 'string' || lastError.length > MAX_STRING)) {
      return fail(reply, new ExtensionApiError('invalid_request', 'last_error_code must be a bounded code'))
    }
    // Free-text diagnostics (message/stack/prompt/body) are not accepted.
    for (const forbidden of ['error_message', 'message', 'stack', 'prompt']) {
      if (body && forbidden in body) {
        return fail(reply, new ExtensionApiError('invalid_request', `${forbidden} is not accepted`))
      }
    }
    let lastExtractAt: Date | null = null
    if (body?.last_extract_at !== undefined && body?.last_extract_at !== null) {
      const parsed = new Date(String(body.last_extract_at))
      if (Number.isNaN(parsed.getTime())) {
        return fail(reply, new ExtensionApiError('invalid_request', 'last_extract_at must be an ISO timestamp'))
      }
      lastExtractAt = parsed
    }

    const result = await deps.pool.query(
      `INSERT INTO extension_provider_status
         (installation_id, provider_version, state, last_feed_id, feed_lag_seconds,
          pending_jobs, failed_jobs_24h, last_extract_at, last_error_code, reported_at)
       SELECT $1, $3, $4, $5, $6, $7, $8, $9, $10, NOW()
       WHERE EXISTS (
         SELECT 1 FROM extension_installations
         WHERE installation_id = $1 AND provider_id = $2
           AND status IN ('pending', 'active', 'paused')
       )
       ON CONFLICT (installation_id) DO UPDATE SET
         provider_version = EXCLUDED.provider_version,
         state = EXCLUDED.state,
         last_feed_id = EXCLUDED.last_feed_id,
         feed_lag_seconds = EXCLUDED.feed_lag_seconds,
         pending_jobs = EXCLUDED.pending_jobs,
         failed_jobs_24h = EXCLUDED.failed_jobs_24h,
         last_extract_at = EXCLUDED.last_extract_at,
         last_error_code = EXCLUDED.last_error_code,
         reported_at = NOW()`,
      [
        installationId, identity.providerId, providerVersion, state,
        counts.last_feed_id, counts.feed_lag_seconds, counts.pending_jobs, counts.failed_jobs_24h,
        lastExtractAt, lastError ?? null,
      ],
    )
    if ((result.rowCount ?? 0) === 0) {
      extensionProviderStatusReports.inc({ provider: boundedProviderLabel(identity.providerId), result: 'rejected' })
      return fail(reply, new ExtensionApiError('not_found', 'installation not found'))
    }
    extensionProviderStatusReports.inc({ provider: boundedProviderLabel(identity.providerId), result: 'accepted' })
    return { installation_id: installationId, state }
  })

  // User view: latest snapshot per installation with offline derived from
  // the heartbeat TTL; never written back to the status table.
  app.get('/api/extensions/v1/status', async (req, reply) => {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      return fail(reply, new ExtensionApiError('unauthorized', 'authorization required'))
    }
    const payload = await deps.verifyAccessToken(header.slice(7))
    if (!payload) return fail(reply, new ExtensionApiError('unauthorized', 'invalid token'))
    const offlineAfter = (deps.offlineAfterSeconds ?? DEFAULT_OFFLINE_AFTER_SECONDS) * 1000
    const result = await deps.pool.query(
      `SELECT i.installation_id, i.provider_id, i.status AS installation_status,
              s.provider_version, s.state, s.last_feed_id, s.feed_lag_seconds,
              s.pending_jobs, s.failed_jobs_24h, s.last_extract_at, s.last_error_code,
              s.reported_at
       FROM extension_installations i
       LEFT JOIN extension_provider_status s ON s.installation_id = i.installation_id
       WHERE i.owner_user_id = $1
       ORDER BY i.created_at ASC`,
      [payload.userId],
    )
    const installations = result.rows.map((row: Record<string, unknown>) => ({
      installation_id: row.installation_id,
      provider_id: row.provider_id,
      installation_status: row.installation_status,
      provider_version: row.provider_version ?? null,
      state: row.reported_at
        ? (new Date(String(row.reported_at)).getTime() + offlineAfter < Date.now() ? 'offline' : row.state)
        : 'offline',
      last_feed_id: row.last_feed_id ?? null,
      feed_lag_seconds: row.feed_lag_seconds ?? null,
      pending_jobs: row.pending_jobs ?? null,
      failed_jobs_24h: row.failed_jobs_24h ?? null,
      last_extract_at: row.last_extract_at ?? null,
      last_error_code: row.last_error_code ?? null,
      reported_at: row.reported_at ?? null,
    }))
    return { installations }
  })
}
