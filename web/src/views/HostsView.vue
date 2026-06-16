<template>
  <div class="page-container">
    <!-- Page Header -->
    <div class="page-header">
      <div>
        <h2 class="page-title">主机</h2>
        <div class="page-subtitle">共 <span class="text-mono">{{ daemons.length }}</span> 台 · <span class="text-success text-mono">{{ onlineCount }}</span> 在线 · <span class="text-tertiary text-mono">{{ offlineCount }}</span> 离线</div>
      </div>
      <button class="btn btn-secondary" @click="showRegister = true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
        注册主机
      </button>
    </div>

    <!-- 全局 Token 概览条（占位，待 C2/C3 接真实数据） -->
    <div class="token-global-strip">
      <div class="tg-item"><span class="tg-num">—</span><span class="tg-label">总消耗</span></div>
      <div class="tg-sep"></div>
      <div class="tg-item"><span class="tg-num">—</span><span class="tg-label">今日</span></div>
      <div class="tg-sep"></div>
      <div class="tg-item"><span class="tg-num">—</span><span class="tg-label">本周</span></div>
      <div class="tg-sep"></div>
      <div class="tg-item"><span class="tg-num">—</span><span class="tg-label">本月</span></div>
    </div>

    <!-- 筛选 + 搜索 -->
    <div class="host-controls">
      <div class="host-filter" role="tablist" aria-label="按状态筛选主机">
        <button :class="{ active: filter === 'all' }" @click="filter = 'all'">全部<span class="count">{{ daemons.length }}</span></button>
        <button :class="{ active: filter === 'online' }" @click="filter = 'online'">在线<span class="count">{{ onlineCount }}</span></button>
        <button :class="{ active: filter === 'offline' }" @click="filter = 'offline'">离线<span class="count">{{ offlineCount }}</span></button>
      </div>
      <div class="host-search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input type="text" v-model="searchQuery" placeholder="搜索名称、IP 或系统…" aria-label="搜索主机" />
      </div>
    </div>

    <!-- 主机布局（单栏：卡片网格 ↔ 胶囊横向 + 全宽详情） -->
    <div class="hosts-layout" :class="{ 'hosts-selecting': !!selectedId }">
      <div class="hosts-grid-wrap">
        <div class="host-cards-grid" id="host-cards">
          <div v-for="d in filteredDaemons" :key="d.daemon_id"
            :class="['host-card', { selected: selectedId === d.daemon_id }]"
            :data-id="d.daemon_id"
            tabindex="0"
            role="button"
            :aria-label="(d.daemon_alias || d.hostname || d.daemon_id?.slice(0,8)) + ' ' + statusLabel(d)"
            @click="selectHost(d.daemon_id)"
            @keydown.enter.prevent="selectHost(d.daemon_id)">
            <div class="hc-head">
              <span :class="['status-dot', d.daemon_online ? 'online' : 'offline', { reconnecting: d.status === 'reconnecting' }]"></span>
              <span class="hc-icon" v-html="hostIcon(d, 18)"></span>
              <div class="hc-info">
                <div class="hc-name">{{ d.daemon_alias || d.hostname || d.daemon_id?.slice(0, 8) }}</div>
                <div class="hc-meta">{{ d.ip && d.ip !== 'unknown' ? d.ip : '—' }} · {{ d.os || 'unknown' }}</div>
              </div>
            </div>
            <div class="hc-foot">
              <div><span class="hc-sessions">{{ d.active_sessions || 0 }}</span> <span class="hc-sess-label">活跃会话</span></div>
              <span :class="['status-pill', 'mini', statusPillClass(d)]" :style="statusPillStyle(d)">{{ statusLabel(d) }}</span>
            </div>
            <button class="ss-more-btn" type="button" title="更多操作" aria-label="更多操作" @click.stop="openMenu($event, d)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>
            </button>
          </div>
          <div v-if="filteredDaemons.length === 0" class="host-cards-empty">没有匹配的主机</div>
        </div>
        <button class="hosts-deselect-btn" type="button" title="取消选择，恢复全部卡片" aria-label="取消选择" @click="deselectAll">✕</button>
      </div>

      <!-- 详情面板（全宽） -->
      <div v-if="selectedDaemon" class="host-detail-panel">
        <div class="hd-header">
          <button class="hd-more-btn" type="button" title="更多操作" aria-label="更多操作" @click.stop="openDetailMenu($event)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>
          </button>
          <div class="hd-icon" v-html="hostIcon(selectedDaemon, 28)"></div>
          <div class="hd-headinfo">
            <div class="hd-title">
              {{ selectedDaemon.daemon_alias || selectedDaemon.hostname || selectedDaemon.daemon_id?.slice(0, 8) }}
              <span :class="['status-pill', statusPillClass(selectedDaemon)]" :style="statusPillStyle(selectedDaemon)">
                <span v-if="selectedDaemon.daemon_online || selectedDaemon.status === 'reconnecting'" class="pulse"></span>{{ statusLabel(selectedDaemon) }}
              </span>
            </div>
            <div class="hd-sub">{{ selectedDaemon.ip && selectedDaemon.ip !== 'unknown' ? selectedDaemon.ip : '—' }} · {{ selectedDaemon.os || 'unknown' }} · {{ selectedDaemon.arch || '—' }}</div>
          </div>
        </div>

        <div class="hd-actions">
          <template v-if="selectedDaemon.status === 'reconnecting'">
            <button class="btn btn-secondary" disabled><span class="mini-spinner"></span>正在重启…</button>
          </template>
          <template v-else-if="selectedDaemon.daemon_online">
            <button class="btn btn-secondary" @click="confirmRestart(selectedDaemon)">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 019-9 9 9 0 016.7 3"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 01-9 9 9 9 0 01-6.7-3"/><path d="M3 21v-5h5"/></svg>
              重启 daemon
            </button>
            <button class="btn btn-danger" @click="confirmKick(selectedDaemon)">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v9"/><path d="M6.4 6.4a8 8 0 106.6-2.3"/></svg>
              强制踢下线
            </button>
          </template>
          <template v-else>
            <button class="btn btn-secondary" @click="reconnectHost(selectedDaemon)" title="等待主机端 daemon 重新连接">等待重连</button>
          </template>
        </div>

        <div class="host-detail-grid">
          <!-- 资源占用 -->
          <div class="hd-section">
            <div class="hd-section-title">{{ selectedDaemon.daemon_online ? '资源占用' : '资源占用（主机离线）' }}</div>
            <div :class="['resource-row', { offline: !selectedDaemon.daemon_online }]">
              <span class="r-label">CPU</span>
              <div class="r-bar"><div :class="['r-fill', resourceClass(selectedDaemon.cpu_pct)]" :style="rFillStyle(selectedDaemon.cpu_pct)"></div></div>
              <span class="r-val">{{ selectedDaemon.cpu_pct != null ? selectedDaemon.cpu_pct.toFixed(0) + '%' : '—' }}</span>
            </div>
            <div :class="['resource-row', { offline: !selectedDaemon.daemon_online }]">
              <span class="r-label">内存</span>
              <div class="r-bar"><div :class="['r-fill', resourceClass(selectedDaemon.mem_pct)]" :style="rFillStyle(selectedDaemon.mem_pct)"></div></div>
              <span class="r-val">{{ selectedDaemon.mem_pct != null ? selectedDaemon.mem_pct.toFixed(0) + '%' : '—' }}</span>
            </div>
            <div :class="['resource-row', { offline: !selectedDaemon.daemon_online }]">
              <span class="r-label">磁盘</span>
              <div class="r-bar"><div :class="['r-fill', resourceClass(selectedDaemon.disk_pct)]" :style="rFillStyle(selectedDaemon.disk_pct)"></div></div>
              <span class="r-val">{{ selectedDaemon.disk_pct != null ? selectedDaemon.disk_pct.toFixed(0) + '%' : '—' }}</span>
            </div>
          </div>

          <!-- 连接信息 -->
          <div class="hd-section">
            <div class="hd-section-title">连接信息</div>
            <div class="conn-grid">
              <div class="conn-item"><div class="c-label">IP 地址</div><div class="c-val">{{ selectedDaemon.ip && selectedDaemon.ip !== 'unknown' ? selectedDaemon.ip : '—' }}</div></div>
              <div class="conn-item"><div class="c-label">端口</div><div class="c-val">{{ selectedDaemon.port || '—' }}</div></div>
              <div class="conn-item"><div class="c-label">DAEMON 版本</div><div class="c-val">{{ selectedDaemon.version ? 'v' + selectedDaemon.version : '—' }}</div></div>
              <div class="conn-item"><div class="c-label">系统</div><div class="c-val">{{ selectedDaemon.os || '—' }}</div></div>
              <div class="conn-item"><div class="c-label">运行时长</div><div :class="['c-val', { muted: !selectedDaemon.daemon_online }]">{{ selectedDaemon.started_at ? formatUptime(selectedDaemon.started_at) : '—' }}</div></div>
              <div class="conn-item"><div class="c-label">最后心跳</div><div :class="['c-val', { muted: !selectedDaemon.daemon_online }]">{{ selectedDaemon.last_heartbeat ? formatRelativeTime(selectedDaemon.last_heartbeat) : '—' }}</div></div>
            </div>
          </div>

          <!-- Agent 运行状态（占位，待 C4 接版本探测/上报） -->
          <div class="hd-section">
            <div class="hd-section-title">Agent 运行状态</div>
            <template v-if="agentCards(selectedDaemon).length">
              <div class="agent-card" v-for="(a, i) in agentCards(selectedDaemon)" :key="i">
                <div :class="['ag-icon', agentIconClass(a)]">{{ agentShort(a) }}</div>
                <div class="ag-info">
                  <div class="ag-name">{{ agentName(a) }} <span class="ag-version">{{ agentVersionLabel(a) }}</span></div>
                  <div class="ag-meta">Token 统计即将上线</div>
                </div>
              </div>
            </template>
            <div v-else class="agent-card">
              <div class="ag-icon claude">CC</div>
              <div class="ag-info">
                <div class="ag-name">Claude Code <span class="ag-version">版本待上报</span></div>
                <div class="ag-meta">Agent 版本与 Token 统计即将上线</div>
              </div>
            </div>
          </div>

          <!-- Token 消耗（占位，待 C2/C3 接真实数据） -->
          <div class="hd-section">
            <div class="hd-section-title">Token 消耗</div>
            <div class="token-overview">
              <div class="token-stat"><div class="tk-num">—</div><div class="tk-label">主机总计</div></div>
              <div class="token-stat"><div class="tk-num accent">—</div><div class="tk-label">今日消耗</div></div>
              <div class="token-stat"><div class="tk-num">—</div><div class="tk-label">本月消耗</div></div>
            </div>
            <div class="session-token-list">
              <div class="session-token-row"><span class="st-title" style="color:var(--fg-tertiary);">Token 统计即将上线</span></div>
            </div>
          </div>

          <!-- 会话（全宽） -->
          <div class="hd-section hd-section-full">
            <div class="hd-section-title">会话</div>
            <div class="sess-summary">
              <div class="ss-block">
                <span class="ss-num accent">{{ selectedDaemon.active_sessions || 0 }}</span>
                <span class="ss-label">活跃会话</span>
              </div>
              <div class="ss-divider"></div>
              <div class="ss-block">
                <span class="ss-num">{{ selectedDaemon.total_sessions || 0 }}</span>
                <span class="ss-label">历史总数</span>
              </div>
              <a class="btn btn-ghost ss-link" @click="goSessionWithHost(selectedDaemon)">查看全部 →</a>
            </div>
          </div>
        </div>
      </div>

      <!-- Empty Detail -->
      <div v-else class="host-detail-panel empty">
        <div class="empty-icon">—</div>
        <div class="empty-title">请选择一台主机</div>
        <div class="empty-sub">查看连接信息、资源占用、Agent 版本、Token 消耗，或执行强制踢下线、重启等操作。</div>
      </div>
    </div>

    <!-- Floating Action Menu -->
    <div v-if="menuOpen" class="ss-menu" :style="{ left: menuX + 'px', top: menuY + 'px' }" @click.stop>
      <button class="ss-menu-item" @click="onMenuAct('copy')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        <span>复制连接信息</span>
      </button>
      <button class="ss-menu-item" @click="onMenuAct('export')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>
        <span>导出主机报告</span>
      </button>
      <button class="ss-menu-item" @click="onMenuAct('alias')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        <span>编辑别名</span>
      </button>
      <div class="ss-menu-sep"></div>
      <template v-if="menuTarget?.daemon_online">
        <button class="ss-menu-item" @click="onMenuAct('restart')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 019-9 9 9 0 016.7 3"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 01-9 9 9 9 0 01-6.7-3"/><path d="M3 21v-5h5"/></svg>
          <span>重启 daemon</span>
        </button>
        <button class="ss-menu-item" @click="onMenuAct('kick')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v9"/><path d="M6.4 6.4a8 8 0 106.6-2.3"/></svg>
          <span>强制踢下线</span>
        </button>
      </template>
      <div class="ss-menu-sep"></div>
      <button class="ss-menu-item danger" @click="onMenuAct('unregister')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
        <span>注销主机</span>
      </button>
    </div>

    <!-- Register Dialog -->
    <RegisterDaemonDialog v-if="showRegister" @close="showRegister = false" />

    <!-- Confirm Dialog -->
    <div v-if="confirm.show" class="ss-overlay" @click.self="confirm.show = false">
      <div class="ss-dialog">
        <div class="ss-dialog-icon" :class="{ danger: confirm.danger }">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>
        </div>
        <h3 class="ss-dialog-title">{{ confirm.title }}</h3>
        <p class="ss-dialog-desc">{{ confirm.desc }}</p>
        <div class="ss-dialog-actions">
          <button class="btn btn-cancel" @click="confirm.show = false">取消</button>
          <button :class="['btn', confirm.danger ? 'ss-confirm' : 'btn-accent']" :disabled="confirm.loading" @click="confirm.action">
            <span v-if="confirm.loading" class="mini-spinner"></span>{{ confirm.loading ? '处理中…' : confirm.confirmText }}
          </button>
        </div>
      </div>
    </div>

    <!-- Toast -->
    <div v-if="toast.show" class="ss-toast" @click.stop>
      <span class="ss-toast-msg">{{ toast.msg }}</span>
      <button v-if="toast.undo" class="ss-toast-undo" @click="toast.undo()">撤销</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useWebSocket } from '../composables/useWebSocket'
import { useAuth } from '../composables/useAuth'
import { formatRelativeTime } from '../composables/useRelativeTime'
import RegisterDaemonDialog from '../components/RegisterDaemonDialog.vue'

const router = useRouter()
const ws = useWebSocket()
const { accessToken } = useAuth()
const { connect, send, onEvent } = ws

const daemons = ref<any[]>([])
const selectedId = ref<string | null>(null)
const filter = ref<'all' | 'online' | 'offline'>('all')
const searchQuery = ref('')
const showRegister = ref(false)
const toast = ref<{ show: boolean; msg: string; undo?: () => void }>({ show: false, msg: '' })
const confirm = ref<{ show: boolean; title: string; desc: string; confirmText: string; danger: boolean; loading: boolean; action: () => void }>({
  show: false, title: '', desc: '', confirmText: '确认', danger: false, loading: false, action: () => {}
})
let toastTimer: ReturnType<typeof setTimeout> | null = null
const cleanups: (() => void)[] = []

// Floating menu
const menuOpen = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const menuTarget = ref<any>(null)

const onlineCount = computed(() => daemons.value.filter(d => d.daemon_online).length)
const offlineCount = computed(() => daemons.value.filter(d => !d.daemon_online).length)
const selectedDaemon = computed(() => daemons.value.find(d => d.daemon_id === selectedId.value))

const filteredDaemons = computed(() => {
  let list = daemons.value
  if (filter.value === 'online') list = list.filter(d => d.daemon_online)
  if (filter.value === 'offline') list = list.filter(d => !d.daemon_online)
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter(d =>
      (d.hostname || '').toLowerCase().includes(q) ||
      (d.daemon_alias || '').toLowerCase().includes(q) ||
      (d.ip || '').toLowerCase().includes(q) ||
      (d.os || '').toLowerCase().includes(q)
    )
  }
  return list
})

function hostIcon(d: any, size = 20): string {
  const h = (d.hostname || d.daemon_alias || '').toLowerCase()
  const o = (d.os || '').toLowerCase()
  const isNas = h.includes('nas') || d.daemon_alias?.toLowerCase?.()?.includes?.('nas')
  if (isNas) return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"/><path d="M5 10v10a2 2 0 002 2h10a2 2 0 002-2V10"/><path d="M8 14h8"/><path d="M8 18h8"/></svg>`
  if (o === 'darwin' || o === 'macos') return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><circle cx="6" cy="6" r="1" fill="currentColor"/><circle cx="6" cy="18" r="1" fill="currentColor"/></svg>`
}

function statusLabel(d: any): string {
  if (d.status === 'reconnecting') return '重启中'
  return d.daemon_online ? '在线' : '离线'
}

function statusPillClass(d: any): string {
  if (d.status === 'reconnecting') return 'busy'
  return d.daemon_online ? 'online' : 'offline'
}

function statusPillStyle(d: any): Record<string, string> {
  if (d.status === 'reconnecting') return { background: 'var(--warning-bg)', color: 'var(--warning)' }
  if (d.daemon_online) return { background: 'var(--success-bg)', color: 'var(--success)' }
  return { background: 'var(--surface-hover)', color: 'var(--fg-tertiary)' }
}

function resourceClass(pct: number | null | undefined): string {
  if (pct == null) return ''
  if (pct >= 80) return 'high'
  if (pct >= 60) return 'warn'
  return 'ok'
}

function rFillStyle(pct: number | null | undefined): Record<string, string> {
  return { width: (pct ?? 0) + '%' }
}

function formatUptime(startedAt: number): string {
  if (!startedAt) return '—'
  const seconds = Math.floor(Date.now() / 1000 - startedAt)
  if (seconds < 60) return `${seconds}秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}小时`
  return `${Math.floor(seconds / 86400)}天`
}

// Agent 字段兼容（字符串数组 / 对象数组）
function agentCards(d: any): any[] {
  if (d && Array.isArray(d.agents) && d.agents.length) return d.agents
  return []
}
function agentName(a: any): string { return typeof a === 'string' ? a : (a?.name || 'Agent') }
function agentShort(a: any): string { return /codex/i.test(agentName(a)) ? 'Cx' : 'CC' }
function agentIconClass(a: any): string { return /codex/i.test(agentName(a)) ? 'codex' : 'claude' }
function agentVersionLabel(a: any): string {
  if (typeof a === 'object' && a?.version) return 'v' + a.version
  return '版本待上报'
}

function showToast(msg: string, undo?: () => void) {
  if (toastTimer) clearTimeout(toastTimer)
  toast.value = { show: true, msg, undo }
  toastTimer = setTimeout(() => { toast.value = { show: false, msg: '' } }, 5500)
}

function showConfirm(opts: { title: string; desc: string; confirmText?: string; danger?: boolean; action: () => void }) {
  confirm.value = { show: true, title: opts.title, desc: opts.desc, confirmText: opts.confirmText || '确认', danger: !!opts.danger, loading: false, action: opts.action }
}

// 卡片 ↔ 胶囊 状态机
function selectHost(id: string) {
  selectedId.value = selectedId.value === id ? null : id
}
function deselectAll() {
  if (selectedId.value) selectedId.value = null
}

function goSessionWithHost(d: any) {
  // C1-1c: 跳会话列表并选中当前主机
  router.push({ path: '/session/default', query: { host: d.daemon_id } })
}

function openMenu(e: MouseEvent, d: any) {
  menuTarget.value = d
  const btn = (e.currentTarget as HTMLElement).getBoundingClientRect()
  menuX.value = Math.max(8, btn.right - 188)
  menuY.value = btn.bottom + 6
  menuOpen.value = true
}

function openDetailMenu(e: MouseEvent) {
  if (!selectedDaemon.value) return
  openMenu(e, selectedDaemon.value)
}

function closeMenu() { menuOpen.value = false }

function onMenuAct(act: string) {
  closeMenu()
  const d = menuTarget.value
  if (!d) return
  const id = d.daemon_id
  setTimeout(() => {
    if (act === 'copy') copyConnection(d)
    else if (act === 'export') exportReport(d)
    else if (act === 'alias') { selectedId.value = id; startRename(d) }
    else if (act === 'restart') confirmRestart(d)
    else if (act === 'kick') confirmKick(d)
    else if (act === 'unregister') confirmUnregister(d)
  }, 50)
}

function copyConnection(d: any) {
  const conn = d.ip && d.ip !== 'unknown' ? d.ip : '—'
  navigator.clipboard.writeText(conn).then(() => showToast(`已复制 ${conn}`)).catch(() => {})
}

function exportReport(d: any) {
  const md = `# ${d.daemon_alias || d.hostname || '主机报告'}\n\n- **状态**: ${statusLabel(d)}\n- **IP**: ${d.ip || '—'}\n- **系统**: ${d.os || '—'} (${d.arch || '—'})\n- **Daemon 版本**: ${d.version ? 'v' + d.version : '—'}\n- **CPU**: ${d.cpu_pct != null ? d.cpu_pct.toFixed(0) + '%' : '—'}\n- **内存**: ${d.mem_pct != null ? d.mem_pct.toFixed(0) + '%' : '—'}\n- **磁盘**: ${d.disk_pct != null ? d.disk_pct.toFixed(0) + '%' : '—'}\n`
  const blob = new Blob([md], { type: 'text/markdown' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${(d.hostname || 'host').replace(/[^\w]/g, '_')}-report.md`
  a.click()
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 200)
  showToast(`已导出 ${a.download}`)
}

function confirmRestart(d: any) {
  showConfirm({ title: `重启「${d.hostname || d.daemon_id?.slice(0, 8)}」上的 daemon？`, desc: 'daemon 将短暂断开，约 5-10 秒后自动恢复。期间会话暂停。', confirmText: '重启 daemon',
    action: async () => {
      confirm.value.loading = true
      try {
        const origin = getRelayOrigin()
        await fetch(`${origin}/api/daemons/${d.daemon_id}/restart`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken.value}` } })
        d.status = 'reconnecting'
        showToast('重启指令已发送，等待重连…')
      } catch { showToast('重启失败') }
      confirm.value.show = false
      confirm.value.loading = false
    }
  })
}

function confirmKick(d: any) {
  const prev = { daemon_online: d.daemon_online, cpu_pct: d.cpu_pct, mem_pct: d.mem_pct, disk_pct: d.disk_pct, active_sessions: d.active_sessions }
  showConfirm({ title: `强制踢下线「${d.hostname || d.daemon_id?.slice(0, 8)}」？`, desc: '立即断开 daemon 连接，所有运行中会话被中止。需重新连接恢复。', confirmText: '强制踢下线', danger: true,
    action: () => {
      d.daemon_online = false; d.cpu_pct = null; d.mem_pct = null; d.disk_pct = null; d.active_sessions = 0
      confirm.value.show = false
      const origin = getRelayOrigin()
      fetch(`${origin}/api/daemons/${d.daemon_id}/forceKick`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken.value}` } }).catch(() => {})
      showToast(`已踢下线「${d.hostname || d.daemon_id?.slice(0, 8)}」`, () => { Object.assign(d, prev) })
    }
  })
}

function reconnectHost(d: any) {
  d.status = 'reconnecting'
  showToast('等待 daemon 重连…')
}

function confirmUnregister(d: any) {
  showConfirm({ title: `注销「${d.hostname || d.daemon_id?.slice(0, 8)}」？`, desc: '从账户移除主机，历史会话保留。需重新注册才能连接。', confirmText: '注销主机', danger: true,
    action: () => {
      const idx = daemons.value.findIndex(x => x.daemon_id === d.daemon_id)
      const removed = daemons.value.splice(idx, 1)[0]
      if (selectedId.value === d.daemon_id) selectedId.value = daemons.value[0]?.daemon_id || null
      confirm.value.show = false
      showToast(`已注销「${d.hostname || d.daemon_id?.slice(0, 8)}」`, () => { daemons.value.splice(idx, 0, removed) })
    }
  })
}

function startRename(d: any) {
  const newName = prompt('输入新别名', d.daemon_alias || d.hostname || '')
  if (newName && newName.trim()) {
    const oldName = d.daemon_alias
    d.daemon_alias = newName.trim()
    const origin = getRelayOrigin()
    fetch(`${origin}/api/daemons/${d.daemon_id}/alias`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken.value}` },
      body: JSON.stringify({ alias: newName.trim() })
    }).catch(() => {})
    showToast(`已重命名为「${newName.trim()}」`, () => { d.daemon_alias = oldName })
  }
}

function getRelayOrigin(): string {
  const relayWs = localStorage.getItem('pocketctl_relay_url') || (window as any).__RELAY_WS__ || ''
  try { const url = new URL(relayWs); if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return ''; return url.origin.replace(/^ws/, 'http') } catch { return '' }
}

// Global close for menu
const onDocClick = (e: MouseEvent) => { if (menuOpen.value && !(e.target as HTMLElement).closest('.ss-more-btn') && !(e.target as HTMLElement).closest('.hd-more-btn')) closeMenu() }
const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') { closeMenu(); confirm.value.show && (confirm.value.show = false) } }
const onScroll = () => closeMenu()

onMounted(() => {
  connect()
  send({ type: 'list_daemons' })
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onEsc)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onScroll, true)

  cleanups.push(onEvent('daemon_list', (msg: any) => {
    daemons.value = msg.daemons || []
    // 首屏默认选中第一台（匹配设计稿 selectHost(HOSTS[0].id)）
    if (!selectedId.value && daemons.value.length) {
      selectedId.value = daemons.value[0].daemon_id
    }
  }))
  cleanups.push(onEvent('daemon_status', (msg: any) => {
    const idx = daemons.value.findIndex(d => d.daemon_id === msg.daemon_id)
    if (idx >= 0) {
      if (msg.status === 'online') { daemons.value[idx].daemon_online = true; daemons.value[idx].status = 'online'; if (msg.hostname) daemons.value[idx].hostname = msg.hostname; if (msg.os) daemons.value[idx].os = msg.os; if (msg.ip) daemons.value[idx].ip = msg.ip }
      else if (msg.status === 'offline') { daemons.value[idx].daemon_online = false; daemons.value[idx].status = 'offline' }
      else if (msg.status === 'reconnecting') { daemons.value[idx].status = 'reconnecting' }
    } else if (msg.status === 'online') { daemons.value.push({ daemon_id: msg.daemon_id, hostname: msg.hostname, agents: msg.agents, daemon_online: true, daemon_alias: msg.alias || null, os: msg.os, ip: msg.ip, status: 'online' }) }
  }))
})

onUnmounted(() => {
  for (const fn of cleanups) fn()
  if (toastTimer) clearTimeout(toastTimer)
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onEsc)
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', onScroll, true)
})
</script>

<style scoped>
/* Page Header */
.page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; gap: 16px; }
.page-title { font-size: 24px; font-weight: 700; color: var(--fg); font-family: var(--font-display); }
.page-subtitle { font-size: 14px; color: var(--fg-secondary); margin-top: 4px; }

/* 全局 Token 概览条（占位） */
.token-global-strip { display: flex; align-items: center; gap: 24px; padding: 10px 18px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-lg); margin-bottom: 20px; font-size: 13px; }
.token-global-strip .tg-item { display: flex; align-items: baseline; gap: 6px; }
.token-global-strip .tg-num { font-size: 18px; font-weight: 700; color: var(--fg); font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.token-global-strip .tg-label { color: var(--fg-tertiary); }
.token-global-strip .tg-sep { width: 1px; height: 20px; background: var(--border); }

/* 筛选 + 搜索 */
.host-controls { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.host-filter { display: flex; gap: 2px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 3px; }
.host-filter button { padding: 5px 11px; border: none; background: none; color: var(--fg-secondary); font-size: 13px; font-weight: 500; font-family: var(--font-body); border-radius: 5px; cursor: pointer; transition: background 0.12s, color 0.12s; }
.host-filter button.active { background: var(--surface-active); color: var(--fg); }
.host-filter button .count { color: var(--fg-tertiary); margin-left: 4px; font-variant-numeric: tabular-nums; }
.host-search { position: relative; flex: 1; max-width: 360px; min-width: 180px; }
.host-search input { width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 8px 12px 8px 34px; color: var(--fg); font-size: 13px; outline: none; transition: border-color 0.15s, box-shadow 0.15s; box-sizing: border-box; }
.host-search input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-muted); }
.host-search input::placeholder { color: var(--fg-tertiary); }
.host-search svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--fg-tertiary); pointer-events: none; }

/* 主机布局（单栏） */
.hosts-layout { display: flex; flex-direction: column; gap: 20px; }
.hosts-grid-wrap { display: flex; align-items: center; gap: 6px; }

/* 卡片网格 */
.host-cards-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; flex: 1; min-width: 0; }
.host-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 16px; cursor: pointer; transition: border-color 0.15s, background 0.15s, box-shadow 0.15s; position: relative; }
.host-card:hover { border-color: var(--border-light); background: var(--surface-hover); }
.host-card.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent-muted); }
.host-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.host-card .hc-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.host-card .hc-icon { width: 36px; height: 36px; border-radius: var(--radius-md); background: var(--surface-active); display: flex; align-items: center; justify-content: center; flex-shrink: 0; color: var(--fg-secondary); }
.host-card .hc-icon :deep(svg) { width: 18px; height: 18px; }
.host-card .hc-info { flex: 1; min-width: 0; }
.host-card .hc-name { font-size: 14px; font-weight: 600; color: var(--fg); display: flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.host-card .hc-meta { font-size: 12px; color: var(--fg-tertiary); font-family: var(--font-mono); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.host-card .hc-foot { display: flex; align-items: center; justify-content: space-between; padding-top: 10px; border-top: 1px solid var(--border); }
.host-card .hc-sessions { font-size: 14px; font-weight: 600; color: var(--fg); font-variant-numeric: tabular-nums; }
.host-card .hc-sess-label { font-size: 11px; color: var(--fg-tertiary); margin-left: 2px; }
.host-card .ss-more-btn { position: absolute; top: 10px; right: 10px; }
.host-card:hover .ss-more-btn { opacity: 1; }
.host-cards-empty { padding: 48px 16px; text-align: center; color: var(--fg-tertiary); font-size: 13px; grid-column: 1 / -1; }

/* 选中 → 胶囊横向 */
.hosts-selecting .host-cards-grid { display: flex; flex-wrap: nowrap; overflow-x: auto; gap: 6px; padding: 4px 0; scrollbar-width: none; }
.hosts-selecting .host-cards-grid::-webkit-scrollbar { display: none; }
.hosts-selecting .host-card { flex: 0 0 auto; cursor: pointer; display: inline-flex; align-items: center; padding: 5px 12px; border-radius: var(--radius-full); font-size: 13px; min-width: 0; }
.hosts-selecting .host-card .hc-head { margin: 0; gap: 6px; }
.hosts-selecting .host-card .hc-icon,
.hosts-selecting .host-card .hc-meta,
.hosts-selecting .host-card .hc-foot,
.hosts-selecting .host-card .ss-more-btn { display: none; }
.hosts-selecting .host-card.selected { background: var(--accent-muted); border-color: var(--accent); color: var(--accent); }
.hosts-selecting .host-card.selected .hc-name { color: var(--accent); }

/* 取消选择按钮 */
.hosts-deselect-btn { display: none; flex-shrink: 0; width: 28px; height: 28px; border-radius: 50%; border: 1px solid var(--border); background: var(--surface); color: var(--fg-tertiary); cursor: pointer; align-items: center; justify-content: center; font-size: 16px; line-height: 1; transition: background 0.15s, color 0.15s; }
.hosts-deselect-btn:hover { background: var(--surface-hover); color: var(--fg); }
.hosts-selecting .hosts-deselect-btn { display: inline-flex; }

/* 详情面板（全宽） */
.host-detail-panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 28px; transition: background var(--transition), border-color var(--transition); }
.host-detail-panel.empty { text-align: center; padding: 72px 24px; }
.host-detail-panel.empty .empty-icon { font-size: 40px; color: var(--fg-tertiary); margin-bottom: 12px; }
.host-detail-panel.empty .empty-title { font-size: 16px; font-weight: 600; color: var(--fg-secondary); margin-bottom: 6px; }
.host-detail-panel.empty .empty-sub { font-size: 13px; color: var(--fg-tertiary); max-width: 360px; margin: 0 auto; }

/* 详情双栏 */
.host-detail-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 28px 36px; }
.host-detail-grid .hd-section-full { grid-column: 1 / -1; }

/* 详情头部 */
.hd-header { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 4px; position: relative; }
.hd-more-btn { position: absolute; top: 0; right: 0; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; border: none; background: transparent; color: var(--fg-tertiary); border-radius: var(--radius-md); cursor: pointer; opacity: 0.4; transition: opacity 0.15s, background 0.15s, color 0.15s; }
.hd-more-btn:hover, .hd-more-btn:focus-visible { opacity: 1; background: var(--surface-active); color: var(--fg); }
.hd-icon { width: 48px; height: 48px; border-radius: var(--radius-md); background: var(--surface-active); display: flex; align-items: center; justify-content: center; color: var(--fg-secondary); flex-shrink: 0; }
.hd-headinfo { flex: 1; min-width: 0; padding-right: 40px; }
.hd-title { font-size: 20px; font-weight: 700; color: var(--fg); letter-spacing: -0.01em; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hd-sub { font-size: 13px; color: var(--fg-tertiary); font-family: var(--font-mono); margin-top: 4px; }
.status-pill { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: var(--radius-full); font-size: 12px; font-weight: 600; }
.status-pill.mini { padding: 2px 8px; font-size: 11px; }
.status-pill .pulse { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

.hd-actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 16px 0 24px; }

/* Sections */
.hd-section { margin-bottom: 0; }
.hd-section-title { font-size: 12px; font-weight: 600; color: var(--fg-tertiary); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 12px; }

/* Resource Rows */
.resource-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.resource-row:last-child { margin-bottom: 0; }
.resource-row.offline .r-bar { background: var(--surface-active); }
.resource-row.offline .r-val { color: var(--fg-tertiary); }
.r-label { font-size: 13px; color: var(--fg-secondary); width: 44px; flex-shrink: 0; }
.r-bar { flex: 1; height: 6px; background: var(--bg); border-radius: 3px; overflow: hidden; }
.r-fill { height: 100%; border-radius: 3px; transition: width 0.5s cubic-bezier(0.2, 0, 0, 1); }
.r-fill.ok { background: var(--success); }
.r-fill.warn { background: var(--warning); }
.r-fill.high { background: var(--error); }
.r-val { font-size: 13px; font-weight: 600; color: var(--fg); width: 44px; text-align: right; font-variant-numeric: tabular-nums; flex-shrink: 0; }

/* Connection Grid */
.conn-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px 24px; }
.conn-item .c-label { font-size: 11px; text-transform: uppercase; color: var(--fg-tertiary); letter-spacing: 0.06em; margin-bottom: 4px; }
.conn-item .c-val { font-size: 14px; color: var(--fg); font-family: var(--font-mono); }
.conn-item .c-val.muted { color: var(--fg-tertiary); }

/* Agent Card */
.agent-card { display: flex; align-items: center; gap: 12px; padding: 12px 14px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md); margin-bottom: 10px; transition: border-color 0.15s; }
.agent-card:last-child { margin-bottom: 0; }
.agent-card .ag-icon { width: 32px; height: 32px; border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 14px; font-weight: 700; }
.agent-card .ag-icon.claude { background: rgba(88,166,255,0.15); color: var(--accent); }
.agent-card .ag-icon.codex { background: rgba(63,185,80,0.15); color: var(--success); }
.agent-card .ag-info { flex: 1; min-width: 0; }
.agent-card .ag-name { font-size: 14px; font-weight: 600; color: var(--fg); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.agent-card .ag-version { font-family: var(--font-mono); font-size: 12px; color: var(--fg-secondary); display: inline-flex; align-items: center; gap: 4px; }
.agent-card .ag-meta { font-size: 12px; color: var(--fg-tertiary); margin-top: 3px; }

/* Token Overview */
.token-overview { display: flex; gap: 16px; align-items: flex-start; margin-bottom: 16px; flex-wrap: wrap; }
.token-stat { flex: 1; min-width: 100px; padding: 12px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md); }
.token-stat .tk-num { font-size: 22px; font-weight: 700; color: var(--fg); font-variant-numeric: tabular-nums; letter-spacing: -0.01em; line-height: 1; }
.token-stat .tk-num.accent { color: var(--accent); }
.token-stat .tk-label { font-size: 11px; color: var(--fg-tertiary); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.06em; }
.session-token-list { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; }
.session-token-row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 13px; }
.session-token-row:last-child { border-bottom: none; }
.session-token-row .st-title { flex: 1; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-token-row .st-tokens { font-family: var(--font-mono); font-size: 13px; color: var(--fg-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }

/* Session Summary */
.sess-summary { display: flex; align-items: center; gap: 20px; padding: 16px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md); }
.ss-block { display: flex; flex-direction: column; gap: 2px; }
.ss-num { font-size: 24px; font-weight: 700; color: var(--fg); font-variant-numeric: tabular-nums; line-height: 1; letter-spacing: -0.01em; }
.ss-num.accent { color: var(--accent); }
.ss-label { font-size: 12px; color: var(--fg-tertiary); }
.ss-divider { width: 1px; align-self: stretch; background: var(--border); }
.ss-link { margin-left: auto; font-size: 13px; color: var(--accent); text-decoration: none; white-space: nowrap; cursor: pointer; }
.ss-link:hover { text-decoration: underline; }

/* ⋯ Button (card) */
.ss-more-btn { width: 28px; height: 28px; border: none; background: none; color: var(--fg-tertiary); cursor: pointer; border-radius: 6px; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.15s, background 0.15s, color 0.15s; flex-shrink: 0; }
.ss-more-btn:hover { background: var(--surface-active); color: var(--fg); }
.ss-more-btn:focus-visible { opacity: 1; outline: 2px solid var(--accent); outline-offset: -2px; }

/* status dot */
.status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.status-dot.online { background: var(--success); animation: pulse-green 2s infinite; }
.status-dot.offline { background: var(--fg-tertiary); }
.status-dot.reconnecting { background: var(--warning); animation: pulse-amber 1.5s infinite; }

/* Floating Menu */
.ss-menu { position: fixed; z-index: 200; min-width: 188px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); box-shadow: var(--shadow-lg); padding: 4px; }
.ss-menu-item { width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: none; background: none; color: var(--fg-secondary); font-size: 13px; cursor: pointer; border-radius: var(--radius-sm); text-align: left; }
.ss-menu-item:hover { background: var(--surface-hover); color: var(--fg); }
.ss-menu-item.danger { color: var(--error); }
.ss-menu-item.danger:hover { background: rgba(248, 81, 73, 0.12); }
.ss-menu-sep { height: 1px; background: var(--border); margin: 4px 2px; }

/* Buttons */
.btn { padding: 8px 16px; border: none; border-radius: var(--radius-md); font-size: 14px; font-weight: 500; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: background 0.15s, border-color 0.15s, color 0.15s; }
.btn-secondary { background: var(--surface); color: var(--fg); border: 1px solid var(--border); }
.btn-secondary:hover:not(:disabled) { background: var(--surface-hover); border-color: var(--border-light); }
.btn-secondary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-accent { background: var(--accent); color: #fff; }
.btn-accent:hover:not(:disabled) { opacity: 0.9; }
.btn-ghost { background: none; border: none; padding: 0; }
.btn-danger { background: transparent; color: var(--error); border: 1px solid rgba(248, 81, 73, 0.4); }
.btn-danger:hover:not(:disabled) { background: rgba(248, 81, 73, 0.1); border-color: var(--error); }
.btn-danger:disabled { opacity: 0.4; cursor: not-allowed; }
[data-theme="light"] .btn-danger { border-color: rgba(207, 34, 46, 0.4); }

/* Dialog */
.ss-overlay { position: fixed; inset: 0; z-index: 210; background: rgba(1, 4, 9, 0.6); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; padding: 24px; }
[data-theme="light"] .ss-overlay { background: rgba(31, 35, 40, 0.34); }
.ss-dialog { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-xl); box-shadow: var(--shadow-lg); max-width: 400px; width: 100%; padding: 26px 24px 22px; text-align: center; }
.ss-dialog-icon { width: 44px; height: 44px; border-radius: 50%; background: var(--accent-muted); color: var(--accent); display: flex; align-items: center; justify-content: center; margin: 0 auto 12px; }
.ss-dialog-icon.danger { background: rgba(248, 81, 73, 0.12); color: var(--error); }
.ss-dialog-title { font-size: 18px; font-weight: 700; color: var(--fg); font-family: var(--font-display); margin: 0 0 8px; }
.ss-dialog-desc { font-size: 13px; color: var(--fg-secondary); line-height: 1.6; margin: 0 0 16px; }
.ss-dialog-actions { display: flex; gap: 10px; }
.btn-cancel { flex: 1; padding: 8px 16px; background: var(--surface); color: var(--fg-secondary); border: 1px solid var(--border); border-radius: var(--radius-md); font-size: 14px; font-weight: 500; cursor: pointer; }
.ss-confirm { flex: 1; padding: 8px 16px; background: var(--error); color: #fff; border: none; border-radius: var(--radius-md); font-size: 14px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.ss-confirm:hover:not(:disabled) { filter: brightness(1.08); }
.ss-confirm:disabled { opacity: 0.6; cursor: not-allowed; }

/* Toast */
.ss-toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 220; background: var(--surface-active); color: var(--fg); padding: 11px 14px 11px 18px; border-radius: var(--radius-full); font-size: 13px; display: flex; align-items: center; gap: 16px; box-shadow: var(--shadow-lg); }
.ss-toast-undo { background: var(--accent); color: #fff; border: none; padding: 4px 12px; border-radius: var(--radius-full); font-size: 12px; font-weight: 600; cursor: pointer; }
.ss-toast-undo:hover { background: var(--accent-hover); }

/* Spinner */
.mini-spinner { width: 14px; height: 14px; border: 2px solid transparent; border-top-color: currentColor; border-radius: 50%; animation: spin 0.8s linear infinite; display: inline-block; }

/* Utility */
.text-mono { font-family: var(--font-mono); }
.text-success { color: var(--success); }
.text-tertiary { color: var(--fg-tertiary); }

@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pulse-green { 0% { box-shadow: 0 0 0 0 rgba(63, 185, 80, 0.4); } 70% { box-shadow: 0 0 0 6px rgba(63, 185, 80, 0); } 100% { box-shadow: 0 0 0 0 rgba(63, 185, 80, 0); } }
@keyframes pulse-amber { 0% { box-shadow: 0 0 0 0 rgba(210, 153, 34, 0.4); } 70% { box-shadow: 0 0 0 6px rgba(210, 153, 34, 0); } 100% { box-shadow: 0 0 0 0 rgba(210, 153, 34, 0); } }

/* Responsive */
@media (max-width: 900px) { .host-cards-grid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); } .host-detail-grid { grid-template-columns: 1fr; } .conn-grid { grid-template-columns: 1fr; } }
@media (max-width: 520px) { .host-controls { flex-direction: column; align-items: stretch; } .host-search { max-width: none; } .host-cards-grid { grid-template-columns: repeat(2, 1fr); } .host-filter { justify-content: space-between; } }
@media (max-width: 768px) { .host-card .ss-more-btn { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
</style>
