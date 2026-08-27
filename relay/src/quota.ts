import { randomUUID } from 'crypto'
import type pg from 'pg'
import type { Entitlements } from './entitlements.js'

export type QuotaOperation = 'create' | 'resume'

export interface QuotaReservationBinding {
  reservationId: string
  userId: number
  daemonId: string
  requestId: string
  operation: QuotaOperation
  sessionId: string | null
}

export interface QuotaTransitionResult {
  matched: boolean
  changed: boolean
}

export interface ReserveConcurrentSessionInput {
  userId: number
  requestId: string
  operation: QuotaOperation
  daemonId: string
  sessionId?: string
  limit: number | null
  now?: Date
  ttlMs?: number
  /** Durable create metadata used only to recover an accepted grant after restart. */
  agentType?: string
  cwd?: string
}

export interface RecoveredQuotaReservation {
  binding: QuotaReservationBinding
  agentType: string | null
  cwd: string | null
  hostname: string
}

export class QuotaReservationBindingError extends Error {
  readonly code = 'quota_reservation_binding_mismatch'
  readonly permanent = true

  constructor() {
    super('quota reservation binding mismatch')
    this.name = 'QuotaReservationBindingError'
  }
}

export type QuotaDecision =
  | { allowed: true; reservationId: string | null; expiresAt: number | null; reused: boolean }
  | { allowed: false; reason: 'concurrent_session_quota_exceeded'; used: number; reserved: number; limit: number }
  | { allowed: false; reason: 'quota_reservation_binding_conflict' }
  | { allowed: false; reason: 'quota_request_already_finalized' }

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
  machineId?: string
  hostname: string
  agents: any[]
  arch?: string
  version?: string
  startedAt?: number
  limit: number | null
}

export type BoundDaemonDecision =
  | { allowed: true; reconnect: boolean; used: number; limit: number | null }
  | { allowed: false; reason: 'host_quota_exceeded' | 'daemon_owned_by_other_user' | 'machine_already_online'; used: number; limit: number | null }

const STABLE_MACHINE_ID = /^(?:machine-[a-f0-9]{32}|daemon-[a-f0-9]{8})$/

function isStableMachineID(machineId: string | undefined): machineId is string {
  return typeof machineId === 'string' && STABLE_MACHINE_ID.test(machineId)
}

const ACTIVE_ROOT_SESSION_SQL = `
  SELECT COUNT(*)::int AS active_count
  FROM sessions
  WHERE user_id = $1
    AND status IN ('running', 'busy', 'retry', 'idle', 'waiting', 'waiting_approval', 'waiting_question')
    AND COALESCE(is_subagent, false) = false
    AND session_id NOT LIKE 'pending-%'`

/**
 * M-4: a reservation only leaves the quota budget through an explicit
 * settlement. Unsettled rows — `pending` (grant in flight) and `uncertain`
 * (grant expired / daemon went silent without an outcome) — keep counting
 * toward used + reserved; `expires_at` only tells the daemon how long it
 * may still accept the grant, it never frees quota by itself.
 */
const UNSETTLED_RESERVATION_COUNT_SQL = `
  SELECT COUNT(*)::int AS reservation_count
  FROM quota_reservations
  WHERE user_id = $1 AND resource = 'concurrent_session' AND state IN ('pending', 'uncertain')`

export type QuotaSettlementReason =
  | 'session_created'
  | 'session_create_failed'
  | 'session_active'
  | 'reconciled'
  | 'user_deleted'

const SETTLEMENT_REASONS: readonly QuotaSettlementReason[] = [
  'session_created', 'session_create_failed', 'session_active', 'reconciled', 'user_deleted',
]

function assertSettlementReason(reason: QuotaSettlementReason): void {
  if (!SETTLEMENT_REASONS.includes(reason)) {
    throw new Error(`settleQuotaReservation requires an explicit known reason, got: ${String(reason)}`)
  }
}

function assertReservationBinding(binding: QuotaReservationBinding, reason?: QuotaSettlementReason): void {
  if (!binding.reservationId || !Number.isSafeInteger(binding.userId) || binding.userId <= 0
    || !binding.daemonId || !binding.requestId) {
    throw new Error('quota reservation transition requires reservation/user/daemon/request binding')
  }
  if (binding.operation === 'resume' && !binding.sessionId) {
    throw new Error('resume quota reservation transition requires a session binding')
  }
  if (reason === 'session_created' && (binding.operation !== 'create' || !binding.sessionId)) {
    throw new Error('session_created may only settle a create reservation with its created session')
  }
  if (reason === 'session_create_failed' && (binding.operation !== 'create' || binding.sessionId !== null)) {
    throw new Error('session_create_failed may only settle an unbound create reservation')
  }
  if (reason === 'session_active' && (binding.operation !== 'resume' || !binding.sessionId)) {
    throw new Error('session_active may only settle a resume reservation for its bound session')
  }
}

function transitionResult(row: Record<string, unknown> | undefined): QuotaTransitionResult {
  return { matched: row?.matched === true, changed: row?.changed === true }
}

/**
 * Settle a reservation with an explicit, server-derived identity tuple.
 * `matched` is true for both a new transition and an idempotent replay of the
 * same binding; `changed` distinguishes the first transition. A create may
 * bind its newly inserted session exactly once, while a resume must already
 * carry the reserved session id.
 */
export async function settleQuotaReservation(
  pool: pg.Pool,
  binding: QuotaReservationBinding,
  reason: QuotaSettlementReason,
): Promise<QuotaTransitionResult> {
  assertSettlementReason(reason)
  assertReservationBinding(binding, reason)
  if (binding.reservationId.startsWith('unlimited-')) return { matched: true, changed: false }
  const result = await pool.query(
    `WITH target AS MATERIALIZED (
       SELECT reservation.id, reservation.state
       FROM quota_reservations reservation
       WHERE reservation.id = $1
         AND reservation.user_id = $2
         AND reservation.daemon_id = $3
         AND reservation.request_id = $4
         AND reservation.operation = $5
         AND (
           ($5 = 'create' AND (
             ($6::varchar IS NULL AND reservation.session_id IS NULL)
             OR ($6::varchar IS NOT NULL
               AND (reservation.session_id IS NULL OR reservation.session_id = $6)
               AND EXISTS (
                 SELECT 1 FROM sessions session
                 WHERE session.session_id = $6
                   AND session.user_id = $2
                   AND session.daemon_id = $3
                   AND session.created_at >= reservation.created_at
               ))
           ))
           OR ($5 = 'resume'
             AND reservation.session_id = $6
             AND EXISTS (
               SELECT 1 FROM sessions session
               WHERE session.session_id = $6
                 AND session.user_id = $2
                 AND session.daemon_id = $3
             ))
         )
         AND (reservation.state <> 'settled'
           OR (reservation.settlement_reason = $7
             AND reservation.session_id IS NOT DISTINCT FROM $6))
       FOR UPDATE
     ), updated AS (
       UPDATE quota_reservations reservation
       SET state = 'settled',
           session_id = COALESCE(reservation.session_id, $6),
           settled_at = NOW(),
           settlement_reason = $7
       FROM target
       WHERE reservation.id = target.id AND reservation.state <> 'settled'
       RETURNING reservation.id
     )
     SELECT EXISTS (SELECT 1 FROM target) AS matched,
            EXISTS (SELECT 1 FROM updated) AS changed`,
    [
      binding.reservationId, binding.userId, binding.daemonId, binding.requestId,
      binding.operation, binding.sessionId, reason,
    ],
  )
  return transitionResult(result.rows[0])
}

/**
 * Atomically pin a create reservation to the one canonical session it may
 * materialize. This transition deliberately precedes session upsert so two
 * concurrent daemon outcomes cannot both commit active session rows.
 */
export async function claimQuotaReservationSession(
  pool: pg.Pool,
  binding: QuotaReservationBinding,
): Promise<QuotaTransitionResult> {
  assertReservationBinding(binding)
  if (binding.operation !== 'create' || !binding.sessionId) {
    throw new Error('quota create claim requires a canonical session binding')
  }
  if (binding.reservationId.startsWith('unlimited-')) return { matched: true, changed: false }
  const result = await pool.query(
    `WITH target AS MATERIALIZED (
       SELECT id, session_id
       FROM quota_reservations
       WHERE id = $1
         AND user_id = $2
         AND daemon_id = $3
         AND request_id = $4
         AND operation = 'create'
         AND (
           (state IN ('pending', 'uncertain') AND (session_id IS NULL OR session_id = $5))
           OR (state = 'settled' AND session_id = $5 AND settlement_reason = 'session_created')
         )
       FOR UPDATE
     ), updated AS (
       UPDATE quota_reservations reservation
       SET session_id = $5
       FROM target
       WHERE reservation.id = target.id AND reservation.session_id IS NULL
       RETURNING reservation.id
     )
     SELECT EXISTS (SELECT 1 FROM target) AS matched,
            EXISTS (SELECT 1 FROM updated) AS changed`,
    [binding.reservationId, binding.userId, binding.daemonId, binding.requestId, binding.sessionId],
  )
  return transitionResult(result.rows[0])
}

/**
 * Recover an outcome binding without trusting a daemon-provided reservation
 * id. The database lookup uses the authenticated owner, registered daemon,
 * request id, expected operation, and expected session shape as one tuple.
 */
export async function recoverQuotaReservation(
  pool: pg.Pool,
  expected: Omit<QuotaReservationBinding, 'reservationId'>,
  reason: Extract<QuotaSettlementReason, 'session_created' | 'session_create_failed' | 'session_active'>,
): Promise<RecoveredQuotaReservation | null> {
  if (!Number.isSafeInteger(expected.userId) || expected.userId <= 0
    || !expected.daemonId || !expected.requestId) {
    return null
  }
  if (expected.operation === 'resume' && !expected.sessionId) return null
  const result = await pool.query(
    `SELECT reservation.id, reservation.resource, reservation.operation,
            reservation.daemon_id, reservation.session_id, reservation.state,
            reservation.settlement_reason, reservation.agent_type, reservation.cwd,
            COALESCE(daemon.hostname, 'unknown') AS hostname
     FROM quota_reservations reservation
     LEFT JOIN daemons daemon
       ON daemon.daemon_id = reservation.daemon_id AND daemon.user_id = reservation.user_id
     WHERE reservation.user_id = $1
       AND reservation.request_id = $2
     LIMIT 1`,
    [expected.userId, expected.requestId],
  )
  const row = result.rows[0]
  if (!row) return null
  const rowSessionId = typeof row.session_id === 'string' ? row.session_id : null
  const sessionMatches = expected.operation === 'resume'
    ? rowSessionId === expected.sessionId
    : expected.sessionId === null
      ? rowSessionId === null
      : rowSessionId === null || rowSessionId === expected.sessionId
  const unsettled = row.state === 'pending' || row.state === 'uncertain'
  const idempotentSettlement = row.state === 'settled'
    && row.settlement_reason === reason
    && rowSessionId === expected.sessionId
  if (row.resource !== 'concurrent_session'
    || row.operation !== expected.operation
    || row.daemon_id !== expected.daemonId
    || !sessionMatches
    || (!unsettled && !idempotentSettlement)) {
    throw new QuotaReservationBindingError()
  }
  return {
    binding: { reservationId: String(row.id), ...expected },
    agentType: typeof row.agent_type === 'string' ? row.agent_type : null,
    cwd: typeof row.cwd === 'string' ? row.cwd : null,
    hostname: typeof row.hostname === 'string' && row.hostname ? row.hostname : 'unknown',
  }
}

/**
 * M-4: a grant whose outcome is unknown (timeout, silent daemon, daemon
 * disconnect mid-create) moves to `uncertain` and CONTINUES to consume the
 * quota budget. Only an audited reconciliation can later settle it.
 */
export async function markQuotaReservationUncertain(
  pool: pg.Pool,
  binding: QuotaReservationBinding,
  reason: string,
): Promise<QuotaTransitionResult> {
  assertReservationBinding(binding)
  if (binding.reservationId.startsWith('unlimited-')) return { matched: true, changed: false }
  const result = await pool.query(
    `WITH target AS MATERIALIZED (
       SELECT id, state
       FROM quota_reservations
       WHERE id = $1
         AND user_id = $2
         AND daemon_id = $3
         AND request_id = $4
         AND operation = $5
         AND (($5 = 'create' AND session_id IS NULL)
           OR ($5 = 'resume' AND session_id = $6))
         AND state IN ('pending', 'uncertain')
       FOR UPDATE
     ), updated AS (
       UPDATE quota_reservations reservation
       SET state = 'uncertain', settlement_reason = $7
       FROM target
       WHERE reservation.id = target.id AND reservation.state = 'pending'
       RETURNING reservation.id
     )
     SELECT EXISTS (SELECT 1 FROM target) AS matched,
            EXISTS (SELECT 1 FROM updated) AS changed`,
    [
      binding.reservationId, binding.userId, binding.daemonId, binding.requestId,
      binding.operation, binding.sessionId, reason,
    ],
  )
  return transitionResult(result.rows[0])
}

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
    let replacesOfflineMachine = false
    if (!reconnect && isStableMachineID(input.machineId)) {
      const machineRows = await client.query(
        `SELECT status
         FROM daemons
         WHERE user_id = $1
           AND daemon_id <> $2
           AND (
             machine_id = $3
             OR (COALESCE(machine_id, '') IN ('', 'unknown') AND daemon_id = $3)
           )
         FOR UPDATE`,
        [input.userId, input.daemonId, input.machineId],
      )
      if (machineRows.rows.some((row: { status?: string | null }) => row.status === 'online')) {
        await client.query('COMMIT')
        return { allowed: false, reason: 'machine_already_online', used: 0, limit: input.limit }
      }
      replacesOfflineMachine = machineRows.rows.some((row: { status?: string | null }) => row.status === 'offline')
    }
    const used = await countBoundDaemonsLocked(client, input.userId)
    if (!reconnect && !replacesOfflineMachine && input.limit !== null && used >= input.limit) {
      await client.query('COMMIT')
      return { allowed: false, reason: 'host_quota_exceeded', used, limit: input.limit }
    }

    // Admission owns only the durable account binding. Connection metadata,
    // online status, incarnation, and token are committed later by Router's
    // generation-guarded activation transaction.
    if (!reconnect) {
      await client.query(
        `INSERT INTO daemons (daemon_id, user_id, machine_id, status)
         VALUES ($1, $2, $3, 'offline')
         ON CONFLICT (daemon_id) DO NOTHING`,
        [input.daemonId, input.userId, isStableMachineID(input.machineId) ? input.machineId : null],
      )
    }
    await client.query('COMMIT')
    return {
      allowed: true,
      reconnect,
      used: reconnect || replacesOfflineMachine ? used : used + 1,
      limit: input.limit,
    }
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
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0 || !input.requestId || !input.daemonId) {
    throw new Error('quota reservation requires user/request/daemon binding')
  }
  if (input.operation === 'resume' && !input.sessionId) {
    throw new Error('resume quota reservation requires a session binding')
  }
  const client = await pool.connect()
  const now = input.now ?? new Date()
  const ttlMs = input.ttlMs ?? 20_000
  const expiresAt = new Date(now.getTime() + ttlMs)
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1)', [input.userId])
    await client.query(
      `DELETE FROM quota_reservations
       WHERE user_id = $1 AND state = 'settled'
         AND settled_at <= $2::timestamptz - interval '24 hours'`,
      [input.userId, now],
    )

    const existing = await client.query(
      `SELECT id, expires_at, operation, daemon_id, session_id, state
       FROM quota_reservations
       WHERE user_id = $1 AND request_id = $2`,
      [input.userId, input.requestId],
    )
    if (existing.rows[0]) {
      const row = existing.rows[0]
      const sameSession = input.operation === 'create' && !input.sessionId
        ? true
        : (row.session_id ?? null) === (input.sessionId ?? null)
      const sameBinding = row.operation === input.operation
        && row.daemon_id === input.daemonId
        && sameSession
      if (sameBinding && row.state !== 'settled' && input.operation === 'create') {
        await client.query(
          `UPDATE quota_reservations
           SET agent_type = COALESCE(agent_type, $3), cwd = COALESCE(cwd, $4)
           WHERE user_id = $1 AND request_id = $2`,
          [input.userId, input.requestId, input.agentType?.slice(0, 64) || null, input.cwd ?? null],
        )
      }
      await client.query('COMMIT')
      if (!sameBinding) return { allowed: false, reason: 'quota_reservation_binding_conflict' }
      if (row.state === 'settled') return { allowed: false, reason: 'quota_request_already_finalized' }
      const existingExpiry = new Date(existing.rows[0].expires_at).getTime()
      return {
        allowed: true,
        reservationId: existing.rows[0].id,
        expiresAt: existingExpiry,
        reused: true,
      }
    }

    if (input.limit !== null) {
      const activeResult = await client.query(ACTIVE_ROOT_SESSION_SQL, [input.userId])
      const reservationResult = await client.query(UNSETTLED_RESERVATION_COUNT_SQL, [input.userId])
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
    }

    const reservationId = randomUUID()
    await client.query(
      `INSERT INTO quota_reservations
         (id, user_id, resource, operation, daemon_id, session_id, request_id, expires_at, agent_type, cwd)
       VALUES ($1, $2, 'concurrent_session', $3, $4, $5, $6, $7, $8, $9)`,
      [
        reservationId, input.userId, input.operation, input.daemonId, input.sessionId || null,
        input.requestId, expiresAt, input.agentType?.slice(0, 64) || null, input.cwd ?? null,
      ],
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

/**
 * Legacy name kept for existing imports: releasing now REQUIRES an explicit
 * settlement reason and never physically deletes an unsettled row.
 */
export async function releaseQuotaReservation(
  pool: pg.Pool,
  binding: QuotaReservationBinding,
  reason: QuotaSettlementReason = 'reconciled',
): Promise<void> {
  await settleQuotaReservation(pool, binding, reason)
}

export async function getQuotaSnapshot(
  pool: pg.Pool,
  userId: number,
  entitlements: Entitlements,
): Promise<QuotaSnapshot> {
  const [hostResult, activeResult, reservationResult] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS count FROM daemons WHERE user_id = $1`, [userId]),
    pool.query(ACTIVE_ROOT_SESSION_SQL, [userId]),
    pool.query(UNSETTLED_RESERVATION_COUNT_SQL, [userId]),
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
