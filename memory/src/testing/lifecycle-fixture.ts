import type { PacketSourceEvent } from '../episodes/packet.js'

// Synthetic source lineage only. Never replace this with captured user sessions.
export const lifecyclePacketInput = { installationId: 'installation-1', sessionId: 'session-1', turnId: 'turn-1',
  outcome: 'completed', reason: null, repository: null, artifacts: [], sourcePolicy: 'lifecycle-v1' as const }
export function lifecycleSourceEvent(id: string, text: string, extra: Record<string, unknown> = {}): PacketSourceEvent {
  return { source_event_id: id, event_type: 'agent_text', occurred_at: new Date('2026-11-03T00:00:00Z'),
    payload_hash: Buffer.from(id), payload: { text }, classification: {}, source_provenance: { memory: {
      version: 1, producer: 'codex', session_id: 'session-1', turn_id: 'turn-1', event_id: id,
      sequence: String(Number(id.slice(1))), invocation_id: 'root', source_role: 'assistant',
      skill_state: 'non_skill', lineage_complete: true, derived_from_event_ids: [], ...extra,
    } } }
}
