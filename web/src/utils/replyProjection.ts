import type { TurnMessage } from './turnProjection'

export interface ReplyMessage extends TurnMessage {
  role?: string
  content?: string
  streaming?: boolean
  deliveryStatus?: string
  retry_of_turn_id?: string
  actor_scope?: string
}
export interface ReplyGroup<T extends ReplyMessage = ReplyMessage> {
  id: string
  kind: 'reply' | 'message'
  messages: T[]
  prompt?: T
  partial: boolean
}
const turn = (m: ReplyMessage) => String(m.turn_id || m.turnId || '')
export function associateReplyRetries<T extends ReplyMessage>(messages: readonly T[]): T[] {
  const roots = new Map<string, string>()
  for (const m of messages) if (m.role === 'user' && turn(m) && m.retry_of_turn_id) roots.set(turn(m), m.retry_of_turn_id)
  return messages.map(m => m.role === 'user' && !m.retry_of_turn_id && roots.has(turn(m))
    ? { ...m, retry_of_turn_id: roots.get(turn(m)) } : m)
}
export function isSentQuestion(m: ReplyMessage): boolean {
  return m.role === 'user' && !m.retry_of_turn_id && (!m.deliveryStatus || m.deliveryStatus === 'accepted')
}
/** Display-only, source-ordered projection within ONE already-routed agent bucket.
 * Known old turn IDs never attach late events to a newer question. Unknown
 * history before a loaded question stays separate and is marked incomplete.
 * Markdown and reducer message identities are deliberately untouched.
 */
export function projectReplies<T extends ReplyMessage>(source: readonly T[]): ReplyGroup<T>[] {
  const messages = associateReplyRetries(source)
  const rows: ReplyGroup<T>[] = []
  const owners = new Map<string, T>()
  const attempts = new Set<string>()
  for (const m of messages) if (isSentQuestion(m) && turn(m)) owners.set(turn(m), m)
  for (const m of messages) if (m.role === 'user' && m.retry_of_turn_id && turn(m)) {
    attempts.add(turn(m))
    const root = owners.get(m.retry_of_turn_id)
    if (root) owners.set(turn(m), root)
  }
  let current: T | undefined
  let previousKey = ''
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.retry_of_turn_id) {
        current = owners.get(m.retry_of_turn_id)
        if (turn(m) && current) owners.set(turn(m), current)
        previousKey = ''
        continue
      }
      if (isSentQuestion(m)) {
        current = m
        if (turn(m)) owners.set(turn(m), m)
      }
      rows.push({ id: `message:${m.id}`, kind: 'message', messages: [m], partial: false })
      previousKey = ''
      continue
    }
    const nativeTurn = turn(m)
    const previousTurn = String(m.previous_turn_id || m.previousTurnId || '')
    const prompt = owners.get(nativeTurn) || owners.get(previousTurn) || current
    if (nativeTurn && prompt) owners.set(nativeTurn, prompt)
    const key = `${prompt ? `prompt:${prompt.id}` : `partial:${nativeTurn}`}::${m.actor_scope || ''}::${attempts.has(nativeTurn) ? nativeTurn : ''}`
    let row = previousKey === key ? rows.at(-1) : undefined
    if (row?.kind !== 'reply') {
      row = { id: `reply:${m.id}`, kind: 'reply', messages: [], prompt, partial: !prompt }
      rows.push(row)
    }
    row.messages.push(m)
    previousKey = key
  }
  const contentTurns = new Set(rows.filter(row => row.kind === 'reply').flatMap(row =>
    row.messages.filter(m => m.type !== 'turn_status' && turn(m)).map(turn)))
  return rows.filter(row => row.kind === 'message' || row.messages.some(m => m.type !== 'turn_status')
    || !row.messages.some(marker => contentTurns.has(turn(marker))))
}
export function replyText(group: ReplyGroup): string {
  return group.messages.filter(m => m.type === 'agent_text').map(m => m.content || '').filter(Boolean).join('\n\n')
}
export function replyStatus(group: ReplyGroup): string {
  if (group.messages.some(m => ['approval_request','question_request','mcp_elicitation_request','interactive_prompt'].includes(m.type || '') && (!m.status || m.status === 'pending'))) return 'waiting'
  const status = [...group.messages].reverse().find(m => m.turn_status || m.turnStatus)
  const value = String(status?.turn_status || status?.turnStatus || '')
  if (['completed','interrupted','failed','abandoned'].includes(value)) return value
  if (group.messages.some(m => m.type === 'error')) return 'failed'
  if (group.messages.some(m => m.streaming)) return 'streaming'
  // No end marker is not evidence of successful completion.
  return 'recorded'
}
