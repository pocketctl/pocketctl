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

// Daemon online tracking
const daemons = ref<Map<string, DaemonInfo>>(new Map())

function connect(url: string) {
  if (ws.value && ws.value.readyState === WebSocket.OPEN) return
  currentUrl = url
  reconnecting.value = true
  ws.value = new WebSocket(url)

  ws.value.onopen = () => { connected.value = true; reconnecting.value = false; reconnectAttempt = 0 }
  ws.value.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      // Handle daemon_status internally to track online state
      if (data.type === 'daemon_status') {
        handleDaemonStatus(data)
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
  if (ws.value && ws.value.readyState === WebSocket.OPEN) ws.value.send(JSON.stringify(data))
}

function onEvent(handler: EventHandler) { handlers.add(handler); return () => handlers.delete(handler) }

export function useWebSocket() {
  return { ws, connected, reconnecting, daemons, isDaemonOnline, effectiveStatus, connect, send, onEvent }
}
