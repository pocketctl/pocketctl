import type { MaterializationInput } from './types.js'

const liveActivityEvents = new Set([
  'user_text',
  'agent_reasoning',
  'tool_call',
  'tool_result',
  'agent_patch',
  'agent_file',
  'agent_file_change',
  'agent_plan',
  'agent_todo',
  'agent_subtask',
  'agent_profile',
  'approval_request',
  'approval_resolved',
  'question_request',
  'question_resolved',
  'mcp_elicitation_request',
  'mcp_elicitation_resolved',
  'interactive_prompt',
  'agent_retry',
  'agent_compaction',
  'turn_status',
])

function validDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function boundedSourceTime(value: unknown, receivedAt?: Date | null): Date | null {
  const parsed = validDate(value)
  if (!parsed) return null
  if (!receivedAt || Number.isNaN(receivedAt.getTime())) return parsed
  return parsed.getTime() > receivedAt.getTime() ? receivedAt : parsed
}

/**
 * Returns the semantic session activity time represented by a daemon event.
 * Metadata and historical replay are deliberately not activity. Discovery may
 * restore a source snapshot, but never substitutes Relay receipt time.
 */
export function resolveSessionActivityAt(input: MaterializationInput): Date | null {
  const payload = input.payload

  if (input.eventType === 'session_status' || input.eventType === 'session_discovered') {
    return boundedSourceTime(payload.last_activity_at, input.receivedAt)
  }
  if (payload.resync === true) return null
  if (input.eventType === 'session_created') return input.receivedAt ?? null
  if (input.eventType === 'turn_status' && payload.turn_reason === 'daemon_restart_reconcile') return null
  if (input.eventType === 'agent_text') {
    if (payload.content_class === 'telemetry') return null
    const hasBody = [payload.text, payload.snapshot].some(value => typeof value === 'string' && value.length > 0)
    return hasBody ? input.receivedAt ?? null : null
  }
  return liveActivityEvents.has(input.eventType) ? input.receivedAt ?? null : null
}
