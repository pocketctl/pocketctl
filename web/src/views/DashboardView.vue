<template>
  <div class="page-container">
    <!-- Stats Strip (三状态，点击筛选跳转) -->
    <div class="stats-strip">
      <router-link class="stat-cell" :to="{ path: '/hosts', query: { filter: 'online' } }">
        <span class="stat-dot online"></span>
        <span class="stat-num">{{ onlineDaemonCount }}</span>
        <span class="stat-lbl">在线主机</span>
      </router-link>
      <router-link class="stat-cell" :to="{ path: '/hosts', query: { filter: 'offline' } }">
        <span class="stat-dot offline"></span>
        <span class="stat-num">{{ offlineDaemonCount }}</span>
        <span class="stat-lbl">离线主机</span>
      </router-link>
      <router-link class="stat-cell" :to="'/session/default'">
        <span class="stat-num">{{ activeSessionCount }}</span>
        <span class="stat-lbl">活跃会话</span>
      </router-link>
    </div>

    <!-- Token Strip (C3 接真实数据，现占位) -->
    <div class="token-strip">
      <span class="ts-prefix">Token 消耗</span>
      <span class="ts-sep"></span>
      <span class="ts-item"><span class="ts-num">{{ formatCost(tokenSummary.total) }}</span>总消耗</span>
      <span class="ts-sep"></span>
      <span class="ts-item"><span class="ts-num">{{ formatCost(tokenSummary.today) }}</span>今日</span>
      <span class="ts-sep"></span>
      <span class="ts-item"><span class="ts-num">{{ formatCost(tokenSummary.week) }}</span>本周</span>
      <span class="ts-sep"></span>
      <span class="ts-item"><span class="ts-num">{{ formatCost(tokenSummary.month) }}</span>本月</span>
    </div>

    <!-- Daemon Section -->
    <div class="page-header">
      <div>
        <h2 class="page-title">我的主机</h2>
        <div class="page-subtitle">
          <span class="text-mono">{{ daemons.length }}</span> 台 ·
          <span class="text-success">{{ onlineDaemonCount }}</span> 在线 ·
          <span class="text-tertiary">{{ offlineDaemonCount }}</span> 离线 ·
          <router-link to="/hosts" class="manage-all-link">管理全部 →</router-link>
        </div>
      </div>
      <button class="btn btn-secondary" @click="showRegisterDaemon = true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
        注册主机
      </button>
    </div>

    <!-- Error Banner -->
    <div v-if="lastError" class="banner banner-error">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 4h1.5v5h-1.5V5zm.75 6.5a.75.75 0 110-1.5.75.75 0 010 1.5z"/></svg>
      {{ lastError }}
    </div>

    <!-- Empty State -->
    <div v-if="daemons.length === 0 && !loading" class="empty-state">
      <div class="empty-icon">🖥️</div>
      <div class="empty-title">暂无在线主机</div>
      <div class="empty-subtitle">在远程机器上安装并启动 Daemon 即可开始监控</div>
      <div class="code-block" style="margin-top:16px; max-width:500px; margin-left:auto;margin-right:auto;">
        <span class="cmd">curl -fsSL https://pocketctl.me/install.sh | bash</span><br/>
        <span class="cmd">pocketctl daemon start</span>
      </div>
    </div>

    <!-- Daemon Cards Grid -->
    <div v-if="daemons.length > 0" class="daemon-grid">
      <div v-for="(d, i) in daemons" :key="d.daemon_id" class="daemon-card" :class="{ selected: selectedDaemon === d.daemon_id }" :data-default-name="d.hostname || d.daemon_id.slice(0,8)" @click="toggleDaemonFilter(d.daemon_id)">
        <div class="card-header">
          <div class="daemon-icon">
            <svg v-if="d.daemon_online" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><circle cx="6" cy="6" r="1" fill="currentColor"/><circle cx="6" cy="18" r="1" fill="currentColor"/></svg>
          </div>
          <div class="daemon-name">
            <h3>
              <span>{{ getDisplayName(d) }}</span>
              <span class="alias-badge" :class="{ visible: !!d.daemon_alias }">别名</span>
              <button class="edit-name-btn" @click.stop="startRename(i)" title="编辑别名">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              <button class="reset-name-btn" :class="{ visible: !!d.daemon_alias }" @click.stop="resetAlias(i)">恢复默认</button>
              <span :class="['chip', d.daemon_online ? 'chip-online' : 'chip-offline']" style="margin-left:auto;">{{ d.daemon_online ? '在线' : '离线' }}</span>
            </h3>
            <div class="daemon-host">{{ d.ip && d.ip !== 'unknown' ? d.ip + ' · ' : '' }}{{ d.os && d.os !== 'unknown' ? d.os : '' }}</div>
          </div>
        </div>

        <!-- Rename Row -->
        <div class="rename-row" :class="{ visible: renameIndex === i }">
          <input class="rename-input" v-model="renameInput" type="text" placeholder="输入别名…" maxlength="32" @keydown.enter="confirmRename(i)" @keydown.escape="cancelRename" />
          <button class="rename-action confirm" @click.stop="confirmRename(i)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>
          </button>
          <button class="rename-action cancel" @click.stop="cancelRename">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <div class="card-stats">
          <div class="stat">
            <div class="stat-value" :class="{ accent: daemonSessionCount(d.daemon_id) > 0 }">{{ daemonSessionCount(d.daemon_id) }}</div>
            <div class="stat-label">活跃会话</div>
          </div>
          <div class="stat">
            <div class="stat-value">{{ totalSessionCount(d.daemon_id) }}</div>
            <div class="stat-label">总会话数</div>
          </div>
          <div class="stat">
            <div class="stat-value" :style="!d.daemon_online ? 'color:var(--fg-tertiary);' : ''">{{ d.daemon_online ? '在线' : '离线' }}</div>
            <div class="stat-label">状态</div>
          </div>
        </div>
        <div class="card-meta">
          <div class="agents">
            <span v-for="agent in getActiveAgents(d.daemon_id)" :key="agent" :class="['chip', d.daemon_online ? 'chip-terminal' : 'chip-offline']">{{ agentLabel(agent) }}</span>
          </div>
          <span>{{ d.daemon_online ? '在线' : (d.last_seen_at ? '最后在线 ' + formatRelativeTime(d.last_seen_at) : '离线') }}</span>
        </div>
      </div>
    </div>

    <!-- Sessions Section -->
    <div class="page-header" style="margin-top:16px;">
      <div>
        <h2 class="page-title">{{ selectedDaemon ? (getDisplayName(selectedDaemonObj) + ' 的会话') : '最近会话' }}</h2>
        <div class="page-subtitle">{{ selectedDaemon ? '该主机关联的所有会话' : '跨所有主机的会话活动' }}</div>
      </div>
      <button v-if="selectedDaemon" class="btn btn-secondary" @click="clearDaemonFilter">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        清除筛选
      </button>
    </div>

    <div class="session-table" v-if="filteredSessions.length > 0">
      <div class="session-table-header">
        <span>会话</span>
        <span class="col-daemon">主机</span>
        <span class="col-time">时间</span>
        <span class="col-actions" style="text-align:right;">状态</span>
      </div>
      <div v-for="s in filteredSessions" :key="s.session_id" :class="['session-row', { 'pending-delete': s.__pendingDelete }]" @click="!s.__pendingDelete && $router.push(`/session/${s.session_id}`)">
        <div class="session-info">
          <span :class="['status-dot', getEffectiveStatus(s)]"></span>
          <span v-if="s.pinned" class="pin-mark">📌</span>
          <input v-if="sessRenamingId === s.session_id" class="ss-rename-input" v-model="sessRenameInput" maxlength="60"
            @click.stop @keydown.enter="sessCommitRename(s)" @keydown.escape="sessCancelRename" @blur="sessCommitRename(s)" />
          <span v-else :class="['session-title', { mono: !s.title || s.title.startsWith('Terminal Session') }]">{{ s.title || s.session_id.slice(0, 8) }}</span>
        </div>
        <div class="session-daemon">{{ s.daemon_alias || s.hostname || s.daemon_id?.slice(0, 8) }}</div>
        <div class="session-time">{{ formatRelativeTime(s.last_activity_at || s.updated_at) }}</div>
        <div class="session-actions">
          <span :class="['chip', statusChip(s)]">{{ statusLabel(s) }}</span>
          <SessionActions :session="s" @startRename="sessStartRename" @deleted="onDeleted" @pinned="onPinned" />
        </div>
      </div>
    </div>

    <!-- No Sessions -->
    <div v-if="filteredSessions.length === 0 && daemons.length > 0" class="session-empty">
      <div class="empty-title" style="font-size:15px;">暂无活跃会话</div>
      <div class="empty-subtitle">点击"新建会话"开始一个 AI 编程会话</div>
    </div>

    <NewSessionDialog v-if="showNewSession" :daemons="daemons" @close="showNewSession = false" />
    <RegisterDaemonDialog v-if="showRegisterDaemon" @close="showRegisterDaemon = false" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick, inject, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useWebSocket } from '../composables/useWebSocket'
import { formatRelativeTime } from '../composables/useRelativeTime'
import { useAuth } from '../composables/useAuth'
import NewSessionDialog from '../components/NewSessionDialog.vue'
import RegisterDaemonDialog from '../components/RegisterDaemonDialog.vue'
import SessionActions from '../components/SessionActions.vue'
import { useSessionRename } from '../composables/useSessionRename'

const { renamingId: sessRenamingId, renameInput: sessRenameInput, startRename: sessStartRename, commitRename: sessCommitRename, cancelRename: sessCancelRename } = useSessionRename()

const { connect, send, onEvent, effectiveStatus } = useWebSocket()
const { isLoggedIn, logout, accessToken } = useAuth()
const router = useRouter()

const daemons = ref<any[]>([])
const sessions = ref<any[]>([])
const showNewSession = ref(false)
const showRegisterDaemon = ref(false)
const triggerNewSession = inject<{ value: number }>('triggerNewSession', { value: 0 })
watch(() => triggerNewSession.value, (v) => { if (v > 0) showNewSession.value = true })
const lastError = ref('')
const loading = ref(true)
const renameIndex = ref<number | null>(null)
const renameInput = ref('')
const aliases = ref<Record<string, string>>({})
const selectedDaemon = ref<string | null>(null)

// Token cost summary — wired to /api/cost/summary (cost_usd in USD)
const tokenSummary = ref({ total: 0, today: 0, week: 0, month: 0 })
function formatCost(v: number | null | undefined): string {
  if (v == null) return '—'
  if (v > 0 && v < 0.01) return '<$0.01'
  return '$' + v.toFixed(2)
}
function getRelayOrigin(): string {
  const relayWs = localStorage.getItem('pocketctl_relay_url') || (window as any).__RELAY_WS__ || ''
  try { const url = new URL(relayWs); if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return ''; return url.origin.replace(/^ws/, 'http') } catch { return '' }
}
async function fetchCostSummary() {
  const origin = getRelayOrigin()
  try {
    const r = await fetch(`${origin}/api/cost/summary`, { headers: { Authorization: `Bearer ${accessToken.value}` } })
    if (r.ok) {
      const d = await r.json()
      tokenSummary.value = { total: d.total ?? 0, today: d.today ?? 0, week: d.thisWeek ?? 0, month: d.thisMonth ?? 0 }
    }
  } catch { /* ignore */ }
}

const onlineDaemonCount = computed(() => daemons.value.filter(d => d.daemon_online).length)
const offlineDaemonCount = computed(() => daemons.value.filter(d => !d.daemon_online).length)
const activeSessionCount = computed(() => sessions.value.filter(s => s.status === 'running' || s.status === 'busy').length)

const sortedSessions = computed(() => [...sessions.value].sort((a, b) => {
  if (a.pinned && !b.pinned) return -1
  if (!a.pinned && b.pinned) return 1
  const ta = a.last_activity_at ? new Date(a.last_activity_at).getTime() : 0
  const tb = b.last_activity_at ? new Date(b.last_activity_at).getTime() : 0
  return tb - ta
}))

const filteredSessions = computed(() => {
  if (!selectedDaemon.value) return sortedSessions.value
  return sortedSessions.value.filter(s => s.daemon_id === selectedDaemon.value)
})

const selectedDaemonObj = computed(() => daemons.value.find(d => d.daemon_id === selectedDaemon.value))

function toggleDaemonFilter(daemonId: string) {
  selectedDaemon.value = selectedDaemon.value === daemonId ? null : daemonId
}

function clearDaemonFilter() {
  selectedDaemon.value = null
}

function getDisplayName(d: any): string { return d.daemon_alias || d.hostname || d.daemon_id?.slice(0, 8) }
function daemonSessionCount(daemonId: string): number { return sessions.value.filter(s => s.daemon_id === daemonId && (s.status === 'running' || s.status === 'busy')).length }
function totalSessionCount(daemonId: string): number { return sessions.value.filter(s => s.daemon_id === daemonId).length }
function getEffectiveStatus(s: any): string { return effectiveStatus({ status: s.status, daemon_id: s.daemon_id }) }

function getActiveAgents(daemonId: string): string[] {
  const agents = new Set<string>()
  for (const s of sessions.value) {
    if (s.daemon_id === daemonId && s.agent_type) {
      agents.add(s.agent_type)
    }
  }
  return agents.size > 0 ? [...agents] : ['claude-code'] // fallback if no sessions
}

function agentLabel(agent: string): string {
  const labels: Record<string, string> = { 'claude-code': 'Claude Code', 'opencode': 'OpenCode', 'codex': 'Codex' }
  return labels[agent] || agent
}

function statusChip(s: any): string {
  const st = getEffectiveStatus(s)
  if (st === 'running') return 'chip-running'
  if (st === 'busy') return 'chip-busy'
  if (st === 'idle') return 'chip-busy'
  if (st === 'completed') return 'chip-terminal'
  if (st === 'error' || st === 'killed') return 'chip-offline'
  return 'chip-terminal'
}

function statusLabel(s: any): string {
  const st = getEffectiveStatus(s)
  const labels: Record<string, string> = { running: '运行中', busy: '繁忙', idle: '空闲', completed: '已完成', error: '错误', killed: '已终止', disconnected: '已断开', exited: '已退出' }
  return labels[st] || s.status
}

// Alias editing
function startRename(i: number) {
  renameIndex.value = i
  renameInput.value = daemons.value[i].daemon_alias || ''
  nextTick(() => { const el = document.querySelector('.rename-input') as HTMLInputElement; if (el) el.focus() })
}

async function confirmRename(i: number) {
  const d = daemons.value[i]
  const alias = renameInput.value.trim() || null
  try {
    const token = localStorage.getItem('pocketctl_access_token')
    if (token) {
      await fetch(`/api/daemons/${d.daemon_id}/alias`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ alias }),
      })
    }
  } catch { /* API fail silently */ }
  d.daemon_alias = alias
  renameIndex.value = null
}

function cancelRename() { renameIndex.value = null; renameInput.value = '' }
function resetAlias(i: number) { daemons.value[i].daemon_alias = null; confirmRename(i) }


onMounted(() => {
  if (!isLoggedIn.value) { router.push('/login'); return }
  connect()
  send({ type: 'list_sessions' })
  send({ type: 'list_daemons' })
  fetchCostSummary()

  onEvent('daemon_list', (msg: any) => {
    daemons.value = (msg.daemons || []).map((d: any) => ({ ...d }))
    loading.value = false
  })

  onEvent('session_list', (msg: any) => {
    sessions.value = msg.sessions || []
    loading.value = false
    if ((window as any).__updateSessionCount) (window as any).__updateSessionCount(sessions.value.length)
  })

  onEvent('session_created', () => send({ type: 'list_sessions' }))

  onEvent('session_status', (msg: any) => {
    const idx = sessions.value.findIndex((s: any) => s.session_id === msg.session_id)
    if (idx >= 0) { sessions.value[idx].status = msg.status; if (msg.exit_reason) sessions.value[idx].exit_reason = msg.exit_reason }
  })

  onEvent('daemon_status', (msg: any) => {
    const idx = daemons.value.findIndex((d: any) => d.daemon_id === msg.daemon_id)
    if (msg.status === 'online') {
      if (idx >= 0) {
        daemons.value[idx].daemon_online = true; daemons.value[idx].hostname = msg.hostname; daemons.value[idx].agents = msg.agents
      } else {
        daemons.value.push({ daemon_id: msg.daemon_id, hostname: msg.hostname, agents: msg.agents, daemon_online: true, daemon_alias: msg.alias || null })
      }
    } else if (msg.status === 'offline') {
      if (idx >= 0) { daemons.value[idx].daemon_online = false; daemons.value[idx].last_seen_at = msg.last_seen_at || new Date().toISOString() }
    }
  })

  onEvent('session_deleted', (msg: any) => { sessions.value = sessions.value.filter((s: any) => s.session_id !== msg.session_id) })
  onEvent('session_title_update', (msg: any) => { const s = sessions.value.find((s: any) => s.session_id === msg.session_id); if (s) s.title = msg.title })
  onEvent('session_pinned', (msg: any) => { const s = sessions.value.find((s: any) => s.session_id === msg.session_id); if (s) s.pinned = msg.pinned })
  onEvent('error', (msg: any) => { lastError.value = msg.error || '未知错误' })
})

// SessionActions handlers (optimistic local updates)
function onDeleted(sessionId: string) { sessions.value = sessions.value.filter((s: any) => s.session_id !== sessionId) }
function onPinned(sessionId: string, pinned: boolean) { const s = sessions.value.find((s: any) => s.session_id === sessionId); if (s) s.pinned = pinned }
</script>

<style>
/* Stats Strip — 三状态横条，可点击筛选 */
.stats-strip { display: flex; align-items: stretch; border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; margin-bottom: 16px; background: var(--surface); }
.stat-cell { display: flex; align-items: center; gap: 9px; padding: 13px 18px; flex: 1; min-width: 0; text-decoration: none; color: var(--fg-secondary); transition: background 0.15s; cursor: pointer; }
.stat-cell:hover { background: var(--surface-hover); }
.stat-cell + .stat-cell { border-left: 1px solid var(--border); }
.stat-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.stat-dot.online { background: var(--success); }
.stat-dot.offline { background: var(--fg-tertiary); }
.stat-num { font-family: var(--font-display); font-size: 19px; font-weight: 600; color: var(--fg); font-variant-numeric: tabular-nums; letter-spacing: -0.01em; line-height: 1; }
.stat-lbl { font-size: 12.5px; color: var(--fg-tertiary); white-space: nowrap; }

/* Token Strip */
.token-strip { display: flex; align-items: center; gap: 20px; padding: 10px 18px; margin-bottom: 24px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-lg); font-size: 13px; color: var(--fg-secondary); }
.ts-prefix { font-size: 13px; font-weight: 600; color: var(--fg-secondary); }
.ts-item { display: flex; align-items: baseline; gap: 6px; }
.ts-num { font-family: var(--font-display); font-size: 17px; font-weight: 600; color: var(--fg); font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.ts-sep { width: 1px; height: 18px; background: var(--border); }

.text-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.text-success { color: var(--success); }
.text-tertiary { color: var(--fg-tertiary); }
.manage-all-link { color: var(--accent); text-decoration: none; }
.manage-all-link:hover { text-decoration: underline; }

.daemon-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; margin-bottom: 32px; }

.daemon-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 20px; transition: all 0.2s; cursor: pointer; }
.daemon-card:hover { border-color: var(--border-light); box-shadow: var(--shadow-sm); }
.daemon-card.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.daemon-card .card-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.daemon-card .daemon-icon { width: 40px; height: 40px; border-radius: var(--radius-md); background: var(--surface-active); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.daemon-card .daemon-icon svg { width: 20px; height: 20px; color: var(--fg-secondary); }
.daemon-card .daemon-name { flex: 1; min-width: 0; }
.daemon-card .daemon-name h3 { font-size: 15px; font-weight: 600; color: var(--fg); display: flex; align-items: center; gap: 6px; }
.daemon-card .daemon-name h3 .alias-badge { font-size: 10px; font-weight: 500; color: var(--accent); background: var(--accent-muted); padding: 1px 6px; border-radius: 4px; display: none; }
.daemon-card .daemon-name h3 .alias-badge.visible { display: inline-block; }
.daemon-card .daemon-name .daemon-host { font-size: 12px; color: var(--fg-tertiary); font-family: var(--font-mono); margin-top: 2px; }

.daemon-card .edit-name-btn { background: none; border: none; color: var(--fg-tertiary); cursor: pointer; padding: 4px; border-radius: 4px; display: flex; align-items: center; opacity: 0; transition: opacity 0.15s, color 0.15s; }
.daemon-card:hover .edit-name-btn { opacity: 1; }
.daemon-card .edit-name-btn:hover { color: var(--accent); }
.daemon-card .reset-name-btn { background: none; border: none; color: var(--fg-tertiary); font-size: 11px; cursor: pointer; padding: 2px 6px; border-radius: 4px; display: none; transition: color 0.15s; }
.daemon-card .reset-name-btn.visible { display: inline-block; }
.daemon-card .reset-name-btn:hover { color: var(--accent); }

.daemon-card .rename-row { display: none; align-items: center; gap: 6px; margin-bottom: 8px; animation: fade-in 0.15s ease; }
.daemon-card .rename-row.visible { display: flex; }
.daemon-card .rename-input { flex: 1; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-family: var(--font-body); font-size: 14px; color: var(--fg); outline: none; transition: border-color 0.15s; }
.daemon-card .rename-input:focus { border-color: var(--accent); }
.rename-action { background: none; border: none; cursor: pointer; padding: 4px; border-radius: 4px; display: flex; align-items: center; color: var(--fg-tertiary); transition: color 0.15s; }
.rename-action.confirm:hover { color: var(--success); }
.rename-action.cancel:hover { color: var(--error); }

.daemon-card .card-stats { display: flex; gap: 16px; margin-bottom: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
.daemon-card .stat { display: flex; flex-direction: column; gap: 2px; }
.daemon-card .stat .stat-value { font-size: 20px; font-weight: 700; color: var(--fg); font-family: var(--font-display); }
.daemon-card .stat .stat-value.accent { color: var(--accent); }
.daemon-card .stat .stat-label { font-size: 12px; color: var(--fg-tertiary); }

.daemon-card .card-meta { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--fg-tertiary); }
.daemon-card .card-meta .agents { display: flex; gap: 6px; }

/* Session Table */
.session-table { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; transition: background var(--transition), border-color var(--transition); }
.session-table-header { display: grid; grid-template-columns: 2fr 1fr 1fr 120px; padding: 12px 20px; font-size: 12px; font-weight: 600; color: var(--fg-tertiary); text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid var(--border); background: var(--surface-hover); }
.session-row { display: grid; grid-template-columns: 2fr 1fr 1fr 120px; padding: 14px 20px; align-items: center; border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.1s, opacity 0.25s ease; }
.session-row.pending-delete { opacity: 0.35; pointer-events: none; }
.session-row:last-child { border-bottom: none; }
.session-row:hover { background: var(--surface-hover); }
.session-row .session-info { display: flex; align-items: center; gap: 10px; }
.session-row .session-info .session-title { font-size: 14px; font-weight: 500; color: var(--fg); }
.session-row .session-info .session-title.mono { font-family: var(--font-mono); font-size: 13px; color: var(--accent); }
.session-row .ss-rename-input { background: var(--bg); border: 1px solid var(--accent); border-radius: var(--radius-sm); box-shadow: 0 0 0 3px var(--accent-muted); color: var(--fg); font-family: var(--font-body); font-size: 14px; font-weight: 500; padding: 4px 8px; outline: none; width: 100%; max-width: 200px; }
.session-row .session-daemon { font-size: 13px; color: var(--fg-secondary); }
.session-row .session-time { font-size: 13px; color: var(--fg-tertiary); }
.session-row .session-actions { display: flex; align-items: center; gap: 6px; justify-content: flex-end; }

.session-empty { padding: 48px; text-align: center; }

@media (max-width: 768px) {
  .daemon-grid { grid-template-columns: 1fr; }
  .quick-stats { flex-direction: column; }
  .session-table-header, .session-row { grid-template-columns: 1fr; }
  .session-table-header .col-daemon, .session-table-header .col-time, .session-table-header .col-actions,
  .session-row .session-daemon, .session-row .session-time, .session-row .session-actions { display: none; }
}
</style>
