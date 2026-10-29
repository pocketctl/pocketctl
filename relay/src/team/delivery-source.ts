import type pg from 'pg'
import { TeamRepositoryError } from './repository.js'

/** Freeze publication authority for this transaction, not just at job polling.
 * Published Team copies have their own lifetime; this gate applies to new bytes
 * and new publication only. Read/receipt APIs never resurrect the private source. */
export async function requireDeliverySource(db: Pick<pg.PoolClient, 'query'>, taskId: string, teamId: string, actor: number, callId: string, specRevision: number) {
  let source
  try {
    source = (await db.query(`SELECT c.*,o.owner_user_id,o.daemon_id,o.state AS offer_state,o.revision AS current_offer_revision,
        b.state AS binding_state,b.revision AS current_binding_revision,b.native_session_id AS bound_native_session_id,
        s.state AS session_state
      FROM collaboration_calls c
      JOIN team_agent_offers o ON o.offer_id=c.offer_id AND o.team_id=$2
      JOIN collaboration_sessions s ON s.team_session_id=c.team_session_id AND s.team_id=$2
      JOIN collaboration_session_agent_bindings b ON b.binding_id=c.binding_id AND b.team_session_id=c.team_session_id
        AND b.offer_id=c.offer_id AND b.owner_user_id=o.owner_user_id
      JOIN team_call_delivery_specs f ON f.call_id=c.call_id AND f.task_id=c.task_id AND f.spec_revision=$4
      WHERE c.call_id=$1 AND c.task_id=$3 FOR SHARE OF c,o,s,b NOWAIT`, [callId,teamId,taskId,specRevision])).rows[0]
  } catch (error) {
    // Dispatch/binding mutations take a different lock order. Never wait while
    // holding the task lock: let the caller retry its unchanged original intent.
    if ((error as {code?: string}).code === '55P03') throw new TeamRepositoryError('source_busy', 'delivery source is changing; retry original request')
    throw error
  }
  if (!source || Number(source.owner_user_id) !== actor) throw new TeamRepositoryError('offer_owner_required', 'only the source Agent owner can publish its delivery')
  if (source.state !== 'completed' || source.session_state !== 'active' || source.offer_state !== 'active' || source.binding_state !== 'active'
      || !['create','message'].includes(source.operation) || !source.native_session_id || source.native_session_id !== source.bound_native_session_id
      || Number(source.offer_revision) !== Number(source.current_offer_revision) || Number(source.binding_revision) !== Number(source.current_binding_revision)) {
    throw new TeamRepositoryError('invalid_state', 'delivery source is no longer authorized')
  }
  // Same fence as manual/lifecycle deletion; a missing session row can simply
  // mean the native session has not synchronized, but a tombstone is definitive.
  const fence = (await db.query('SELECT pg_try_advisory_xact_lock(1885566061,hashtext($1)) AS held', [source.native_session_id])).rows[0]
  if (!fence?.held) throw new TeamRepositoryError('source_busy', 'source session lifecycle is changing')
  const unavailable = (await db.query(`SELECT 1 FROM deleted_sessions WHERE session_id=$1
    UNION ALL SELECT 1 FROM sessions WHERE session_id=$1 AND
      (user_id IS DISTINCT FROM $2 OR daemon_id IS DISTINCT FROM $3 OR content_state IN ('deleting','deleted')) LIMIT 1`,
    [source.native_session_id,actor,source.daemon_id])).rows[0]
  if (unavailable) throw new TeamRepositoryError('invalid_state', 'source session is no longer available for publication')
  return source
}
