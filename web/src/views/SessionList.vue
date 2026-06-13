<template>
  <div class="session-list">
    <div class="header-row">
      <h2>Sessions</h2>
      <div class="header-actions">
        <button class="btn logout" @click="handleLogout">退出</button>
        <button class="btn primary" @click="showNewSession = true">+ New Session</button>
      </div>
    </div>
    <div v-if="lastError" class="error-banner">{{ lastError }}</div>
    <div v-if="sessions.length === 0" class="empty">
      <div class="empty-icon">📡</div>
      <p class="empty-title">还没有活跃的会话</p>
      <p class="empty-desc">在远程机器上安装并启动 Daemon 即可看到会话</p>
      <code class="empty-cmd">curl -fsSL https://pocketctl.me/install.sh | bash</code>
      <code class="empty-cmd">pocketctl daemon start --relay &lt;url&gt; --api-key &lt;key&gt;</code>
      <button class="btn primary empty-btn" @click="showNewSession = true">创建 Web 会话</button>
    </div>
    <div v-for="s in sortedSessions" :key="s.session_id" class="session-row" @click="$router.push(`/session/${s.session_id}`)">
      <span class="status-indicator" :class="getEffectiveStatus(s)">
        <span v-if="getEffectiveStatus(s) === 'running' || getEffectiveStatus(s) === 'busy'" class="pulse-ring"></span>
        <span v-if="getEffectiveStatus(s) === 'completed'" class="icon">✓</span>
        <span v-else-if="getEffectiveStatus(s) === 'killed'" class="icon">✕</span>
      </span>
      <div class="session-info">
        <div class="session-title">{{ s.title || s.session_id.slice(0, 8) }}</div>
        <div class="session-meta">
          <span class="source-badge" :class="s.source">{{ s.source === 'terminal' ? '📺 终端' : '🌐 Web' }}</span>
          <span v-if="s.hostname" class="hostname-badge">💻 {{ s.hostname }}</span>
          <span v-if="s.subagent_count > 0" class="subagent-badge">🤖 {{ s.subagent_count }}</span>
          <span v-if="s.exit_reason" class="exit-reason">{{ exitReasonLabel(s.exit_reason) }}</span>
          <span class="session-id">{{ s.session_id.slice(0, 8) }}</span>
          <span class="session-agent">{{ s.agent || 'claude-code' }}</span>
        </div>
      </div>
      <span class="session-time">{{ formatRelativeTime(s.last_activity_at || s.started_at) }}</span>
    </div>
    <NewSessionDialog v-if="showNewSession" @close="showNewSession = false" @create="handleCreate" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useWebSocket } from '../composables/useWebSocket'
import type { DaemonEvent } from '../composables/useWebSocket'
import { formatRelativeTime } from '../composables/useRelativeTime'
import { useAuth } from '../composables/useAuth'
import NewSessionDialog from '../components/NewSessionDialog.vue'

const { connect, send, onEvent, effectiveStatus } = useWebSocket()
const { isLoggedIn, logout } = useAuth()
const $router = useRouter()
const sessions = ref<any[]>([])
const showNewSession = ref(false)
const lastError = ref('')

const sortedSessions = computed(() => {
  return [...sessions.value].sort((a, b) => {
    const ta = a.last_activity_at ? new Date(a.last_activity_at).getTime() : (a.started_at ? new Date(a.started_at).getTime() : 0)
    const tb = b.last_activity_at ? new Date(b.last_activity_at).getTime() : (b.started_at ? new Date(b.started_at).getTime() : 0)
    return tb - ta
  })
})

function getEffectiveStatus(s: any): string {
  return effectiveStatus({ status: s.status, daemon_id: s.daemon_id })
}

function exitReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    user_interrupt: '用户中断',
    normal_exit: '正常退出',
    process_crash: '异常退出',
    signal_kill: '被终止',
    unknown: '已退出',
  }
  return labels[reason] || '已退出'
}

onMounted(() => {
  const token = localStorage.getItem('pocketctl_access_token') || ''
  if (!token) { $router.push('/login'); return }
  const relayWs = localStorage.getItem('pocketctl_relay_url') || (window as any).__RELAY_WS__ || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
  const wsUrl = `${relayWs}?type=client&token=${encodeURIComponent(token)}`
  connect(wsUrl)

  setTimeout(() => { send({ type: 'list_sessions' }) }, 500)

  onEvent((evt: DaemonEvent) => {
    if (evt.type === 'error') {
      lastError.value = evt.error || 'Unknown error'
      setTimeout(() => { lastError.value = '' }, 5000)
    }
    if (evt.type === 'session_list') {
      const list = (evt as any).sessions as any[]
      if (list && list.length) {
        sessions.value = list.map(s => ({
          session_id: s.session_id,
          status: s.status,
          agent: s.agent_type || 'claude-code',
          started_at: new Date(s.created_at),
          last_activity_at: s.last_activity_at ? new Date(s.last_activity_at) : undefined,
          cwd: s.cwd,
          title: s.title || '',
          source: s.source || 'daemon',
          daemon_id: s.daemon_id,
          hostname: s.hostname || '',
          exit_reason: s.exit_reason,
          daemon_online: s.daemon_online,
          subagent_count: s.subagent_count || 0,
        }))
      }
    }
    if (evt.type === 'session_status' && evt.session_id) {
      const existing = sessions.value.find(s => s.session_id === evt.session_id)
      if (existing) {
        existing.status = evt.status
        if (evt.exit_reason) existing.exit_reason = evt.exit_reason
        if (evt.last_activity_at) existing.last_activity_at = new Date(evt.last_activity_at)
      }
    }
    if (evt.type === 'session_id_changed' && evt.session_id) {
      const old = (evt as any).old_session_id
      const existing = sessions.value.find(s => s.session_id === old)
      if (existing) existing.session_id = evt.session_id
    }
    if (evt.type === 'session_created' && evt.session_id) {
      if (!sessions.value.find(s => s.session_id === evt.session_id)) {
        sessions.value.unshift({ session_id: evt.session_id, status: 'running', agent: 'claude-code', started_at: new Date(), title: evt.title || '', source: 'daemon', last_activity_at: new Date() })
      }
    }
    if (evt.type === 'session_discovered' && evt.session_id) {
      if (!sessions.value.find(s => s.session_id === evt.session_id)) {
        sessions.value.unshift({ session_id: evt.session_id, status: 'busy', agent: 'claude-code', started_at: new Date(), title: evt.title || 'Terminal Session', source: 'terminal', cwd: evt.cwd, last_activity_at: new Date(), subagent_count: (evt as any).subagent_count || 0, daemon_id: (evt as any).daemon_id || '', hostname: (evt as any).hostname || '' })
      }
    }
    if (evt.type === 'session_title_update' && evt.session_id) {
      const existing = sessions.value.find(s => s.session_id === evt.session_id)
      if (existing) existing.title = evt.title || existing.title
    }
  })
})

function handleCreate(data: { agent: string; cwd: string; prompt: string }) {
  send({ type: 'session_create', agent: data.agent, cwd: data.cwd, prompt: data.prompt })
  showNewSession.value = false
}

function handleLogout() {
  logout()
  $router.push('/login')
}
</script>

<style scoped>
.session-list { padding: 20px; max-width: 800px; margin: 0 auto; }
.header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.header-row h2 { font-size: 20px; }
.btn { padding: 8px 16px; border-radius: 6px; border: 1px solid #30363d; background: #21262d; color: #e6edf3; cursor: pointer; font-size: 14px; }
.btn.primary { background: #238636; border-color: #238636; }
.btn.primary:hover { background: #2ea043; }
.btn.logout { background: transparent; border-color: #30363d; color: #8b949e; font-size: 13px; }
.btn.logout:hover { border-color: #f85149; color: #f85149; }
.header-actions { display: flex; gap: 8px; align-items: center; }
.empty { text-align: center; color: #8b949e; padding: 48px 20px; }
.empty-icon { font-size: 40px; margin-bottom: 12px; }
.empty-title { font-size: 16px; color: #e6edf3; margin-bottom: 6px; }
.empty-desc { font-size: 13px; margin-bottom: 20px; }
.empty-cmd { display: block; background: #0d1117; padding: 8px 12px; border-radius: 6px; font-size: 12px; color: #79c0ff; margin: 6px auto; max-width: 400px; word-break: break-all; }
.empty-btn { margin-top: 20px; }
.error-banner { background: #3d1214; border: 1px solid #da3633; color: #f85149; padding: 12px 16px; border-radius: 8px; margin-bottom: 12px; font-size: 14px; }
.session-row { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border: 1px solid #21262d; border-radius: 8px; margin-bottom: 8px; cursor: pointer; background: #161b22; }
.session-row:hover { border-color: #30363d; background: #1c2129; }

/* Status indicator — unified dot/icon system */
.status-indicator {
  width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  position: relative; font-size: 9px; font-weight: 700;
}
.status-indicator.running { background: #22C55E; }
.status-indicator.running .pulse-ring {
  position: absolute; inset: -3px; border-radius: 50%; border: 2px solid #22C55E;
  animation: pulse-ring 1.5s infinite;
}
.status-indicator.busy { background: #d29922; }
.status-indicator.busy .pulse-ring {
  position: absolute; inset: -3px; border-radius: 50%; border: 2px solid #d29922;
  animation: pulse-ring 1.5s infinite;
}
.status-indicator.idle { background: #EAB308; }
.status-indicator.waiting_approval { background: #F97316; }
.status-indicator.exited { background: #6B7280; }
.status-indicator.completed { background: #9CA3AF; color: white; }
.status-indicator.error { background: #EF4444; }
.status-indicator.killed { background: #DC2626; color: white; }
.status-indicator.disconnected {
  background: transparent; border: 2px dashed #3B82F6;
  animation: none;
}

.exit-reason { font-size: 11px; color: #6B7280; }
.session-id { font-family: monospace; font-size: 12px; color: #58a6ff; }
.session-agent { color: #8b949e; font-size: 12px; }
.session-time { margin-left: auto; color: #8b949e; font-size: 13px; white-space: nowrap; }
.session-info { flex: 1; min-width: 0; }
.session-title { font-size: 14px; color: #e6edf3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 2px; }
.session-meta { display: flex; align-items: center; gap: 8px; }
.source-badge { font-size: 11px; padding: 1px 6px; border-radius: 8px; }
.source-badge.terminal { background: #1f3a5f; color: #79c0ff; }
.source-badge.daemon { background: #1a3a2a; color: #7ee787; }
.hostname-badge { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: #1c2333; color: #8b949e; }
.subagent-badge { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: #2d1a3e; color: #c084fc; }

/* Mobile */
@media (max-width: 768px) {
  .session-list { padding: 12px; }
  .session-row { padding: 14px 12px; gap: 10px; min-height: 44px; }
  .session-id { font-size: 13px; }
  .session-agent { display: none; }
  .session-time { font-size: 12px; }
  .header-row h2 { font-size: 17px; }
  .btn { padding: 10px 14px; font-size: 13px; min-height: 44px; }
}
@keyframes pulse-ring { 0% { opacity: 0.8; transform: scale(1); } 100% { opacity: 0; transform: scale(1.6); } }
</style>
