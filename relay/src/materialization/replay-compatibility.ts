import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import { canonicalPayloadHash, parseMemorySourceProvenance } from '@pocketctl/session-source'
import { sanitizeJSONBPayload } from '../jsonb-payload.js'
import { hydratePostgresEventRows, withSessionHistoryScope } from '../session-history/postgres-reader.js'

export class ReplayConflictError extends Error {
  constructor(readonly code: 'replay_payload_conflict' | 'replay_provenance_conflict' | 'replay_canonical_unavailable') {
    super(code)
    this.name = 'ReplayConflictError'
  }
}

/** Match the registered producer contract in memoryEventProducer. */
export function replayMemoryProducer(session: {agent_type?: unknown; source?: unknown; control_mode?: unknown} | null): string | undefined {
  if (!session) return undefined
  if (session.agent_type === 'codex-desktop') return session.source === 'observer' && session.control_mode === 'legacy_read_only' ? 'codex' : undefined
  if (session.agent_type === 'claude-code' || session.agent_type === 'claude') return 'claude'
  return session.agent_type === 'codex' || session.agent_type === 'opencode' ? session.agent_type : undefined
}

/** Producer metadata never upgrades an existing event's provenance. The only
 * asymmetric migrations accepted are an absent proof or an exact historical
 * producer=unknown placeholder followed by an explicitly unknown, incomplete,
 * identity-bound envelope from the registered producer. Canonical proof stays. */
export function assertReplayCompatible(canonical: Record<string, unknown>, raw: Record<string, unknown>, producer?: string): void {
  const incoming = sanitizeJSONBPayload(raw)
  const stable = typeof canonical.event_id === 'string' && canonical.event_id.length > 0
    || typeof canonical.request_id === 'string' && canonical.request_id.length > 0
  // The local TUI witness exists only during live collection. Re-reading the
  // same source record after restart cannot reproduce (or upgrade) it.
  const omitLocalWitness = canonical.type === 'user_text' && incoming.type === 'user_text'
    && (canonical.local_submit_id === undefined || incoming.local_submit_id === undefined)
  const strip = (p: Record<string, unknown>) => Object.fromEntries(Object.entries(p).filter(([k]) =>
    k !== 'memory_source' && !(omitLocalWitness && k === 'local_submit_id') && !(stable && (k === 'seq' || k === 'resync'))))
  if (!isDeepStrictEqual(strip(canonical), strip(incoming))) throw new ReplayConflictError('replay_payload_conflict')
  if (isDeepStrictEqual(canonical.memory_source, incoming.memory_source)) return
  // Older producers may omit an already-established proof. It stays canonical.
  if (incoming.memory_source === undefined) return
  const proof = parseMemorySourceProvenance(incoming.memory_source)
  // This is stampUnknownMemorySource's exact role mapping, not the UI's
  // classification (agent_reasoning and metadata are system observations).
  const role = ['user_text', 'user_message'].includes(String(canonical.type)) ? 'user'
    : ['tool_call', 'tool_result'].includes(String(canonical.type)) ? 'tool'
    : canonical.type === 'agent_text' ? 'assistant' : 'system'
  // Historical producers also persisted the same unknown observation with an
  // unknown producer. Compare every field, including the exact field set;
  // this is replay tolerance, never validation or upgrading of that old proof.
  // A newer history reader can describe why the same negative observation
  // lacks provenance. Compare the original proof fields and keep the first
  // persisted observation, including its producer and diagnostics.
  const historical = incoming.resync === true && (proof?.source_path === undefined ||
    proof.source_path === 'historical_resync' && proof.source_gap_reason === 'historical_replay')
  const coreFields = (p: Record<string, unknown>) => Object.fromEntries(Object.entries(p).filter(([key]) =>
    !['source_path','source_gap_reason','accepted_input_event_id'].includes(key)))
  const saved = canonical.memory_source
  const comparable = historical && parseMemorySourceProvenance(saved)
    ? coreFields(saved as Record<string,unknown>) : saved
  const originalShape = historical && proof ? coreFields({...proof}) : proof
  const legacyPlaceholder = originalShape && (isDeepStrictEqual(comparable, {...originalShape,producer:'unknown'})
    || historical && isDeepStrictEqual(comparable, originalShape))
  if ((canonical.memory_source !== undefined && !legacyPlaceholder) || !proof
    || !isDeepStrictEqual(proof, incoming.memory_source)
    || proof.sequence !== '1' || proof.invocation_id !== proof.turn_id
    || proof.skill_state !== 'unknown' || proof.lineage_complete !== false
    || proof.skill_invocation_id !== undefined || proof.parent_invocation_id !== undefined
    || proof.derived_from_event_ids.length !== 0
    || proof.session_id !== canonical.session_id || proof.event_id !== canonical.event_id
    || proof.turn_id !== (canonical.turn_id ?? canonical.source_turn_id)
    || proof.source_role !== role || proof.producer !== producer) throw new ReplayConflictError('replay_provenance_conflict')
}

/** Caller holds the session fence. Cold content is read from its authenticated
 * archive, never reconstructed from incoming bytes. Re-check the published hash. */
export async function loadReplayCanonicalEvent(pool: Pick<pg.Pool, 'query'>, eventId: number,
  owner: number | null, logicalSession: string, eventType: string, lock = true, incoming?: Record<string, unknown>, rebaseAdmissionSession = false): Promise<{payload: Record<string, unknown>; logicalSession: string}> {
  const row = (await pool.query(`SELECT events.*,id::text,(SELECT jsonb_build_object('agent_type',s.agent_type,'source',s.source,'control_mode',s.control_mode) FROM sessions s WHERE s.session_id=events.session_id) AS replay_session,
    (public.native_session_authority(payload->>'session_id',$2,NULL)->>'sessionId'=$3) AS payload_session_current
    FROM events WHERE id=$1 AND user_id IS NOT DISTINCT FROM $2 AND NOT owner_retired
    AND (logical_source_session_id=$3 OR
      (public.native_event_authority(id,$2)->>'state'='current'
       AND public.native_session_authority($3,$2,NULL)->>'state'='current'
       AND public.native_session_authority($3,$2,NULL)->>'sessionId'=events.session_id)) AND event_type=$4 AND effect_status IN ('none','pending','completed')
    AND (public.native_event_authority(id,$2)->>'state'='current' OR
      (session_id=$3 AND NOT EXISTS(SELECT 1 FROM sessions WHERE session_id=$3)
       AND NOT EXISTS(SELECT 1 FROM session_aliases WHERE old_session_id=$3)
       AND NOT EXISTS(SELECT 1 FROM deleted_sessions WHERE session_id=$3))) ${lock ? 'FOR UPDATE' : ''}`,
    [eventId,owner,logicalSession,eventType])).rows[0]
  if (!row) throw new ReplayConflictError('replay_canonical_unavailable')
  let payload = row.payload
  if (row.body_storage === 'cold') {
    if (!owner) throw new ReplayConflictError('replay_canonical_unavailable')
    const hydrated = await withSessionHistoryScope({userId:owner}, () => hydratePostgresEventRows(pool,row.session_id,[row]))
    payload = hydrated[0]?.payload
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ReplayConflictError('replay_canonical_unavailable')
  if (row.source_header_version != null && (row.source_header_version !== 1
    || canonicalPayloadHash(payload).toString('hex') !== row.canonical_payload_hash))
    throw new ReplayConflictError('replay_canonical_unavailable')
  // Admission recovery rewrites only the trusted route address. Compare it
  // against the original address without changing canonical bytes or proof.
  const comparable = incoming && rebaseAdmissionSession && row.payload_session_current === true
    && incoming.session_id === logicalSession && typeof payload.session_id === 'string'
    ? {...incoming,session_id:payload.session_id} : incoming
  if (comparable) assertReplayCompatible(payload, comparable, replayMemoryProducer(row.replay_session))
  return {payload,logicalSession:row.logical_source_session_id}
}

/** Recovery callers retain strict payload comparison and the original body. */
export async function loadReplayCanonical(pool: Pick<pg.Pool, 'query'>, eventId: number,
  owner: number | null, logicalSession: string, eventType: string, lock = true, incoming?: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await loadReplayCanonicalEvent(pool,eventId,owner,logicalSession,eventType,lock,incoming)).payload
}
