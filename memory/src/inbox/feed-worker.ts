import type pg from 'pg'
import type { FeedBatch } from '../relay/contracts.js'
import { classifyEnvelope } from '../relay/validation.js'
import { RelayRequestError } from '../relay/errors.js'
import { createInboxRepository, FeedIntegrityError } from './repository.js'
import { createScopeControlProjector } from '../governance/membership-projector.js'

export interface FeedConsumerOptions {
  pool: pg.Pool
  pullFeed(installationId: string, limit: number): Promise<FeedBatch>
  ackFeed(input: { installation_id: string; cursor: string; lease_token: string }): Promise<number>
  workerId: string
  signal: AbortSignal
  batchLimit?: number
  pollLeaseMs?: number
  onError?(error: unknown): void
  /** Optional v2 scope-control stream; absent keeps the consumer v1-only. */
  pullScopeControlFeed?(installationId: string, limit: number): Promise<unknown>
  ackScopeControlFeed?(input: { installation_id: string; cursor: string; lease_token: string }): Promise<number>
}

const DEFAULT_BATCH_LIMIT = 100
const DEFAULT_POLL_LEASE_MS = 30_000

/**
 * Feed consumer loop: per-installation local poll lease → pull → classify →
 * single-transaction durable commit → ack with the in-memory cursor/lease.
 * Typed failures recover per the frozen contract: stale leases re-pull from
 * the checkpoint, hard-retention cursor expiry schedules a snapshot
 * reconcile, paused/revoked/integrity-error installations are not pulled.
 */
export function createFeedConsumer(options: FeedConsumerOptions) {
  const inbox = createInboxRepository(options.pool)
  const batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT
  const pollLeaseMs = options.pollLeaseMs ?? DEFAULT_POLL_LEASE_MS
  let currentPass: Promise<{ installations: number }> | undefined

  async function acquirePollLease(installationId: string): Promise<boolean> {
    const result = await options.pool.query(`
      UPDATE memory_installations
      SET poll_owner = $2, poll_epoch = poll_epoch + 1,
          poll_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'), updated_at = NOW()
      WHERE installation_id = $1
        AND local_status NOT IN ('purging', 'purged', 'integrity_error')
        AND relay_status IN ('pending', 'active')
        AND (poll_expires_at IS NULL OR poll_expires_at < NOW() OR poll_owner = $2)
    `, [installationId, options.workerId, pollLeaseMs])
    return (result.rowCount ?? 0) > 0
  }

  async function consumeOne(installationId: string): Promise<boolean> {
    if (!(await acquirePollLease(installationId))) return false
    let pulled: FeedBatch
    try {
      pulled = await options.pullFeed(installationId, batchLimit)
    } catch (error) {
      if (error instanceof RelayRequestError) {
        if (error.code === 'cursor_expired' && error.snapshotRequired) {
          await options.pool.query(`
            UPDATE memory_installations
            SET snapshot_required = TRUE, updated_at = NOW()
            WHERE installation_id = $1
          `, [installationId])
          await options.pool.query(`
            INSERT INTO memory_jobs (job_id, installation_id, job_type, idempotency_key, priority, payload)
            VALUES (gen_random_uuid(), $1, 'snapshot_reconcile', $2, 20, '{}'::jsonb)
            ON CONFLICT DO NOTHING
          `, [installationId, `snapshot:${installationId}`])
          return true
        }
        // stale_lease / plain cursor expiry / transient relay failures: the
        // next pass re-pulls from the Relay checkpoint. Nothing is stored.
        return true
      }
      throw error
    }

    const accepted: FeedBatch['items'] = []
    const quarantined: Array<{ feed_id: string; error_code: 'unsupported_envelope_version' | 'invalid_envelope'; raw: unknown }> = []
    let hasUnaddressableEnvelope = false
    for (const item of pulled.items) {
      const decision = classifyEnvelope(item)
      if (decision.kind === 'accepted') accepted.push(decision.envelope)
      else {
        const rawFeedId = (item as { feed_id?: unknown }).feed_id
        const feedId = typeof rawFeedId === 'string' && /^[1-9][0-9]*$/.test(rawFeedId)
          ? rawFeedId
          : null
        if (feedId) {
          quarantined.push({ feed_id: feedId, error_code: decision.errorCode, raw: { redacted: true } })
        } else {
          hasUnaddressableEnvelope = true
        }
      }
    }
    if (hasUnaddressableEnvelope) {
      throw new Error('unaddressable feed envelope: batch was not committed or acknowledged')
    }

    await inbox.commitBatch({
      installationId,
      envelopes: accepted,
      rawQuarantined: quarantined,
      cursor: pulled.next_cursor,
      leaseToken: pulled.lease_token,
      ack: input => options.ackFeed(input),
    }).catch(error => {
      if (error instanceof FeedIntegrityError) {
        // The installation is already fenced; rethrow nothing — the next
        // pass skips it because of the integrity_error local status.
        return
      }
      throw error
    })
    return true
  }

  const scopeControlProjector = options.pullScopeControlFeed && options.ackScopeControlFeed
    ? createScopeControlProjector({
        pool: options.pool,
        workerId: options.workerId,
        pullScopeControlFeed: options.pullScopeControlFeed,
        ackScopeControlFeed: options.ackScopeControlFeed,
        batchLimit,
        onError: options.onError,
      })
    : null

  return {
    async runOnce(): Promise<{ installations: number }> {
      if (currentPass) return currentPass
      currentPass = (async () => {
        if (options.signal.aborted) return { installations: 0 }
        if (scopeControlProjector) {
          try {
            await scopeControlProjector.runOnce()
          } catch (error) {
            options.onError?.(error)
          }
        }
        const rows = await options.pool.query<{ installation_id: string }>(`
          SELECT installation_id FROM memory_installations
          WHERE relay_status IN ('pending', 'active')
            AND local_status IN ('discovering', 'syncing', 'ready', 'degraded')
            AND snapshot_required = FALSE
          ORDER BY created_at ASC
        `)
        let installations = 0
        for (const row of rows.rows) {
          if (options.signal.aborted) break
          try {
            if (await consumeOne(row.installation_id)) installations++
          } catch (error) {
            // One malformed or unavailable installation must not starve the
            // rest of the provider inventory. Its batch remains unacked and
            // will be retried on the next pass.
            options.onError?.(error)
          }
        }
        return { installations }
      })().finally(() => {
        currentPass = undefined
      })
      return currentPass
    },
  }
}

export type FeedConsumer = ReturnType<typeof createFeedConsumer>
