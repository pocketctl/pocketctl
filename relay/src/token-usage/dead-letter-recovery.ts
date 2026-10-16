import type pg from 'pg'
import { lockSessionMaterializationFence } from '../db.js'

export interface TokenDeadLetterCandidate {
  inbox_id: string
  session_id: string
  date: string
  attempts: number
  received_at: Date
}

const candidates = `SELECT i.inbox_id::text, i.session_id,
  (i.received_at AT TIME ZONE 'UTC')::date::text AS date, i.attempts, i.received_at
 FROM event_inbox i
 JOIN sessions s ON s.session_id=i.session_id
 WHERE i.inbox_id=ANY($1::bigint[]) AND i.status=3
   AND i.last_error='unknown_daemon_session' AND i.materialized_event_id IS NULL
   AND i.user_id IS NOT NULL AND s.user_id=i.user_id AND s.daemon_id=i.daemon_id
   AND NOT EXISTS (SELECT 1 FROM deleted_sessions d WHERE d.session_id=i.session_id)
   AND EXISTS (SELECT 1 FROM token_usage_accounting_state b
     WHERE b.key='baseline-v1' AND i.received_at>=b.completed_at)
   AND i.event_type='agent_text' AND i.payload->>'type'='agent_text'
   AND i.payload->>'session_id'=i.session_id
   AND jsonb_typeof(i.payload->'usage')='object'
   AND i.payload->'resync'='true'::jsonb
   AND jsonb_typeof(i.payload->'event_id')='string' AND length(i.payload->>'event_id')>0
   AND NOT (i.payload ? 'request_id')
   AND (i.materialization_context - ARRAY['agentType','cwd','hostname','reservationId'])='{}'::jsonb
   AND (i.materialization_context->>'reservationId') IS NULL
   AND (i.received_at AT TIME ZONE 'UTC')::date < (NOW() AT TIME ZONE 'UTC')::date
   AND NOT EXISTS (SELECT 1 FROM token_daily_closures c
     WHERE c.date=(i.received_at AT TIME ZONE 'UTC')::date AND c.status='sealed')
 ORDER BY i.inbox_id`

/** Explicit maintenance only. Original payload/identity/receive time and retry
 * count survive; the normal worker still authorizes, deduplicates and accounts.
 * No session creation, content mutation, direct facts or forced day closure.
 */
export async function recoverOwnedTokenDeadLetters(
  pool: pg.Pool, ids: string[], apply = false,
): Promise<TokenDeadLetterCandidate[]> {
  if (ids.length === 0 || ids.length > 1000 || new Set(ids).size !== ids.length
    || ids.some(id => !/^[1-9][0-9]*$/.test(id))) {
    throw new Error('recovery requires 1..1000 distinct positive inbox ids')
  }
  const client = await pool.connect()
  try {
    await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
    const preview = (await client.query<TokenDeadLetterCandidate>(candidates,[ids])).rows
    if (!apply) { await client.query('COMMIT'); return preview }
    if (preview.length !== ids.length) throw new Error('token recovery preconditions changed')
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('token-usage-accounting-global'))")
    for (const date of [...new Set(preview.map(row => row.date))].sort()) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('token-day-close:' || $1))",[date])
    }
    for (const session of [...new Set(preview.map(row => row.session_id))].sort()) {
      await lockSessionMaterializationFence(client,session)
    }
    const locked = (await client.query<TokenDeadLetterCandidate>(candidates+' FOR UPDATE OF i',[ids])).rows
    if (locked.length !== ids.length) throw new Error('token recovery preconditions changed')
    // Audit and state transition are atomic. Never persist event content here.
    await client.query(`INSERT INTO audit_log(user_id,action,details)
      SELECT user_id,'token_dead_letter_requeue',jsonb_build_object(
        'inbox_id',inbox_id::text,'previous_status',status,'previous_error',last_error,
        'attempts',attempts,'received_at',received_at,'payload_md5',md5(payload::text),
        'policy','owned_usage_replay_v1')
      FROM event_inbox WHERE inbox_id=ANY($1::bigint[])`,[ids])
    const changed=await client.query(`UPDATE event_inbox
      SET status=0,available_at=NOW(),completed_at=NULL,claimed_at=NULL,claimed_by=NULL,last_error=NULL
      WHERE inbox_id=ANY($1::bigint[]) AND status=3`,[ids])
    if (changed.rowCount !== ids.length) throw new Error('token recovery preconditions changed')
    await client.query('COMMIT')
    return locked
  } catch(error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}
