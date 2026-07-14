export type OpenCodeStructuredType = 'agent_file' | 'agent_patch' | 'agent_todo' | 'agent_subtask' | 'agent_profile'

export interface OpenCodeStructuredEvent {
  type: OpenCodeStructuredType
  session_id?: string
  message_id?: string
  part_id?: string
  [key: string]: unknown
}

export type StructuredMergeResult = 'inserted' | 'updated' | 'ignored'

export function structuredPartKey(event: OpenCodeStructuredEvent): string {
  if (event.part_id) return `${event.type}:${event.part_id}`
  if (event.type === 'agent_todo' && event.session_id) return `agent_todo:${event.session_id}`
  return ''
}

/** Upserts immutable OpenCode Parts and replaces the mutable session Todo snapshot. */
export function mergeStructuredPart(target: any[], event: OpenCodeStructuredEvent): StructuredMergeResult {
  const partKey = structuredPartKey(event)
  const existing = partKey ? target.find((message) => message.partKey === partKey) : undefined
  if (existing) {
    if (event.type !== 'agent_todo') return 'ignored'
    Object.assign(existing, event, {
      type: event.type,
      partKey,
      partId: event.part_id,
      messageId: event.message_id,
      todos: Array.isArray(event.todos) ? event.todos : [],
    })
    return 'updated'
  }

  target.push({
    ...event,
    id: partKey || undefined,
    role: 'agent',
    partKey,
    partId: event.part_id,
    messageId: event.message_id,
    todos: event.type === 'agent_todo' && !Array.isArray(event.todos) ? [] : event.todos,
  })
  return 'inserted'
}
