import type { FastifyInstance, FastifyRequest } from 'fastify'
import type pg from 'pg'
import { verifyProviderExtensionToken } from './provider-auth.js'
import { ExtensionApiError } from './errors.js'
import { decodeDeliveryWithdrawalCursor, encodeDeliveryWithdrawalCursor, leaseBindingHash, newLeaseToken } from './cursor.js'
import type { FeedRouteDeps } from './feed-routes.js'

const endpoint = '/api/extensions/v1/team-delivery-withdrawals'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const binding = (consumer: string, epoch: string, token: string, sequence: string) => leaseBindingHash({
  installationId: `delivery-withdrawal:${consumer}`, leaseEpoch: epoch, leaseToken: token, cursorFeedId: sequence,
})

/** First-party, content-free invalidation only. No user/installation grants and
 * no capture flag: disabling capture must never disable outstanding cleanup. */
export function registerDeliveryWithdrawalRoutes(app: FastifyInstance, deps: FeedRouteDeps): void {
  const ttl = Math.min(300, Math.max(1, deps.leaseTtlSeconds))
  async function authenticate(req: FastifyRequest) {
    if (deps.mode !== 'enabled') throw new ExtensionApiError('feature_disabled', 'extension controls disabled')
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : ''
    const identity = verifyProviderExtensionToken(token, { secret: deps.providerJwtSecret, issuer: deps.issuer })
    if (!identity) throw new ExtensionApiError('unauthorized', 'provider token required')
    if (!uuid.test(identity.credentialId)) throw new ExtensionApiError('unauthorized', 'provider credential unavailable')
    if (identity.providerId !== 'pocketctl-memory') throw new ExtensionApiError('forbidden', 'first-party Memory control stream required')
    const active = await deps.pool.query(`SELECT 1 FROM extension_provider_credentials c JOIN extension_providers p USING(provider_id)
      WHERE c.credential_id=$1 AND c.provider_id='pocketctl-memory' AND c.status='active' AND p.status='enabled'
        AND (c.expires_at IS NULL OR c.expires_at>clock_timestamp())`, [identity.credentialId])
    if (!active.rowCount) throw new ExtensionApiError('unauthorized', 'provider credential unavailable')
  }
  async function transaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await deps.pool.connect()
    try { await client.query('BEGIN'); const result = await run(client); await client.query('COMMIT'); return result }
    catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  function failure(error: unknown, reply: { code(n: number): unknown }) {
    if (!(error instanceof ExtensionApiError)) throw error
    reply.code(error.httpStatus); return { error: { code: error.code, message: error.message } }
  }
  app.get(endpoint, async (req, reply) => {
    const rate = deps.rateLimiter?.check(`delivery-withdrawals:${req.ip}`)
    if (rate && !rate.allowed) return reply.code(429).send({ error: { code: 'invalid_request', message: 'rate limit exceeded' } })
    try {
      await authenticate(req)
      const query = req.query as Record<string, unknown>, consumer = query.consumer_id
      if (typeof consumer !== 'string' || !uuid.test(consumer)) throw new ExtensionApiError('invalid_request', 'consumer_id required')
      const requested = Number(query.limit ?? 100)
      if (!Number.isSafeInteger(requested) || requested < 1) throw new ExtensionApiError('invalid_request', 'invalid limit')
      const replayAfter = query.after_sequence
      if (replayAfter !== undefined && (typeof replayAfter !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(replayAfter)
        || BigInt(replayAfter) > 9223372036854775807n)) throw new ExtensionApiError('invalid_request', 'invalid replay position')
      const limit = Math.min(100, requested)
      return await transaction(async client => {
        await client.query('INSERT INTO team_delivery_memory_consumers(consumer_id) VALUES($1) ON CONFLICT DO NOTHING', [consumer])
        const checkpoint = (await client.query(`SELECT ack_sequence::text,lease_epoch::text FROM team_delivery_memory_consumers
          WHERE consumer_id=$1 FOR UPDATE`, [consumer])).rows[0]
        const after = replayAfter !== undefined && BigInt(replayAfter as string) < BigInt(checkpoint.ack_sequence) ? replayAfter as string : checkpoint.ack_sequence
        const rows = (await client.query(`SELECT sequence::text,team_id,team_session_id,submission_id::text,decision_id::text,recorded_at
          FROM team_delivery_memory_withdrawals WHERE sequence>$1 ORDER BY sequence LIMIT $2`, [after, limit])).rows
        const sequence = rows.at(-1)?.sequence ?? after
        const epoch = (BigInt(checkpoint.lease_epoch) + 1n).toString(), lease = newLeaseToken()
        const expires = new Date(Date.now() + ttl * 1000)
        const cursor = encodeDeliveryWithdrawalCursor({ v: 1, consumer_id: consumer, sequence, lease_epoch: epoch, exp: Math.floor(expires.getTime() / 1000) }, deps.cursorSecret)
        await client.query(`UPDATE team_delivery_memory_consumers SET lease_epoch=$2,lease_hash=$3,lease_expires_at=$4,updated_at=clock_timestamp()
          WHERE consumer_id=$1`, [consumer, epoch, binding(consumer, epoch, lease, sequence), expires])
        return { version: 1, consumer_id: consumer, items: rows.map(row => ({ sequence: row.sequence, team_id: row.team_id,
          team_session_id: row.team_session_id, submission_id: row.submission_id, decision_id: row.decision_id, recorded_at: row.recorded_at.toISOString() })),
          through_sequence: sequence, next_cursor: cursor, lease_token: lease, lease_expires_at: expires.toISOString() }
      })
    } catch (error) { return failure(error, reply) }
  })
  app.post(`${endpoint}/ack`, { bodyLimit: 4096 }, async (req, reply) => {
    const rate = deps.ackRateLimiter?.check(`delivery-withdrawals-ack:${req.ip}`)
    if (rate && !rate.allowed) return reply.code(429).send({ error: { code: 'invalid_request', message: 'rate limit exceeded' } })
    try {
      await authenticate(req)
      const body = req.body as Record<string, unknown> | null
      if (!body || typeof body.consumer_id !== 'string' || !uuid.test(body.consumer_id)
        || typeof body.cursor !== 'string' || typeof body.lease_token !== 'string' || body.lease_token.length > 128) {
        throw new ExtensionApiError('invalid_request', 'consumer, cursor and lease required')
      }
      const consumer = body.consumer_id, cursor = decodeDeliveryWithdrawalCursor(body.cursor, deps.cursorSecret)
      if (!cursor || cursor.consumer_id !== consumer) throw new ExtensionApiError('cursor_expired', 'withdrawal cursor expired or mismatched')
      const hash = binding(consumer, cursor.lease_epoch, body.lease_token, cursor.sequence)
      const result = await deps.pool.query(`UPDATE team_delivery_memory_consumers SET ack_sequence=GREATEST(ack_sequence,$2::bigint),updated_at=clock_timestamp()
        WHERE consumer_id=$1 AND lease_epoch=$3 AND lease_hash=$4 AND lease_expires_at>clock_timestamp()
        RETURNING ack_sequence::text`, [consumer, cursor.sequence, cursor.lease_epoch, hash])
      if (!result.rowCount) throw new ExtensionApiError('stale_lease', 'withdrawal lease no longer current')
      return { ack_sequence: result.rows[0].ack_sequence }
    } catch (error) { return failure(error, reply) }
  })
}
