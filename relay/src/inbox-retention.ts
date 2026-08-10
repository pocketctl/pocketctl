import type pg from 'pg'

const COMPLETED_RETENTION_HOURS = 6
const DELETE_BATCH_LIMIT = 1_000

export interface RetentionStats {
  deletedCompleted: number;
  blockedUndelivered: number;
}

export class InboxRetention {
  constructor(private readonly pool: pg.Pool) {}

  async runOnce(): Promise<RetentionStats> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const blocked = await client.query<{ blocked_undelivered: number }>(
        `SELECT COUNT(*)::int AS blocked_undelivered
         FROM event_inbox i
         WHERE i.status = 2
           AND i.completed_at < NOW() - INTERVAL '${COMPLETED_RETENTION_HOURS} hours'
           AND EXISTS (
             SELECT 1
             FROM realtime_outbox o
             WHERE o.inbox_id = i.inbox_id
               AND o.delivered_at IS NULL
           )`,
      )
      const deleted = await client.query(
        `WITH expired AS (
           SELECT i.inbox_id
           FROM event_inbox i
           WHERE i.status = 2
             AND i.completed_at < NOW() - INTERVAL '${COMPLETED_RETENTION_HOURS} hours'
             AND (
               i.event_type <> 'agent_text'
               OR NOT (i.payload ? 'usage')
               OR NOT EXISTS (
                 SELECT 1 FROM token_usage_accounting_state baseline
                 WHERE baseline.key = 'baseline-v1'
                   AND i.received_at >= baseline.completed_at
               )
               OR EXISTS (
                 SELECT 1 FROM token_daily_closures closure
                 WHERE closure.date = (i.received_at AT TIME ZONE 'UTC')::date
                   AND closure.status = 'sealed'
               )
             )
             AND NOT EXISTS (
               SELECT 1
               FROM realtime_outbox o
               WHERE o.inbox_id = i.inbox_id
                 AND o.delivered_at IS NULL
             )
           ORDER BY i.completed_at, i.inbox_id
           FOR UPDATE OF i SKIP LOCKED
           LIMIT $1
         )
         DELETE FROM event_inbox i
         USING expired
         WHERE i.inbox_id = expired.inbox_id`,
        [DELETE_BATCH_LIMIT],
      )
      await client.query(
        `WITH expired AS (
           SELECT r.receipt_id
           FROM event_inbox_receipt r
           JOIN daemon_ack_checkpoint c
             ON c.daemon_id = r.daemon_id
            AND c.daemon_generation = r.daemon_generation
           WHERE r.inbox_id IS NULL
             AND c.ack_seq >= r.seq
             AND r.received_at < NOW() - INTERVAL '${COMPLETED_RETENTION_HOURS} hours'
           ORDER BY r.received_at, r.receipt_id
           FOR UPDATE OF r SKIP LOCKED
           LIMIT $1
         )
         DELETE FROM event_inbox_receipt r
         USING expired
         WHERE r.receipt_id = expired.receipt_id`,
        [DELETE_BATCH_LIMIT],
      )
      await client.query('COMMIT')
      return {
        deletedCompleted: deleted.rowCount ?? 0,
        blockedUndelivered: Number(blocked.rows[0]?.blocked_undelivered ?? 0),
      }
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Preserve the cleanup failure.
      }
      throw error
    } finally {
      client.release()
    }
  }
}
