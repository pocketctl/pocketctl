import { randomUUID } from 'crypto'
import type pg from 'pg'
import type { Entitlements } from './entitlements.js'

export type QuotaOperation = 'create' | 'resume'

export interface ReserveConcurrentSessionInput {
  userId: number
  requestId: string
  operation: QuotaOperation
  daemonId?: string
  sessionId?: string
  limit: number | null
  now?: Date
  ttlMs?: number
}

export type QuotaDecision =
  | { allowed: true; reservationId: string | null; expiresAt: number | null; reused: boolean }
  | { allowed: false; reason: 'concurrent_session_quota_exceeded'; used: number; reserved: number; limit: number }

export interface QuotaResource {
  used: number
  limit: number | null
  over_limit: boolean
  reserved?: number
}

export interface QuotaSnapshot {
  resources: {
    bound_hosts: QuotaResource
    concurrent_sessions: QuotaResource
  }
}

export interface ClaimBoundDaemonInput {
  userId: number
  daemonId: string
  hostname: string
  agents: any[]
  arch?: string
  version?: string
  startedAt?: number
  limit: number | null
}

export type BoundDaemonDecision =
  | { allowed: true; reconnect: boolean; used: number; limit: number | null }
  | { allowed: false; reason: 'host_quota_exceeded' | 'daemon_owned_by_other_user'; used: number; limit: number | null }

const ACTIVE_ROOT_SESSION_SQL = `
  SELECT COUNT(*)::int AS active_count
  FROM sessions
  WHERE user_id = $1
    AND status IN ('running', 'busy', 'idle', 'waiting', 'waiting_approval')
    AND COALESCE(is_subagent, false) = false
    AND session_id NOT LIKE 'pending-%'`

export async function countBoundDaemonsLocked(client: Pick<pg.PoolClient, 'query'>, userId: number): Promise<number> {
  const result = await client.query(
    `SELECT COUNT(*)::int AS count FROM daemons WHERE user_id = $1`,
    [userId],
  )
  return Number(result.rows[0]?.count || 0)
}

export async function claimBoundDaemonSlot(pool: pg.Pool, input: ClaimBoundDaemonInput): Promise<BoundDaemonDecision> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1)', [input.userId])
    const existing = await client.query(`SELECT user_id FROM daemons WHERE daemon_id = $1`, [input.daemonId])
    const existingOwner = existing.rows[0]?.user_id
    if (existingOwner != null && Number(existingOwner) !== input.userId) {
      await client.query('COMMIT')
      return { allowed: false, reason: 'daemon_owned_by_other_user', used: 0, limit: input.limit }
    }

    const reconnect = existing.rows.length > 0 && Number(existingOwner) === input.userId
    const used = await countBoundDaemonsLocked(client, input.userId)
    if (!reconnect && input.limit !== null && used >= input.limit) {
      await client.query('COMMIT')
      return { allowed: false, reason: 'host_quota_exceeded', used, limit: input.limit }
    }

    await client.query(
      `INSERT INTO daemons
         (daemon_id, user_id, hostname, agents, status, last_heartbeat, arch, version, started_at)
       VALUES ($1, $2, $3, $4, 'online', NOW(), $5, $6, $7)
       ON CONFLICT (daemon_id) DO UPDATE SET
         user_id = $2, hostname = $3, agents = $4, status = 'online', last_heartbeat = NOW(),
         arch = COALESCE($5, daemons.arch), version = COALESCE($6, daemons.version),
         started_at = COALESCE($7, daemons.started_at)`,
      [input.daemonId, input.userId, input.hostname, JSON.stringify(input.agents), input.arch || null, input.version || null, input.startedAt || null],
    )
    await client.query('COMMIT')
    return { allowed: true, reconnect, used: reconnect ? used : used + 1, limit: input.limit }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function reserveConcurrentSession(
  pool: pg.Pool,
  input: ReserveConcurrentSessionInput,
): Promise<QuotaDecision> {
  if (input.limit === null) {
    return { allowed: true, reservationId: null, expiresAt: null, reused: false }
  }

  const client = await pool.connect()
  const now = input.now ?? new Date()
  const ttlMs = input.ttlMs ?? 20_000
  const expiresAt = new Date(now.getTime() + ttlMs)
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1)', [input.userId])
    await client.query(
      `DELETE FROM quota_reservations WHERE user_id = $1 AND expires_at <= $2`,
      [input.userId, now],
    )

    const existing = await client.query(
      `SELECT id, expires_at
       FROM quota_reservations
       WHERE user_id = $1 AND request_id = $2 AND expires_at > $3`,
      [input.userId, input.requestId, now],
    )
    if (existing.rows[0]) {
      await client.query('COMMIT')
      const existingExpiry = new Date(existing.rows[0].expires_at).getTime()
      return {
        allowed: true,
        reservationId: existing.rows[0].id,
        expiresAt: existingExpiry,
        reused: true,
      }
    }

    const activeResult = await client.query(ACTIVE_ROOT_SESSION_SQL, [input.userId])
    const reservationResult = await client.query(
      `SELECT COUNT(*)::int AS reservation_count
       FROM quota_reservations
       WHERE user_id = $1 AND resource = 'concurrent_session' AND expires_at > $2`,
      [input.userId, now],
    )
    const used = Number(activeResult.rows[0]?.active_count || 0)
    const reserved = Number(reservationResult.rows[0]?.reservation_count || 0)
    if (used + reserved >= input.limit) {
      await client.query('COMMIT')
      return {
        allowed: false,
        reason: 'concurrent_session_quota_exceeded',
        used,
        reserved,
        limit: input.limit,
      }
    }

    const reservationId = randomUUID()
    await client.query(
      `INSERT INTO quota_reservations
         (id, user_id, resource, operation, daemon_id, session_id, request_id, expires_at)
       VALUES ($1, $2, 'concurrent_session', $3, $4, $5, $6, $7)`,
      [reservationId, input.userId, input.operation, input.daemonId || null, input.sessionId || null, input.requestId, expiresAt],
    )
    await client.query('COMMIT')
    return { allowed: true, reservationId, expiresAt: expiresAt.getTime(), reused: false }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function releaseQuotaReservation(pool: pg.Pool, reservationId: string): Promise<void> {
  await pool.query(`DELETE FROM quota_reservations WHERE id = $1`, [reservationId])
}

export async function getQuotaSnapshot(
  pool: pg.Pool,
  userId: number,
  entitlements: Entitlements,
): Promise<QuotaSnapshot> {
  const [hostResult, activeResult, reservationResult] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS count FROM daemons WHERE user_id = $1`, [userId]),
    pool.query(ACTIVE_ROOT_SESSION_SQL, [userId]),
    pool.query(
      `SELECT COUNT(*)::int AS reservation_count
       FROM quota_reservations
       WHERE user_id = $1 AND resource = 'concurrent_session' AND expires_at > NOW()`,
      [userId],
    ),
  ])
  const hostUsed = Number(hostResult.rows[0]?.count || 0)
  const sessionUsed = Number(activeResult.rows[0]?.active_count || 0)
  const reserved = Number(reservationResult.rows[0]?.reservation_count || 0)
  const hostLimit = entitlements.maxBoundDaemons
  const sessionLimit = entitlements.maxConcurrentSessions

  return {
    resources: {
      bound_hosts: {
        used: hostUsed,
        limit: hostLimit,
        over_limit: hostLimit !== null && hostUsed > hostLimit,
      },
      concurrent_sessions: {
        used: sessionUsed,
        reserved,
        limit: sessionLimit,
        over_limit: sessionLimit !== null && sessionUsed + reserved > sessionLimit,
      },
    },
  }
}
