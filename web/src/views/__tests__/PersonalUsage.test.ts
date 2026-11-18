import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { useAuth } from '../../composables/useAuth'
import { usePersonalUsage } from '../../composables/usePersonalUsage'
import fixture from '../../../../tests/fixtures/usage-analytics/personal-v1.json'

const { apiGetAuth } = vi.hoisted(() => ({ apiGetAuth: vi.fn() }))
vi.mock('../../composables/useAuth', async () => {
  const { ref } = await import('vue')
  const accessToken = ref('fixture')
  const user = ref<{ id: number } | null>({ id: 1 })
  return { useAuth: () => ({ accessToken, user, apiGetAuth }) }
})

const url = (path: string) => new URL(path, 'https://fixture.invalid')
const ok = (data: unknown) => ({ ok: true, status: 200, data })
const failed = (error: string, status = 409) => ({ ok: false, status, data: { error } })
const dashboard = (snapshot_token: string) => ({
  ...fixture.dashboard,
  meta: { ...fixture.dashboard.meta, snapshot_token },
})
const defer = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(finish => { resolve = finish })
  return { resolve, promise }
}

let wrapper: ReturnType<typeof mount> | undefined
function openUsage(daemon = 'all') {
  let usage!: ReturnType<typeof usePersonalUsage>
  wrapper = mount(defineComponent({ setup() { usage = usePersonalUsage(daemon); return () => '' } }))
  return usage
}

beforeEach(() => {
  apiGetAuth.mockReset()
  useAuth().accessToken.value = 'fixture'
  useAuth().user.value = { id: 1, email: null, phone: null, display_name: null }
})
afterEach(() => wrapper?.unmount())

it('aborts the previous dashboard scope and discards its late response', async () => {
  const old = defer<ReturnType<typeof ok>>()
  apiGetAuth.mockImplementation(path =>
    url(path).searchParams.get('daemon') === 'old' ? old.promise : ok(dashboard('new')),
  )
  const usage = openUsage('old')
  void usage.load()
  await flushPromises()
  usage.daemon.value = 'new'
  await flushPromises()
  expect(apiGetAuth.mock.calls[0]![1].signal.aborted).toBe(true)
  expect(usage.dashboard.value?.meta.snapshot_token).toBe('new')
  old.resolve(ok(dashboard('old')))
  await flushPromises()
  expect(usage.dashboard.value?.meta.snapshot_token).toBe('new')
  expect(usage.error.value).toBe('')
})

it('shares duplicate dashboard, section and detail requests', async () => {
  const first = defer<ReturnType<typeof ok>>()
  const section = defer<ReturnType<typeof ok>>()
  const detail = defer<ReturnType<typeof ok>>()
  apiGetAuth.mockImplementation(path => {
    switch (url(path).pathname) {
      case '/api/tokens/dashboard': return first.promise
      case '/api/tokens/sessions': return section.promise
      default: return detail.promise
    }
  })
  const usage = openUsage()
  usage.tab.value = 'sessions'
  const loads = [usage.load(), usage.load()]
  await flushPromises()
  expect(apiGetAuth).toHaveBeenCalledTimes(1)
  first.resolve(ok(dashboard('first')))
  await flushPromises()
  const sections = [usage.loadSection(), usage.loadSection()]
  const details = [usage.detail('/detail'), usage.detail('/detail')]
  await flushPromises()
  expect(apiGetAuth).toHaveBeenCalledTimes(3)
  section.resolve(ok(fixture.sessions))
  detail.resolve(ok(fixture.sessions))
  await Promise.all([...loads, ...sections, ...details])
})

it('aborts superseded section, detail and unmounted requests and ignores late responses', async () => {
  const firstSection = defer<ReturnType<typeof ok>>()
  const oldDetail = defer<ReturnType<typeof ok>>()
  const newDetail = defer<ReturnType<typeof ok>>()
  apiGetAuth.mockImplementation(path => {
    const request = url(path)
    switch (request.pathname) {
      case '/api/tokens/dashboard': return ok(dashboard('first'))
      case '/api/tokens/sessions': return request.searchParams.get('q') ? ok(fixture.sessions) : firstSection.promise
      case '/old': return oldDetail.promise
      default: return newDetail.promise
    }
  })
  const usage = openUsage()
  usage.tab.value = 'sessions'
  void usage.load()
  await flushPromises()
  const first = usage.detail('/old').catch(error => error)
  await flushPromises()
  usage.search.value = 'current'
  await flushPromises()
  expect(apiGetAuth.mock.calls.find(([path]) => url(path).searchParams.get('q') === '')![1].signal.aborted).toBe(true)
  expect(apiGetAuth.mock.calls.find(([path]) => path.startsWith('/old'))![1].signal.aborted).toBe(true)
  firstSection.resolve(ok({ ...fixture.sessions, total: -1 }))
  oldDetail.resolve(ok(fixture.sessions))
  await flushPromises()
  expect((await first).name).toBe('AbortError')
  expect(usage.sessions.value.total).toBe(fixture.sessions.total)

  const second = usage.detail('/new').catch(error => error)
  await flushPromises()
  wrapper?.unmount()
  wrapper = undefined
  expect(apiGetAuth.mock.calls.find(([path]) => path.startsWith('/new'))![1].signal.aborted).toBe(true)
  newDetail.resolve(ok(fixture.sessions))
  expect((await second).name).toBe('AbortError')
})

it('refreshes one snapshot after simultaneous section/detail conflicts and replays current filters', async () => {
  const renewed = defer<ReturnType<typeof ok>>()
  let dashboards = 0
  apiGetAuth.mockImplementation(path => {
    const request = url(path)
    if (request.pathname === '/api/tokens/dashboard') {
      return ++dashboards === 1 ? ok(dashboard('first')) : renewed.promise
    }
    if (request.searchParams.get('snapshot_token') === 'first') {
      return failed(request.pathname === '/detail' ? 'snapshot_expired' : 'snapshot_changed')
    }
    return ok(fixture.sessions)
  })
  const usage = openUsage()
  await usage.load()
  usage.tab.value = 'sessions'
  usage.page.value = 3
  usage.search.value = 'filtered'
  usage.association.value = { call_object_id: 'call-1' }
  const section = usage.loadSection()
  const detail = usage.detail('/detail')
  await flushPromises()
  expect(dashboards).toBe(2)
  renewed.resolve(ok(dashboard('renewed')))
  await Promise.all([section, detail])
  const requests = apiGetAuth.mock.calls.map(([path]) => url(path))
  const sections = requests.filter(r => r.pathname === '/api/tokens/sessions').map(r => Object.fromEntries(r.searchParams))
  expect(sections).toEqual(['first', 'renewed'].map(snapshot_token => ({
    contract: 'personal-v1', daemon: 'all', range: '30d', snapshot_token,
    page: '3', limit: '20', q: 'filtered', call_object_id: 'call-1',
  })))
  expect(requests.filter(r => r.pathname === '/detail').map(r => r.searchParams.get('snapshot_token'))).toEqual(['first', 'renewed'])
  expect(usage.error.value).toBe('')
})

it.each([
  [409, 'snapshot_changed', 2],
  [500, 'snapshot_expired', 1],
])('keeps request retries bounded for HTTP %s %s', async (status, code, expectedAttempts) => {
  let dashboards = 0
  apiGetAuth.mockImplementation(path => url(path).pathname === '/api/tokens/dashboard'
    ? ok(dashboard(String(++dashboards)))
    : failed(code, status))
  const usage = openUsage()
  await usage.load()
  usage.tab.value = 'calls'
  await usage.loadSection()
  expect(dashboards).toBe(expectedAttempts)
  expect(apiGetAuth.mock.calls.filter(([path]) => url(path).pathname === '/api/usage/calls')).toHaveLength(expectedAttempts)
  expect(usage.error.value).toBe(code)
})

it.each(['snapshot_authorization_changed', 'authorization_changed'])('clears protected data on %s without replay', async code => {
  apiGetAuth.mockImplementation(path => {
    switch (url(path).pathname) {
      case '/api/tokens/dashboard': return ok(dashboard('first'))
      case '/api/tokens/sessions': return ok(fixture.sessions)
      default: return failed(code)
    }
  })
  const usage = openUsage()
  usage.tab.value = 'sessions'
  await usage.load()
  expect(usage.sessions.value).toBeTruthy()
  await expect(usage.detail('/detail')).rejects.toThrow()
  expect(usage.dashboard.value).toBeNull()
  expect(usage.sessions.value).toBeNull()
  expect(usage.error.value).toBe(code)
  expect(apiGetAuth).toHaveBeenCalledTimes(3)
})

it('discards a pending detail when identity changes even if the token is the same', async () => {
  const old = defer<ReturnType<typeof ok>>()
  apiGetAuth.mockImplementation(path => {
    if (path.startsWith('/detail')) return old.promise
    return ok(path.startsWith('/api/tokens/sessions') ? fixture.sessions : dashboard('first'))
  })
  const usage = openUsage()
  usage.tab.value = 'sessions'
  usage.search.value = 'account-specific title'
  await usage.load()
  const detail = usage.detail('/detail').catch(error => error)
  await flushPromises()
  useAuth().user.value = { id: 2, email: null, phone: null, display_name: null }
  await flushPromises()
  expect(apiGetAuth.mock.calls.find(([path]) => path.startsWith('/detail'))![1].signal.aborted).toBe(true)
  old.resolve(ok(fixture.sessions))
  expect((await detail).name).toBe('AbortError')
  const searchQueries = apiGetAuth.mock.calls
    .map(([path]) => url(path))
    .filter(request => request.pathname === '/api/tokens/sessions')
    .map(request => request.searchParams.get('q'))
  expect(searchQueries).toEqual(['account-specific title', ''])
})

it('uses the refreshed snapshot only for the new section after navigation during recovery', async () => {
  const renewed = defer<ReturnType<typeof ok>>()
  let dashboards = 0
  apiGetAuth.mockImplementation(path => {
    const request = url(path)
    if (request.pathname === '/api/tokens/dashboard') {
      return ++dashboards === 1 ? ok(dashboard('first')) : renewed.promise
    }
    if (request.searchParams.get('snapshot_token') === 'first') return failed('snapshot_changed')
    return ok(fixture.calls)
  })
  const usage = openUsage()
  await usage.load()
  usage.tab.value = 'sessions'
  void usage.loadSection()
  await flushPromises()
  expect(dashboards).toBe(2)
  usage.tab.value = 'calls'
  usage.category.value = 'mcp'
  await flushPromises()
  expect(apiGetAuth.mock.calls.find(([path]) => path.startsWith('/api/tokens/sessions'))![1].signal.aborted).toBe(true)

  renewed.resolve(ok(dashboard('renewed')))
  await flushPromises()
  const sections = apiGetAuth.mock.calls.map(([path]) => url(path)).filter(r => r.pathname !== '/api/tokens/dashboard')
  expect(sections.map(r => [r.pathname, r.searchParams.get('snapshot_token'), r.searchParams.get('category')])).toEqual([
    ['/api/tokens/sessions', 'first', null],
    ['/api/usage/calls', 'renewed', 'mcp'],
  ])
  expect(usage.calls.value).toBeTruthy()
  expect(usage.sessions.value).toBeNull()
})
