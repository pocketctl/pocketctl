import type { Pool } from 'pg'
import { parseMemorySourceProvenance } from '@pocketctl/session-source'
import { createHash } from 'node:crypto'
import type { MaterializationInput } from '../materialization/types.js'
import { platformStatisticsConfig } from './config.js'

type Query = Pick<Pool, 'query'>
export async function recordRegistration(client: Query, userId: number, occurredAt: Date | string): Promise<void> {
  const config = platformStatisticsConfig()
  if (!config.enabled) return
  if (!config.valid) throw new Error('Invalid platform statistics exclusion configuration')
  await client.query(`INSERT INTO platform_statistics_facts(kind,source_id,user_id,occurred_at)
    VALUES('registration',$1,$2,$3) ON CONFLICT DO NOTHING`, [`registration:${userId}`, userId, occurredAt])
}

/** Resolve only an owned, acyclic main session; never trust a daemon root ID. */
async function canonicalSession(client: Query, userId: number, sessionId: string, allowCreate = false): Promise<string | null> {
  const result = await client.query<{ session_id: string; parent_session_id: string | null; is_subagent: boolean; depth: number }>(`
    WITH RECURSIVE chain AS (
      SELECT session_id,parent_session_id,is_subagent,ARRAY[session_id::text] AS path,0 AS depth
      FROM sessions WHERE session_id=$1 AND user_id=$2
      UNION ALL
      SELECT s.session_id,s.parent_session_id,s.is_subagent,c.path || s.session_id::text,c.depth+1
      FROM sessions s JOIN chain c ON s.session_id=c.parent_session_id
      WHERE s.user_id=$2 AND c.depth<32 AND NOT s.session_id::text=ANY(c.path)
    ) SELECT session_id,parent_session_id,is_subagent,depth FROM chain ORDER BY depth DESC LIMIT 1`, [sessionId, userId])
  const row = result.rows[0]
  if (row) return !row.parent_session_id && row.is_subagent !== true ? row.session_id : null
  if (!allowCreate) return null
  const existing = await client.query('SELECT 1 FROM sessions WHERE session_id=$1', [sessionId])
  return existing.rows.length === 0 ? sessionId : null
}

async function insertActivity(client: Query, source: string, userId: number, sessionId: string, occurredAt: Date, human: boolean): Promise<void> {
  await client.query(`INSERT INTO platform_statistics_facts(kind,source_id,user_id,session_id,occurred_at)
    SELECT kind,$1,$2,$3,$4 FROM unnest($5::text[]) kind ON CONFLICT DO NOTHING`,
  [source, userId, sessionId, occurredAt, human ? ['human', 'session'] : ['session']])
}

// An authenticated daemon can attest either a TUI submission or the exact
// input acknowledged by the native Codex runtime. A user-shaped echo alone
// does not distinguish local input from an agent, workflow or history replay.
function localInputSource(input: MaterializationInput): string | null {
  const p = input.payload
  if (input.eventType !== 'user_text' || p.actor_scope !== 'root' || p.flow_scope !== 'main'
    || p.content_class !== 'dialogue' || p.agent_id || p.is_subagent === true
    || typeof p.text !== 'string' || !p.text.trim()) return null
  if (typeof p.local_submit_id === 'string' && /^codex-tui:[a-f0-9]{64}$/.test(p.local_submit_id)) return p.local_submit_id
  const proof = parseMemorySourceProvenance(p.memory_source)
  if (!proof || proof.producer !== 'codex' || proof.session_id !== input.sessionId || proof.turn_id !== p.turn_id
    || typeof p.source_turn_id !== 'string' || !p.source_turn_id || proof.source_role !== 'user' || proof.skill_state !== 'non_skill' || !proof.lineage_complete
    || proof.parent_invocation_id || proof.skill_invocation_id || proof.derived_from_event_ids.length
    || typeof p.request_id !== 'string' || !p.request_id || typeof p.msg_id !== 'string' || !p.msg_id
    || p.event_id !== `native-input:${p.msg_id}`) return null
  const id = 'input:' + createHash('sha256').update([input.sessionId, p.request_id, p.msg_id].join('\0')).digest('hex')
  return proof.event_id === id && proof.invocation_id === id ? p.request_id : null
}

/** Called in the same fence transaction as canonical event persistence. */
export async function recordMaterializedActivity(client: Query, input: MaterializationInput, eventId: number): Promise<void> {
  const config = platformStatisticsConfig()
  if (!config.enabled) return
  if (!config.valid) throw new Error('Invalid platform statistics exclusion configuration')
  if (input.userId === null || !input.sessionId || !input.receivedAt || input.payload.resync === true) return
  const local = localInputSource(input)
  const acceptedReceipt = input.eventType === 'user_message_receipt' && input.payload.status === 'accepted' && Boolean(input.context?.admission)
  const created = input.eventType === 'session_created' && input.context?.quotaOperation === 'create' && Boolean(input.context.requestId)
  const resumed = input.eventType === 'session_status' && Boolean(input.context?.requestId)
    && (input.context?.quotaOperation === 'resume' || Boolean(input.context?.admission))
    && ['running', 'busy', 'retry', 'idle', 'waiting', 'waiting_approval', 'waiting_question'].includes(String(input.payload.status))
  const agentOutput = input.eventType === 'agent_text' && input.payload.content_class !== 'telemetry'
    && [input.payload.text, input.payload.snapshot].some(value => typeof value === 'string' && value.trim().length > 0)
  if (!(acceptedReceipt || created || resumed || agentOutput || local)) return
  const canonical = local
    ? (await client.query<{ session_id: string }>(`SELECT session_id FROM sessions
        WHERE user_id=$1 AND session_id=$2 AND parent_session_id IS NULL AND is_subagent IS NOT TRUE
        AND agent_type IN ('codex','codex-desktop')`, [input.userId, input.sessionId])).rows[0]?.session_id
    : await canonicalSession(client, input.userId, input.sessionId, created)
  if (!canonical) return
  const requestId = acceptedReceipt ? input.context!.admission!.requestId : local ?? input.context?.requestId
  const source = (created || resumed || acceptedReceipt || local)
    ? `request:${createHash('sha256').update(JSON.stringify([input.userId, canonical, requestId])).digest('hex')}`
    : `event:${eventId}`
  await insertActivity(client, source, input.userId, canonical, input.receivedAt, !agentOutput)
}

/** Accepted authenticated human decision, transport/outbox admission only. */
export async function recordHumanDecision(client: Query, input: { userId: number; sessionId: string; requestId: string; type: string }, now = new Date()): Promise<void> {
  const config = platformStatisticsConfig()
  if (!config.enabled) return
  if (!config.valid) throw new Error('Invalid platform statistics exclusion configuration')
  if (!['approval_response', 'question_response', 'question_reject', 'interactive_response'].includes(input.type)
    || !input.requestId || input.requestId.length > 128) return
  const canonical = await canonicalSession(client, input.userId, input.sessionId)
  if (!canonical) return
  const source = `decision:${createHash('sha256').update(JSON.stringify([input.userId,input.sessionId,input.requestId,input.type])).digest('hex')}`
  await insertActivity(client, source, input.userId, canonical, now, true)
}
