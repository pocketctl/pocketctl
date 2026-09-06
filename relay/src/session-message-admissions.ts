import { createHash, randomUUID } from 'crypto'
import type pg from 'pg'
import { getSessionRuntimePolicy, isSessionDeleted, lockSessionMaterializationFence, UnknownDaemonSessionError } from './db.js'
import { isObserverAgentType } from './session-observer-policy.js'
import { QuotaReservationBindingError, reserveConcurrentSessionInTransaction, type QuotaDecision } from './quota.js'

export interface ContinueAdmission {
  id: string; userId: number; daemonId: string; sessionId: string; requestId: string
  canonicalSessionId?: string
  state: 'issued' | 'completed' | 'uncertain'; expiresAt: Date
}
export type MessageAdmissionDecision =
  | { kind: 'continue'; admission: ContinueAdmission; reused: boolean }
  | { kind: 'resume'; decision: QuotaDecision }
  | { kind: 'conflict' }
  | { kind: 'forbidden'; reason?: string }

// Recursive key ordering preserves array order and all actual wire semantics.
// Transport identities and a client-supplied grant are bound separately/overwritten.
export function messageCommandHash(command: Record<string, unknown>): string {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => [k, canonical(v)]))
    return value
  }
  const { quota_grant: _grant, request_id: _request, ...semantic } = command
  return createHash('sha256').update(JSON.stringify(canonical(semantic))).digest('hex')
}

export async function admitSessionMessage(pool: pg.Pool, input: {
  userId: number; daemonId: string; sessionId: string; requestId: string
  command: Record<string, unknown>; limit: number | null
}): Promise<MessageAdmissionDecision> {
  // Standalone maintenance commits before acquiring any session/account locks.
  // Quota snapshots remain read-only, including while effects hold a fence.
  await pool.query("UPDATE session_message_admissions SET state = 'uncertain' WHERE user_id = $1 AND state = 'issued' AND expires_at <= NOW()",[input.userId])
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Quota -> account/daemon rows -> session fence/row -> grants. Account
    // deletion locks the account first; machine migration locks daemon first.
    await client.query('SELECT pg_advisory_xact_lock($1)', [input.userId])
    await client.query('SELECT id FROM users WHERE id = $1 FOR KEY SHARE', [input.userId])
    const owner = await client.query('SELECT 1 FROM daemons WHERE daemon_id = $1 AND user_id = $2 FOR SHARE', [input.daemonId, input.userId])
    await lockSessionMaterializationFence(client, input.sessionId)
    await client.query('SELECT session_id FROM sessions WHERE session_id = $1 FOR UPDATE', [input.sessionId])
    const scoped = client as unknown as pg.Pool
    const policy = await getSessionRuntimePolicy(scoped, input.sessionId, input.userId)
    if (!policy || policy.daemonId !== input.daemonId || !owner.rows[0]
      || isObserverAgentType(policy.agentType) || await isSessionDeleted(scoped, input.sessionId)
      || policy.controlMode === 'legacy_read_only') {
      await client.query('COMMIT')
      return { kind: 'forbidden', reason: policy && isObserverAgentType(policy.agentType) ? 'observer_read_only' : 'session_not_found' }
    }
    const hash = messageCommandHash(input.command)
    const msgId = typeof input.command.msg_id === 'string' ? input.command.msg_id : null
    const previous = await client.query('SELECT * FROM session_message_admissions WHERE user_id = $1 AND request_id = $2', [input.userId, input.requestId])
    if (previous.rows[0]) {
      const row = previous.rows[0]
      await client.query('COMMIT')
      if (row.daemon_id !== input.daemonId || (row.canonical_session_id ?? row.session_id) !== input.sessionId || row.command_hash !== messageCommandHash({...input.command,session_id:row.session_id}) || row.msg_id !== msgId) return { kind: 'conflict' }
      return { kind: 'continue', reused: true, admission: { id: row.id, userId: input.userId, daemonId: input.daemonId, sessionId: row.session_id, canonicalSessionId: row.canonical_session_id ?? row.session_id, requestId: input.requestId, state: row.state, expiresAt: new Date(row.expires_at) } }
    }
    const reservation = await client.query('SELECT id FROM quota_reservations WHERE user_id = $1 AND request_id = $2', [input.userId, input.requestId])
    const active = ['running','busy','retry','idle','waiting','waiting_approval','waiting_question'].includes(policy.status ?? '')
    if (!active || reservation.rows[0]) {
      const decision = await reserveConcurrentSessionInTransaction(client, { ...input, operation: 'resume', commandHash: hash })
      await client.query('COMMIT')
      return { kind: 'resume', decision }
    }
    const admission: ContinueAdmission = { id: randomUUID(), userId: input.userId, daemonId: input.daemonId, sessionId: input.sessionId, requestId: input.requestId, state: 'issued', expiresAt: new Date(Date.now() + 20_000) }
    await client.query(`INSERT INTO session_message_admissions(id,user_id,daemon_id,session_id,request_id,msg_id,command_hash,expires_at,canonical_session_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$4)`, [admission.id,input.userId,input.daemonId,input.sessionId,input.requestId,msgId,hash,admission.expiresAt])
    await client.query('COMMIT')
    return { kind: 'continue', admission, reused: false }
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}

export async function recoverContinueAdmission(pool: pg.Pool, input: { userId: number; daemonId: string; sessionId: string; requestId: string }, msgId?: string | null, outcome: 'session_active' | 'accepted' | 'rejected' = 'session_active'): Promise<ContinueAdmission | null> {
  const result = await pool.query(`SELECT a.* FROM session_message_admissions a
    WHERE a.user_id = $1 AND a.request_id = $2`, [input.userId,input.requestId])
  const row = result.rows[0]
  if (!row) return null
  if (row.daemon_id !== input.daemonId || ![row.session_id,row.canonical_session_id,...(row.session_aliases ?? [])].includes(input.sessionId) || ['user_deleted','daemon_deleted'].includes(row.outcome) || (row.outcome === 'rejected' && outcome !== 'rejected') || (['accepted','session_active'].includes(row.outcome) && outcome === 'rejected') || (msgId !== undefined && row.msg_id !== msgId)) throw new QuotaReservationBindingError()
  // expires_at authorizes starting execution, not durable replay of its outcome.
  return { id: row.id, ...input, sessionId: row.session_id, canonicalSessionId: row.canonical_session_id ?? row.session_id, state: row.state, expiresAt: new Date(row.expires_at) }
}

export async function completeContinueAdmission(pool: pg.Pool, admission: ContinueAdmission, outcome: 'session_active' | 'accepted' | 'rejected' = 'session_active'): Promise<void> {
  const result = await pool.query(`UPDATE session_message_admissions a
    SET state = CASE WHEN $6 = 'accepted' AND NOT EXISTS (
      SELECT 1 FROM sessions WHERE session_id = COALESCE(a.canonical_session_id,a.session_id) AND status IN ('running','busy','retry','idle','waiting','waiting_approval','waiting_question')
    ) AND state <> 'completed' THEN 'uncertain' ELSE 'completed' END,
    completed_at = CASE WHEN $6 = 'accepted' AND NOT EXISTS (
      SELECT 1 FROM sessions WHERE session_id = COALESCE(a.canonical_session_id,a.session_id) AND status IN ('running','busy','retry','idle','waiting','waiting_approval','waiting_question')
    ) AND state <> 'completed' THEN NULL ELSE COALESCE(completed_at,NOW()) END,
    outcome = CASE WHEN outcome = 'session_active' THEN outcome ELSE $6 END
    WHERE id = $1 AND user_id = $2 AND daemon_id = $3 AND session_id = $4 AND request_id = $5
      AND (claimed_outcome = $6 OR (claimed_outcome IN ('session_active','accepted') AND $6 IN ('session_active','accepted')))
      AND (outcome IS NULL OR outcome = $6 OR (outcome IN ('session_active','accepted') AND $6 IN ('session_active','accepted')))
      AND EXISTS (SELECT 1 FROM sessions s JOIN daemons d ON d.daemon_id = s.daemon_id
        WHERE s.session_id = COALESCE(a.canonical_session_id,a.session_id) AND s.user_id = a.user_id AND s.daemon_id = a.daemon_id AND d.user_id = a.user_id)
      AND NOT EXISTS (SELECT 1 FROM deleted_sessions WHERE session_id = COALESCE(a.canonical_session_id,a.session_id))
    RETURNING id`, [admission.id,admission.userId,admission.daemonId,admission.sessionId,admission.requestId,outcome])
  if (!result.rows[0]) throw new QuotaReservationBindingError()
}

/** Resolve only this exact previously issued request, never a generic alias. */
export async function resolveMessageSessionId(pool: pg.Pool, userId: number, command: Record<string,unknown>): Promise<string | null> {
  const requestId = command.request_id || command.msg_id
  if (typeof requestId !== 'string' || typeof command.session_id !== 'string') return null
  const result = await pool.query('SELECT * FROM session_message_admissions WHERE user_id = $1 AND request_id = $2',[userId,requestId])
  const row = result.rows[0]
  if (!row || ![row.session_id,row.canonical_session_id,...(row.session_aliases ?? [])].includes(command.session_id)
    || row.msg_id !== (command.msg_id ?? null)
    || row.command_hash !== messageCommandHash({...command,session_id:row.session_id})) return null
  return row.canonical_session_id ?? row.session_id
}

export class AdmissionSessionMovedError extends Error {}

/** Claim compatibility inside the canonical fence; accounting stays unresolved. */
export async function claimContinueAdmissionOutcome(pool: pg.Pool, admission: ContinueAdmission, outcome: 'accepted' | 'rejected' | 'session_active'): Promise<void> {
  await pool.query('SELECT session_id FROM sessions WHERE session_id=$1 FOR UPDATE',[admission.canonicalSessionId ?? admission.sessionId])
  const row = (await pool.query('SELECT canonical_session_id,session_id FROM session_message_admissions WHERE id=$1 FOR UPDATE',[admission.id])).rows[0]
  if (row && (row.canonical_session_id ?? row.session_id) !== (admission.canonicalSessionId ?? admission.sessionId)) throw new AdmissionSessionMovedError('session renamed during admission recovery')
  const result = await pool.query(`UPDATE session_message_admissions SET claimed_outcome = CASE WHEN claimed_outcome = 'session_active' THEN claimed_outcome ELSE $6 END
    WHERE id=$1 AND user_id=$2 AND daemon_id=$3 AND session_id=$4 AND request_id=$5
      AND (claimed_outcome IS NULL OR claimed_outcome=$6 OR (claimed_outcome IN ('accepted','session_active') AND $6 IN ('accepted','session_active')))
      AND (outcome IS NULL OR outcome=$6 OR (outcome IN ('accepted','session_active') AND $6 IN ('accepted','session_active')))
    RETURNING id`,[admission.id,admission.userId,admission.daemonId,admission.sessionId,admission.requestId,outcome])
  if (!result.rows[0]) throw new QuotaReservationBindingError()
}

/** Keep canonical resolution stable through one status + ledger mutation. */
export async function mutateContinueAdmissionSession<T>(
  pool: pg.Pool,
  admission: ContinueAdmission,
  mutate: (client: pg.Pool, sessionId: string) => Promise<T>,
): Promise<{ sessionId: string; value: T }> {
  const ownsTransaction = typeof pool.connect === 'function' && !('release' in pool)
  const run = async (client: pg.PoolClient): Promise<{ sessionId: string; value: T }> => {
    const params = [admission.id, admission.userId, admission.daemonId, admission.sessionId, admission.requestId]
    const bindingSQL = `SELECT COALESCE(canonical_session_id, session_id) AS canonical
      FROM session_message_admissions
      WHERE id = $1 AND user_id = $2 AND daemon_id = $3 AND session_id = $4 AND request_id = $5`
    const initial = (await client.query(bindingSQL, params)).rows[0]
    if (!initial) throw new QuotaReservationBindingError()
    const canonical = String(initial.canonical)
    // Rename locks sessions before admissions. If it won while we waited,
    // detect its new mapping before invoking the missing-target ledger logic.
    await client.query('SELECT session_id FROM sessions WHERE session_id = $1 FOR UPDATE', [canonical])
    const locked = (await client.query(bindingSQL + ' FOR UPDATE', params)).rows[0]
    if (!locked) throw new QuotaReservationBindingError()
    if (locked.canonical !== canonical) {
      throw new AdmissionSessionMovedError('session renamed before status mutation')
    }
    const scoped = client as unknown as pg.Pool
    if (await isSessionDeleted(scoped, canonical)) throw new UnknownDaemonSessionError()
    return { sessionId: canonical, value: await mutate(scoped, canonical) }
  }
  if (!ownsTransaction) return run(pool as unknown as pg.PoolClient)
  for (let attempt = 0; attempt < 3; attempt++) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await run(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      if (!(error instanceof AdmissionSessionMovedError) || attempt === 2) throw error
    } finally { client.release() }
  }
  throw new AdmissionSessionMovedError('session identity did not stabilize before status mutation')
}
