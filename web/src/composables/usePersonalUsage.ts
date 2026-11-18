import { onBeforeUnmount, ref, watch } from 'vue'
import { useAuth } from './useAuth'
import { getRelayWs } from './useEnv'
import type { UsageDashboard, UsageRange } from '../types/usage'

type RequestKind = 'dashboard' | 'section' | 'detail'
type PendingRequest = {
  key: string
  scope: string
  section: string
  controller: AbortController
  promise: Promise<any>
}

class UsageRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export function usePersonalUsage(initialDaemon = 'all') {
  const { accessToken, user, apiGetAuth } = useAuth()
  const daemon = ref(initialDaemon)
  const range = ref<UsageRange>('30d')
  const tab = ref('tokens')
  const category = ref('tools')
  const page = ref(1)
  const search = ref('')
  const association = ref<Record<string, string>>({})
  const dashboard = ref<UsageDashboard | null>(null)
  const calls = ref<any>(null)
  const sessions = ref<any>(null)
  const loading = ref(false)
  const error = ref('')

  const pending: Partial<Record<RequestKind, PendingRequest>> = {}
  let dashboardScope = ''
  let loadOperation: { scope: string; promise: Promise<void> } | undefined
  const identity = () => user.value?.id
  const scopeKey = () => JSON.stringify([getRelayWs(), identity(), accessToken.value, daemon.value, range.value])
  const params = () => new URLSearchParams({ contract: 'personal-v1', daemon: daemon.value, range: range.value })

  function sectionQuery() {
    if (tab.value !== 'calls' && tab.value !== 'sessions') return null
    const query = params()
    query.set('page', String(page.value))
    query.set('limit', '20')
    if (tab.value === 'calls') {
      query.set('category', category.value)
      return { path: '/api/usage/calls', query }
    }
    query.set('q', search.value)
    for (const key of Object.keys(association.value).sort()) query.set(key, association.value[key]!)
    return { path: '/api/tokens/sessions', query }
  }

  function sectionKey() {
    const section = sectionQuery()
    return section ? section.path + '?' + section.query : tab.value
  }

  function abort(kind: RequestKind) {
    pending[kind]?.controller.abort()
    delete pending[kind]
  }

  function clearData() {
    abort('dashboard')
    abort('section')
    cancelDetail()
    dashboardScope = ''
    dashboard.value = null
    calls.value = null
    sessions.value = null
    loadOperation = undefined
    loading.value = false
  }

  function isCurrent(kind: RequestKind, request: PendingRequest) {
    return pending[kind] === request && request.scope === scopeKey() &&
      (kind === 'dashboard' || request.section === sectionKey())
  }

  function ensureCurrent(kind: RequestKind, request: PendingRequest) {
    if (!isCurrent(kind, request)) throw new DOMException('stale_usage_request', 'AbortError')
  }

  function start<T>(kind: RequestKind, key: string, run: (request: PendingRequest) => Promise<T>): Promise<T> {
    const active = pending[kind]
    if (active && active.key === key && isCurrent(kind, active)) return active.promise
    abort(kind)
    const request: PendingRequest = {
      key,
      scope: scopeKey(),
      section: sectionKey(),
      controller: new AbortController(),
      promise: Promise.resolve().then(() => run(request)).finally(() => {
        if (pending[kind] === request) delete pending[kind]
      }),
    }
    pending[kind] = request
    return request.promise
  }

  async function get(kind: RequestKind, request: PendingRequest, path: string, query: URLSearchParams) {
    ensureCurrent(kind, request)
    if (!accessToken.value) throw new Error('auth_expired')
    const response = await apiGetAuth(path + '?' + query, { signal: request.controller.signal })
    ensureCurrent(kind, request)
    if (!response.ok) {
      const code = response.data?.error ?? 'request_failed'
      if (['authorization_changed', 'snapshot_authorization_changed', 'snapshot_invalid'].includes(code)) {
        clearData()
        error.value = code
      }
      throw new UsageRequestError(code, response.status)
    }
    if (response.data?.meta?.contract !== 'personal-v1') throw new Error('upgrade_required')
    return response.data
  }

  function fetchDashboard() {
    const query = params()
    return start('dashboard', String(query), async request => {
      const data: UsageDashboard = await get('dashboard', request, '/api/tokens/dashboard', query)
      ensureCurrent('dashboard', request)
      calls.value = null
      sessions.value = null
      dashboardScope = request.scope
      dashboard.value = data
      void loadSection()
      return data
    })
  }

  function currentSnapshot() {
    return dashboardScope === scopeKey() ? dashboard.value?.meta.snapshot_token : undefined
  }

  async function snapshotWhenReady(request: PendingRequest) {
    const refreshing = pending.dashboard
    if (refreshing?.scope === request.scope) await refreshing.promise
    return currentSnapshot()
  }

  async function getWithSnapshot(kind: 'section' | 'detail', request: PendingRequest, path: string, query: URLSearchParams) {
    const send = (snapshot?: string) => {
      const requestQuery = new URLSearchParams(query)
      if (snapshot) requestQuery.set('snapshot_token', snapshot)
      return get(kind, request, path, requestQuery)
    }
    const originalSnapshot = await snapshotWhenReady(request)
    try {
      const data = await send(originalSnapshot)
      if (originalSnapshot === await snapshotWhenReady(request)) return { data, snapshot: originalSnapshot }
    } catch (cause) {
      ensureCurrent(kind, request)
      if (!(cause instanceof UsageRequestError) || cause.status !== 409 ||
        (cause.message !== 'snapshot_changed' && cause.message !== 'snapshot_expired')) throw cause
      if (originalSnapshot === currentSnapshot()) await fetchDashboard()
    }
    const snapshot = await snapshotWhenReady(request)
    return { data: await send(snapshot), snapshot }
  }

  function load() {
    const scope = scopeKey()
    if (loadOperation?.scope === scope) return loadOperation.promise
    if (!pending.dashboard || pending.dashboard.scope !== scope) clearData()
    loading.value = true
    error.value = ''

    const operation = {
      scope,
      promise: fetchDashboard().then(async () => {
        if (loadOperation === operation && scope === scopeKey()) await loadSection()
      }).catch(cause => {
        if (loadOperation === operation && scope === scopeKey()) error.value = (cause as Error).message
      }).finally(() => {
        if (loadOperation === operation) {
          loadOperation = undefined
          if (scope === scopeKey()) loading.value = false
        }
      }),
    }
    loadOperation = operation
    return operation.promise
  }

  function loadSection() {
    const section = sectionQuery()
    if (!section || dashboardScope !== scopeKey()) {
      abort('section')
      return Promise.resolve()
    }
    return start('section', sectionKey(), async request => {
      try {
        const { data, snapshot } = await getWithSnapshot('section', request, section.path, section.query)
        ensureCurrent('section', request)
        if (snapshot !== currentSnapshot()) return
        if (section.path === '/api/usage/calls') calls.value = data
        else sessions.value = data
      } catch (cause) {
        if (isCurrent('section', request) && (cause as Error).name !== 'AbortError') error.value = (cause as Error).message
      }
    })
  }

  function detail(path: string) {
    const query = params()
    return start('detail', path, async request => {
      try {
        const { data, snapshot } = await getWithSnapshot('detail', request, path, query)
        ensureCurrent('detail', request)
        if (snapshot !== currentSnapshot()) throw new DOMException('stale_usage_snapshot', 'AbortError')
        return data
      } catch (cause) {
        ensureCurrent('detail', request)
        if ((cause as Error).name !== 'AbortError') error.value = (cause as Error).message
        throw cause
      }
    })
  }

  function cancelDetail() {
    abort('detail')
  }

  watch([daemon, range, accessToken, identity], ([host, period, token, userId], previous) => {
    const identityChanged = userId !== previous[3] || !token
    if (identityChanged) search.value = ''
    if (host !== previous[0] || period !== previous[1] || identityChanged) {
      page.value = 1
      association.value = {}
    }
    if (token) void load()
    else {
      clearData()
      error.value = 'auth_expired'
    }
  })
  watch(sectionKey, key => {
    if (pending.detail && pending.detail.section !== key) cancelDetail()
    void loadSection()
  })
  onBeforeUnmount(clearData)

  return { daemon, range, tab, category, page, search, association, dashboard, calls, sessions, loading, error, load, loadSection, detail, cancelDetail }
}
