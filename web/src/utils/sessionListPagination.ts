export const SESSION_RENDER_BATCH_SIZE = 15
export const SESSION_REMOTE_PAGE_SIZE = 20

export function nextVisibleSessionCount(current: number, total: number): number {
  return Math.min(current + SESSION_RENDER_BATCH_SIZE, total)
}

export function mergeSessionPage<T extends { session_id: string }>(existing: T[], incoming: T[]): T[] {
  const incomingById = new Map(incoming.map(session => [session.session_id, session]))
  const merged = existing.map(session => incomingById.get(session.session_id) ?? session)
  const existingIds = new Set(existing.map(session => session.session_id))
  return merged.concat(incoming.filter(session => !existingIds.has(session.session_id)))
}
