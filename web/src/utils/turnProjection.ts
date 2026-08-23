export interface TurnMessage {
  id?: string | number
  type?: string
  turn_id?: string
  turnId?: string
  turn_status?: string
  turnStatus?: string
  previous_turn_id?: string
  previousTurnId?: string
  continuation_reason?: string
  continuationReason?: string
  flow_scope?: string
  flowScope?: string
  content_class?: string
  contentClass?: string
  status?: string
  [key: string]: unknown
}

export interface LegacyTurnRow<T extends TurnMessage = TurnMessage> {
  kind: 'legacy'
  id: string
  message: T
}

export interface TurnGroup<T extends TurnMessage = TurnMessage> {
  kind: 'turn'
  id: string
  turnId: string
  messages: T[]
  main: T[]
  auxiliary: T[]
  status: string
  previousTurnId: string
  continuedAfterInterrupt: boolean
  interrupted: boolean
}

export type TurnProjectionRow<T extends TurnMessage = TurnMessage> = LegacyTurnRow<T> | TurnGroup<T>

function stringField(message: TurnMessage, camel: string, snake: string): string {
  const value = message[camel] ?? message[snake]
  return typeof value === 'string' ? value.trim() : ''
}

function isPendingInteraction(message: TurnMessage): boolean {
  return ['approval_request', 'question_request', 'mcp_elicitation_request', 'interactive_prompt'].includes(message.type || '')
    && (message.status || 'pending') === 'pending'
}

function isMain(message: TurnMessage): boolean {
  if (isPendingInteraction(message)) return true
  // Classification is optional and forward-compatible. Only the explicitly
  // classified auxiliary lane is collapsible; missing or future values must
  // fail open into the always-visible lane.
  return stringField(message, 'flowScope', 'flow_scope') !== 'auxiliary'
}

function messageIdentity(message: TurnMessage): string {
  return message.id === undefined ? '' : `${typeof message.id}:${String(message.id)}`
}

/**
 * Produces a display-only turn projection for one already-routed message bucket.
 * It never sorts, mutates, deduplicates, or joins messages across buckets.
 */
export function projectTurns<T extends TurnMessage>(messages: readonly T[]): TurnProjectionRow<T>[] {
  const rows: TurnProjectionRow<T>[] = []
  let currentTurnId = ''

  for (const message of messages) {
    const turnId = stringField(message, 'turnId', 'turn_id')
    if (!turnId) {
      rows.push({ kind: 'legacy', id: `legacy:${message.id || rows.length}`, message })
      currentTurnId = ''
      continue
    }

    let group = rows.at(-1)?.kind === 'turn' && currentTurnId === turnId
      ? rows.at(-1) as TurnGroup<T>
      : undefined
    if (!group) {
      group = {
        kind: 'turn', id: '', turnId, messages: [], main: [], auxiliary: [], status: '',
        previousTurnId: stringField(message, 'previousTurnId', 'previous_turn_id'),
        continuedAfterInterrupt: false, interrupted: false,
      }
      rows.push(group)
      currentTurnId = turnId
    }

    group.messages.push(message)
    // Lifecycle markers drive the header state but have no renderable card of
    // their own, so they must not create a phantom auxiliary toggle.
    if (message.type !== 'turn_status') {
      if (isMain(message)) group.main.push(message)
      else group.auxiliary.push(message)
    }

    const status = stringField(message, 'turnStatus', 'turn_status')
    if (status) {
      group.status = status
      group.interrupted = status === 'interrupted'
    }
    const previousTurnId = stringField(message, 'previousTurnId', 'previous_turn_id')
    if (previousTurnId) group.previousTurnId = previousTurnId
    const continuationReason = stringField(message, 'continuationReason', 'continuation_reason')
    if (continuationReason === 'after_interrupt') group.continuedAfterInterrupt = true
  }

  // Pure candidate identities are anchored from the right, matching iOS. The
  // stateful presentation reconciler below then preserves an existing ID by
  // member overlap when prepend/append changes a segment's candidate anchor.
  const turnsSeenFromRight = new Set<string>()
  let rightBoundaryMessageId = ''
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]
    if (row.kind === 'legacy') {
      rightBoundaryMessageId = messageIdentity(row.message)
      continue
    }
    if (!turnsSeenFromRight.has(row.turnId)) {
      turnsSeenFromRight.add(row.turnId)
      row.id = `turn:${row.turnId}:tail`
    } else {
      row.id = `turn:${row.turnId}:before-message:${rightBoundaryMessageId || 'missing'}`
    }
    rightBoundaryMessageId = messageIdentity(row.messages.at(-1)!)
  }

  return rows
}

export interface TurnSegmentIdentityContext {
  sessionId: string
  focusedAgentId?: string
}

function contextKey(context: TurnSegmentIdentityContext): string {
  return `${context.sessionId}::${context.focusedAgentId || ''}`
}

interface RetainedTurnSegment {
  id: string
  turnId: string
  memberMessageIDs: Set<string>
}

/** UI-only identity reconciliation; reducer messages are never mutated. */
export class TurnSegmentIdentityRegistry {
  private context = ''
  private retained: RetainedTurnSegment[] = []
  private allocationSerial = 0

  reset(context?: TurnSegmentIdentityContext): void {
    this.context = context ? contextKey(context) : ''
    this.retained = []
    this.allocationSerial = 0
  }

  reconcile<T extends TurnMessage>(rows: readonly TurnProjectionRow<T>[], context: TurnSegmentIdentityContext): TurnProjectionRow<T>[] {
    const nextContext = contextKey(context)
    if (this.context !== nextContext) this.reset(context)
    const current = rows.flatMap((row, rowIndex) => row.kind === 'turn' ? [{
      rowIndex, candidateID: row.id, turnId: row.turnId,
      memberMessageIDs: new Set(row.messages.map(messageIdentity).filter(Boolean)),
    }] : [])
    const candidates: Array<{ overlap: number; current: number; retained: number }> = []
    current.forEach((segment, currentIndex) => this.retained.forEach((retained, retainedIndex) => {
      if (segment.turnId !== retained.turnId) return
      let overlap = 0
      for (const id of segment.memberMessageIDs) if (retained.memberMessageIDs.has(id)) overlap++
      if (overlap > 0) candidates.push({ overlap, current: currentIndex, retained: retainedIndex })
    }))
    candidates.sort((lhs, rhs) => rhs.overlap - lhs.overlap
      || current[lhs.current].rowIndex - current[rhs.current].rowIndex
      || this.retained[lhs.retained].id.localeCompare(this.retained[rhs.retained].id))

    const assigned = new Map<number, string>()
    const usedRetained = new Set<number>()
    for (const candidate of candidates) {
      if (assigned.has(candidate.current) || usedRetained.has(candidate.retained)) continue
      assigned.set(candidate.current, this.retained[candidate.retained].id)
      usedRetained.add(candidate.retained)
    }
    const usedIDs = new Set(assigned.values())
    current.forEach((segment, index) => {
      if (assigned.has(index)) return
      let id = segment.candidateID
      while (usedIDs.has(id)) id = `${segment.candidateID}:ui:${++this.allocationSerial}`
      usedIDs.add(id)
      assigned.set(index, id)
    })

    const reconciled = rows.map(row => row.kind === 'turn' ? { ...row } : row) as TurnProjectionRow<T>[]
    current.forEach((segment, index) => {
      const row = reconciled[segment.rowIndex]
      if (row.kind === 'turn') row.id = assigned.get(index)!
    })
    this.retained = current.map((segment, index) => ({
      id: assigned.get(index)!, turnId: segment.turnId, memberMessageIDs: segment.memberMessageIDs,
    }))
    return reconciled
  }
}

/** Context-scoped collapse state keyed only by reconciled presentation IDs. */
export class TurnSegmentCollapseRegistry {
  private context = ''
  private collapsed = new Set<string>()

  private ensureContext(context: TurnSegmentIdentityContext): void {
    const nextContext = contextKey(context)
    if (this.context !== nextContext) {
      this.context = nextContext
      this.collapsed.clear()
    }
  }

  reconcile(validSegmentIDs: Set<string>, context: TurnSegmentIdentityContext): void {
    this.ensureContext(context)
    for (const id of this.collapsed) if (!validSegmentIDs.has(id)) this.collapsed.delete(id)
  }

  isCollapsed(segmentID: string, context: TurnSegmentIdentityContext): boolean {
    this.ensureContext(context)
    return this.collapsed.has(segmentID)
  }

  toggle(segmentID: string, context: TurnSegmentIdentityContext): void {
    this.ensureContext(context)
    if (this.collapsed.has(segmentID)) this.collapsed.delete(segmentID)
    else this.collapsed.add(segmentID)
  }
}
