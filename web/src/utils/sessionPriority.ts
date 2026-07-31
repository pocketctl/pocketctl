export interface SessionPriorityItem {
  status: string
  pinned?: boolean
  last_activity_at?: string | Date
  started_at?: string | Date
}

const STATUS_PRIORITY: Record<string, number> = {
  waiting_approval: 0,
  waiting_question: 0,
  running: 1,
  busy: 1,
  retry: 1,
  idle: 1,
  waiting: 1,
  error: 2,
  disconnected: 2,
  completed: 3,
  exited: 3,
  killed: 3,
}

function activityTime(session: SessionPriorityItem): number {
  const value = session.last_activity_at ?? session.started_at
  if (!value) return 0
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? 0 : time
}

export function sortMobileSessions<T extends SessionPriorityItem>(sessions: readonly T[]): T[] {
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) => {
      const priorityDifference =
        (STATUS_PRIORITY[a.session.status] ?? 4) - (STATUS_PRIORITY[b.session.status] ?? 4)
      if (priorityDifference !== 0) return priorityDifference

      if (a.session.pinned !== b.session.pinned) return a.session.pinned ? -1 : 1

      const activityDifference = activityTime(b.session) - activityTime(a.session)
      return activityDifference || a.index - b.index
    })
    .map(({ session }) => session)
}
