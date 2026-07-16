export type OpenCodeStructuredType = 'agent_file' | 'agent_patch' | 'agent_todo' | 'agent_subtask' | 'agent_profile'

export interface OpenCodeStructuredEvent {
  type: OpenCodeStructuredType
  session_id?: string
  message_id?: string
  part_id?: string
  event_id?: string
  previous_event_id?: string
  [key: string]: unknown
}

export type StructuredMergeResult = 'inserted' | 'updated' | 'deferred' | 'ignored'

const MAX_DEFERRED_STRUCTURED_EVENTS = 32

function enqueueDeferredStructuredEvent(deferred: OpenCodeStructuredEvent[], event: OpenCodeStructuredEvent): void {
  if (deferred.some(item => item.event_id === event.event_id)) return
  deferred.push({ ...event })
  if (deferred.length <= MAX_DEFERRED_STRUCTURED_EVENTS) return
  const removableIndex = deferred.findIndex(item =>
    deferred.some(successor => successor.previous_event_id === item.event_id),
  )
  if (removableIndex < 0) {
    deferred.pop()
    return
  }
  const removable = deferred[removableIndex]
  const successor = deferred.find(item => item.previous_event_id === removable.event_id)!
  successor.previous_event_id = removable.previous_event_id
  deferred.splice(removableIndex, 1)
}

function applyStructuredEvent(existing: any, event: OpenCodeStructuredEvent, partKey: string): void {
  Object.assign(existing, event, {
    type: event.type,
    partKey,
    partId: event.part_id,
    messageId: event.message_id,
    eventId: event.event_id,
    todos: Array.isArray(event.todos) ? event.todos : [],
  })
}

function drainDeferredStructuredEvents(existing: any, partKey: string): void {
  const deferred = existing._deferredStructuredEvents as OpenCodeStructuredEvent[] | undefined
  if (!deferred?.length) return
  while (existing.eventId) {
    const index = deferred.findIndex(event => event.previous_event_id === existing.eventId)
    if (index < 0) break
    const [successor] = deferred.splice(index, 1)
    applyStructuredEvent(existing, successor, partKey)
  }
  if (!deferred.length) delete existing._deferredStructuredEvents
}

export function structuredPartKey(event: OpenCodeStructuredEvent): string {
  if (event.part_id) return `${event.type}:${event.part_id}`
  if (event.type === 'agent_todo' && event.session_id) return `agent_todo:${event.session_id}`
  return ''
}

/** Upserts causally ordered OpenCode Part and Todo snapshots. */
export function mergeStructuredPart(target: any[], event: OpenCodeStructuredEvent): StructuredMergeResult {
  const partKey = structuredPartKey(event)
  const existing = partKey ? target.find((message) => message.partKey === partKey) : undefined
  if (existing) {
    const eventId = event.event_id
    let causalSuccessor = false
    if (eventId && !existing.eventId) {
      applyStructuredEvent(existing, event, partKey)
      drainDeferredStructuredEvents(existing, partKey)
      return 'updated'
    }
    if (eventId && existing.eventId) {
      if (eventId === existing.eventId) return 'ignored'
      if (event.previous_event_id !== existing.eventId) {
        if (event.previous_event_id) {
          const deferred = (existing._deferredStructuredEvents ??= []) as OpenCodeStructuredEvent[]
          enqueueDeferredStructuredEvent(deferred, event)
          return 'deferred'
        }
        return 'ignored'
      }
      causalSuccessor = true
    }
    if (!causalSuccessor && event.type !== 'agent_todo') return 'ignored'
    applyStructuredEvent(existing, event, partKey)
    drainDeferredStructuredEvents(existing, partKey)
    return 'updated'
  }

  target.push({
    ...event,
    id: partKey || undefined,
    role: 'agent',
    partKey,
    partId: event.part_id,
    messageId: event.message_id,
    eventId: event.event_id,
    todos: event.type === 'agent_todo' && !Array.isArray(event.todos) ? [] : event.todos,
  })
  return 'inserted'
}
