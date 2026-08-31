/** Known wire controls that never own a chat-timeline row. */
export const knownNonTimelineControlEventTypes = new Set<string>([
  'websocket_connected', 'connection_restored', 'pong',
  'session_list', 'session_created', 'session_discovered',
  'daemon_list', 'daemon_status', 'command_list',
  'session_agent_list', 'session_agent_changed', 'session_meta',
  'replay_batch', 'replay_end',
  'user_message_ack', 'user_message_nack', 'user_message_receipt',
  'subagent_title_update', 'subagent_usage', 'permission_config_changed',
  'session_title_update', 'session_deleted', 'session_pinned', 'session_id_changed',
])

export function isKnownNonTimelineControlEvent(type: string): boolean {
  return knownNonTimelineControlEventTypes.has(type)
}

type TimelineWireEvent = Record<string, any>

function eventValue(event: TimelineWireEvent, key: string): unknown {
  if (event[key] !== undefined && event[key] !== null) return event[key]
  const payload = event.payload
  return payload && typeof payload === 'object' ? payload[key] : undefined
}

function compactHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** Stable identity for a forward-compatible timeline row. */
export function unknownTimelineEventIdentity(event: TimelineWireEvent, type: string): string {
  const eventId = eventValue(event, 'event_id')
  if (eventId !== undefined && eventId !== null && String(eventId)) return String(eventId)
  const messageId = eventValue(event, 'message_id')
  if (messageId !== undefined && messageId !== null && String(messageId)) return String(messageId)

  const sequence = eventValue(event, 'seq')
  if (sequence === undefined || sequence === null || String(sequence) === '') return ''
  const generation = eventValue(event, 'daemon_generation')
  if (generation !== undefined && generation !== null && String(generation) !== '') {
    return `seq:${String(generation)}:${String(sequence)}`
  }

  // Legacy seq-only relays cannot identify a daemon generation. Normalize the
  // semantic payload so a replay wrapper dedupes while distinct reused-seq
  // events remain visible.
  const semanticFields = [
    'session_id', 'agent_id', 'turn_id', 'part_id', 'stream_id', 'chunk_seq',
    'call_id', 'request_id', 'status', 'text', 'content', 'output',
  ]
  const signature = JSON.stringify([type, ...semanticFields.map(key => eventValue(event, key) ?? null)])
  return `seq:legacy:${String(sequence)}:${compactHash(signature)}`
}
