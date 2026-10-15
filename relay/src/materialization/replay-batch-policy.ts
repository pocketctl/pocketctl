import type { MaterializationInput } from './types.js';
// Only immutable historical content with no business effect may share a batch.
// Lifecycle, interactions, usage, aliases, subagents and unknown types stay on
// the ordinary durable-effect path. This is an optimization, never authority.
const contentTypes = new Set(['tool_result', 'tool_call', 'agent_text', 'agent_reasoning', 'agent_patch', 'agent_file', 'agent_file_change', 'agent_plan', 'agent_todo', 'agent_compaction']);
export const REPLAY_BATCH_MAX_BYTES = 512 * 1024;
export function isSideEffectFreeReplay(input: MaterializationInput): boolean {
  return input.userId !== null && input.userId > 0 && Boolean(input.sessionId)
    && contentTypes.has(input.eventType)
    && input.payload.type === input.eventType && input.payload.session_id === input.sessionId
    && input.payload.resync === true && input.payload.usage == null
    && input.payload.is_subagent !== true && input.payload.request_id == null
    && typeof input.payload.event_id === 'string' && input.payload.event_id.length > 0
    && Object.entries(input.context ?? {}).every(([key, value]) =>
      ['agentType', 'cwd', 'hostname'].includes(key) || (key === 'reservationId' && value == null));
}
