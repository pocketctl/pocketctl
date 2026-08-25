import { createHmac } from 'crypto'
import type pg from 'pg'
import { filterHashForInstallation } from './cursor.js'

/**
 * ADR-0003 Snapshot/inventory reads. Ownership is enforced inside the single
 * SQL statement: installation -> sessions(user_id = owner) -> events. There
 * is deliberately no "check ownership then read everything" split, so a
 * cross-owner id cannot leak rows through a TOCTOU gap.
 */

export interface SnapshotInstallationScope {
  installationId: string
  providerId: string
  ownerUserId: number
  eventFilter: Record<string, unknown>
}

export interface InventorySessionRow {
  session_id: string
  agent_type: string | null
  status: string | null
  daemon_id: string | null
  created_at: Date
  updated_at: Date
  cursor: string
}

function sessionScopeClauses(
  eventFilter: Record<string, unknown>,
  params: unknown[],
): string[] {
  const daemonIds = Array.isArray(eventFilter.daemon_ids) ? eventFilter.daemon_ids as string[] : []
  const agentTypes = Array.isArray(eventFilter.agent_types) ? eventFilter.agent_types as string[] : []
  const clauses: string[] = [
    "s.source IS DISTINCT FROM 'app_review_demo'",
    "s.session_id NOT LIKE 'app-review-demo-%'",
  ]
  if (daemonIds.length > 0) {
    params.push(daemonIds)
    clauses.push(`s.daemon_id = ANY($${params.length}::varchar[])`)
  }
  if (agentTypes.length > 0) {
    params.push(agentTypes)
    clauses.push(`s.agent_type = ANY($${params.length}::varchar[])`)
  }
  return clauses
}

export async function listInventorySessions(
  pool: Pick<pg.Pool, 'query'>,
  scope: SnapshotInstallationScope,
  options: { afterSessionRowId: number; limit: number },
): Promise<InventorySessionRow[]> {
  const params: unknown[] = [scope.installationId, scope.providerId, options.afterSessionRowId, options.limit]
  const scopeSql = sessionScopeClauses(scope.eventFilter ?? {}, params)
  const result = await pool.query<InventorySessionRow & { row_id: number }>(`
    SELECT s.session_id, s.agent_type, s.status, s.daemon_id, s.created_at, s.updated_at, s.id AS row_id
    FROM extension_installations i
    JOIN sessions s ON s.user_id = i.owner_user_id
    WHERE i.installation_id = $1
      AND i.provider_id = $2
      AND s.id > $3
      AND s.session_id NOT LIKE 'pending-%'
      AND ${scopeSql.join('\n      AND ')}
    ORDER BY s.id ASC
    LIMIT $4
  `, params)
  return result.rows.map(row => ({
    session_id: row.session_id,
    agent_type: row.agent_type,
    status: row.status,
    daemon_id: row.daemon_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    cursor: String(row.row_id),
  }))
}

export interface SnapshotEventRow {
  event_id: number
  event_type: string
  payload: Record<string, unknown>
  created_at: Date
}

export async function getSnapshotEventPage(
  pool: Pick<pg.Pool, 'query'>,
  scope: SnapshotInstallationScope,
  sessionId: string,
  options: { afterEventId: number; limit: number },
): Promise<SnapshotEventRow[]> {
  const params: unknown[] = [scope.installationId, scope.providerId, sessionId, options.afterEventId, options.limit]
  const scopeSql = sessionScopeClauses(scope.eventFilter ?? {}, params)
  const result = await pool.query<SnapshotEventRow>(`
    SELECT e.id AS event_id, e.event_type, e.payload, e.created_at
    FROM extension_installations i
    JOIN sessions s ON s.user_id = i.owner_user_id AND s.session_id = $3
    JOIN events e ON e.session_id = s.session_id
    WHERE i.installation_id = $1
      AND i.provider_id = $2
      AND e.id > $4
      AND ${scopeSql.join('\n      AND ')}
    ORDER BY e.id ASC
    LIMIT $5
  `, params)
  return result.rows.map(row => ({
    event_id: Number(row.event_id),
    event_type: row.event_type,
    payload: row.payload,
    created_at: row.created_at,
  }))
}

export async function snapshotSessionExists(
  pool: Pick<pg.Pool, 'query'>,
  scope: SnapshotInstallationScope,
  sessionId: string,
): Promise<boolean> {
  const params: unknown[] = [scope.installationId, scope.providerId, sessionId]
  const scopeSql = sessionScopeClauses(scope.eventFilter ?? {}, params)
  const result = await pool.query(
    `SELECT 1 FROM extension_installations i
     JOIN sessions s ON s.user_id = i.owner_user_id AND s.session_id = $3
     WHERE i.installation_id = $1
       AND i.provider_id = $2
       AND ${scopeSql.join('\n       AND ')}
     LIMIT 1`,
    params,
  )
  return (result.rowCount ?? 0) > 0
}

// --- Signed snapshot cursors (installation-bound) ---------------------------

export interface SnapshotCursorV1 {
  v: 1
  k: 'inventory' | 'snapshot'
  installation_id: string
  position: string
  config_version: string
  filter_hash: string
  exp: number
}

function cursorHmac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(`snapshot:${payload}`).digest('base64url')
}

export function encodeSnapshotCursor(
  cursor: SnapshotCursorV1,
  secret: string,
): string {
  const payload = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
  return `${payload}.${cursorHmac(secret, payload)}`
}

export function decodeSnapshotCursor(
  token: string,
  secret: string,
  installationId: string,
  options: { configVersion?: string | number; filterHash?: string; now?: number } = {},
): SnapshotCursorV1 | null {
  const now = options.now ?? Date.now()
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return null
  const separator = token.lastIndexOf('.')
  if (separator <= 0) return null
  const payload = token.slice(0, separator)
  const signature = token.slice(separator + 1)
  const expected = cursorHmac(secret, payload)
  if (signature.length !== expected.length) return null
  let diff = 0
  for (let index = 0; index < expected.length; index++) {
    diff |= signature.charCodeAt(index) ^ expected.charCodeAt(index)
  }
  if (diff !== 0) return null
  let cursor: SnapshotCursorV1
  try {
    cursor = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (cursor.v !== 1
    || (cursor.k !== 'inventory' && cursor.k !== 'snapshot')
    || cursor.installation_id !== installationId
    || !/^[0-9]+$/.test(cursor.position)
    || typeof cursor.config_version !== 'string'
    || typeof cursor.filter_hash !== 'string'
    || typeof cursor.exp !== 'number') {
    return null
  }
  if (cursor.exp * 1000 <= now) return null
  // Cursors are bound to the installation's current scope: a mid-pagination
  // config or filter change invalidates outstanding cursors.
  if (options.configVersion !== undefined && cursor.config_version !== String(options.configVersion)) {
    return null
  }
  if (options.filterHash !== undefined && cursor.filter_hash !== options.filterHash) {
    return null
  }
  return cursor
}
