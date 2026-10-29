import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, expect, test, vi } from 'vitest'
import { teamDeliveryCache, deliveryCacheScope } from '../teamDeliveryCache'
import { loadTeamNavigation } from '../teamNavigationCache'

vi.stubGlobal('indexedDB', new IDBFactory())
const scope = deliveryCacheScope(7, 'https://one.test')
const options = { scope, kind: 'directory' as const, id: 'teams', team: '', current: () => true }
const offline = () => Promise.reject({ status: 0 })
beforeEach(async () => { await teamDeliveryCache.purge(); localStorage.clear() })
test('only a previously read account/origin directory is available offline', async () => {
  await loadTeamNavigation({ ...options, load: async () => [{ id: 'a' }] })
  expect(await loadTeamNavigation({ ...options, load: offline })).toMatchObject({ cached: true, data: [{ id: 'a' }] })
  await expect(loadTeamNavigation({ ...options, scope: deliveryCacheScope(8, 'https://one.test'), load: offline })).rejects.toMatchObject({ status: 0 })
  await expect(loadTeamNavigation({ ...options, scope: deliveryCacheScope(7, 'https://two.test'), load: offline })).rejects.toMatchObject({ status: 0 })
})
test.each([401, 403, 404])('authoritative %s clears the directory and cannot fall back later', async status => {
  await loadTeamNavigation({ ...options, load: async () => [{ id: 'a' }] })
  await expect(loadTeamNavigation({ ...options, load: async () => { throw { status } } })).rejects.toMatchObject({ status })
  await expect(loadTeamNavigation({ ...options, load: offline })).rejects.toMatchObject({ status: 0 })
})
test('team revocation fences an already started directory load', async () => {
  let resolve!: (x: { id: string }[]) => void
  const load = vi.fn(() => new Promise<{ id: string }[]>(r => { resolve = r }))
  const pending = loadTeamNavigation({ ...options, load })
  await vi.waitFor(() => expect(load).toHaveBeenCalled())
  await teamDeliveryCache.purge(scope, { team: 'a' })
  resolve([{ id: 'a' }])
  await expect(pending).rejects.toThrow('identity changed')
  expect(await teamDeliveryCache.read(scope, 'directory', 'teams')).toBeNull()
})
test('missing membership purges the team and re-fetches after invalidation', async () => {
  await loadTeamNavigation({ ...options, load: async () => [{ id: 'a' }, { id: 'b' }] })
  await teamDeliveryCache.write(scope, 'detail', 'task', 'a', ['task'], { secret: true }, teamDeliveryCache.ticket())
  const load = vi.fn(async () => [{ id: 'b' }])
  expect(await loadTeamNavigation({ ...options, load })).toMatchObject({ data: [{ id: 'b' }], cached: false })
  expect(load).toHaveBeenCalledTimes(2)
  expect(await teamDeliveryCache.read(scope, 'detail', 'task')).toBeNull()
})
test('task snapshots cannot reappear after a task is revoked; file eviction preserves navigation', async () => {
  const tasks = { ...options, kind: 'tasks' as const, id: 'a:all', team: 'a', load: async () => [{ id: 'task' }] }
  await loadTeamNavigation(tasks)
  await teamDeliveryCache.purge(scope, { task: 'task', filesOnly: true })
  expect(await loadTeamNavigation({ ...tasks, load: offline })).toMatchObject({ cached: true })
  await teamDeliveryCache.purge(scope, { task: 'task' })
  await expect(loadTeamNavigation({ ...tasks, load: offline })).rejects.toMatchObject({ status: 0 })
})
test('identity change during a successful response cannot populate navigation', async () => {
  let current = true
  await expect(loadTeamNavigation({ ...options, current: () => current, load: async () => { current = false; return [{ id: 'a' }] } })).rejects.toThrow('identity changed')
  expect(await teamDeliveryCache.read(scope, 'directory', 'teams')).toBeNull()
})
