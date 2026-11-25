/** Metadata supplied by the authenticated producer/projector, never inferred
 * from dialogue or model output. Parsing validates shape, not authenticity;
 * callers must read the persisted source_provenance channel only. */
const sourcePaths = ['managed_dispatch', 'readonly_observation', 'historical_resync'] as const
const sourceGapReasons = [
  'historical_replay', 'native_metadata_unavailable', 'no_live_dispatch_binding', 'dispatch_mismatch',
  'sidechain', 'native_record_missing', 'record_limit', 'dispatch_pending', 'native_user_root_unconfirmed',
  'native_root_mismatch', 'turn_mismatch', 'native_parent_missing', 'native_lineage_incomplete',
  'dispatch_unconfirmed', 'dispatch_buffer_overflow', 'accepted_input_without_output_binding',
  'codex_history_unavailable', 'codex_inventory_incomplete', 'codex_input_unconfirmed',
  'codex_final_unconfirmed', 'codex_operation_unverified',
] as const
export type SourceGapReason = typeof sourceGapReasons[number]

export interface MemorySourceProvenance {
  version: 1
  source_path?: typeof sourcePaths[number]
  source_gap_reason?: SourceGapReason
  accepted_input_event_id?: string
  producer: 'codex' | 'opencode' | 'claude'
  session_id: string
  turn_id: string
  event_id: string
  sequence: string
  invocation_id: string
  parent_invocation_id?: string
  source_role: 'user' | 'assistant' | 'tool' | 'summary' | 'system'
  skill_state: 'non_skill' | 'skill' | 'unknown'
  skill_invocation_id?: string
  lineage_complete: boolean
  derived_from_event_ids: string[]
}
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(v)
const member = <T extends string>(v: unknown, values: readonly T[]): v is T => typeof v === 'string' && values.includes(v as T)
export function parseMemorySourceProvenance(raw: unknown): MemorySourceProvenance | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const p = raw as Record<string, unknown>
  if (p.version !== 1 || !member(p.producer, ['codex', 'opencode', 'claude'] as const)
    || (p.source_path !== undefined && !member(p.source_path, sourcePaths))
    || (p.source_gap_reason !== undefined && (!p.source_path || p.lineage_complete !== false
      || !member(p.source_gap_reason, sourceGapReasons)))
    || ((p.source_path === 'historical_resync' || p.source_path === 'readonly_observation')
      && (p.lineage_complete !== false || p.skill_state === 'non_skill'))
    || (p.accepted_input_event_id !== undefined && (p.source_path !== 'managed_dispatch'
      || typeof p.accepted_input_event_id !== 'string' || !/^input:[a-f0-9]{64}$/.test(p.accepted_input_event_id)))
    || !identifier(p.session_id) || !identifier(p.turn_id) || !identifier(p.event_id)
    || !identifier(p.invocation_id) || typeof p.sequence !== 'string' || !/^[1-9][0-9]{0,19}$/.test(p.sequence)
    || !member(p.source_role, ['user', 'assistant', 'tool', 'summary', 'system'] as const)
    || !member(p.skill_state, ['non_skill', 'skill', 'unknown'] as const)
    || typeof p.lineage_complete !== 'boolean'
    || (p.parent_invocation_id !== undefined && !identifier(p.parent_invocation_id))
    || (p.skill_invocation_id !== undefined && !identifier(p.skill_invocation_id))
    || !Array.isArray(p.derived_from_event_ids) || p.derived_from_event_ids.length > 32
    || !p.derived_from_event_ids.every(identifier)) return null
  // Allowlist fields; arbitrary metadata must not reach the evidence manifest.
  return { version: 1, producer: p.producer, session_id: p.session_id, turn_id: p.turn_id,
    ...(p.source_path && {source_path: p.source_path}),
    ...(p.source_gap_reason && {source_gap_reason: p.source_gap_reason}),
    ...(p.accepted_input_event_id && {accepted_input_event_id: p.accepted_input_event_id}),
    event_id: p.event_id, sequence: p.sequence, invocation_id: p.invocation_id,
    ...(p.parent_invocation_id ? { parent_invocation_id: p.parent_invocation_id } : {}),
    source_role: p.source_role, skill_state: p.skill_state,
    ...(p.skill_invocation_id ? { skill_invocation_id: p.skill_invocation_id } : {}),
    lineage_complete: p.lineage_complete, derived_from_event_ids: [...p.derived_from_event_ids] }
}
