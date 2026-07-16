export interface RevisionedPartEvent {
  type: 'agent_text' | 'agent_reasoning'
  text?: string
  snapshot?: string
  message_id?: string
  part_id?: string
  revision?: number
  event_id?: string
  previous_event_id?: string
  replace?: boolean
  streaming?: boolean
  usage?: unknown
}

export type PartMergeResult = 'inserted' | 'updated' | 'deferred' | 'ignored' | 'legacy'

const MAX_DEFERRED_PART_EVENTS = 32

function enqueueDeferredPartEvent(deferred: RevisionedPartEvent[], event: RevisionedPartEvent): void {
  if (deferred.some(item => item.event_id === event.event_id)) return
  deferred.push({ ...event })
  if (deferred.length <= MAX_DEFERRED_PART_EVENTS) return
  // Every daemon causal event carries a full snapshot. Compact the oldest
  // link that has a known successor by rewiring that successor to the same
  // predecessor. An isolated event cannot be removed safely: its predecessor
  // may arrive later, so reject only the just-arrived overflow item instead.
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

function applyPartEvent(existing: any, event: RevisionedPartEvent): void {
  if (event.snapshot !== undefined) {
    existing.content = event.snapshot
  } else {
    existing.content = event.replace
      ? (event.text ?? '')
      : `${existing.content ?? ''}${event.text ?? ''}`
  }
  existing.revision = event.revision
  if (event.event_id) existing.eventId = event.event_id
  existing.streaming = event.streaming ?? false
  if (event.message_id) existing.messageId = event.message_id
  if (event.usage) existing.usage = event.usage
}

function drainDeferredPartEvents(existing: any): void {
  const deferred = existing._deferredPartEvents as RevisionedPartEvent[] | undefined
  if (!deferred?.length) return
  while (existing.eventId) {
    const index = deferred.findIndex(event => event.previous_event_id === existing.eventId)
    if (index < 0) break
    const [successor] = deferred.splice(index, 1)
    applyPartEvent(existing, successor)
  }
  if (!deferred.length) delete existing._deferredPartEvents
}

/**
 * Applies an OpenCode mutable Part event to a chat message list. Part identity,
 * rather than list adjacency, lets a text/reasoning Part continue after tool
 * cards have been inserted into the stream.
 */
export function mergeRevisionedPart(target: any[], event: RevisionedPartEvent): PartMergeResult {
  const partId = event.part_id
  const revision = event.revision
  if (!partId || !revision || revision < 1) return 'legacy'

  const existing = target.find((message) => message.partId === partId)
  if (!existing) {
    target.push({
      id: `part:${partId}`,
      type: event.type,
      role: 'agent',
      content: event.snapshot ?? event.text ?? '',
      streaming: event.streaming ?? false,
      messageId: event.message_id,
      partId,
      revision,
      eventId: event.event_id,
      usage: event.usage,
    })
    return 'inserted'
  }

  const eventId = event.event_id
  const previousEventId = event.previous_event_id
  let hasCausalOrder = false
  // A full causal snapshot can safely establish ordering on a legacy record
  // that predates event IDs, even when its local revision is larger.
  if (eventId && !existing.eventId && event.snapshot !== undefined) {
    applyPartEvent(existing, event)
    drainDeferredPartEvents(existing)
    return 'updated'
  }
  if (eventId && existing.eventId) {
    if (eventId === existing.eventId) return 'ignored'
    if (previousEventId !== existing.eventId) {
      if (previousEventId && event.snapshot !== undefined) {
        const deferred = (existing._deferredPartEvents ??= []) as RevisionedPartEvent[]
        enqueueDeferredPartEvent(deferred, event)
        return 'deferred'
      }
      return 'ignored'
    }
    hasCausalOrder = true
  }
  if (!hasCausalOrder && (existing.revision ?? 0) >= revision) {
    return 'ignored'
  }

  applyPartEvent(existing, event)
  drainDeferredPartEvents(existing)
  return 'updated'
}
