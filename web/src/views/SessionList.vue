<template>
  <div class="session-list">
    <template v-if="isMobile">
      <header class="mobile-session-nav">
        <button class="mobile-session-back" type="button" aria-label="返回我的主机" @click="$router.push('/hosts')">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          <span>我的主机</span>
        </button>
        <h1 class="mobile-session-nav-title">{{ daemonDisplayName }}</h1>
        <div class="mobile-session-nav-actions">
          <button
            type="button"
            data-testid="session-list-search-toggle"
            :aria-label="searchPresented ? '关闭搜索' : '搜索会话'"
            @click="toggleSearch"
          >
            <svg v-if="!searchPresented" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
          </button>
          <button type="button" class="mobile-new-session" data-testid="session-list-new-session" aria-label="新建会话" @click="showNewSession = true">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </div>
      </header>
      <div class="mobile-daemon-status">
        <span :class="['mobile-daemon-dot', { online: selectedDaemon?.online }]" aria-hidden="true"></span>
        <span>{{ selectedDaemon?.online ? '在线 · 最后心跳 刚刚' : '离线' }}</span>
        <AttentionInboxEntryButton
          v-if="hostId"
          class="mobile-session-inbox"
          :scope="{ type: 'daemon', daemonId: hostId, daemonName: daemonDisplayName }"
          show-label
        />
      </div>
      <div v-if="searchPresented" class="mobile-session-search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>
        <input
          ref="searchField"
          v-model="searchQuery"
          type="search"
          inputmode="search"
          autocomplete="off"
          autocapitalize="none"
          placeholder="搜索已加载会话"
          data-testid="session-list-search-field"
        />
        <button v-if="hasSearchQuery" type="button" data-testid="session-list-search-clear" aria-label="清空搜索并显示全部会话" @click="clearSearch">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></svg>
        </button>
      </div>
      <p v-if="searchPresented && hasLoadedSessions" class="mobile-search-summary">
        {{ hasSearchQuery ? `${searchResults.length} 个结果 · ` : '' }}已加载 {{ sortedSessions.length }} 个会话
      </p>
    </template>
    <div v-else class="header-row">
      <h2>Sessions</h2>
      <div class="header-actions">
        <button class="btn logout" @click="handleLogout">退出</button>
        <button class="btn primary" @click="showNewSession = true">+ New Session</button>
      </div>
    </div>
    <div v-if="lastError" class="error-banner">{{ lastError }}</div>
    <div v-if="!hasLoadedSessions && !lastError" class="session-loading" data-state="loading-sessions" aria-label="正在查询会话记录">
      <div v-for="index in 3" :key="index" class="session-skeleton" :style="{ '--delay': `${index * 70}ms` }">
        <span class="skeleton-dot"></span>
        <div class="skeleton-lines">
          <span></span>
          <span></span>
          <span></span>
        </div>
      </div>
    </div>
    <div v-else-if="isMobile && hasSearchQuery && searchResults.length === 0" class="mobile-search-empty">
      <strong>在已加载的 {{ sortedSessions.length }} 个会话中未找到“{{ searchQuery.trim() }}”</strong>
      <span>可搜索会话标题、模型或 Agent 类型</span>
    </div>
    <DaemonInstallGuide
      v-else-if="sortedSessions.length === 0"
      data-state="daemon-install-guide"
      :install-command="getInstallCommand()"
      @create="showNewSession = true"
    />
    <div v-for="s in renderedSessions" :key="s.session_id" class="session-group">
      <MobileSessionCard
        v-if="isMobile"
        :session="s"
        :effective-status="getEffectiveStatus(s)"
        :relative-time="formatRelativeTime(s.last_activity_at || s.started_at)"
        :expanded="!!folded[s.session_id]"
        @open="$router.push(`/session/${s.session_id}`)"
        @toggle-subagents="toggleFold(s.session_id)"
        @toggle-pin="toggleMobilePin"
        @delete="pendingDeleteSession = $event"
      />
      <div v-else :class="['session-row', { 'pending-delete': s.__pendingDelete }]" @click="!s.__pendingDelete && $router.push(`/session/${s.session_id}`)">
        <span class="status-indicator" :class="getEffectiveStatus(s)">
          <span v-if="getEffectiveStatus(s) === 'running' || getEffectiveStatus(s) === 'busy' || getEffectiveStatus(s) === 'retry'" class="pulse-ring"></span>
          <span v-if="getEffectiveStatus(s) === 'completed'" class="icon">✓</span>
          <span v-else-if="getEffectiveStatus(s) === 'killed'" class="icon">✕</span>
        </span>
        <div class="session-info">
          <div class="session-title">
            <span v-if="s.children && s.children.length" class="fold-toggle" @click.stop="toggleFold(s.session_id)">{{ folded[s.session_id] ? '▾' : '▸' }}</span>
            <span v-if="s.pinned" class="pin-mark" style="color: var(--accent); margin-right: 4px;">📌</span>
            <input v-if="renamingId === s.session_id" class="ss-rename-input" v-model="renameInput" maxlength="60"
              @click.stop @keydown.enter="commitRename(s)" @keydown.escape="cancelRename" @blur="commitRename(s)" />
            <span v-else class="session-title-copy">{{ s.title || s.session_id.slice(0, 8) }}</span>
          </div>
          <div class="session-meta">
            <span class="source-badge" :class="s.source">{{ s.source === 'terminal' ? '📺 终端' : '🌐 Web' }}</span>
            <span v-if="s.hostname" class="hostname-badge">💻 {{ s.hostname }}</span>
            <span v-if="s.subagent_count > 0" class="subagent-badge">🤖 {{ s.subagent_count }}</span>
            <span v-if="s.totalTokens > 0" class="token-badge" :title="t('session.total_incl_subagent')">🪙 {{ formatTokenCount(s.totalTokens) }}</span>
            <span v-if="s.exit_reason" class="exit-reason">{{ exitReasonLabel(s.exit_reason) }}</span>
            <span class="session-id">{{ s.session_id.slice(0, 8) }}</span>
            <AgentBadge :agent="s.agent" size="sm" />
            <span v-if="s.model" class="model-badge" :title="s.model">{{ s.model }}</span>
          </div>
        </div>
        <span class="session-time">{{ formatRelativeTime(s.last_activity_at || s.started_at) }}</span>
        <SessionActions :session="s" @startRename="startRename" @deleted="onDeleted" @pinned="onPinned" />
      </div>
      <div v-if="s.children && s.children.length && folded[s.session_id]" :class="['child-rows', { 'mobile-child-panel': isMobile }]">
        <div v-if="isMobile" class="mobile-child-header">
          <strong>子智能体 · {{ s.children.length }}</strong>
          <button type="button" @click="showAllChildren[s.session_id] = !showAllChildren[s.session_id]">
            {{ showAllChildren[s.session_id] ? '收起' : '查看全部' }} <span aria-hidden="true">›</span>
          </button>
        </div>
        <div v-for="c in visibleChildren(s)" :key="c.agentId" class="child-row" role="button" tabindex="0"
          :title="c.title || c.agentId.slice(0, 8)"
          @click.stop="$router.push(`/session/${s.session_id}?subagent=${c.agentId}`)"
          @keydown.enter="$router.push(`/session/${s.session_id}?subagent=${c.agentId}`)">
          <span class="child-indent">↳</span>
          <span v-if="isMobile" :class="['child-status-dot', c.status || 'completed']" aria-hidden="true"></span>
          <span class="child-title">{{ c.title || c.agentId.slice(0, 8) }}</span>
          <span v-if="childAgentTokenTotal(c) > 0" class="child-token">
            {{ isMobile ? `↑${formatCompactToken(c.tokenIn || 0)} ↓${formatCompactToken(c.tokenOut || 0)}` : `🪙 ${formatTokenCount(childAgentTokenTotal(c))}` }}
          </span>
        </div>
        <button v-if="isMobile && !showAllChildren[s.session_id] && s.children.length > 2" class="mobile-child-more" type="button" @click="showAllChildren[s.session_id] = true">
          还有 {{ s.children.length - 2 }} 个子智能体
        </button>
      </div>
    </div>
    <div v-if="canLoadMore && !hasSearchQuery" ref="loadMoreSentinel" class="session-load-more">
      <button class="session-load-more-btn" type="button" :disabled="isLoadingPage" @click="loadMoreSessions">
        <span v-if="isLoadingPage" class="load-more-spinner" aria-hidden="true"></span>
        {{ isLoadingPage ? '正在加载…' : '加载更多会话' }}
      </button>
    </div>
    <div v-if="pendingDeleteSession" class="mobile-delete-overlay" role="presentation" @click.self="pendingDeleteSession = null">
      <div class="mobile-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="mobile-delete-title">
        <h2 id="mobile-delete-title">删除会话</h2>
        <p>删除后将无法恢复该会话的历史记录，确定删除？</p>
        <div><button type="button" @click="pendingDeleteSession = null">取消</button><button class="danger" type="button" @click="confirmMobileDelete">删除</button></div>
      </div>
    </div>
    <NewSessionDialog v-if="showNewSession" :daemons="daemons" @close="showNewSession = false" @create="handleCreate" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, inject, onMounted, onBeforeUnmount, watch, nextTick, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useWebSocket } from '../composables/useWebSocket'
import type { DaemonEvent } from '../composables/useWebSocket'
import { formatRelativeTime } from '../composables/useRelativeTime'
import { useAuth } from '../composables/useAuth'
import NewSessionDialog from '../components/NewSessionDialog.vue'
import SessionActions from '../components/SessionActions.vue'
import AgentBadge from '../components/AgentBadge.vue'
import MobileSessionCard from '../components/MobileSessionCard.vue'
import DaemonInstallGuide from '../components/DaemonInstallGuide.vue'
import { getInstallCommand } from '../composables/useEnv'
import { formatTokenCount, childAgentTokenTotal } from '../utils/tokenFormat'
import { useLocale } from '../composables/useLocale'
import { useSessionRename } from '../composables/useSessionRename'
import { useResponsiveLayout } from '../composables/useResponsiveLayout'
import { sortMobileSessions } from '../utils/sessionPriority'
import { hasSessionSearchQuery, matchesSessionSearch } from '../utils/sessionSearch'
import {
  SESSION_REMOTE_PAGE_SIZE,
  SESSION_RENDER_BATCH_SIZE,
  mergeSessionPage,
  nextVisibleSessionCount,
} from '../utils/sessionListPagination'
import AttentionInboxEntryButton from '../components/attention-inbox/AttentionInboxEntryButton.vue'

const { renamingId, renameInput, startRename, commitRename, cancelRename } = useSessionRename()
const { t } = useLocale()

const { connect, send, onEvent, effectiveStatus } = useWebSocket()
const { isLoggedIn, accessToken, logout } = useAuth()
const $router = useRouter()
const route = useRoute()
const sessions = ref<any[]>([])
const daemons = ref<any[]>([])
const showNewSession = ref(false)
const lastError = ref('')
const hasLoadedSessions = ref(false)
const folded = ref<Record<string, boolean>>({})
const showAllChildren = ref<Record<string, boolean>>({})
const { isMobile } = useResponsiveLayout()
const hostId = computed(() => typeof route.query.host === 'string' ? route.query.host : '')
const visibleCount = ref(SESSION_RENDER_BATCH_SIZE)
const hasMoreRemoteSessions = ref(false)
const nextSessionCursor = ref<string | null>(null)
const isLoadingPage = ref(false)
const requestingNextPage = ref(false)
const liveSessionIds = new Set<string>()
const loadMoreSentinel = ref<HTMLElement | null>(null)
let loadMoreObserver: IntersectionObserver | null = null
const triggerNewSession = inject<Ref<number>>('triggerNewSession', ref(0))
const searchPresented = ref(false)
const searchQuery = ref('')
const searchField = ref<HTMLInputElement | null>(null)
const pendingDeleteSession = ref<any | null>(null)
let normalScrollY: number | null = null
watch(triggerNewSession, (value) => {
  if (value > 0) showNewSession.value = true
})

const sortedSessions = computed(() => {
  const rootSessions = sessions.value.filter(s => !s.isSubagent)
  if (isMobile.value) return sortMobileSessions(rootSessions)

  return [...rootSessions].sort((a, b) => {
    // Pinned first
    if (a.pinned && !b.pinned) return -1
    if (!a.pinned && b.pinned) return 1
    const ta = a.last_activity_at ? new Date(a.last_activity_at).getTime() : (a.started_at ? new Date(a.started_at).getTime() : 0)
    const tb = b.last_activity_at ? new Date(b.last_activity_at).getTime() : (b.started_at ? new Date(b.started_at).getTime() : 0)
    return tb - ta
  })
})
const displayedSessions = computed(() => sortedSessions.value.slice(0, visibleCount.value))
const hasSearchQuery = computed(() => hasSessionSearchQuery(searchQuery.value))
const searchResults = computed(() => hasSearchQuery.value
  ? sortedSessions.value.filter(session => matchesSessionSearch(session, searchQuery.value))
  : [])
const renderedSessions = computed(() => hasSearchQuery.value ? searchResults.value : displayedSessions.value)
const selectedDaemon = computed(() => daemons.value.find(daemon => daemon.daemon_id === hostId.value))
const daemonDisplayName = computed(() => selectedDaemon.value?.alias || selectedDaemon.value?.hostname || '会话列表')
const canLoadMore = computed(() =>
  visibleCount.value < sortedSessions.value.length ||
  (Boolean(hostId.value) && hasMoreRemoteSessions.value),
)

function requestSessionPage(cursor?: string) {
  isLoadingPage.value = true
  requestingNextPage.value = Boolean(cursor)
  if (hostId.value) {
    send({
      type: 'list_sessions',
      daemon_id: hostId.value,
      limit: SESSION_REMOTE_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    })
    return
  }
  send({ type: 'list_sessions' })
}

function loadMoreSessions() {
  if (isLoadingPage.value) return
  if (visibleCount.value < sortedSessions.value.length) {
    visibleCount.value = nextVisibleSessionCount(visibleCount.value, sortedSessions.value.length)
    return
  }
  if (hostId.value && hasMoreRemoteSessions.value && nextSessionCursor.value) {
    requestSessionPage(nextSessionCursor.value)
  }
}

watch([canLoadMore, loadMoreSentinel], async ([canLoad]) => {
  await nextTick()
  loadMoreObserver?.disconnect()
  if (!canLoad || !loadMoreSentinel.value || typeof IntersectionObserver === 'undefined') return
  loadMoreObserver = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) loadMoreSessions()
  }, { rootMargin: '160px 0px' })
  loadMoreObserver.observe(loadMoreSentinel.value)
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

function toggleFold(id: string) {
  folded.value[id] = !folded.value[id]
}

function visibleChildren(session: any) {
  if (!isMobile.value || showAllChildren.value[session.session_id]) return session.children
  return session.children.slice(0, 2)
}

function formatCompactToken(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace('.0', '')}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace('.0', '')}k`
  return String(value)
}

async function toggleSearch() {
  if (searchPresented.value) {
    clearSearch()
    searchPresented.value = false
    return
  }
  searchPresented.value = true
  await nextTick()
  searchField.value?.focus()
}

function clearSearch() {
  searchQuery.value = ''
  searchField.value?.focus()
  if (normalScrollY !== null) {
    const restoreY = normalScrollY
    normalScrollY = null
    if (restoreY > 0) nextTick(() => window.scrollTo({ top: restoreY, behavior: 'auto' }))
  }
}

watch(hasSearchQuery, active => {
  if (active && normalScrollY === null) normalScrollY = window.scrollY
})

function toggleMobilePin(session: any) {
  const pinned = !session.pinned
  session.pinned = pinned
  send({ type: 'session_pin', session_id: session.session_id, pinned })
  onPinned(session.session_id, pinned)
}

function confirmMobileDelete() {
  const session = pendingDeleteSession.value
  if (!session) return
  session.__pendingDelete = true
  send({ type: 'session_delete', session_id: session.session_id })
  onDeleted(session.session_id)
  pendingDeleteSession.value = null
}

onMounted(() => {
  const token = accessToken.value
  if (!token) { $router.push('/login'); return }
  connect()

  setTimeout(() => { requestSessionPage() }, 500)
  send({ type: 'list_daemons' })

  onEvent((evt: DaemonEvent) => {
    if (evt.type === 'error') {
      lastError.value = evt.error || 'Unknown error'
      isLoadingPage.value = false
      requestingNextPage.value = false
      setTimeout(() => { lastError.value = '' }, 5000)
    }
    if (evt.type === 'session_list') {
      const event = evt as any
      if (hostId.value && event.daemon_id !== hostId.value) return
      const list = Array.isArray(event.sessions) ? event.sessions : []
      const normalized = list.map((s: any) => ({
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
          totalTokens: s.totalTokens ?? 0,
          tokInput: s.tokInput ?? 0,
          tokOutput: s.tokOutput ?? 0,
          tokCacheRead: s.tokCacheRead ?? 0,
          tokCacheCreate: s.tokCacheCreate ?? 0,
          model: s.model || '',
          pinned: s.pinned || false,
          parentSessionId: s.parent_session_id ?? null,
          isSubagent: !!s.is_subagent,
          children: s.children ?? [],
        }))
      if (hostId.value) {
        if (requestingNextPage.value) {
          sessions.value = mergeSessionPage(sessions.value, normalized)
        } else {
          const liveSessions = sessions.value.filter(session => liveSessionIds.has(session.session_id))
          sessions.value = mergeSessionPage(normalized, liveSessions)
          visibleCount.value = SESSION_RENDER_BATCH_SIZE
        }
        hasMoreRemoteSessions.value = Boolean(event.has_more)
        nextSessionCursor.value = typeof event.next_cursor === 'string' ? event.next_cursor : null
      } else {
        sessions.value = normalized
      }
      hasLoadedSessions.value = true
      isLoadingPage.value = false
      requestingNextPage.value = false
    }
    if (evt.type === 'daemon_list') {
      daemons.value = (evt as any).daemons || []
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
      if ((!hostId.value || (evt as any).daemon_id === hostId.value) && !sessions.value.find(s => s.session_id === evt.session_id)) {
        liveSessionIds.add(evt.session_id)
        hasLoadedSessions.value = true
        sessions.value.unshift({ session_id: evt.session_id, status: 'running', agent: (evt as any).agent_type || (evt as any).agent || 'claude-code', started_at: new Date(), title: evt.title || '', source: 'daemon', last_activity_at: new Date(), model: (evt as any).model || '' })
      }
    }
    if (evt.type === 'session_discovered' && evt.session_id) {
      if ((!hostId.value || (evt as any).daemon_id === hostId.value) && !sessions.value.find(s => s.session_id === evt.session_id)) {
        liveSessionIds.add(evt.session_id)
        hasLoadedSessions.value = true
        sessions.value.unshift({ session_id: evt.session_id, status: 'busy', agent: (evt as any).agent || 'claude-code', started_at: new Date(), title: evt.title || 'Terminal Session', source: 'terminal', cwd: evt.cwd, last_activity_at: new Date(), subagent_count: (evt as any).subagent_count || 0, daemon_id: (evt as any).daemon_id || '', hostname: (evt as any).hostname || '', model: (evt as any).model || '' })
      }
    }
    if (evt.type === 'session_model_changed' && evt.session_id) {
      const existing = sessions.value.find(s => s.session_id === evt.session_id)
      if (existing) existing.model = (evt as any).model || existing.model
    }
    if (evt.type === 'session_title_update' && evt.session_id) {
      const existing = sessions.value.find(s => s.session_id === evt.session_id)
      if (existing) existing.title = evt.title || existing.title
    }
    if (evt.type === 'session_deleted' && evt.session_id) {
      sessions.value = sessions.value.filter(s => s.session_id !== evt.session_id)
    }
    if (evt.type === 'session_pinned' && evt.session_id) {
      const existing = sessions.value.find(s => s.session_id === evt.session_id)
      if (existing) existing.pinned = (evt as any).pinned
    }
  })
})

onBeforeUnmount(() => loadMoreObserver?.disconnect())

// SessionActions handlers (local optimistic updates; WS events above keep multi-client in sync)
function onDeleted(sessionId: string) {
  sessions.value = sessions.value.filter(s => s.session_id !== sessionId)
}
function onPinned(sessionId: string, pinned: boolean) {
  const s = sessions.value.find(s => s.session_id === sessionId)
  if (s) s.pinned = pinned
}

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
.session-loading { display: grid; gap: 10px; padding-top: 6px; }
.session-skeleton { display: flex; min-height: 76px; align-items: flex-start; gap: 12px; padding: 14px; border: 1px solid var(--border, #21262d); border-radius: 12px; background: var(--surface, #161b22); animation: skeleton-in .35s ease both; animation-delay: var(--delay); }
.skeleton-dot { width: 10px; height: 10px; flex: 0 0 10px; margin-top: 5px; border-radius: 50%; background: var(--surface-active, #30363d); }
.skeleton-lines { display: grid; width: 100%; gap: 8px; }
.skeleton-lines span { height: 10px; border-radius: 6px; background: linear-gradient(90deg, var(--surface-active, #21262d), var(--surface-hover, #30363d), var(--surface-active, #21262d)); background-size: 200% 100%; animation: skeleton-shimmer 1.4s ease-in-out infinite; }
.skeleton-lines span:first-child { width: 52%; height: 14px; }
.skeleton-lines span:nth-child(2) { width: 68%; }
.skeleton-lines span:last-child { width: 34%; }
.error-banner { background: #3d1214; border: 1px solid #da3633; color: #f85149; padding: 12px 16px; border-radius: 8px; margin-bottom: 12px; font-size: 14px; }
.session-load-more { display: flex; justify-content: center; padding: 8px 0 18px; }
.session-load-more-btn { display: inline-flex; min-height: 40px; align-items: center; justify-content: center; gap: 8px; padding: 8px 16px; border: 1px solid var(--border, #30363d); border-radius: 999px; background: var(--surface, #161b22); color: var(--fg-secondary, #c9d1d9); font-size: 12px; cursor: pointer; }
.session-load-more-btn:disabled { cursor: default; opacity: .65; }
.load-more-spinner { width: 13px; height: 13px; border: 2px solid var(--border-light, #484f58); border-top-color: var(--accent, #58a6ff); border-radius: 50%; animation: load-more-spin .7s linear infinite; }
.session-row { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border: 1px solid #21262d; border-radius: 8px; margin-bottom: 8px; cursor: pointer; background: #161b22; transition: opacity 0.25s ease; }
.session-row.pending-delete { opacity: 0.35; pointer-events: none; }
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
.status-indicator.waiting_question { background: #A855F7; }
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
.model-badge {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #8b949e;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
}
.session-time { margin-left: auto; color: #8b949e; font-size: 13px; white-space: nowrap; }
.session-info { flex: 1; min-width: 0; }
.session-title { font-size: 14px; color: #e6edf3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 2px; }
.ss-rename-input { background: var(--bg, #0d1117); border: 1px solid #58a6ff; border-radius: 6px; box-shadow: 0 0 0 3px rgba(88,166,255,0.15); color: #e6edf3; font-family: inherit; font-size: 14px; font-weight: 500; padding: 4px 8px; outline: none; width: 100%; max-width: 200px; }
.session-meta { display: flex; align-items: center; gap: 8px; }
.source-badge { font-size: 11px; padding: 1px 6px; border-radius: 8px; }
.source-badge.terminal { background: #1f3a5f; color: #79c0ff; }
.source-badge.daemon { background: #1a3a2a; color: #7ee787; }
.hostname-badge { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: #1c2333; color: #8b949e; }
.subagent-badge { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: #2d1a3e; color: #c084fc; }
.token-badge { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: #1a2e1a; color: #7ee787; }

/* Fold toggle */
.session-group { margin-bottom: 8px; }
.fold-toggle { cursor: pointer; margin-right: 4px; font-size: 14px; color: #8b949e; user-select: none; line-height: 1; }
.fold-toggle:hover { color: #e6edf3; }

/* Child rows */
.child-rows { padding: 4px 0 4px 42px; }
.child-row { display: flex; align-items: center; gap: 8px; padding: 4px 8px; font-size: 13px; color: #8b949e; border-radius: var(--radius-sm); cursor: pointer; transition: background 0.15s, color 0.15s; }
.child-row:hover { background: var(--hover, rgba(255,255,255,0.04)); color: #c9d1d9; }
.child-indent { color: #6B7280; font-size: 12px; flex-shrink: 0; }
.child-title { color: #c9d1d9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.child-token { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: var(--success-bg); color: var(--success); }

.mobile-session-nav,
.mobile-daemon-status,
.mobile-session-search,
.mobile-search-summary,
.mobile-search-empty { display: none; }

.mobile-delete-overlay {
  position: fixed;
  inset: 0;
  z-index: 240;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(1, 4, 9, .56);
  backdrop-filter: blur(4px);
}
.mobile-delete-dialog { width: min(310px, 100%); overflow: hidden; border: 1px solid var(--border-light); border-radius: 14px; background: color-mix(in srgb, var(--surface) 96%, transparent); box-shadow: var(--shadow-lg); text-align: center; }
.mobile-delete-dialog h2 { margin: 20px 20px 7px; color: var(--fg); font-size: 17px; }
.mobile-delete-dialog p { margin: 0 20px 18px; color: var(--fg-secondary); font-size: 13px; line-height: 1.45; }
.mobile-delete-dialog > div { display: grid; grid-template-columns: 1fr 1fr; border-top: 1px solid var(--border); }
.mobile-delete-dialog button { min-height: 46px; border: 0; color: var(--accent); background: transparent; font-size: 15px; }
.mobile-delete-dialog button + button { border-left: 1px solid var(--border); }
.mobile-delete-dialog button.danger { color: var(--error); font-weight: 600; }

/* Mobile */
@media (max-width: 768px) {
  .session-list { min-height: 100dvh; padding: 0 10px 20px; background: var(--bg); }
  .header-row { display: none; }
  .mobile-session-nav {
    position: sticky;
    top: 0;
    z-index: 60;
    display: grid;
    min-height: calc(48px + env(safe-area-inset-top));
    grid-template-columns: minmax(82px, 1fr) minmax(0, 1fr) minmax(82px, 1fr);
    align-items: end;
    margin: 0 -10px;
    padding: max(6px, env(safe-area-inset-top)) 10px 8px;
    background: color-mix(in srgb, var(--bg) 94%, transparent);
    backdrop-filter: blur(14px);
  }
  .mobile-session-back {
    min-width: 0;
    height: 32px;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0;
    border: 0;
    color: var(--accent);
    background: transparent;
    font-size: 15px;
    white-space: nowrap;
  }
  .mobile-session-back svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .mobile-session-nav-title { align-self: center; min-width: 0; margin: 0; overflow: hidden; color: var(--fg); font: 600 17px/22px var(--font-display); text-align: center; text-overflow: ellipsis; white-space: nowrap; }
  .mobile-session-nav-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .mobile-session-nav-actions button {
    width: 32px;
    height: 32px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 1px solid var(--border-light);
    border-radius: 50%;
    color: var(--fg-secondary);
    background: var(--surface-hover);
  }
  .mobile-session-nav-actions .mobile-new-session { border-color: var(--primary-btn); color: var(--bg); background: var(--primary-btn); }
  .mobile-session-nav-actions svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
  .mobile-daemon-status { display: flex; align-items: center; gap: 6px; min-height: 33px; color: var(--fg-secondary); font-size: 13px; }
  .mobile-session-inbox { margin-left: auto; }
  .mobile-daemon-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg-tertiary); }
  .mobile-daemon-dot.online { background: var(--success); }
  .mobile-session-search {
    display: flex;
    height: 36px;
    align-items: center;
    gap: 7px;
    margin: 0 0 8px;
    padding: 0 10px;
    border: 1px solid var(--border-light);
    border-radius: 10px;
    background: var(--surface-hover);
  }
  .mobile-session-search > svg { width: 16px; height: 16px; flex: 0 0 16px; fill: none; stroke: var(--fg-tertiary); stroke-width: 2; stroke-linecap: round; }
  .mobile-session-search input { min-width: 0; flex: 1; padding: 0; border: 0; outline: 0; color: var(--fg); background: transparent; font: 13px var(--font-body); -webkit-appearance: none; appearance: none; }
  .mobile-session-search input::-webkit-search-cancel-button { display: none; }
  .mobile-session-search button { width: 28px; height: 28px; display: grid; flex: 0 0 28px; place-items: center; padding: 0; border: 0; color: var(--fg-tertiary); background: transparent; }
  .mobile-session-search button svg { width: 18px; height: 18px; fill: currentColor; stroke: var(--surface-hover); stroke-width: 1.8; }
  .mobile-search-summary { display: block; margin: 0 0 8px; color: var(--fg-tertiary); font-size: 11px; line-height: 14px; }
  .mobile-search-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 44px 18px; text-align: center; }
  .mobile-search-empty strong { color: var(--fg); font-size: 14px; font-weight: 500; }
  .mobile-search-empty span { color: var(--fg-secondary); font-size: 12px; }
  .error-banner { margin-top: 4px; }
  .session-loading { gap: 8px; padding-top: 8px; }
  .session-skeleton { min-height: 73px; gap: 10px; padding: 12px 10px 12px 14px; }
  .skeleton-dot { width: 8px; height: 8px; flex-basis: 8px; margin-top: 6px; }
  .session-group { margin-bottom: 8px; }
  .child-rows.mobile-child-panel {
    margin: -10px 6px 0;
    padding: 14px 11px 9px;
    border: 1px solid var(--border-light);
    border-top: 0;
    border-radius: 0 0 10px 10px;
    background: color-mix(in srgb, var(--accent) 4.5%, transparent);
  }
  .mobile-child-header { min-height: 18px; display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
  .mobile-child-header strong { color: var(--fg-secondary); font-size: 11px; font-weight: 600; }
  .mobile-child-header button, .mobile-child-more { padding: 0; border: 0; color: var(--accent); background: transparent; font-size: 10px; font-weight: 500; }
  .child-row { min-height: 28px; gap: 7px; padding: 3px 1px; color: var(--fg-secondary); font-size: 11px; }
  .child-indent { width: 12px; color: #6e7681; font-size: 12px; text-align: center; }
  .child-status-dot { width: 6px; height: 6px; flex: 0 0 6px; border-radius: 50%; background: #6e7681; }
  .child-status-dot.running, .child-status-dot.busy, .child-status-dot.retry { background: var(--success); }
  .child-status-dot.error { background: var(--error); }
  .child-title { flex: 1; color: var(--fg-secondary); }
  .child-token { padding: 0; border-radius: 0; color: #6e7681; background: transparent; font: 10px var(--font-mono); white-space: nowrap; }
  .mobile-child-more { margin: 2px 0 0 25px; color: #6e7681; font-weight: 400; }
  .session-load-more { padding-bottom: 8px; }
  .btn { padding: 10px 14px; font-size: 13px; min-height: 44px; }
}
@keyframes pulse-ring { 0% { opacity: 0.8; transform: scale(1); } 100% { opacity: 0; transform: scale(1.6); } }
@keyframes load-more-spin { to { transform: rotate(360deg); } }
@keyframes skeleton-shimmer { to { background-position: -200% 0; } }
@keyframes skeleton-in { from { opacity: 0; transform: translateY(4px); } }
</style>
