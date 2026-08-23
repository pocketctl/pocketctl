export interface ReplaySessionTrustContext {
  key: string
  currentSessionId: string
}

type ReplayEvent = Record<string, any>

function eventValue(event: ReplayEvent, key: string): unknown {
  if (event[key] !== undefined && event[key] !== null) return event[key]
  const payload = event.payload
  return payload && typeof payload === 'object' ? payload[key] : undefined
}

function eventSessionId(event: ReplayEvent): unknown {
  return eventValue(event, 'session_id')
}

function sessionIdChange(event: ReplayEvent): { oldId: string; newId: string } | undefined {
  const type = event.type ?? event.event_type ?? eventValue(event, 'type') ?? eventValue(event, 'event_type')
  if (type !== 'session_id_changed') return undefined
  const oldId = eventValue(event, 'old_session_id')
  const newId = eventValue(event, 'session_id')
  if (typeof oldId !== 'string' || !oldId || typeof newId !== 'string' || !newId) return undefined
  return { oldId, newId }
}

/**
 * Buffers one correlated replay request while deriving the smallest trusted
 * session-ID set reachable from its current ID through explicit
 * session_id_changed edges.
 *
 * Progressive replay drains only a fully trusted prefix. An unresolved event
 * therefore acts as an ordering barrier until a later batch links its ID; at
 * replay_end, still-unlinked events are discarded and the remaining trusted
 * suffix is emitted in its original source order.
 */
export class ReplaySessionTrustBuffer<T extends ReplayEvent> {
  private contextKey = ''
  private currentSessionId = ''
  private acceptedSessionIds = new Set<string>()
  private items: T[] = []

  append(context: ReplaySessionTrustContext, events: T[]): void {
    this.ensureContext(context)
    this.items.push(...events)
  }

  takeReady(context: ReplaySessionTrustContext): T[] {
    this.ensureContext(context)
    this.expandAliases()
    let readyCount = 0
    while (readyCount < this.items.length && this.accepts(this.items[readyCount])) readyCount++
    return this.items.splice(0, readyCount)
  }

  takeFinal(context: ReplaySessionTrustContext): T[] {
    this.ensureContext(context)
    this.expandAliases()
    const trusted = this.items.filter(event => this.accepts(event))
    // The request page is complete, but aliases established by an explicit
    // session_id_changed edge remain valid for older pages in the same load.
    // Drop only buffered rows; a context reset owns trust invalidation.
    this.items = []
    return trusted
  }

  reset(): void {
    this.contextKey = ''
    this.currentSessionId = ''
    this.acceptedSessionIds.clear()
    this.items = []
  }

  private ensureContext(context: ReplaySessionTrustContext): void {
    if (this.contextKey === context.key && this.currentSessionId === context.currentSessionId) return
    this.contextKey = context.key
    this.currentSessionId = context.currentSessionId
    this.acceptedSessionIds = new Set(context.currentSessionId ? [context.currentSessionId] : [])
    this.items = []
  }

  private expandAliases(): void {
    let changed = true
    while (changed) {
      changed = false
      for (const event of this.items) {
        const edge = sessionIdChange(event)
        if (!edge || !this.acceptedSessionIds.has(edge.newId)) continue
        if (!this.acceptedSessionIds.has(edge.oldId)) {
          this.acceptedSessionIds.add(edge.oldId)
          changed = true
        }
      }
    }
  }

  private accepts(event: T): boolean {
    const id = eventSessionId(event)
    if (id === undefined || id === null) return true
    return typeof id === 'string' && this.acceptedSessionIds.has(id)
  }
}
