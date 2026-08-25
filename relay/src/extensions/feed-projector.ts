import type pg from 'pg'
import { buildStoredFeedPayload, type ExtensionSourceRow } from './envelope.js'
import {
  claimSourceBatch,
  deleteSourceRows,
  insertFeedRows,
  type FeedInsertRow,
} from './feed-repository.js'
import {
  extensionFeedProjected,
  extensionProjectorBatchSize,
  extensionProjectorLagSeconds,
  extensionProjectorRetries,
  extensionSourceBacklog,
} from '../metrics.js'

const PROJECTOR_LOCK_KEY = 'relay-extension-feed-projector'

export interface FeedProjectorBatchResult {
  projected: number
  skipped: boolean
}

/**
 * One projector batch inside a single transaction:
 *
 * 1. pg_try_advisory_xact_lock — multi-worker deployments stay single-active;
 * 2. claim source rows FOR UPDATE SKIP LOCKED in source_seq order;
 * 3. map to envelopes in memory (pure, no network, no installation lookups);
 * 4. insert feed rows ON CONFLICT DO NOTHING (idempotent retry);
 * 5. delete the projected source rows and commit atomically.
 *
 * A crash at any point rolls back, so the same source identity simply
 * retries later — RPO 0, no silent skips.
 */
export async function projectFeedBatch(
  pool: pg.Pool,
  options: { batchSize: number },
): Promise<FeedProjectorBatchResult> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const lock = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired`,
      [PROJECTOR_LOCK_KEY],
    )
    if (lock.rows[0]?.acquired !== true) {
      await client.query('COMMIT')
      return { projected: 0, skipped: true }
    }
    try {
      const { rows } = await claimSourceBatch(client, options.batchSize)
      const feedRows: Array<FeedInsertRow & { topicLabel: string }> = rows.map((row: ExtensionSourceRow) => {
        const stored = buildStoredFeedPayload(row)
        return {
          owner_user_id: Number(row.owner_user_id),
          topic: stored.topic,
          topicLabel: stored.topic,
          source_kind: row.source_kind,
          source_id: row.source_id,
          session_id: row.session_id,
          turn_id: stored.subject.turn_id ?? null,
          envelope: stored as unknown as Record<string, unknown>,
        }
      })
      if (rows.length > 0) {
        await insertFeedRows(client, feedRows)
        await deleteSourceRows(client, rows.map(row => row.source_seq))
      }
      await client.query('COMMIT')
      // Count only after the commit lands: a failed batch must not inflate
      // the projected totals.
      if (rows.length > 0) {
        extensionProjectorBatchSize.observe(rows.length)
        for (const row of feedRows) {
          extensionFeedProjected.inc({ topic: row.topicLabel, result: 'projected' })
        }
      }
      return { projected: rows.length, skipped: false }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    }
  } finally {
    client.release()
  }
}

/** Post-batch observability: bounded backlog and lag gauges. */
export async function observeProjectorBacklog(
  pool: Pick<pg.Pool, 'query'>,
): Promise<void> {
  const result = await pool.query<{ count: string; oldest: string | null }>(`
    SELECT COUNT(*)::text AS count,
           COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::bigint::text, '0') AS oldest
    FROM extension_source_outbox
  `)
  extensionSourceBacklog.set(Number(result.rows[0]?.count ?? 0))
  extensionProjectorLagSeconds.set(Number(result.rows[0]?.oldest ?? 0))
}

export function recordProjectorRetry(outcome: string): void {
  extensionProjectorRetries.inc({ outcome })
}
