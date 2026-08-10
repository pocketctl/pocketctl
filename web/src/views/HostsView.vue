<template>
  <div class="page-container">
    <div class="mobile-hosts-heading">
      <h1>{{ t('mobile.my_hosts') }}</h1>
      <p>{{ daemons.length }} {{ t('hosts.host_unit') }} · {{ onlineCount }} {{ t('dashboard.online') }}</p>
    </div>

    <!-- Page Header -->
    <div class="page-header">
      <div>
        <h2 class="page-title">{{ t('nav.hosts') }}</h2>
        <div class="page-subtitle">{{ t('hosts.count_prefix') }} <span class="text-mono">{{ daemons.length }}</span> {{ t('hosts.host_unit') }} · <span class="text-success text-mono">{{ onlineCount }}</span> {{ t('dashboard.online') }} · <span class="text-tertiary text-mono">{{ offlineCount }}</span> {{ t('dashboard.offline') }} <template v-if="boundHosts">· <span :class="{ 'text-danger': boundHosts.over_limit }">{{ t('quota.bound_hosts') }} {{ boundHosts.used }}/{{ boundHosts.limit ?? '∞' }}</span></template></div>
      </div>
      <button class="btn btn-secondary" @click="showRegister = true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
        {{ t('dashboard.register_host') }}
      </button>
    </div>

    <!-- 全局 Token 概览条（占位，待 C2/C3 接真实数据） -->
    <div class="token-global-strip">
              <div class="tg-item"><span class="tg-num">{{ formatTokenCount(tokenGlobal?.total) }}</span><span class="tg-label">{{ t('dashboard.token_total') }}</span></div>
      <div class="tg-sep"></div>
      <div class="tg-item"><span class="tg-num">{{ formatTokenCount(tokenGlobal?.today) }}</span><span class="tg-label">{{ t('dashboard.token_today') }}</span></div>
      <div class="tg-sep"></div>
      <div class="tg-item"><span class="tg-num">{{ formatTokenCount(tokenGlobal?.thisWeek) }}</span><span class="tg-label">{{ t('dashboard.token_week') }}</span></div>
      <div class="tg-sep"></div>
      <div class="tg-item"><span class="tg-num">{{ formatTokenCount(tokenGlobal?.thisMonth) }}</span><span class="tg-label">{{ t('dashboard.token_month') }}</span></div>
    </div>

    <!-- 筛选 + 搜索 -->
    <div class="host-controls">
      <div class="host-filter" role="tablist" :aria-label="t('hosts.filter_by_status')">
        <button :class="{ active: filter === 'all' }" @click="filter = 'all'">{{ t('common.all') }}<span class="count">{{ daemons.length }}</span></button>
        <button :class="{ active: filter === 'online' }" @click="filter = 'online'">{{ t('dashboard.online') }}<span class="count">{{ onlineCount }}</span></button>
        <button :class="{ active: filter === 'offline' }" @click="filter = 'offline'">{{ t('dashboard.offline') }}<span class="count">{{ offlineCount }}</span></button>
      </div>
      <div class="host-search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input type="text" v-model="searchQuery" :placeholder="t('hosts.search_placeholder')" :aria-label="t('hosts.search_hosts')" />
      </div>
    </div>

    <!-- 主机布局（单栏：卡片网格 ↔ 胶囊横向 + 全宽详情） -->
    <div class="hosts-layout">
      <div class="hosts-grid-wrap">
        <div class="host-cards-grid" id="host-cards">
          <template v-if="isMobile">
            <MobileHostCard
              v-for="d in filteredDaemons"
              :key="`mobile-${d.daemon_id}`"
              :daemon="d"
              :active-sessions="d.active_sessions || 0"
              :total-sessions="hostSessionCount(d.daemon_id)"
              :last-activity-label="hostLastActivityLabel(d)"
              @sessions="goSessionWithHost(d)"
              @new-session="openMobileNewSession(d)"
              @more="openMenu($event, d)"
            />
          </template>
          <template v-else>
            <div v-for="d in filteredDaemons" :key="d.daemon_id"
              class="host-card desktop-host-card"
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
                <div><span class="hc-sessions">{{ d.active_sessions || 0 }}</span> <span class="hc-sess-label">{{ t('dashboard.active_sessions') }}</span></div>
                <span :class="['status-pill', 'mini', statusPillClass(d)]" :style="statusPillStyle(d)">{{ statusLabel(d) }}</span>
              </div>
              <button class="ss-more-btn" type="button" :title="t('session.actions.more')" :aria-label="t('session.actions.more')" @click.stop="openMenu($event, d)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>
              </button>
            </div>
          </template>
          <div v-if="filteredDaemons.length === 0" class="host-cards-empty">{{ t('hosts.no_match') }}</div>
        </div>
      </div>

      <!-- 详情面板（全宽） -->
      <div v-if="selectedDaemon" class="host-detail-panel">
        <div class="hd-header">
          <button class="hd-more-btn" type="button" :title="t('session.actions.more')" :aria-label="t('session.actions.more')" @click.stop="openDetailMenu($event)">
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
            <button class="btn btn-secondary" disabled><span class="mini-spinner"></span>{{ t('hosts.restarting') }}</button>
          </template>
          <template v-else-if="selectedDaemon.daemon_online">
            <button class="btn btn-secondary" @click="confirmRestart(selectedDaemon)">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 019-9 9 9 0 016.7 3"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 01-9 9 9 9 0 01-6.7-3"/><path d="M3 21v-5h5"/></svg>
              {{ t('hosts.restart_daemon') }}
            </button>
            <button class="btn btn-danger" @click="confirmKick(selectedDaemon)">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v9"/><path d="M6.4 6.4a8 8 0 106.6-2.3"/></svg>
              {{ t('hosts.force_kick_label') }}
            </button>
          </template>
          <template v-else>
            <button class="btn btn-secondary" @click="reconnectHost(selectedDaemon)" :title="t('hosts.wait_reconnect')">{{ t('hosts.wait_reconnect') }}</button>
          </template>
        </div>

        <div class="host-detail-grid">
          <!-- 资源占用 -->
          <div class="hd-section">
            <div class="hd-section-title">{{ selectedDaemon.daemon_online ? t('hosts.resource_usage') : t('hosts.resource_offline') }}</div>
            <div :class="['resource-row', { offline: !selectedDaemon.daemon_online }]">
              <span class="r-label">CPU</span>
              <div class="r-bar"><div :class="['r-fill', resourceClass(selectedDaemon.cpu_pct)]" :style="rFillStyle(selectedDaemon.cpu_pct)"></div></div>
              <span class="r-val">{{ selectedDaemon.cpu_pct != null ? selectedDaemon.cpu_pct.toFixed(0) + '%' : '—' }}</span>
            </div>
            <div :class="['resource-row', { offline: !selectedDaemon.daemon_online }]">
              <span class="r-label">{{ t('hosts.memory') }}</span>
              <div class="r-bar"><div :class="['r-fill', resourceClass(selectedDaemon.mem_pct)]" :style="rFillStyle(selectedDaemon.mem_pct)"></div></div>
              <span class="r-val">{{ selectedDaemon.mem_pct != null ? selectedDaemon.mem_pct.toFixed(0) + '%' : '—' }}</span>
            </div>
            <div :class="['resource-row', { offline: !selectedDaemon.daemon_online }]">
              <span class="r-label">{{ t('hosts.disk') }}</span>
              <div class="r-bar"><div :class="['r-fill', resourceClass(selectedDaemon.disk_pct)]" :style="rFillStyle(selectedDaemon.disk_pct)"></div></div>
              <span class="r-val">{{ selectedDaemon.disk_pct != null ? selectedDaemon.disk_pct.toFixed(0) + '%' : '—' }}</span>
            </div>
          </div>

          <!-- 连接信息 -->
          <div class="hd-section">
            <div class="hd-section-title">{{ t('hosts.connection_info') }}</div>
            <div class="conn-grid">
              <div class="conn-item"><div class="c-label">{{ t('hosts.ip_addr') }}</div><div class="c-val">{{ selectedDaemon.ip && selectedDaemon.ip !== 'unknown' ? selectedDaemon.ip : '—' }}</div></div>
              <div class="conn-item"><div class="c-label">{{ t('hosts.daemon_version') }}</div><div class="c-val">{{ selectedDaemon.version ? 'v' + selectedDaemon.version : '—' }}</div></div>
              <div class="conn-item"><div class="c-label">{{ t('hosts.os') }}</div><div class="c-val">{{ selectedDaemon.os || '—' }}</div></div>
              <div class="conn-item"><div class="c-label">{{ t('hosts.uptime') }}</div><div :class="['c-val', { muted: !selectedDaemon.daemon_online }]">{{ selectedDaemon.started_at ? formatUptime(selectedDaemon.started_at) : '—' }}</div></div>
              <div class="conn-item"><div class="c-label">{{ t('hosts.last_heartbeat') }}</div><div :class="['c-val', { muted: !selectedDaemon.daemon_online }]">{{ selectedDaemon.last_heartbeat ? formatRelativeTime(selectedDaemon.last_heartbeat) : '—' }}</div></div>
            </div>
          </div>

          <!-- Agent 运行状态（C4b 版本上报 + C4c 升级占位） -->
          <div class="hd-section">
            <div class="hd-section-title">{{ t('hosts.agent_status') }}</div>
            <template v-if="agentCards(selectedDaemon).length">
              <div class="agent-card" v-for="(a, i) in agentCards(selectedDaemon)" :key="i">
                <div :class="['ag-icon', agentIconClass(a)]">{{ agentShort(a) }}</div>
                <div class="ag-info">
                  <div class="ag-name">{{ agentName(a) }} <span class="ag-version">{{ agentVersionLabel(a) }}</span></div>
                  <div class="ag-meta">{{ agentMetaLabel(a) }}</div>
                </div>
                <button v-if="selectedDaemon?.daemon_online && !isAgentLatest(a) && agentManageable(a)" class="ag-upgrade-btn" :class="{ upgrading: upgrading === agentRawName(a) }" :disabled="upgrading === agentRawName(a)" @click="upgradeAgent(agentRawName(a))">
                  {{ t('settings.upgrade_btn') }}
                </button>
                <span v-else-if="isZcodeAgent(a)" class="ag-readonly">{{ t('hosts.agent_readonly_sync') }}</span>
                <span v-else-if="!agentManageable(a)" class="ag-sysinstall">{{ t('hosts.agent_system_install') }}</span>
                <span v-else-if="isAgentLatest(a)" class="ag-latest">✓ {{ t('settings.installed') }}</span>
              </div>
            </template>
            <div v-else class="agent-card">
              <div class="ag-icon claude">CC</div>
              <div class="ag-info">
                <div class="ag-name">Claude Code <span class="ag-version">{{ t('settings.version_pending') }}</span></div>
                <div class="ag-meta">{{ t('hosts.agent_none') }}</div>
              </div>
            </div>
          </div>

          <!-- Token 消耗（C2/C3 真实数据） -->
          <div class="hd-section">
            <div class="hd-section-title">{{ t('dashboard.token_usage') }}</div>
            <div class="token-overview">
              <div class="token-stat"><div class="tk-num">{{ formatTokenCount(daemonCost?.total) }}</div><div class="tk-label">{{ t('hosts.token_host_total') }}</div></div>
              <div class="token-stat"><div class="tk-num accent">{{ formatTokenCount(daemonCost?.today) }}</div><div class="tk-label">{{ t('hosts.token_today_consumed') }}</div></div>
              <div class="token-stat"><div class="tk-num">{{ formatTokenCount(daemonCost?.thisMonth) }}</div><div class="tk-label">{{ t('hosts.token_month_consumed') }}</div></div>
            </div>
            <div class="session-token-list">
              <template v-if="sortedCostSessions.length">
                <div class="session-token-row" v-for="(s, i) in paginatedCostSessions" :key="s.session_id" @click="$router.push(`/session/${s.session_id}`)">
                  <span class="st-rank">{{ (costExpanded ? (costPage - 1) * 10 : 0) + i + 1 }}</span>
                  <span class="st-title">{{ s.title || s.session_id.slice(0, 8) }}</span>
                  <AgentBadge :agent="s.agent_type" size="sm" />
                  <span class="st-tokens">{{ formatTokenCount(s.total_tokens) }}</span>
                  <button class="st-expand" @click.stop="toggleTokenExpand(s.session_id)" :aria-expanded="expandedTokenSession === s.session_id">{{ expandedTokenSession === s.session_id ? '▾' : '▸' }}</button>
                  <div v-if="expandedTokenSession === s.session_id" class="st-breakdown">
                    <div class="stb-item"><span class="stb-label">{{ t('dashboard.token_input') }}</span><span class="stb-val">{{ formatTokenCount(s.tok_input) }}</span></div>
                    <div class="stb-item"><span class="stb-label">{{ t('dashboard.token_output') }}</span><span class="stb-val">{{ formatTokenCount(s.tok_output) }}</span></div>
                    <div class="stb-item"><span class="stb-label">{{ t('dashboard.token_cache_read') }}</span><span class="stb-val">{{ formatTokenCount(s.tok_cache_read) }}</span></div>
                    <div class="stb-item"><span class="stb-label">{{ t('dashboard.token_cache_create') }}</span><span class="stb-val">{{ formatTokenCount(s.tok_cache_create) }}</span></div>
                  </div>
                </div>
                <a v-if="sortedCostSessions.length > 5 && !costExpanded" class="st-more" @click="costExpanded = true">{{ t('common.all') }} {{ sortedCostSessions.length }} →</a>
                <div v-if="costExpanded && costTotalPages > 1" class="st-pagination">
                  <button class="st-page-btn" :disabled="costPage === 1" @click="costPage--">‹</button>
                  <span class="st-page-info">{{ costPage }} / {{ costTotalPages }}</span>
                  <button class="st-page-btn" :disabled="costPage === costTotalPages" @click="costPage++">›</button>
                </div>
              </template>
              <div v-else class="session-token-row"><span class="st-title" style="color:var(--fg-tertiary);">{{ t('hosts.token_no_records') }}</span></div>
            </div>
          </div>

          <!-- 会话（全宽） -->
          <div class="hd-section hd-section-full">
            <div class="hd-section-title">{{ t('nav.sessions') }}</div>
            <div class="sess-summary">
              <div class="ss-block">
                <span class="ss-num accent">{{ selectedDaemon.active_sessions || 0 }}</span>
                <span class="ss-label">{{ t('dashboard.active_sessions') }}</span>
              </div>
              <div class="ss-divider"></div>
              <div class="ss-block">
                <span class="ss-num">{{ detailSessionTotal }}</span>
                <span class="ss-label">{{ t('dashboard.total_sessions') }}</span>
              </div>
              <a class="btn btn-ghost ss-link" @click="goSessionWithHost(selectedDaemon)">{{ t('dashboard.view_all') }} →</a>
            </div>
          </div>
        </div>
      </div>

      <!-- Empty Detail -->
      <div v-else class="host-detail-panel empty">
        <div class="empty-icon">—</div>
        <div class="empty-title">{{ t('hosts.empty_title') }}</div>
        <div class="empty-sub">{{ t('hosts.empty_desc') }}</div>
      </div>
    </div>

    <HostActionsMenu
      v-if="menuOpen && menuTarget"
      :daemon="menuTarget"
      :x="menuX"
      :y="menuY"
      @action="onMenuAct"
      @close="closeMenu"
    />

    <!-- Register Dialog -->
    <RegisterDaemonDialog v-if="showRegister" @close="showRegister = false" />
    <NewSessionDialog
      v-if="mobileNewSessionHost"
      :daemons="daemons"
      :pre-selected-daemon-id="mobileNewSessionHost.daemon_id"
      @close="mobileNewSessionHost = null"
    />

    <!-- Confirm Dialog -->
    <div v-if="confirm.show" class="ss-overlay" @click.self="confirm.show = false">
      <div class="ss-dialog">
        <div class="ss-dialog-icon" :class="{ danger: confirm.danger }">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>
        </div>
        <h3 class="ss-dialog-title">{{ confirm.title }}</h3>
        <p class="ss-dialog-desc">{{ confirm.desc }}</p>
        <div class="ss-dialog-actions">
          <button class="btn btn-cancel" @click="confirm.show = false">{{ t('common.cancel') }}</button>
          <button :class="['btn', confirm.danger ? 'ss-confirm' : 'btn-accent']" :disabled="confirm.loading" @click="confirm.action">
            <span v-if="confirm.loading" class="mini-spinner"></span>{{ confirm.loading ? t('common.processing') : confirm.confirmText }}
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
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useWebSocket } from '../composables/useWebSocket'
import { useAuth } from '../composables/useAuth'
import { formatRelativeTime } from '../composables/useRelativeTime'
import { useLocale } from '../composables/useLocale'
import { useQuota } from '../composables/useQuota'
import { agentDisplayName, agentShortLabel, agentIconClass as agentIconClassHelper, isZcodeAgent as isZcodeAgentHelper } from '../utils/agentDisplay'
import RegisterDaemonDialog from '../components/RegisterDaemonDialog.vue'
import NewSessionDialog from '../components/NewSessionDialog.vue'
import MobileHostCard from '../components/hosts/MobileHostCard.vue'
import HostActionsMenu from '../components/hosts/HostActionsMenu.vue'
import AgentBadge from '../components/AgentBadge.vue'
import { getRelayOrigin } from '../composables/useEnv'
import { formatTokenCount } from '../utils/tokenFormat'
import { hostSessionsLocation } from '../utils/hostNavigation'
import { useResponsiveLayout } from '../composables/useResponsiveLayout'
import type { HostActionId } from '../utils/hostActions'

const router = useRouter()
const ws = useWebSocket()
const { accessToken, apiGetAuth } = useAuth()
const { connect, send, onEvent } = ws
const { t } = useLocale()
const { boundHosts } = useQuota()
const { isMobile } = useResponsiveLayout()

const daemons = ref<any[]>([])
const selectedId = ref<string | null>(null)
const filter = ref<'all' | 'online' | 'offline'>('all')
const searchQuery = ref('')
const showRegister = ref(false)
const mobileNewSessionHost = ref<any | null>(null)
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

// C4c: agent upgrade (claude-code) in-flight state
const upgrading = ref('')

// C3: Token cost data (from C2 backend — cost_usd in USD)
const tokenGlobal = ref<{ total: number; today: number; thisWeek: number; thisMonth: number } | null>(null)
const daemonCost = ref<{ total: number; today: number; thisMonth: number; sessions: Array<{ session_id: string; title: string; total_tokens: number; tok_input: number; tok_output: number; tok_cache_read: number; tok_cache_create: number; model: string; agent_type: string; status: string; created_at: Date }> } | null>(null)

async function fetchCostSummary() {
  const origin = getRelayOrigin()
  try {
    const r = await fetch(`${origin}/api/tokens/summary`, { headers: { Authorization: `Bearer ${accessToken.value}` } })
    if (r.ok) tokenGlobal.value = await r.json()
  } catch { /* ignore */ }
}
async function fetchCostByDaemon(id: string) {
  const origin = getRelayOrigin()
  try {
    const r = await fetch(`${origin}/api/tokens/by-daemon/${id}`, { headers: { Authorization: `Bearer ${accessToken.value}` } })
    daemonCost.value = r.ok ? await r.json() : null
  } catch { daemonCost.value = null }
}

const onlineCount = computed(() => daemons.value.filter(d => d.daemon_online).length)
const offlineCount = computed(() => daemons.value.filter(d => !d.daemon_online).length)
const selectedDaemon = computed(() => daemons.value.find(d => d.daemon_id === selectedId.value))

watch(selectedDaemon, (d) => {
  if (d?.daemon_id) fetchCostByDaemon(d.daemon_id)
  else daemonCost.value = null
})

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
  if (d.status === 'reconnecting') return t('hosts.reconnecting')
  return d.daemon_online ? t('hosts.status_online') : t('hosts.status_offline')
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
  if (seconds < 60) return `${seconds}${t('hosts.uptime_s')}`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}${t('hosts.uptime_m')}`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}${t('hosts.uptime_h')}`
  return `${Math.floor(seconds / 86400)}${t('hosts.uptime_d')}`
}

// Agent 字段兼容（字符串数组 / 对象数组）
function agentCards(d: any): any[] {
  if (d && Array.isArray(d.agents) && d.agents.length) return d.agents
  return []
}
function agentRawName(a: any): string { return typeof a === 'string' ? a : (a?.name || a?.type || 'Agent') }
function agentName(a: any): string {
  return agentDisplayName(agentRawName(a))
}
function agentShort(a: any): string { return agentShortLabel(agentRawName(a)) }
function agentIconClass(a: any): string { return agentIconClassHelper(agentRawName(a)) }
function agentVersionLabel(a: any): string {
  if (typeof a !== 'object' || !a?.version) return t('settings.version_pending')
  const v = 'v' + a.version
  if (a.latest && a.version !== a.latest) return v + ' → v' + a.latest
  return v
}
function isAgentLatest(a: any): boolean {
  return typeof a === 'object' && !!a?.latest && a?.version === a?.latest
}
function agentManageable(a: any): boolean { return typeof a !== 'object' || a?.manageable !== false }
function isZcodeAgent(a: any): boolean { return isZcodeAgentHelper(agentRawName(a)) }
function agentMetaLabel(a: any): string {
  if (typeof a === 'object' && a?.version) {
    return a.latest && a.version !== a.latest ? t('settings.upgrade_available') : t('settings.installed')
  }
  return t('settings.version_pending')
}
async function upgradeAgent(name: string) {
  if (upgrading.value) return
  const d = selectedDaemon.value
  if (!d) return
  upgrading.value = name
  try {
    const origin = getRelayOrigin()
    const r = await fetch(`${origin}/api/daemons/${d.daemon_id}/upgrade-agent`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken.value}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: name }),
    })
    if (!r.ok) {
      showToast(t('hosts.upgrade_failed'))
      upgrading.value = ''
    }
    // 成功后等待 upgrade_result 事件反馈（daemon 异步执行升级命令）
  } catch {
    showToast(t('hosts.upgrade_failed'))
    upgrading.value = ''
  }
}

function showToast(msg: string, undo?: () => void) {
  if (toastTimer) clearTimeout(toastTimer)
  toast.value = { show: true, msg, undo }
  toastTimer = setTimeout(() => { toast.value = { show: false, msg: '' } }, 5500)
}

function showConfirm(opts: { title: string; desc: string; confirmText?: string; danger?: boolean; action: () => void }) {
  confirm.value = { show: true, title: opts.title, desc: opts.desc, confirmText: opts.confirmText || '确认', danger: !!opts.danger, loading: false, action: opts.action }
}

function selectHost(id: string) {
  selectedId.value = id
}

function goSessionWithHost(d: any) {
  router.push(hostSessionsLocation(d.daemon_id))
}

function openMobileNewSession(d: any) {
  if (d.daemon_online) mobileNewSessionHost.value = d
}

// Sessions for detail panel (recent 3)
const allSessions = ref<any[]>([])
function sessionsForHost(daemonId: string): any[] {
  return allSessions.value.filter(session => session.daemon_id === daemonId)
}
function hostSessionCount(daemonId: string): number {
  return sessionsForHost(daemonId).length
}
function hostLastActivityLabel(d: any): string {
  const latest = sessionsForHost(d.daemon_id)
    .map(session => session.last_activity_at || session.updated_at || session.created_at)
    .filter(Boolean)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0]
  const value = latest || d.last_heartbeat
  return value ? formatRelativeTime(value) : ''
}
const detailSessions = computed(() => {
  if (!selectedId.value) return []
  return allSessions.value
    .filter(s => s.daemon_id === selectedId.value)
    .sort((a, b) => {
      const ta = a.last_activity_at ? new Date(a.last_activity_at).getTime() : 0
      const tb = b.last_activity_at ? new Date(b.last_activity_at).getTime() : 0
      return tb - ta
    })
    .slice(0, 3)
})
const detailSessionTotal = computed(() => {
  if (!selectedId.value) return 0
  return allSessions.value.filter(s => s.daemon_id === selectedId.value).length
})
// Cost sessions: sorted by cost desc, top 5 default, expand + paginate
const costExpanded = ref(false)
const costPage = ref(1)
const COST_PAGE_SIZE = 10
const sortedCostSessions = computed(() => {
  if (!daemonCost.value?.sessions) return []
  return [...daemonCost.value.sessions].sort((a, b) => (b.total_tokens || 0) - (a.total_tokens || 0))
})
const costTotalPages = computed(() => Math.max(1, Math.ceil(sortedCostSessions.value.length / COST_PAGE_SIZE)))
const paginatedCostSessions = computed(() => {
  const all = sortedCostSessions.value
  if (!costExpanded.value) return all.slice(0, 5)
  const start = (costPage.value - 1) * COST_PAGE_SIZE
  return all.slice(start, start + COST_PAGE_SIZE)
})
// Expandable per-session token breakdown
const expandedTokenSession = ref<string | null>(null)
function toggleTokenExpand(sid: string) {
  expandedTokenSession.value = expandedTokenSession.value === sid ? null : sid
}
// Reset pagination when daemon changes
watch(selectedId, () => { costExpanded.value = false; costPage.value = 1; expandedTokenSession.value = null })

function sessionStatusLabel(s: any): string {
  const STATUS_KEYS: Record<string, string> = { running: 'session.status.running', busy: 'session.status.busy', retry: 'session.status.retry', idle: 'session.status.idle', completed: 'session.status.completed', error: 'session.status.error', killed: 'session.status.killed', disconnected: 'session.status.disconnected', exited: 'session.status.exited' }
  return t(STATUS_KEYS[s.status] || 'session.status.running')
}

function openMenu(e: MouseEvent, d: any) {
  menuTarget.value = d
  const btn = (e.currentTarget as HTMLElement).getBoundingClientRect()
  menuX.value = Math.max(8, btn.right - 224)
  menuY.value = btn.bottom + 6
  menuOpen.value = true
}

function openDetailMenu(e: MouseEvent) {
  if (!selectedDaemon.value) return
  openMenu(e, selectedDaemon.value)
}

function closeMenu() { menuOpen.value = false }

function onMenuAct(act: HostActionId) {
  closeMenu()
  const d = menuTarget.value
  if (!d) return
  const id = d.daemon_id
  setTimeout(() => {
    if (act === 'refresh') refreshHost(d)
    else if (act === 'alias') { selectedId.value = id; startRename(d) }
    else if (act === 'restart') confirmRestart(d)
    else if (act === 'kick') confirmKick(d)
    else if (act === 'unregister') confirmUnregister(d)
  }, 50)
}

async function refreshHost(d: any) {
  const { ok, data } = await apiGetAuth(`/api/daemons/${encodeURIComponent(d.daemon_id)}`)
  if (!ok || !data || data.daemon_id !== d.daemon_id) {
    showToast(t('hosts.refresh_failed'))
    return
  }
  const existingAlias = d.daemon_alias
  Object.assign(d, data)
  if (!d.daemon_alias && existingAlias) d.daemon_alias = existingAlias
  showToast(t('hosts.refresh_success'))
}

function confirmRestart(d: any) {
  showConfirm({ title: t('hosts.restart_confirm_title', { name: d.hostname || d.daemon_id?.slice(0, 8) }), desc: t('hosts.restart_confirm_desc'), confirmText: t('hosts.restart_daemon'),
    action: async () => {
      confirm.value.loading = true
      try {
        const origin = getRelayOrigin()
        await fetch(`${origin}/api/daemons/${d.daemon_id}/restart`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken.value}` } })
        d.status = 'reconnecting'
        showToast(t('hosts.restart_sent'))
      } catch { showToast(t('hosts.restart_failed')) }
      confirm.value.show = false
      confirm.value.loading = false
    }
  })
}

function confirmKick(d: any) {
  const prev = { daemon_online: d.daemon_online, cpu_pct: d.cpu_pct, mem_pct: d.mem_pct, disk_pct: d.disk_pct, active_sessions: d.active_sessions }
  showConfirm({ title: t('hosts.kick_title', { name: d.hostname || d.daemon_id?.slice(0, 8) }), desc: t('hosts.kick_desc'), confirmText: t('hosts.kick_confirm'), danger: true,
    action: () => {
      d.daemon_online = false; d.cpu_pct = null; d.mem_pct = null; d.disk_pct = null; d.active_sessions = 0
      confirm.value.show = false
      const origin = getRelayOrigin()
      fetch(`${origin}/api/daemons/${d.daemon_id}/forceKick`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken.value}` } }).catch(() => {})
      showToast(t('hosts.kick_toast', { name: d.hostname || d.daemon_id?.slice(0, 8) }), () => { Object.assign(d, prev) })
    }
  })
}

function reconnectHost(d: any) {
  d.status = 'reconnecting'
  showToast('等待 daemon 重连…')
}

function confirmUnregister(d: any) {
  showConfirm({ title: t('hosts.unregister_title', { name: d.hostname || d.daemon_id?.slice(0, 8) }), desc: t('hosts.unregister_desc'), confirmText: t('hosts.unregister_confirm'), danger: true,
    action: () => {
      const idx = daemons.value.findIndex(x => x.daemon_id === d.daemon_id)
      const removed = daemons.value.splice(idx, 1)[0]
      if (selectedId.value === d.daemon_id) selectedId.value = daemons.value[0]?.daemon_id || null
      confirm.value.show = false
      const origin = getRelayOrigin()
      fetch(`${origin}/api/daemons/${d.daemon_id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken.value}` } })
        .then((r) => {
          if (r.ok) showToast(`已注销「${d.hostname || d.daemon_id?.slice(0, 8)}」`)
          else { daemons.value.splice(idx, 0, removed); showToast('注销失败，请重试') }
        })
        .catch(() => { daemons.value.splice(idx, 0, removed); showToast('注销失败，请重试') })
    }
  })
}

function startRename(d: any) {
  const newName = prompt(t('hosts.alias_prompt'), d.daemon_alias || d.hostname || '')
  if (newName && newName.trim()) {
    const oldName = d.daemon_alias
    d.daemon_alias = newName.trim()
    const origin = getRelayOrigin()
    fetch(`${origin}/api/daemons/${d.daemon_id}/alias`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken.value}` },
      body: JSON.stringify({ alias: newName.trim() })
    }).catch(() => {})
    showToast(t('hosts.rename_toast', { name: newName.trim() }), () => { d.daemon_alias = oldName })
  }
}

// Global close for menu
const onDocClick = (e: MouseEvent) => { if (menuOpen.value && !(e.target as HTMLElement).closest('.ss-more-btn') && !(e.target as HTMLElement).closest('.hd-more-btn')) closeMenu() }
const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') { closeMenu(); confirm.value.show && (confirm.value.show = false) } }
const onScroll = () => closeMenu()

onMounted(() => {
  connect()
  send({ type: 'list_daemons' })
  send({ type: 'list_sessions' })
  fetchCostSummary()
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onEsc)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onScroll, true)

  cleanups.push(onEvent('daemon_list', (msg: any) => {
    daemons.value = msg.daemons || []
    if (!selectedId.value && daemons.value.length) {
      selectedId.value = daemons.value[0].daemon_id
    }
  }))
  cleanups.push(onEvent('session_list', (msg: any) => {
    allSessions.value = msg.sessions || []
  }))
  cleanups.push(onEvent('session_status', (msg: any) => {
    const idx = allSessions.value.findIndex((s: any) => s.session_id === msg.session_id)
    if (idx >= 0) { allSessions.value[idx].status = msg.status }
  }))
  cleanups.push(onEvent('session_created', (msg: any) => {
    const sid = msg.session_id
    if (sid && !allSessions.value.find((s: any) => s.session_id === sid)) {
      // 乐观插入：relay 的 session_created 早于 DB 落库，补刷的 list_sessions 可能拿不到
      // 新会话，先插入占位，随后 session_list 整体覆盖保持一致。
      allSessions.value.unshift({
        session_id: sid,
        status: 'running',
        agent_type: 'claude-code',
        source: 'daemon',
        title: msg.title || '',
        daemon_id: msg.daemon_id || '',
        hostname: msg.hostname || '',
        created_at: new Date().toISOString(),
        last_activity_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        subagent_count: 0,
        pinned: false,
      })
    }
    send({ type: 'list_sessions' })
  }))
  cleanups.push(onEvent('daemon_status', (msg: any) => {
    const idx = daemons.value.findIndex(d => d.daemon_id === msg.daemon_id)
    if (idx >= 0) {
      if (msg.agents) daemons.value[idx].agents = msg.agents
      if (msg.status === 'online') { daemons.value[idx].daemon_online = true; daemons.value[idx].status = 'online'; if (msg.hostname) daemons.value[idx].hostname = msg.hostname; if (msg.os) daemons.value[idx].os = msg.os; if (msg.ip) daemons.value[idx].ip = msg.ip }
      else if (msg.status === 'offline') { daemons.value[idx].daemon_online = false; daemons.value[idx].status = 'offline' }
      else if (msg.status === 'reconnecting') { daemons.value[idx].status = 'reconnecting' }
    } else if (msg.status === 'online') { daemons.value.push({ daemon_id: msg.daemon_id, hostname: msg.hostname, agents: msg.agents, daemon_online: true, daemon_alias: msg.alias || null, os: msg.os, ip: msg.ip, status: 'online' }) }
  }))
  cleanups.push(onEvent('upgrade_result', (msg: any) => {
    upgrading.value = ''
    if (msg.status === 'success') showToast(t('hosts.upgrade_success', { agent: msg.agent || 'Agent', version: msg.message || '' }))
    else if (msg.reason === 'permission_denied') showToast(t('hosts.upgrade_perm_denied'))
    else showToast(t('hosts.upgrade_error', { error: msg.error || t('dashboard.unknown_error') }))
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
.mobile-hosts-heading { display: none; }

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
.agent-card .ag-icon.zcode { background: rgba(20,184,166,0.15); color: #14b8a6; }
.agent-card .ag-info { flex: 1; min-width: 0; }
.agent-card .ag-name { font-size: 14px; font-weight: 600; color: var(--fg); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.agent-card .ag-version { font-family: var(--font-mono); font-size: 12px; color: var(--fg-secondary); display: inline-flex; align-items: center; gap: 4px; }
.agent-card .ag-meta { font-size: 12px; color: var(--fg-tertiary); margin-top: 3px; }
.ag-upgrade-btn { flex-shrink: 0; padding: 5px 11px; border-radius: var(--radius-full); border: 1px solid var(--accent); background: var(--accent-muted); color: var(--accent); font-size: 12px; font-weight: 600; cursor: pointer; font-family: var(--font-body); transition: background 0.15s, color 0.15s; white-space: nowrap; }
.ag-upgrade-btn:hover { background: var(--accent); color: #fff; }
.ag-upgrade-btn:disabled { opacity: 0.6; cursor: wait; }
.ag-upgrade-btn.upgrading { background: var(--accent); color: #fff; opacity: 0.75; }
.ag-latest { flex-shrink: 0; color: var(--success); font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; }
.ag-sysinstall { flex-shrink: 0; max-width: 220px; font-size: 11px; color: var(--fg-tertiary); text-align: right; line-height: 1.3; }
.ag-readonly { flex-shrink: 0; max-width: 220px; font-size: 11px; color: var(--fg-tertiary); text-align: right; line-height: 1.3; }

/* Token Overview */
.token-overview { display: flex; gap: 16px; align-items: flex-start; margin-bottom: 16px; flex-wrap: wrap; }
.token-stat { flex: 1; min-width: 100px; padding: 12px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md); }
.token-stat .tk-num { font-size: 22px; font-weight: 700; color: var(--fg); font-variant-numeric: tabular-nums; letter-spacing: -0.01em; line-height: 1; }
.token-stat .tk-num.accent { color: var(--accent); }
.token-stat .tk-label { font-size: 11px; color: var(--fg-tertiary); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.06em; }
.session-token-list { margin-top: 10px; border-radius: var(--radius-md); overflow: hidden; border: 1px solid var(--border); }
.session-token-row { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 10px; padding: 9px 12px; border-bottom: 1px solid var(--border); font-size: 13px; cursor: pointer; transition: background 0.1s; }
.session-token-row:last-child { border-bottom: none; }
.session-token-row:hover { background: var(--surface-hover); }
.session-token-row .st-rank { width: 18px; height: 18px; border-radius: 50%; background: var(--surface-active); color: var(--fg-tertiary); font-size: 10px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-family: var(--font-mono); }
.session-token-row:nth-child(1) .st-rank { background: var(--accent); color: #fff; }
.session-token-row:nth-child(2) .st-rank { background: rgba(88,166,255,0.5); color: #fff; }
.session-token-row:nth-child(3) .st-rank { background: rgba(88,166,255,0.3); color: var(--accent); }
.session-token-row .st-title { flex: 1; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.session-token-row .st-tokens { font-family: var(--font-mono); font-size: 13px; font-weight: 600; color: var(--success); font-variant-numeric: tabular-nums; white-space: nowrap; }
.session-token-row .st-expand { background: none; border: none; color: var(--fg-tertiary); cursor: pointer; padding: 2px 4px; font-size: 11px; line-height: 1; flex-shrink: 0; border-radius: 4px; }
.session-token-row .st-expand:hover { color: var(--accent); background: var(--surface-hover); }
.session-token-row .st-breakdown { flex: 0 0 100%; display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; padding: 8px 0 2px 28px; margin-top: 6px; border-top: 1px dashed var(--border); }
.session-token-row .stb-item { display: flex; justify-content: space-between; align-items: center; font-size: 12px; }
.session-token-row .stb-label { color: var(--fg-tertiary); }
.session-token-row .stb-val { font-family: var(--font-mono); font-weight: 600; color: var(--fg); font-variant-numeric: tabular-nums; }

/* Session Summary */
.sess-summary { display: flex; align-items: center; gap: 20px; padding: 16px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md); }
.ss-block { display: flex; flex-direction: column; gap: 2px; }
.ss-num { font-size: 24px; font-weight: 700; color: var(--fg); font-variant-numeric: tabular-nums; line-height: 1; letter-spacing: -0.01em; }
.ss-num.accent { color: var(--accent); }
.ss-label { font-size: 12px; color: var(--fg-tertiary); }
.ss-divider { width: 1px; align-self: stretch; background: var(--border); }
.ss-link { margin-left: auto; font-size: 13px; color: var(--accent); text-decoration: none; white-space: nowrap; cursor: pointer; }
.ss-link:hover { text-decoration: underline; }

/* Detail session list (recent 3 + view all) */
.detail-sess-list { margin-top: 8px; }
.detail-sess-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-radius: var(--radius-sm); cursor: pointer; transition: background 0.1s; }
.detail-sess-row:hover { background: var(--surface-hover); }
.detail-sess-row .ds-title { font-size: 13px; font-weight: 500; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.detail-sess-row .ds-status { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: var(--radius-full); margin-left: 8px; flex-shrink: 0; }
.detail-sess-row .ds-status.running, .detail-sess-row .ds-status.busy, .detail-sess-row .ds-status.retry { background: var(--success-bg); color: var(--success); }
.detail-sess-row .ds-status.completed, .detail-sess-row .ds-status.exited { background: var(--surface-active); color: var(--fg-tertiary); }
.detail-sess-row .ds-status.error, .detail-sess-row .ds-status.killed { background: var(--error-bg); color: var(--error); }
.detail-sess-row .ds-status.idle, .detail-sess-row .ds-status.disconnected { background: var(--accent-muted); color: var(--accent); }
.detail-sess-more { display: block; text-align: center; padding: 10px; font-size: 13px; font-weight: 600; color: var(--accent); cursor: pointer; border-radius: var(--radius-sm); transition: background 0.1s; }
.detail-sess-more:hover { background: var(--accent-muted); }
.detail-sess-empty { padding: 20px; text-align: center; font-size: 13px; color: var(--fg-tertiary); }

/* Cost session list (top 5 + expand + paginate) */
.st-more { display: flex; align-items: center; justify-content: center; gap: 4px; padding: 8px; font-size: 12px; font-weight: 600; color: var(--accent); cursor: pointer; transition: background 0.1s; border-top: 1px solid var(--border); }
.st-more:hover { background: var(--accent-muted); }
.st-pagination { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 8px; border-top: 1px solid var(--border); }
.st-page-btn { width: 26px; height: 26px; border: 1px solid var(--border); background: var(--surface); color: var(--fg-secondary); border-radius: var(--radius-sm); cursor: pointer; font-size: 13px; display: flex; align-items: center; justify-content: center; transition: all 0.15s; }
.st-page-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); background: var(--accent-muted); }
.st-page-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.st-page-info { font-size: 11px; color: var(--fg-tertiary); font-family: var(--font-mono); padding: 0 4px; }

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
@media (max-width: 768px) {
  .page-container { padding: 14px 12px 20px; }
  .page-header,
  .token-global-strip,
  .host-controls,
  .desktop-host-card,
  .host-detail-panel { display: none; }
  .mobile-hosts-heading { display: block; margin: 4px 2px 16px; }
  .mobile-hosts-heading h1 { margin: 0; color: var(--fg); font-size: 27px; font-weight: 750; letter-spacing: -.02em; }
  .mobile-hosts-heading p { margin: 5px 0 0; color: var(--fg-secondary); font-size: 12px; }
  .hosts-layout,
  .hosts-grid-wrap { width: 100%; }
  .host-cards-grid { display: grid; grid-template-columns: 1fr; gap: 10px; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
</style>
