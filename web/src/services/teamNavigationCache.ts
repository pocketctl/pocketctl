import { teamDeliveryCache } from './teamDeliveryCache'

// Navigation snapshots never contain capabilities or a grant to mutate.
export async function loadTeamNavigation<T extends { id: string }[]>(options: {
  scope: string; kind: 'directory' | 'tasks'; id: string; team: string
  load: () => Promise<T>; current: () => boolean
}, remainingRefetches = 1): Promise<{ data: T; cached: boolean; at: number }> {
  const { scope, kind, id, team, load, current } = options
  const ticket = teamDeliveryCache.ticket()
  const valid = () => current() && ticket === teamDeliveryCache.ticket()
  const previous = await teamDeliveryCache.read<T>(scope, kind, id).catch(() => null)
  if (!valid()) throw new Error('Navigation identity changed')
  let data: T
  try { data = await load() } catch (error) {
    if (!valid()) throw error
    const status = (error as { status?: number })?.status
    if (status === 401 || status === 403 || status === 404) {
      await teamDeliveryCache.purge(scope, team ? { team } : undefined).catch(() => {})
    } else if (previous && (status === 0 || status === 408 || status === 429 || (status !== undefined && status >= 500))) {
      if (valid()) return { ...previous, cached: true }
    }
    throw error
  }
  if (!valid()) throw new Error('Navigation identity changed')
  const removed = previous?.data.filter(old => !data.some(next => next.id === old.id)) ?? []
  if (removed.length) {
    for (const old of removed) await teamDeliveryCache.purge(scope, kind === 'directory' ? { team: old.id } : { task: old.id })
    // The purge invalidates pending loads. Re-fetch after that fence before saving.
    if (!remainingRefetches) throw new Error('Navigation changed; refresh again')
    return loadTeamNavigation({ ...options }, remainingRefetches - 1)
  }
  await teamDeliveryCache.write(scope, kind, id, team, kind === 'tasks' ? data.map(x => x.id) : [], data, ticket).catch(() => {})
  if (!valid()) throw new Error('Navigation identity changed')
  return { data, cached: false, at: Date.now() }
}
