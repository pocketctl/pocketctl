import { createHash, randomUUID } from 'crypto'

export interface QueueItem {
  id: string
  content: string
  request_id?: string
  state: 'pending' | 'dispatching' | 'running' | 'unknown' | 'failed'
  started_at?: number
  turn_id?: string
  terminal?: string
}
export interface QueueState {
  version: number
  items: QueueItem[]
  blocked: string
  busy: boolean
  busy_turn_id?: string
  cursor: string
  // Retain content-free idempotency tombstones after execution/cancellation.
  seen: Record<string, string>
}
export function emptyQueue(busy: boolean, cursor: string): QueueState {
  return { version: 0, items: [], blocked: '', busy, cursor, seen: {} }
}

export function mutateQueue(state: QueueState, command: any): void {
  if (command.action === 'enqueue') {
    if (typeof command.item_id !== 'string' || !command.item_id || command.item_id.length > 128
      || typeof command.content !== 'string' || !command.content.trim() || command.content.length > 32768
      || command.content.trimStart().startsWith('/')) {
      throw Error('invalid_request')
    }
    const hash = createHash('sha256').update(command.content).digest('hex')
    if (Object.hasOwn(state.seen, command.item_id)) {
      if (state.seen[command.item_id] !== hash) throw Error('request_id_conflict')
      return
    }
    if (state.items.length >= 50 || Object.keys(state.seen).length >= 10000) throw Error('queue_limit')
    state.items.push({ id: command.item_id, content: command.content, state: 'pending' })
    Object.defineProperty(state.seen, command.item_id, { value: hash, enumerable: true, configurable: true, writable: true })
  } else {
    if (command.version !== state.version) throw Error('queue_changed')
    if (command.action === 'cancel') {
      const item = state.items.find(i => i.id === command.item_id)
      if (!item || !['pending', 'failed'].includes(item.state)) throw Error('already_started')
      state.items = state.items.filter(i => i !== item)
    } else if (command.action === 'reorder') {
      const movable = state.items.filter(i => i.state === 'pending')
      const ids = command.item_ids
      if (!Array.isArray(ids) || ids.length !== movable.length || new Set(ids).size !== ids.length
        || ids.some(id => !movable.some(i => i.id === id))) throw Error('queue_changed')
      let n = 0
      const sorted = ids.map(id => movable.find(i => i.id === id)!)
      state.items = state.items.map(i => i.state === 'pending' ? sorted[n++] : i)
    } else if (command.action === 'resume') {
      if (state.items.some(i => ['unknown', 'dispatching', 'running'].includes(i.state))) throw Error('execution_unresolved')
      state.blocked = ''
      for (const item of state.items) {
        item.state = 'pending'
        delete item.request_id
        delete item.turn_id
        delete item.terminal
        delete item.started_at
      }
    } else throw Error('invalid_request')
  }
  state.version++
}

export function reduceQueueEvent(state: QueueState, event: any): void {
  const p = event.payload
  if (!p || p.agent_id || p.is_subagent || p.actor_scope === 'subagent' || p.resync) return
  const active = state.items.find(i => i.request_id && ['dispatching', 'running', 'unknown'].includes(i.state))
  if (event.event_type === 'turn_status' && p.turn_id) {
    if (['running', 'waiting_approval', 'waiting_question', 'interrupt_requested'].includes(p.turn_status)) {
      state.busy = true
      state.busy_turn_id = p.turn_id
      if (active && !active.turn_id) active.turn_id = p.turn_id
    } else if (['completed', 'failed', 'interrupted', 'abandoned'].includes(p.turn_status)) {
      // Late terminals from an older turn cannot release a newer running turn.
      if (!state.busy_turn_id || state.busy_turn_id === p.turn_id) {
        state.busy = false
        delete state.busy_turn_id
        if (p.turn_status !== 'completed') state.blocked = p.turn_status
      }
      if (active && active.turn_id === p.turn_id) active.terminal = p.turn_status
    }
  }
  if (active && p.request_id === active.request_id) {
    if (event.event_type === 'queue_dispatch_started') {
      active.state = 'running'
      if (state.blocked === 'execution_unresolved') state.blocked = ''
    }
    if (event.event_type === 'user_message_receipt' && p.status === 'rejected') {
      active.state = 'failed'
      state.blocked = p.reason || 'rejected'
    }
    if (event.event_type === 'error') {
      active.state = 'unknown'
      state.blocked = 'execution_unresolved'
    }
  }
  // A send acknowledgement alone is never execution completion. Both the
  // correlated dispatch result and a root terminal are required, in either order.
  if (active?.state === 'running' && active.terminal) {
    state.items = state.items.filter(i => i !== active)
    if (active.terminal !== 'completed') state.blocked = active.terminal
  }
}

export function claimQueue(state: QueueState, online: boolean, now = Date.now()): QueueItem | undefined {
  for (const item of state.items) {
    if (item.state === 'dispatching' && now - (item.started_at ?? now) > 30000) {
      item.state = 'unknown'
      state.blocked = 'execution_unresolved'
      state.version++
    }
  }
  if (!online || state.busy || state.blocked || state.items.some(i => i.state !== 'pending')) return
  const item = state.items[0]
  if (!item) return
  item.state = 'dispatching'
  item.request_id = randomUUID()
  item.started_at = now
  state.version++
  return { ...item }
}
