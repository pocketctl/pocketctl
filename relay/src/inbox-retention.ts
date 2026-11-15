import type pg from 'pg'
import { sessionDocumentUploadsExpired } from './metrics.js'

const DELETE_BATCH_LIMIT = 1_000
const EXPIRED = "NOW() - INTERVAL '6 hours'"
// Team recovery uses Inbox payloads and transport receipt order after a
// disconnect. ACK alone does not retire that business evidence.
const teamProtected = (alias: string) => `EXISTS (
  SELECT 1 FROM collaboration_calls call WHERE call.native_session_id = ${alias}.session_id
    AND call.state NOT IN ('completed', 'failed', 'cancelled', 'blocked'))`
const accountingProtected = `i.event_type = 'agent_text' AND i.payload ? 'usage'
  AND EXISTS (SELECT 1 FROM token_usage_accounting_state b
    WHERE b.key = 'baseline-v1' AND i.received_at >= b.completed_at)
  AND NOT EXISTS (SELECT 1 FROM token_daily_closures c
    WHERE c.date = (i.received_at AT TIME ZONE 'UTC')::date AND c.status = 'sealed')`
const unacknowledged = `(NOT EXISTS (SELECT 1 FROM daemon_ack_checkpoint own
  WHERE own.daemon_id=i.daemon_id AND own.daemon_generation=i.daemon_generation AND own.ack_seq>=i.seq) OR EXISTS (
  SELECT 1 FROM event_inbox_receipt r LEFT JOIN daemon_ack_checkpoint c
    ON c.daemon_id = r.daemon_id AND c.daemon_generation = r.daemon_generation
  WHERE r.inbox_id = i.inbox_id AND (c.ack_seq IS NULL OR c.ack_seq < r.seq)))`
const recentReceipt = `EXISTS (SELECT 1 FROM event_inbox_receipt r WHERE r.inbox_id=i.inbox_id
  AND r.received_at >= ${EXPIRED})`
const deliveryProtected = `EXISTS (SELECT 1 FROM realtime_outbox o WHERE o.inbox_id = i.inbox_id
  AND (o.delivered_at IS NULL OR o.delivered_at >= ${EXPIRED}))`

export type RetentionStage = 'outbox' | 'receipts' | 'inbox' | 'uploads' | 'inspection'
export interface RetentionStats {
  deletedCompleted: number;
  deletedOutbox: number;
  deletedReceipts: number;
  deletedUploads: number;
  /** Bounded oldest-row sample, not a whole-table backlog count. */
  blockedUndelivered: number;
  inspected: Record<string, number>;
  failures: Array<{ stage: RetentionStage; code: string; receiptPersisted: boolean }>;
  moreWork: boolean;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown'
}

async function beginBoundedTransaction(client: pg.PoolClient): Promise<void> {
  await client.query('BEGIN')
  await client.query("SET LOCAL lock_timeout='1s'")
  // Respect a stricter pool/test budget; never widen it for GC.
  await client.query(`SELECT set_config('statement_timeout', LEAST(
    CASE WHEN setting::int = 0 THEN 5000 ELSE setting::int END, 5000)::text, true)
    FROM pg_settings WHERE name='statement_timeout'`)
}

/** Each stage commits independently. Completed transport work must not wait
 * for accounting/Team recovery, and a failing stage cannot roll back another.
 * No failure, pending work, unacknowledged transport or unsealed usage is
 * declared useless merely because it is old. */
export class InboxRetention {
  private readonly retries = new Map<RetentionStage, { at: number; failure: RetentionStats['failures'][number] }>()
  constructor(private readonly pool: pg.Pool) {}

  async runOnce(): Promise<RetentionStats> {
    const result: RetentionStats = { deletedCompleted: 0, deletedOutbox: 0, deletedReceipts: 0,
      deletedUploads: 0, blockedUndelivered: 0, inspected: {}, failures: [], moreWork: false }
    const stage = async (name: RetentionStage, work: (client: pg.PoolClient) => Promise<{ deleted: number; detail?: Record<string, number> }>) => {
      const retry = this.retries.get(name)
      if (retry && Date.now() < retry.at) {
        result.failures.push(retry.failure)
        return { deleted: 0 }
      }
      const started = new Date()
      let client: pg.PoolClient | undefined
      try {
        client = await this.pool.connect()
        await beginBoundedTransaction(client)
        const value = await work(client)
        await client.query(`INSERT INTO ingress_retention_status
          (stage,last_attempt_at,last_success_at,last_deleted,deleted_total,last_error_code,duration_ms,detail)
          VALUES($1,$2,clock_timestamp(),$3::int,$3::bigint,NULL,$4,$5::jsonb)
          ON CONFLICT(stage) DO UPDATE SET last_attempt_at=EXCLUDED.last_attempt_at,
            last_success_at=EXCLUDED.last_success_at,last_deleted=EXCLUDED.last_deleted,
            deleted_total=ingress_retention_status.deleted_total+EXCLUDED.last_deleted,
            last_error_code=NULL,duration_ms=EXCLUDED.duration_ms,detail=EXCLUDED.detail`,
        [name, started, value.deleted, Date.now()-started.getTime(), JSON.stringify(value.detail ?? {})])
        await client.query('COMMIT')
        this.retries.delete(name)
        return value
      } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => undefined)
        const failure = { stage: name, code: errorCode(error), receiptPersisted: false }
        try {
          if (client) {
            await beginBoundedTransaction(client)
            await client.query(`INSERT INTO ingress_retention_status(stage,last_attempt_at,last_error_code,duration_ms)
              VALUES($1,$2,$3,$4) ON CONFLICT(stage) DO UPDATE SET last_attempt_at=EXCLUDED.last_attempt_at,
              last_error_code=EXCLUDED.last_error_code,duration_ms=EXCLUDED.duration_ms`,
            [name, started, failure.code, Date.now()-started.getTime()])
            await client.query('COMMIT')
            failure.receiptPersisted = true
          }
        } catch {
          if (client) await client.query('ROLLBACK').catch(() => undefined)
          // Return the unpersisted failure to the runtime log.
        }
        this.retries.set(name, { at: Date.now() + 60_000, failure })
        result.failures.push(failure)
        return { deleted: 0 }
      } finally { client?.release() }
    }

    result.deletedOutbox = (await stage('outbox', async client => {
      const deleted = await client.query(`WITH expired AS (
        SELECT o.outbox_id FROM realtime_outbox o JOIN event_inbox i USING(inbox_id)
        WHERE o.delivered_at < ${EXPIRED} AND i.status = 2
        ORDER BY o.delivered_at, o.outbox_id LIMIT $1 FOR UPDATE OF o SKIP LOCKED
      ) DELETE FROM realtime_outbox o USING expired e WHERE o.outbox_id=e.outbox_id`, [DELETE_BATCH_LIMIT])
      return { deleted: deleted.rowCount ?? 0 }
    })).deleted

    result.deletedReceipts = (await stage('receipts', async client => {
      const deleted = await client.query(`WITH expired AS (
        SELECT r.receipt_id FROM event_inbox_receipt r
        JOIN daemon_ack_checkpoint c ON c.daemon_id=r.daemon_id AND c.daemon_generation=r.daemon_generation
        LEFT JOIN event_inbox i ON i.inbox_id=r.inbox_id
        WHERE c.ack_seq >= r.seq AND r.received_at < ${EXPIRED}
          AND (r.inbox_id IS NULL OR (i.status = 2 AND NOT ${teamProtected('i')}))
        ORDER BY r.received_at,r.receipt_id LIMIT $1 FOR UPDATE OF r SKIP LOCKED
      ) DELETE FROM event_inbox_receipt r USING expired e WHERE r.receipt_id=e.receipt_id`, [DELETE_BATCH_LIMIT])
      return { deleted: deleted.rowCount ?? 0 }
    })).deleted

    result.deletedCompleted = (await stage('inbox', async client => {
      const eligible = `i.status = 2 AND i.completed_at < ${EXPIRED}
        AND NOT (${accountingProtected}) AND NOT ${deliveryProtected}
        AND NOT ${unacknowledged} AND NOT ${recentReceipt} AND NOT ${teamProtected('i')}`
      const candidates = await client.query<{inbox_id: string}>(`SELECT i.inbox_id FROM event_inbox i
        WHERE ${eligible} ORDER BY i.completed_at,i.inbox_id LIMIT $1 FOR UPDATE OF i SKIP LOCKED`, [DELETE_BATCH_LIMIT])
      if (!candidates.rows.length) return {deleted: 0}
      // New statement snapshot AFTER parent locks: a receipt committed between
      // discovery and locking must be rechecked before ON DELETE CASCADE.
      // These locks prevent further FK inserts until this transaction commits.
      const deleted = await client.query(`DELETE FROM event_inbox i WHERE i.inbox_id=ANY($1::bigint[])
        AND ${eligible}`, [candidates.rows.map(row => row.inbox_id)])
      return { deleted: deleted.rowCount ?? 0 }
    })).deleted

    result.deletedUploads = (await stage('uploads', async client => {
      const deleted = await client.query(`DELETE FROM session_document_uploads WHERE version_id IN (
        SELECT version_id FROM session_document_uploads WHERE expires_at <= NOW()
        ORDER BY expires_at,version_id LIMIT $1 FOR UPDATE SKIP LOCKED)`, [DELETE_BATCH_LIMIT])
      return { deleted: deleted.rowCount ?? 0 }
    })).deleted
    sessionDocumentUploadsExpired.inc(result.deletedUploads)

    const inspection = await stage('inspection', async client => {
      // At most 1,000 oldest rows per state. No recurring full payload scan.
      // Counts use one exclusive reason each; age alone does not authorize GC.
      const rows = await client.query<{ reason: string; count: number }>(`WITH oldest AS MATERIALIZED (
        SELECT i.* FROM (VALUES(0),(1),(2),(3)) states(status)
        CROSS JOIN LATERAL (SELECT * FROM event_inbox i WHERE i.status=states.status
          ORDER BY received_at,inbox_id LIMIT $1) i
      ) SELECT reason,count(*)::int count FROM (
        SELECT CASE WHEN i.status=0 THEN 'pending' WHEN i.status=1 THEN 'processing'
          WHEN i.status=3 THEN 'failed_requires_review'
          WHEN i.completed_at IS NULL THEN 'missing_completion_time'
          WHEN i.completed_at >= ${EXPIRED} THEN 'within_retention'
          WHEN ${teamProtected('i')} THEN 'team_recovery'
          WHEN (${accountingProtected}) THEN 'accounting_unsealed'
          WHEN ${unacknowledged} THEN 'receipt_unacknowledged'
          WHEN ${recentReceipt} THEN 'receipt_within_retention'
          WHEN EXISTS(SELECT 1 FROM realtime_outbox o WHERE o.inbox_id=i.inbox_id AND o.delivered_at IS NULL) THEN 'undelivered'
          WHEN ${deliveryProtected} THEN 'delivery_within_retention'
          ELSE 'eligible' END reason FROM oldest i
      ) reasons GROUP BY reason`, [DELETE_BATCH_LIMIT])
      return { deleted: 0, detail: Object.fromEntries(rows.rows.map(row => [row.reason, row.count])) }
    })
    result.inspected = inspection.detail ?? {}
    result.blockedUndelivered = result.inspected.undelivered ?? 0
    result.moreWork = [result.deletedCompleted,result.deletedOutbox,result.deletedReceipts,result.deletedUploads]
      .some(count => count === DELETE_BATCH_LIMIT)
    return result
  }
}
