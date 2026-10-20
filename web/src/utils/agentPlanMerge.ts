export type AgentPlanStatus = 'pending' | 'in_progress' | 'completed'

export interface AgentPlanItem {
  step: string
  status: AgentPlanStatus
  sourceTitle?: string
}

export interface AgentPlanSnapshot {
  sessionId: string
  partId: string
  eventId: string
  previousEventId: string
  revision: number
  explanation: string
  items: AgentPlanItem[]
  title?: string
}

const validStatuses = new Set<AgentPlanStatus>(['pending', 'in_progress', 'completed'])

export function normalizeAgentPlanEvent(event: any): AgentPlanSnapshot | null {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : event
  const sessionId = String(payload?.session_id ?? payload?.sessionId ?? '')
  const eventId = String(payload?.event_id ?? payload?.eventId ?? '')
  const todo = (payload?.type ?? payload?.event_type ?? event?.type ?? event?.event_type) === 'agent_todo'
  const cleared = payload?.status === 'cleared' || (todo && !(payload?.todos?.length))
  const rawItems = payload?.plan ?? payload?.todos?.map((row: any) => ({ step: row.content, status: row.status })) ?? payload?.items ?? (cleared ? [] : undefined)
  if (!sessionId || !eventId || !Array.isArray(rawItems) || (rawItems.length === 0 && !cleared)) return null

  const items: AgentPlanItem[] = []
  for (const raw of rawItems) {
    const step = typeof raw?.step === 'string' ? raw.step.trim() : ''
    const status = raw?.status as AgentPlanStatus
    if (!step || !validStatuses.has(status)) return null
    items.push({ step, status })
  }

  return {
    sessionId,
    partId: String(payload.part_id ?? payload.partId ?? `${todo ? 'todo' : 'plan'}:${sessionId}`),
    eventId,
    previousEventId: String(payload.previous_event_id ?? payload.previousEventId ?? ''),
    revision: Math.max(0, Number(payload.revision ?? (todo ? payload.seq : 0)) || 0),
    explanation: typeof payload.explanation === 'string' ? payload.explanation.trim() : '',
    title: payload.task_list_title || (todo ? 'Agent tasks' : undefined),
    items,
  }
}

export function mergeAgentPlan(
  current: AgentPlanSnapshot | undefined,
  event: unknown,
): AgentPlanSnapshot | undefined {
  const incoming = normalizeAgentPlanEvent(event)
  if (!incoming) return current
  if (!current || current.sessionId !== incoming.sessionId) return incoming
  if (incoming.eventId === current.eventId) return current
  if (current.previousEventId === incoming.eventId) return current
  if (incoming.previousEventId === current.eventId) return incoming
  if (incoming.revision > current.revision) return incoming
  return current
}

export function completedPlanItemCount(plan: AgentPlanSnapshot): number {
  return plan.items.filter(item => item.status === 'completed').length
}
