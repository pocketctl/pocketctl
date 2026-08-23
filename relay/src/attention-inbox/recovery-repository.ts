import { randomUUID } from 'node:crypto'
import type pg from 'pg'

import type { AttentionRecoveryRecord } from './types.js'

type PoolLike = Pick<pg.Pool, 'connect' | 'query'>

function dateValue(value: unknown): Date | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value : new Date(String(value))
}

export function mapAttentionRecoveryRow(row: Record<string, any>): AttentionRecoveryRecord {
  return {
    recoveryId: row.recovery_id,
    userId: Number(row.user_id),
    daemonId: row.daemon_id,
    registrationGeneration: row.registration_generation,
    state: row.state,
    revision: Number(row.revision),
    reasonCode: 'daemon_offline',
    daemonDisplayName: row.daemon_display_name || row.daemon_id,
    lastSeenAt: dateValue(row.last_seen_at) ?? new Date(0),
    seenAt: dateValue(row.seen_at),
    snoozedUntil: dateValue(row.snoozed_until),
    resolvedAt: dateValue(row.resolved_at),
    handledAt: dateValue(row.handled_at),
    resolution: row.resolution ?? null,
    createdAt: dateValue(row.created_at) ?? new Date(0),
    updatedAt: dateValue(row.updated_at) ?? new Date(0),
  }
}

export type RecoveryProjectionResult =
  | { outcome: 'created' | 'updated'; item: AttentionRecoveryRecord }
  | { outcome: 'noop' }

export class AttentionRecoveryRepository {
  constructor(private readonly pool: PoolLike) {}

  async recordConfirmedOffline(input: {
    userId: number
    daemonId: string
    registrationGeneration: string
    daemonDisplayName: string
  }): Promise<RecoveryProjectionResult> {
    const result = await this.pool.query(
      `WITH changed AS (
         INSERT INTO attention_recovery_items (
           recovery_id, user_id, daemon_id, registration_generation, state,
           daemon_display_name, last_seen_at, created_at, updated_at
         )
         SELECT $1, $2, daemon.daemon_id, $4::varchar, 'open',
                LEFT(COALESCE(NULLIF($5::text, ''), daemon.alias, daemon.hostname, daemon.daemon_id), 255),
                COALESCE(daemon.last_heartbeat, daemon.created_at, NOW()), NOW(), NOW()
         FROM daemons AS daemon
         WHERE daemon.daemon_id = $3
           AND daemon.user_id = $2
           AND daemon.status = 'offline'
           AND daemon.registration_id = $4::varchar
         ON CONFLICT (user_id, daemon_id, registration_generation) DO UPDATE SET
           daemon_display_name = EXCLUDED.daemon_display_name,
           last_seen_at = EXCLUDED.last_seen_at,
           revision = attention_recovery_items.revision + 1,
           updated_at = NOW()
         WHERE attention_recovery_items.state <> 'resolved'
           AND (attention_recovery_items.daemon_display_name, attention_recovery_items.last_seen_at)
             IS DISTINCT FROM (EXCLUDED.daemon_display_name, EXCLUDED.last_seen_at)
         RETURNING attention_recovery_items.*, (xmax = 0) AS inserted
       )
       SELECT changed.*,
         pg_notify('pocketctl_attention', json_build_object(
           'entity', 'recovery', 'user_id', user_id, 'item_id', recovery_id,
           'revision', revision, 'operation', 'changed'
         )::text)
       FROM changed`,
      [randomUUID(), input.userId, input.daemonId, input.registrationGeneration, input.daemonDisplayName],
    )
    const row = result.rows[0]
    if (!row) return { outcome: 'noop' }
    return {
      outcome: row.inserted === true ? 'created' : 'updated',
      item: mapAttentionRecoveryRow(row),
    }
  }

  async recordConfirmedOnline(input: {
    userId: number
    daemonId: string
    registrationGeneration: string
  }): Promise<{ resolved: number; quickResolved: number }> {
    const result = await this.pool.query(
      `WITH current_online AS (
         SELECT daemon_id
         FROM daemons AS daemon
         WHERE daemon.user_id = $1
           AND daemon.daemon_id = $2
           AND daemon.status = 'online'
           AND daemon.registration_id = $3
       ), changed AS (
         UPDATE attention_recovery_items AS recovery
         SET state = 'resolved', snoozed_until = NULL,
             resolved_at = NOW(), handled_at = NOW(),
             resolution = jsonb_build_object('source', 'daemon_online'),
             revision = recovery.revision + 1, updated_at = NOW()
         FROM current_online
         WHERE recovery.user_id = $1
           AND recovery.daemon_id = current_online.daemon_id
           AND recovery.registration_generation <> $3
           AND recovery.state IN ('open', 'snoozed')
         RETURNING recovery.*,
           recovery.created_at >= NOW() - INTERVAL '60 seconds' AS quick_recovery
       )
       SELECT changed.*,
         pg_notify('pocketctl_attention', json_build_object(
           'entity', 'recovery', 'user_id', user_id, 'item_id', recovery_id,
           'revision', revision, 'operation', 'changed'
         )::text)
       FROM changed`,
      [input.userId, input.daemonId, input.registrationGeneration],
    )
    return {
      resolved: result.rows.length,
      quickResolved: result.rows.filter((row) => row.quick_recovery === true).length,
    }
  }

  async listItems(input: {
    userId: number
    daemonId: string | null
    states: string[]
    limit?: number
  }): Promise<{
    items: AttentionRecoveryRecord[]
    counts: { open: number; snoozed: number }
  }> {
    if (input.daemonId) {
      const owned = await this.pool.query(
        `SELECT 1 FROM daemons WHERE daemon_id = $1 AND user_id = $2`,
        [input.daemonId, input.userId],
      )
      if ((owned.rowCount ?? 0) === 0) throw new Error('daemon_not_found')
    }
    const rows = await this.pool.query(
      `SELECT recovery.*
       FROM attention_recovery_items AS recovery
       WHERE recovery.user_id = $1
         AND recovery.state = ANY($2::varchar[])
         AND ($3::varchar IS NULL OR recovery.daemon_id = $3)
       ORDER BY CASE recovery.state WHEN 'open' THEN 0 WHEN 'snoozed' THEN 1 ELSE 2 END,
                recovery.updated_at DESC, recovery.recovery_id DESC
       LIMIT $4`,
      [input.userId, input.states, input.daemonId, Math.min(100, input.limit ?? 100)],
    )
    const counts = await this.pool.query(
      `SELECT COUNT(*) FILTER (WHERE state = 'open')::int AS open,
              COUNT(*) FILTER (WHERE state = 'snoozed')::int AS snoozed
       FROM attention_recovery_items
       WHERE user_id = $1 AND ($2::varchar IS NULL OR daemon_id = $2)`,
      [input.userId, input.daemonId],
    )
    return {
      items: rows.rows.map(mapAttentionRecoveryRow),
      counts: {
        open: Number(counts.rows[0]?.open ?? 0),
        snoozed: Number(counts.rows[0]?.snoozed ?? 0),
      },
    }
  }

  async getItem(userId: number, recoveryId: string, revision?: number): Promise<AttentionRecoveryRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM attention_recovery_items
       WHERE user_id = $1 AND recovery_id = $2
         AND ($3::bigint IS NULL OR revision >= $3)`,
      [userId, recoveryId, revision ?? null],
    )
    return result.rows[0] ? mapAttentionRecoveryRow(result.rows[0]) : null
  }

  async mutateMetadata(input: {
    userId: number
    recoveryId: string
    expectedRevision: number
    operation: 'mark_seen' | 'snooze' | 'restore'
    snoozedUntil: string | null
  }): Promise<
    | { outcome: 'updated'; item: AttentionRecoveryRecord }
    | { outcome: 'not_found' }
    | { outcome: 'stale_revision'; item: AttentionRecoveryRecord }
    | { outcome: 'invalid' }
  > {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const selected = await client.query(
        `SELECT * FROM attention_recovery_items
         WHERE recovery_id = $1 AND user_id = $2 FOR UPDATE`,
        [input.recoveryId, input.userId],
      )
      if ((selected.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK')
        return { outcome: 'not_found' }
      }
      const current = mapAttentionRecoveryRow(selected.rows[0])
      if (current.revision !== input.expectedRevision) {
        await client.query('COMMIT')
        return { outcome: 'stale_revision', item: current }
      }

      let sql: string
      let params: unknown[] = [input.recoveryId, input.userId]
      if (input.operation === 'mark_seen') {
        if (current.seenAt) {
          await client.query('COMMIT')
          return { outcome: 'updated', item: current }
        }
        sql = `UPDATE attention_recovery_items
               SET seen_at = NOW(), revision = revision + 1, updated_at = NOW()
               WHERE recovery_id = $1 AND user_id = $2 RETURNING *`
      } else if (input.operation === 'snooze') {
        const value = input.snoozedUntil ? new Date(input.snoozedUntil) : null
        const delay = value ? value.getTime() - Date.now() : 0
        if (current.state !== 'open' || !value || Number.isNaN(value.getTime())
          || delay < 5 * 60_000 || delay > 7 * 24 * 60 * 60_000) {
          await client.query('COMMIT')
          return { outcome: 'invalid' }
        }
        sql = `UPDATE attention_recovery_items
               SET state = 'snoozed', snoozed_until = $3,
                   revision = revision + 1, updated_at = NOW()
               WHERE recovery_id = $1 AND user_id = $2 RETURNING *`
        params.push(value)
      } else {
        if (current.state !== 'snoozed') {
          await client.query('COMMIT')
          return { outcome: 'invalid' }
        }
        sql = `UPDATE attention_recovery_items
               SET state = 'open', snoozed_until = NULL,
                   revision = revision + 1, updated_at = NOW()
               WHERE recovery_id = $1 AND user_id = $2 RETURNING *`
      }
      const changed = await client.query(sql, params)
      const item = mapAttentionRecoveryRow(changed.rows[0])
      await client.query(
        `SELECT pg_notify('pocketctl_attention', json_build_object(
           'entity', 'recovery', 'user_id', $1::int, 'item_id', $2::text,
           'revision', $3::bigint, 'operation', 'changed'
         )::text)`,
        [item.userId, item.recoveryId, item.revision],
      )
      await client.query('COMMIT')
      return { outcome: 'updated', item }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async runMaintenance(options: { projectOffline?: boolean } = {}): Promise<{ changed: number; open: number }> {
    const created = options.projectOffline === false ? { rows: [] } : await this.pool.query(
      `WITH changed AS (
         INSERT INTO attention_recovery_items (
           recovery_id, user_id, daemon_id, registration_generation, state,
           daemon_display_name, last_seen_at
         )
         SELECT md5(daemon.user_id::text || ':' || daemon.daemon_id || ':' || daemon.registration_id)::uuid,
                daemon.user_id, daemon.daemon_id,
                daemon.registration_id, 'open',
                COALESCE(daemon.alias, daemon.hostname, daemon.daemon_id),
                COALESCE(daemon.last_heartbeat, daemon.created_at, NOW())
         FROM daemons AS daemon
         WHERE daemon.status = 'offline'
           AND daemon.user_id IS NOT NULL AND daemon.registration_id IS NOT NULL
         ORDER BY daemon.last_heartbeat, daemon.daemon_id
         LIMIT 100
         ON CONFLICT (user_id, daemon_id, registration_generation) DO NOTHING
         RETURNING *
       )
       SELECT recovery_id,
         pg_notify('pocketctl_attention', json_build_object(
           'entity', 'recovery', 'user_id', user_id, 'item_id', recovery_id,
           'revision', revision, 'operation', 'changed'
         )::text)
       FROM changed`,
    )
    const resolved = await this.pool.query(
      `WITH candidates AS (
         SELECT recovery.recovery_id,
                CASE WHEN daemon.daemon_id IS NULL THEN 'host_unregistered' ELSE 'daemon_online' END AS source
         FROM attention_recovery_items AS recovery
         LEFT JOIN daemons AS daemon
           ON daemon.daemon_id = recovery.daemon_id AND daemon.user_id = recovery.user_id
         WHERE recovery.state IN ('open', 'snoozed')
           AND (daemon.daemon_id IS NULL OR daemon.status = 'online')
         ORDER BY recovery.updated_at, recovery.recovery_id
         LIMIT 100
         FOR UPDATE OF recovery SKIP LOCKED
       ), changed AS (
         UPDATE attention_recovery_items AS recovery
         SET state = 'resolved', snoozed_until = NULL, resolved_at = NOW(), handled_at = NOW(),
             resolution = jsonb_build_object('source', candidates.source),
             revision = recovery.revision + 1, updated_at = NOW()
         FROM candidates
         WHERE recovery.recovery_id = candidates.recovery_id
         RETURNING recovery.*
       )
       SELECT recovery_id,
         pg_notify('pocketctl_attention', json_build_object(
           'entity', 'recovery', 'user_id', user_id, 'item_id', recovery_id,
           'revision', revision, 'operation', 'changed'
         )::text)
       FROM changed`,
    )
    const woken = await this.pool.query(
      `WITH candidates AS (
         SELECT recovery_id FROM attention_recovery_items
         WHERE state = 'snoozed' AND snoozed_until <= NOW()
         ORDER BY snoozed_until, recovery_id
         LIMIT 100
         FOR UPDATE SKIP LOCKED
       ), changed AS (
         UPDATE attention_recovery_items AS recovery
         SET state = 'open', snoozed_until = NULL, revision = revision + 1, updated_at = NOW()
         FROM candidates
         WHERE recovery.recovery_id = candidates.recovery_id
         RETURNING recovery.*
       )
       SELECT recovery_id,
         pg_notify('pocketctl_attention', json_build_object(
           'entity', 'recovery', 'user_id', user_id, 'item_id', recovery_id,
           'revision', revision, 'operation', 'changed'
         )::text)
       FROM changed`,
    )
    const removed = await this.pool.query(
      `WITH candidates AS (
         SELECT recovery_id FROM attention_recovery_items
         WHERE state = 'resolved' AND handled_at < NOW() - INTERVAL '30 days'
         ORDER BY handled_at, recovery_id
         LIMIT 500
         FOR UPDATE SKIP LOCKED
       ), deleted AS (
         DELETE FROM attention_recovery_items AS recovery
         USING candidates
         WHERE recovery.recovery_id = candidates.recovery_id
         RETURNING recovery.*
       )
       SELECT recovery_id,
         pg_notify('pocketctl_attention', json_build_object(
           'entity', 'recovery', 'user_id', user_id, 'item_id', recovery_id,
           'revision', revision, 'operation', 'removed'
         )::text)
       FROM deleted`,
    )
    const count = await this.pool.query(
      `SELECT COUNT(*)::bigint AS count FROM attention_recovery_items WHERE state = 'open'`,
    )
    return {
      changed: created.rows.length + resolved.rows.length + woken.rows.length + removed.rows.length,
      open: Number(count.rows[0]?.count ?? 0),
    }
  }
}
