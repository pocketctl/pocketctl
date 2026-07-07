import { ref } from 'vue'
import { getRelayOrigin, getRelayWs } from './useEnv'
import { isTokenExpired, useAuth } from './useAuth'

export interface DaemonEvent {
  type: string
  session_id?: string
  text?: string
  streaming?: boolean
  call_id?: string
  tool?: string
  input?: any
  output?: string
  status?: string
  error?: string
  cost_usd?: number
  turns?: number
  title?: string
  cwd?: string
  source?: string
  exit_reason?: string
  last_activity_at?: string
  agent_id?: string
  subagent_desc?: string
  subagent_type?: string
  subagent_count?: number
  commands?: CommandItem[]
  command?: string
  receipt_status?: 'success' | 'failed' | 'unavailable'
  message?: string
}

// CommandItem represents a slash command or skill available for autocompletion.
export interface CommandItem {
  name: string
  source: 'builtin' | 'project' | 'user' | 'plugin'
  kind: 'command' | 'skill'
  description?: string
  arg_hint?: string
  namespace?: string
}

export interface DaemonInfo {
  daemon_id: string
  hostname: string
  agents: string[]
  online: boolean
  last_seen_at?: string
}

export type EventHandler = (event: DaemonEvent) => void

const ws = ref<WebSocket | null>(null)
const connected = ref(false)
const reconnecting = ref(false)
const handlers = new Set<EventHandler>()
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempt = 0
let currentUrl = ''
let currentBaseUrl = ''
let pendingMessages: any[] = []
// 连接流程进行中标志（含 connect 前的 token 刷新）。send 在此期间把消息 buffer 到
// pendingMessages，等 onopen flush——否则 DashboardView 的 `connect(); send()` 在 async
// 刷新窗口内 ws.value 尚未就绪，list_sessions/list_daemons 请求会丢失。
let connecting = false

const { doRefreshToken, logout } = useAuth()

// Daemon online tracking
const daemons = ref<Map<string, DaemonInfo>>(new Map())

function withWsQuery(base: string, params: Record<string, string>): string {
  try {
    const url = new URL(base)
    for (const key of ['token', 'ticket', 'api_key', 'type']) url.searchParams.delete(key)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    return url.toString()
  } catch {
    const [path, rawQuery = ''] = base.split('?')
    const search = new URLSearchParams(rawQuery)
    for (const key of ['token', 'ticket', 'api_key', 'type']) search.delete(key)
    for (const [key, value] of Object.entries(params)) search.set(key, value)
    const query = search.toString()
    return query ? `${path}?${query}` : path
  }
}

async function requestWsTicket(token: string): Promise<string | null> {
  const origin = getRelayOrigin()
  const url = origin ? `${origin}/api/auth/ws-ticket` : '/api/auth/ws-ticket'
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const data = await res.json()
    return typeof data.ticket === 'string' ? data.ticket : null
  } catch {
    return null
  }
}

async function getRelayWsUrl(base = getRelayWs()): Promise<string> {
  const token = localStorage.getItem('pocketctl_access_token')
  if (!token) return base
  const ticket = await requestWsTicket(token)
  if (!ticket) throw new Error('ws ticket request failed')
  return withWsQuery(base, { type: 'client', ticket })
}

/** 连接前确保 access token 未过期；过期则刷新（成功后 localStorage 已写入新 token）。 */
async function ensureFreshToken(): Promise<boolean> {
  const token = localStorage.getItem('pocketctl_access_token')
  if (!token) return true                  // 未登录：交给上层处理，不阻塞连接
  if (!isTokenExpired(token)) return true  // 仍有效
  return await doRefreshToken()
}

async function connect(url?: string) {
  if (ws.value && ws.value.readyState === WebSocket.OPEN) return
  connecting = true
  reconnecting.value = true
  try {
    await ensureFreshToken()
    currentBaseUrl = url || currentBaseUrl || getRelayWs()
    currentUrl = await getRelayWsUrl(currentBaseUrl)
    ws.value = new WebSocket(currentUrl)

    ws.value.onopen = () => {
      connected.value = true; reconnecting.value = false; connecting = false; reconnectAttempt = 0
      // Report current locale to relay for language-aware title generation
      const locale = localStorage.getItem('pocketctl-locale') || 'zh'
      send({ type: 'set_locale', locale })
      // Flush pending messages
      if (pendingMessages.length > 0) {
        const msgs = pendingMessages; pendingMessages = []
        msgs.forEach(m => send(m))
      }
    }
    ws.value.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        // Handle daemon_status and daemon_list internally to track online state
        if (data.type === 'daemon_status') {
          handleDaemonStatus(data)
        }
        if (data.type === 'daemon_list' && data.daemons) {
          for (const d of data.daemons) {
            daemons.value.set(d.daemon_id, {
              daemon_id: d.daemon_id,
              hostname: d.hostname || d.daemon_alias || 'unknown',
              agents: d.agents || [],
              online: d.daemon_online || d.status === 'online',
              last_seen_at: d.last_seen_at,
            })
          }
        }
        handlers.forEach(h => h(data))
      } catch {}
    }
    ws.value.onclose = (ev: CloseEvent) => {
      connected.value = false; connecting = false; reconnecting.value = true
      // 4001 = relay 拒绝 token（过期/吊销）：刷新后用新 token 重连，而非无脑重试
      // 撞同一个失效 token（那会触发 relay 端按 IP 递增封禁）。
      if (ev?.code === 4001) handleAuthRejected()
      else scheduleReconnect()
    }
    ws.value.onerror = () => { ws.value?.close() }
  } catch {
    connecting = false
  }
}

function handleDaemonStatus(data: any) {
  const id = data.daemon_id
  if (!id) return
  const existing = daemons.value.get(id)
  if (data.status === 'online') {
    daemons.value.set(id, {
      daemon_id: id,
      hostname: data.hostname || existing?.hostname || 'unknown',
      agents: data.agents || existing?.agents || [],
      online: true,
    })
  } else if (data.status === 'offline') {
    daemons.value.set(id, {
      daemon_id: id,
      hostname: data.hostname || existing?.hostname || 'unknown',
      agents: existing?.agents || [],
      online: false,
      last_seen_at: data.last_seen_at || new Date().toISOString(),
    })
  }
}

function isDaemonOnline(daemonId?: string): boolean {
  if (!daemonId) return false
  return daemons.value.get(daemonId)?.online ?? false
}

function effectiveStatus(session: { status: string; daemon_id?: string }): string {
  if (session.daemon_id && !isDaemonOnline(session.daemon_id)) {
    return 'disconnected'
  }
  return session.status
}

function scheduleReconnect() {
  if (reconnectTimer) return
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 30000)
  reconnectAttempt++
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(currentBaseUrl) }, delay)
}

/** relay 以 4001(invalid token) 关闭后的恢复：刷新 token，成功则用新 token 立即重连
 * （重置退避），失败则登出——避免持有永久失效的 refresh token 反复重试。 */
async function handleAuthRejected(): Promise<void> {
  const ok = await doRefreshToken()
  if (ok) {
    reconnectAttempt = 0
    connect(currentBaseUrl) // localStorage 已是新 token；ensureFreshToken 见有效不再刷新
  } else {
    logout() // refresh 失败，清空登录态，等待用户重新登录
  }
}

function send(data: any): boolean {
  try {
    if (ws.value && ws.value.readyState === WebSocket.OPEN) {
      ws.value.send(JSON.stringify(data))
      return true
    }
    // 连接流程进行中（含 connect 前的 token 刷新）或正在握手：buffer 到 onopen flush
    if (connecting || (ws.value && ws.value.readyState === WebSocket.CONNECTING)) {
      pendingMessages.push(data)
      return true
    }
    return false // disconnected — caller should roll back optimistic UI
  } catch {
    return false
  }
}

function reportLocale() {
  const locale = localStorage.getItem('pocketctl-locale') || 'zh'
  send({ type: 'set_locale', locale })
}

// Watch locale changes and re-report to relay
if (typeof window !== 'undefined') {
  window.addEventListener('pocketctl-locale-change', ((e: CustomEvent) => {
    send({ type: 'set_locale', locale: e.detail.locale })
  }) as EventListener)
}

function onEvent(typeOrHandler: string | EventHandler, maybeHandler?: EventHandler) {
  if (typeof typeOrHandler === 'function') {
    handlers.add(typeOrHandler)
    return () => handlers.delete(typeOrHandler)
  }
  if (maybeHandler) {
    const wrapped: EventHandler = (data: any) => {
      if (data.type === typeOrHandler) maybeHandler(data)
    }
    handlers.add(wrapped)
    return () => handlers.delete(wrapped)
  }
  throw new Error('onEvent requires a handler function or (type, handler)')
}

export function useWebSocket() {
  return { ws, connected, reconnecting, daemons, isDaemonOnline, effectiveStatus, connect, send, onEvent, reportLocale }
}
