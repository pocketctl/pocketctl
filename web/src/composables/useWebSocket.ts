import { ref } from 'vue'

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
let pendingMessages: any[] = []

// Daemon online tracking
const daemons = ref<Map<string, DaemonInfo>>(new Map())

function getRelayWsUrl(): string {
  const stored = localStorage.getItem('pocketctl_relay_url') || (window as any).__RELAY_WS__ || ''
  // Use relative WebSocket URL when behind nginx proxy (production).
  // Only use stored URL if it points to a non-localhost host (explicit external relay).
  let base: string
  if (stored) {
    try {
      const u = new URL(stored)
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
        base = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`
      } else {
        base = stored
      }
    } catch {
      base = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`
    }
  } else {
    base = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`
  }
  const token = localStorage.getItem('pocketctl_access_token')
  if (!token) return base
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}token=${encodeURIComponent(token)}&type=client`
}

function connect(url?: string) {
  if (ws.value && ws.value.readyState === WebSocket.OPEN) return
  currentUrl = url || getRelayWsUrl()
  reconnecting.value = true
  ws.value = new WebSocket(currentUrl)

  ws.value.onopen = () => {
    connected.value = true; reconnecting.value = false; reconnectAttempt = 0
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
  ws.value.onclose = () => { connected.value = false; reconnecting.value = true; scheduleReconnect() }
  ws.value.onerror = () => { ws.value?.close() }
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
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(currentUrl) }, delay)
}

function send(data: any) {
  if (ws.value && ws.value.readyState === WebSocket.OPEN) {
    ws.value.send(JSON.stringify(data))
  } else if (ws.value && ws.value.readyState === WebSocket.CONNECTING) {
    // Buffer until connected
    pendingMessages.push(data)
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
