export interface SessionPriorityItem {
  status: string
  pinned?: boolean
  last_activity_at?: string | Date
  started_at?: string | Date
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
      if (a.session.pinned !== b.session.pinned) return a.session.pinned ? -1 : 1

      const activityDifference = activityTime(b.session) - activityTime(a.session)
      return activityDifference || a.index - b.index
    })
    .map(({ session }) => session)
}
