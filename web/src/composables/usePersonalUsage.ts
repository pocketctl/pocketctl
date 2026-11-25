import { onBeforeUnmount, ref, watch } from 'vue'
import { useAuth } from './useAuth'
import { getRelayWs } from './useEnv'
import type { UsageDashboard, UsageMeta, UsageRange } from '../types/usage'

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
  const hosts = ref<UsageDashboard['hosts'] | null>(null)
  const summary = ref<Pick<UsageDashboard, 'overview' | 'heatmap'> | null>(null)
  const meta = ref<UsageMeta | null>(null)
  const calls = ref<any>(null)
  const sessions = ref<any>(null)
  const loading = ref(false)
  const error = ref('')

  const pending: Partial<Record<RequestKind, PendingRequest>> = {}
  let snapshotScope = ''
  let summaryScope = ''
  let loadOperation: { key: string; promise: Promise<void> } | undefined
  const identity = () => user.value?.id
  const hostKey = () => JSON.stringify([getRelayWs(), identity(), accessToken.value, daemon.value])
  const scopeKey = () => JSON.stringify([hostKey(), range.value])
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

  function clearRange() {
    abort('dashboard')
    abort('section')
    cancelDetail()
    snapshotScope = ''
    meta.value = null
    dashboard.value = null
    calls.value = null
    sessions.value = null
    loadOperation = undefined
    loading.value = false
  }

  function clearData() {
    clearRange()
    summaryScope = ''
    hosts.value = null
    summary.value = null
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
      if (response.status === 401 || response.status === 403 ||
          ['daemon_not_found', 'authorization_changed', 'snapshot_authorization_changed', 'snapshot_invalid', 'personal_usage_not_enabled'].includes(code)) {
        clearData()
        error.value = code
      }
      throw new UsageRequestError(code, response.status)
    }
    if (response.data?.meta?.contract !== 'personal-v1') {
      clearData()
      error.value = 'upgrade_required'
      throw new Error('upgrade_required')
    }
    return response.data
  }

  function fetchDashboard(snapshot?: string) {
    const query = params()
    if (snapshot) query.set('snapshot_token', snapshot)
    return start('dashboard', String(query), async request => {
      const data: UsageDashboard = await get('dashboard', request, '/api/tokens/dashboard', query)
      ensureCurrent('dashboard', request)
      if (currentSnapshot() !== data.meta.snapshot_token) {
        calls.value = null
        sessions.value = null
      }
      snapshotScope = request.scope
      meta.value = data.meta
      dashboard.value = data
      hosts.value = data.hosts
      summaryScope = hostKey()
      summary.value = { overview: data.overview, heatmap: data.heatmap }
      return data
    })
  }

  function currentSnapshot() {
    return snapshotScope === scopeKey() ? meta.value?.snapshot_token : undefined
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
      if (originalSnapshot === currentSnapshot()) {
        await fetchDashboard()
        if (kind === 'detail') void loadSection()
      }
    }
    const snapshot = await snapshotWhenReady(request)
    return { data: await send(snapshot), snapshot }
  }

  function load() {
    const scope = scopeKey()
    const key = JSON.stringify([scope, tab.value])
    if (loadOperation?.key === key) return loadOperation.promise
    error.value = ''
    loading.value = true

    const operation = {
      key,
      promise: loadCurrent().catch(cause => {
        if (loadOperation === operation && scope === scopeKey()) error.value = (cause as Error).message
      }).finally(() => {
        if (loadOperation === operation) {
          loadOperation = undefined
          loading.value = false
        }
      }),
    }
    loadOperation = operation
    return operation.promise
  }

  async function loadCurrent() {
    // Any personal-v1 endpoint can issue a snapshot. With the host summary already
    // visible, a new range on calls or sessions only needs that section's request.
    if (!summary.value || summaryScope !== hostKey() || tab.value === 'tokens') {
      const snapshot = currentSnapshot()
      try {
        await fetchDashboard(snapshot)
      } catch (cause) {
        if (!snapshot || !(cause instanceof UsageRequestError) || cause.status !== 409 ||
          (cause.message !== 'snapshot_changed' && cause.message !== 'snapshot_expired')) throw cause
        await fetchDashboard()
      }
    }
    await loadSection()
  }

  function loadSection() {
    const section = sectionQuery()
    if (!section || !summary.value || summaryScope !== hostKey()) {
      abort('section')
      return Promise.resolve()
    }
    return start('section', sectionKey(), async request => {
      if (section.path === '/api/usage/calls') calls.value = null
      else sessions.value = null
      error.value = ''
      try {
        const { data, snapshot } = await getWithSnapshot('section', request, section.path, section.query)
        ensureCurrent('section', request)
        if (snapshot !== currentSnapshot()) return
        snapshotScope = request.scope
        if (!snapshot) meta.value = data.meta
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
    if (token !== previous[2] || identityChanged) clearData()
    else {
      clearRange()
      if (host !== previous[0]) {
        summaryScope = ''
        summary.value = null
      }
    }
    if (token) void load()
    else error.value = 'auth_expired'
  })
  watch(sectionKey, key => {
    if (summary.value) error.value = ''
    if (pending.detail && pending.detail.section !== key) cancelDetail()
    void loadSection()
    if (tab.value === 'tokens' && summary.value && !dashboard.value) void load()
  })
  onBeforeUnmount(clearData)

  return { daemon, range, tab, category, page, search, association, dashboard, hosts, summary, meta, calls, sessions, loading, error, load, loadSection, detail, cancelDetail }
}
