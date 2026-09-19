import type { PacketSourceEvent } from './packet.js'

const TEXT_EVENTS = new Set(['agent_text', 'user_message', 'user_text', 'user_goal'])

/**
 * Project streams before applying packet budgets. Keep the authoritative
 * source event as the evidence anchor; never attribute synthetic concatenated
 * text to a delta event. Part identity survives Codex correction stream IDs.
 * Unfinished delta-only streams are not safe claim evidence.
 */
export function collapseStreamEvents(events: readonly PacketSourceEvent[]): PacketSourceEvent[] {
  const groups = new Map<string, PacketSourceEvent[]>()
  const result: PacketSourceEvent[] = []
  for (const event of events) {
    const p = event.payload
    if (!TEXT_EVENTS.has(event.event_type) && event.event_type !== 'tool_result') {
      result.push(event)
      continue
    }
    const part = typeof p.part_id === 'string' && p.part_id ? `part:${p.part_id}`
      : typeof p.stream_id === 'string' && p.stream_id ? `stream:${p.stream_id}` : null
    if (!part) {
      if (p.streaming !== true || p.final === true) result.push(withSnapshot(event))
      continue
    }
    const key = JSON.stringify([event.event_type, p.session_id, p.turn_id, p.agent_id, p.message_id, part])
    const group = groups.get(key) ?? []
    group.push(event)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    // Revisions, not UUIDs or timestamp ties, define ordering within a part.
    group.sort((a, b) => revision(a) - revision(b) || compareEvents(a, b))
    const finals = group.filter(event => event.payload.final === true)
    const selected = finals.at(-1) ?? group.at(-1)!
    if (selected.payload.streaming === true && selected.payload.final !== true) continue
    result.push(withSnapshot(selected))
  }
  return result.sort(compareEvents)
}

function revision(event: PacketSourceEvent): number {
  return typeof event.payload.revision === 'number' && Number.isFinite(event.payload.revision)
    ? event.payload.revision : 0
}

function compareEvents(a: PacketSourceEvent, b: PacketSourceEvent): number {
  return a.occurred_at.getTime() - b.occurred_at.getTime()
    || (a.source_event_id < b.source_event_id ? -1 : a.source_event_id > b.source_event_id ? 1 : 0)
}

function withSnapshot(event: PacketSourceEvent): PacketSourceEvent {
  if (!TEXT_EVENTS.has(event.event_type) || typeof event.payload.snapshot !== 'string') return event
  return { ...event, payload: { ...event.payload, text: event.payload.snapshot } }
}
