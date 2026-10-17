import type pg from 'pg'

import { projectAttentionEvent, type AttentionEventRow } from './projector.js'
import type { AttentionProjection } from './types.js'

export interface AttentionProjectionRepositoryLike {
  applyProjection(
    client: Pick<pg.PoolClient, 'query'>,
    projection: AttentionProjection,
  ): Promise<unknown>
}

export interface AttentionProjectionWorkerDependencies {
  pool: Pick<pg.Pool, 'connect'>
  repository: AttentionProjectionRepositoryLike
  batchSize?: number
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function dateValue(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? new Date(0) : date
}

function mapEventRow(row: Record<string, unknown>): AttentionEventRow {
  return {
    eventId: Number(row.id),
    eventType: String(row.event_type ?? ''),
    sessionId: String(row.session_id ?? ''),
    payload: recordValue(row.payload),
    userId: row.user_id === null || row.user_id === undefined ? null : Number(row.user_id),
    daemonId: row.daemon_id === null || row.daemon_id === undefined ? null : String(row.daemon_id),
    provider: row.agent_type === null || row.agent_type === undefined ? null : String(row.agent_type),
    controlMode: row.control_mode === null || row.control_mode === undefined ? null : String(row.control_mode),
    capabilities: stringList(row.capabilities),
    sessionTitle: row.session_title === null || row.session_title === undefined ? null : String(row.session_title),
    sessionStatus: row.session_status === null || row.session_status === undefined ? null : String(row.session_status),
    daemonAlias: row.daemon_alias === null || row.daemon_alias === undefined ? null : String(row.daemon_alias),
    daemonHostname: row.daemon_hostname === null || row.daemon_hostname === undefined ? null : String(row.daemon_hostname),
    createdAt: dateValue(row.created_at),
  }
}

export function createAttentionProjectionWorker(dependencies: AttentionProjectionWorkerDependencies) {
  const batchSize = Math.max(1, Math.min(500, Math.trunc(dependencies.batchSize ?? 100)))

  async function runOnce(): Promise<number> {
    const client = await dependencies.pool.connect()
    try {
      await client.query('BEGIN')
      const cursor = await client.query(
        `SELECT last_event_id
         FROM attention_projection_cursor
         WHERE projector_name = 'attention-inbox-v1'
         FOR UPDATE SKIP LOCKED`,
      )
      if ((cursor.rowCount ?? cursor.rows.length) === 0) {
        await client.query('COMMIT')
        return 0
      }
      const lastEventID = Number(cursor.rows[0]?.last_event_id ?? 0)
      const events = await client.query(
        `SELECT event.id, event.event_type, event.session_id, event.payload, event.created_at, event.body_storage,
                session.user_id, session.daemon_id, session.agent_type, session.control_mode,
                session.capabilities, session.title AS session_title,
                session.status AS session_status, daemon.alias AS daemon_alias,
                daemon.hostname AS daemon_hostname
         FROM events event
         LEFT JOIN sessions session ON session.session_id = event.session_id
         LEFT JOIN daemons daemon ON daemon.daemon_id = session.daemon_id
         WHERE event.id > $1
         ORDER BY event.id ASC
         LIMIT $2`,
        [lastEventID, batchSize],
      )
      for (const rawRow of events.rows) {
        // Never project an empty approximation of a cold body. Final lifecycle
        // eligibility must keep this cursor ahead of a proposed cold range.
        // A reset/lagging projection therefore stops explicitly for repair.
        if (rawRow.body_storage === 'cold') throw new Error('attention projection cursor requires cold reconciliation')
        const mapped=mapEventRow(rawRow)
        if(['claude-code','dsh'].includes(mapped.provider??'')) {
          const trusted=await client.query(`SELECT 1 FROM collaboration_calls c JOIN team_agent_offers o ON o.offer_id=c.offer_id JOIN daemons d ON d.daemon_id=o.daemon_id AND d.user_id=o.owner_user_id
            WHERE c.native_session_id=$1 AND o.owner_user_id=$2 AND o.daemon_id=$3
              AND (($5::boolean AND d.collaboration_capabilities ? 'team_private_interactions_v2') OR ($4 IN ('approval_resolved','question_resolved') AND EXISTS(SELECT 1 FROM attention_items i WHERE i.session_id=$1 AND i.user_id=$2 AND i.daemon_id=$3 AND i.context->>'team_native_request'='true'))) LIMIT 1`,[mapped.sessionId,mapped.userId,mapped.daemonId,mapped.eventType,process.env.TEAM_PRIVATE_INTERACTIONS_V2==='on'])
          if(trusted.rows[0])mapped.capabilities.push('team_private_interactions_v2')
        }
        const projection = projectAttentionEvent(mapped)
        if (projection) await dependencies.repository.applyProjection(client, projection)
      }
      if (events.rows.length > 0) {
        const newestID = Number(events.rows[events.rows.length - 1]?.id)
        await client.query(
          `UPDATE attention_projection_cursor
           SET last_event_id = $1, updated_at = NOW()
           WHERE projector_name = 'attention-inbox-v1'`,
          [newestID],
        )
      }
      await client.query('COMMIT')
      return events.rows.length
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Preserve the projection error.
      }
      throw error
    } finally {
      client.release()
    }
  }

  return { runOnce }
}
