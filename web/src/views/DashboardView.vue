<template>
  <div class="page-container design-surface content overview-page">
    <div class="page-tools"><button class="btn primary" @click="showNewSession = true"><WorkspaceIcon name="plus" class="icon small" />{{ t('session.new_session') }}</button></div>
    <div class="metrics">
      <WorkspaceMetric :label="t('dashboard.online_hosts')" :value="onlineDaemonCount" :foot="t('replica.host_summary',{total:daemons.length,offline:offlineDaemonCount})" icon="hosts" :to="{path:'/hosts',query:{filter:'online'}}" :unit="t('hosts.host_unit')" />
      <WorkspaceMetric :label="t('dashboard.active_sessions')" :value="activeSessionCount" :foot="t('replica.sessions_loaded',{count:sessions.length})" icon="sessions" to="/sessions" />
      <WorkspaceMetric :label="t('replica.pending_items')" :value="attentionInbox.actionableCount({type:'global'})" :foot="t('replica.pending_copy')" icon="inbox" to="/inbox" />
      <WorkspaceMetric :label="t('token.today')" :value="formatTokenCount(tokenSummary.today)" :foot="t('replica.week_usage',{value:formatTokenCount(tokenSummary.week)})" icon="tokens" to="/tokens" spark :spark-values="tokenHistory" />
    </div>
    <div class="section-head"><h2>{{ t('dashboard.my_hosts') }} <span class="faint section-count">{{ String(daemons.length).padStart(2,'0') }}</span></h2><div class="row"><button class="text-btn" @click="showRegisterDaemon = true">{{ t('dashboard.register_host') }}</button><RouterLink class="text-btn" to="/hosts">{{ t('dashboard.manage_all') }}<WorkspaceIcon name="arrow" class="icon small" /></RouterLink></div></div>
    <p v-if="lastError" class="notice amber">{{ lastError }}</p>
    <div v-if="daemons.length" class="hosts-grid daemon-grid">
      <WorkspaceHostCard v-for="(d,i) in daemons" :key="d.daemon_id" :daemon="d" :selected="selectedDaemon===d.daemon_id" :active-sessions="daemonSessionCount(d.daemon_id)" :activity-label="d.daemon_online ? t('attention.time_now') : formatOfflineTime(d.last_seen_at)" @select="toggleDaemonFilter(d.daemon_id)" @more="openHostActions($event,i)">
        <form v-if="renameIndex===i" class="rename-row visible" @submit.prevent="confirmRename(i)"><input class="rename-input field" v-model="renameInput" :placeholder="t('dashboard.placeholder_alias')" maxlength="32" @keydown.escape="cancelRename" /><button class="btn small" type="submit">{{ t('common.save') }}</button><button class="btn quiet small" type="button" @click="cancelRename">{{ t('common.cancel') }}</button></form>
      </WorkspaceHostCard>
    </div>
    <div v-else-if="!loading" class="card empty"><WorkspaceIcon name="hosts" class="icon" /><h3>{{ t('dashboard.no_hosts_title') }}</h3><p>{{ t('dashboard.no_hosts_desc') }}</p><code>{{ getInstallCommand() }}</code><button class="btn primary" @click="showRegisterDaemon=true">{{ t('dashboard.register_host') }}</button></div>
    <ActionList v-if="hostActionIndex!==null" :anchor="hostActionAnchor" :title="getDisplayName(daemons[hostActionIndex])" @close="hostActionIndex=null"><button class="action-item" @click="startRename(hostActionIndex!);hostActionIndex=null">{{ t('hosts.menu_edit_alias') }}</button><button class="action-item" @click="renameInput='';resetAlias(hostActionIndex!);hostActionIndex=null">{{ t('dashboard.reset_default') }}</button><button class="action-item" @click="router.push({path:'/hosts',query:{daemon_id:daemons[hostActionIndex!].daemon_id}})">{{ t('dashboard.manage_all') }}</button></ActionList>
    <div class="section-head"><h2>{{ selectedDaemon ? t('dashboard.host_sessions',{name:getDisplayName(selectedDaemonObj)}) : t('dashboard.recent_sessions') }}</h2><RouterLink class="text-btn" to="/sessions">{{ t('replica.all_sessions') }}<WorkspaceIcon name="arrow" class="icon small" /></RouterLink></div>
    <div class="two-cols">
      <section class="card recent-work-card"><header class="card-head"><div class="row"><WorkspaceIcon name="sessions" class="icon small" /><h3>{{ t('replica.continue_work') }}</h3></div><span class="badge">{{ t('token.all_hosts') }}</span></header>
        <div v-if="selectedDaemon || codexAccountOptions.length>1" class="reference-session-filters"><ActionSelect v-if="codexAccountOptions.length>1"><select v-model="selectedCodexHome" :aria-label="t('dashboard.codex_account_filter')"><option value="">{{ t('dashboard.all_codex_accounts') }}</option><option v-for="account in codexAccountOptions" :key="account.id" :value="account.id">{{ account.label }}</option></select></ActionSelect><button v-if="selectedDaemon" class="text-btn" @click="clearDaemonFilter">{{ t('dashboard.clear_filter') }}</button></div>
        <div class="table-scroll"><table class="data-table overview-sessions"><thead><tr><th>{{ t('token.session') }}</th><th>Agent</th><th>{{ t('dashboard.column_status') }}</th><th>{{ t('replica.last_activity') }}</th></tr></thead><tbody>
          <template v-for="session in paginatedSessions" :key="session.session_id"><tr :class="{ 'pending-delete':session.__pendingDelete }" class="dashboard-session-card" @click="!session.__pendingDelete && router.push('/session/'+session.session_id)">
            <td><div class="row"><button v-if="session.children?.length" type="button" class="text-btn fold-toggle" :aria-expanded="Boolean(folded[session.session_id])" @click.stop="toggleFold(session.session_id)">{{ folded[session.session_id]?'▾':'▸' }}</button><span v-if="session.pinned" class="pin-mark">◆</span><input v-if="sessRenamingId===session.session_id" class="ss-rename-input" v-model="sessRenameInput" maxlength="60" @click.stop @keydown.enter="sessCommitRename(session)" @keydown.escape="sessCancelRename" @blur="sessCommitRename(session)" /><strong v-else class="overview-session-title">{{ session.title || session.session_id.slice(0,8) }}</strong></div><small class="faint">{{ session.daemon_alias || session.hostname || session.daemon_id?.slice(0,8) }}<span v-if="session.codex_home_label"> · {{ session.codex_home_label }}</span></small></td>
            <td><AgentBadge :agent="session.agent_type" size="sm" /></td><td><span class="badge" :class="getEffectiveStatus(session)==='running'?'green':''">{{ statusLabel(session) }}</span></td><td><div class="row between"><span class="faint">{{ formatRelativeTime(session.last_activity_at || session.created_at) }}</span><SessionActions :session="session" @startRename="sessStartRename" @deleted="onDeleted" @pinned="onPinned" /></div></td>
          </tr><tr v-if="session.children?.length && folded[session.session_id]"><td colspan="4"><div v-for="child in session.children" :key="child.agentId" class="child-row" role="button" tabindex="0" @click="router.push(`/session/${session.session_id}?subagent=${child.agentId}`)" @keydown.enter="router.push(`/session/${session.session_id}?subagent=${child.agentId}`)"><span>↳ {{ child.title || child.agentId.slice(0,8) }}</span><span v-if="childAgentTokenTotal(child)>0" class="mono faint">{{ formatTokenCount(childAgentTokenTotal(child)) }}</span></div></td></tr></template>
          <tr v-if="!filteredSessions.length"><td colspan="4" class="empty">{{ t('dashboard.no_sessions_title') }}</td></tr>
        </tbody></table></div>
        <footer class="table-foot"><span>{{ t('dashboard.page_total',{count:filteredSessions.length}) }}</span><div class="row"><ActionSelect><select v-model.number="pageSize" :aria-label="t('dashboard.page_size')"><option v-for="size in pageSizes" :key="size" :value="size">{{ size }} {{ t('dashboard.page_size_unit') }}</option></select></ActionSelect><button class="btn small" :disabled="currentPage===1" @click="currentPage--">‹</button><span>{{ currentPage }} / {{ totalPages || 1 }}</span><button class="btn small" :disabled="currentPage>=totalPages" @click="currentPage++">›</button></div></footer>
      </section>
      <section class="card"><header class="card-head"><h3>{{ t('replica.needs_attention') }}</h3><span class="badge amber">{{ attentionInbox.actionableCount({type:'global'}) }}</span></header><RouterLink v-for="item in attentionItems" :key="item.item_id" class="attention-mini" :to="{path:'/inbox',query:{item_id:item.item_id}}"><span class="state-icon" :class="item.kind==='approval'?'':'blue'"><WorkspaceIcon :name="item.kind==='approval'?'shield':'sessions'" class="icon small" /></span><div><h3>{{ item.title }}</h3><p>{{ item.provider }} · {{ item.daemon.display_name }}</p><div class="row"><span class="badge" :class="item.kind==='approval'?'amber':'blue'">{{ t(item.kind==='approval'?'attention.kind_approval':'attention.kind_question') }}</span><small class="faint">{{ formatRelativeTime(item.updated_at) }}</small></div></div></RouterLink><div v-if="!attentionItems.length" class="empty"><WorkspaceIcon name="check" class="icon" /><h3>{{ t('attention.empty') }}</h3><p>{{ t('attention.empty_copy') }}</p></div><div class="card-body"><RouterLink class="text-btn" to="/inbox">{{ t('attention.title') }}<WorkspaceIcon name="arrow" class="icon small" /></RouterLink></div></section>
    </div>
    <NewSessionDialog v-if="showNewSession" :daemons="daemons" @close="showNewSession=false" /><RegisterDaemonDialog v-if="showRegisterDaemon" @close="showRegisterDaemon=false" />
  </div>
</template>
<script setup lang="ts">
import WorkspaceMetric from '../components/workspace/WorkspaceMetric.vue'
import WorkspaceHostCard from '../components/workspace/WorkspaceHostCard.vue'
import WorkspaceIcon from '../components/WorkspaceIcon.vue'
import AgentBadge from '../components/AgentBadge.vue'
import ActionSelect from '../components/ActionSelect.vue'
import ActionList from '../components/ActionList.vue'
import { useAttentionInbox } from '../composables/useAttentionInbox'
import { ref, computed, onMounted, nextTick, inject, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useWebSocket } from '../composables/useWebSocket'
import { formatOfflineTime, formatRelativeTime } from '../composables/useRelativeTime'
import { useAuth } from '../composables/useAuth'
import { useLocale } from '../composables/useLocale'
import NewSessionDialog from '../components/NewSessionDialog.vue'
import RegisterDaemonDialog from '../components/RegisterDaemonDialog.vue'
import SessionActions from '../components/SessionActions.vue'
import { agentDisplayName } from '../utils/agentDisplay'
import { getInstallCommand, getRelayOrigin } from '../composables/useEnv'
import { useSessionRename } from '../composables/useSessionRename'
import { formatTokenCount, childAgentTokenTotal } from '../utils/tokenFormat'

const { renamingId: sessRenamingId, renameInput: sessRenameInput, startRename: sessStartRename, commitRename: sessCommitRename, cancelRename: sessCancelRename } = useSessionRename()

const { connect, send, onEvent, effectiveStatus } = useWebSocket()
const { isLoggedIn, logout, accessToken } = useAuth()
const router = useRouter()
const { t } = useLocale()

const attentionInbox=useAttentionInbox()
const attentionItems=computed(()=>attentionInbox.itemsFor({type:'global'},'active').slice(0,2))
const hostActionIndex=ref<number|null>(null),hostActionAnchor=ref<HTMLElement|null>(null)
function openHostActions(event:MouseEvent,index:number){hostActionAnchor.value=event.currentTarget as HTMLElement;hostActionIndex.value=index}
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
const selectedCodexHome = ref('')

// Token cost summary
const tokenHistory=ref<number[]>([])
const tokenSummary = ref({ total: 0, today: 0, week: 0, month: 0 })
async function fetchCostSummary() {
  const origin = getRelayOrigin()
  try {
    const r = await fetch(`${origin}/api/tokens/dashboard?daemon=all&days=14`, {
      headers: { Authorization: `Bearer ${accessToken.value}` },
      credentials: 'include',
    })
    if (r.ok) {
      const dashboard = await r.json()
      const d = dashboard.summary || {}
      const daily=new Map((dashboard.dailySeries||[]).map((day:any)=>[String(day.date).slice(0,10),Number(day.input||0)+Number(day.output||0)+Number(day.cache_read||0)+Number(day.cache_create||0)]))
      tokenHistory.value=Array.from({length:14},(_,index)=>{const day=new Date();day.setUTCDate(day.getUTCDate()-13+index);return Number(daily.get(day.toISOString().slice(0,10))||0)})
      tokenSummary.value = { total: d.total ?? 0, today: d.today ?? 0, week: d.thisWeek ?? 0, month: d.thisMonth ?? 0 }
    }
  } catch { /* ignore */ }
}

const onlineDaemonCount = computed(() => daemons.value.filter(d => d.daemon_online).length)
const offlineDaemonCount = computed(() => daemons.value.filter(d => !d.daemon_online).length)
const activeSessionCount = computed(() => sessions.value.filter(s => s.status === 'running' || s.status === 'busy' || s.status === 'retry').length)

const sortedSessions = computed(() => [...sessions.value].filter(s => !s.is_subagent).sort((a, b) => {
  if (a.pinned && !b.pinned) return -1
  if (!a.pinned && b.pinned) return 1
  const ta = a.last_activity_at ? new Date(a.last_activity_at).getTime() : 0
  const tb = b.last_activity_at ? new Date(b.last_activity_at).getTime() : 0
  return tb - ta
}))

// subagent 折叠组：父 session 展开/收起其子代理列表
const folded = ref<Record<string, boolean>>({})
function toggleFold(id: string) { folded.value[id] = !folded.value[id] }

const filteredSessions = computed(() => {
  return sortedSessions.value.filter(s =>
    (!selectedDaemon.value || s.daemon_id === selectedDaemon.value)
    && (!selectedCodexHome.value || s.codex_home_id === selectedCodexHome.value))
})
const codexAccountOptions = computed(() => {
  const accounts = new Map<string, string>()
  for (const session of sortedSessions.value) {
    if (selectedDaemon.value && session.daemon_id !== selectedDaemon.value) continue
    if (session.codex_home_id) accounts.set(session.codex_home_id, session.codex_home_label || session.codex_home_id.slice(0, 12))
  }
  return [...accounts].map(([id, label]) => ({ id, label }))
})

const pageSize = ref(4)
const pageSizes = [4, 5, 10, 20]
const currentPage = ref(1)
const totalPages = computed(() => Math.max(1, Math.ceil(filteredSessions.value.length / pageSize.value)))
const paginatedSessions = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  return filteredSessions.value.slice(start, start + pageSize.value)
})
watch(selectedDaemon, () => { currentPage.value = 1; selectedCodexHome.value = '' })
watch(selectedCodexHome, () => { currentPage.value = 1 })

const selectedDaemonObj = computed(() => daemons.value.find(d => d.daemon_id === selectedDaemon.value))

function toggleDaemonFilter(daemonId: string) { selectedDaemon.value = selectedDaemon.value === daemonId ? null : daemonId }
function clearDaemonFilter() { selectedDaemon.value = null }
function getDisplayName(d: any): string { return d.daemon_alias || d.hostname || d.daemon_id?.slice(0, 8) }
function daemonSessionCount(daemonId: string): number { return sessions.value.filter(s => s.daemon_id === daemonId && (s.status === 'running' || s.status === 'busy' || s.status === 'retry')).length }
function totalSessionCount(daemonId: string): number { return sessions.value.filter(s => s.daemon_id === daemonId).length }
function getEffectiveStatus(s: any): string { return effectiveStatus({ status: s.status, daemon_id: s.daemon_id }) }
function getActiveAgents(daemonId: string): string[] {
  const agents = new Set<string>()
  for (const s of sessions.value) { if (s.daemon_id === daemonId && s.agent_type) agents.add(s.agent_type) }
  return agents.size > 0 ? [...agents] : ['claude-code']
}
function agentLabel(agent: string): string {
  return agentDisplayName(agent)
}
const STATUS_KEYS: Record<string, string> = {
  running: 'session.status.running', busy: 'session.status.busy', retry: 'session.status.retry', idle: 'session.status.idle',
  completed: 'session.status.completed', error: 'session.status.error', killed: 'session.status.killed',
  disconnected: 'session.status.disconnected', exited: 'session.status.exited',
}
function statusLabel(s: any): string {
  const st = getEffectiveStatus(s)
  return t(STATUS_KEYS[st] || 'session.status.running')
}
// Alias editing
function startRename(i: number) {
  renameIndex.value = i; renameInput.value = daemons.value[i].daemon_alias || ''
  nextTick(() => { const el = document.querySelector('.rename-input') as HTMLInputElement; if (el) el.focus() })
}
async function confirmRename(i: number) {
  const d = daemons.value[i]; const alias = renameInput.value.trim() || null
  try {
    const token = accessToken.value
    if (token) {
      await fetch(`/api/daemons/${d.daemon_id}/alias`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ alias }),
        credentials: 'include',
      })
    }
  } catch {}
  d.daemon_alias = alias; renameIndex.value = null
}
function cancelRename() { renameIndex.value = null; renameInput.value = '' }
function resetAlias(i: number) { daemons.value[i].daemon_alias = null; confirmRename(i) }

onMounted(() => {
  if (!isLoggedIn.value) { router.push('/login'); return }
  connect(); send({ type: 'list_sessions' }); send({ type: 'list_daemons' }); fetchCostSummary()
  onEvent('daemon_list', (msg: any) => { daemons.value = (msg.daemons || []).map((d: any) => ({ ...d })); loading.value = false })
  onEvent('session_list', (msg: any) => { sessions.value = msg.sessions || []; loading.value = false; if ((window as any).__updateSessionCount) (window as any).__updateSessionCount(sessions.value.length) })
  onEvent('session_created', (msg: any) => {
    const sid = msg.session_id
    if (sid && !sessions.value.find((s: any) => s.session_id === sid)) {
      // 乐观插入：relay 的 session_created 早于 DB 落库，挂载后的首次 list_sessions
      // 拿不到新会话，先插入占位，随后 session_list 整体覆盖保持一致。
      sessions.value.unshift({
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
  })
  onEvent('session_status', (msg: any) => { const idx = sessions.value.findIndex((s: any) => s.session_id === msg.session_id); if (idx >= 0) { sessions.value[idx].status = msg.status; if (msg.exit_reason) sessions.value[idx].exit_reason = msg.exit_reason } })
  onEvent('daemon_status', (msg: any) => {
    const idx = daemons.value.findIndex((d: any) => d.daemon_id === msg.daemon_id)
    if (msg.status === 'online') {
      if (idx >= 0) { daemons.value[idx].daemon_online = true; daemons.value[idx].hostname = msg.hostname; daemons.value[idx].agents = msg.agents }
      else { daemons.value.push({ daemon_id: msg.daemon_id, hostname: msg.hostname, agents: msg.agents, daemon_online: true, daemon_alias: msg.alias || null }) }
    } else if (msg.status === 'offline' && idx >= 0) { daemons.value[idx].daemon_online = false; daemons.value[idx].last_seen_at = msg.last_seen_at || new Date().toISOString() }
  })
  onEvent('session_deleted', (msg: any) => { sessions.value = sessions.value.filter((s: any) => s.session_id !== msg.session_id) })
  onEvent('session_title_update', (msg: any) => { const s = sessions.value.find((s: any) => s.session_id === msg.session_id); if (s) s.title = msg.title })
  onEvent('session_pinned', (msg: any) => { const s = sessions.value.find((s: any) => s.session_id === msg.session_id); if (s) s.pinned = msg.pinned })
  onEvent('error', (msg: any) => { lastError.value = msg.error || t('dashboard.unknown_error') })
})
function onDeleted(sessionId: string) { sessions.value = sessions.value.filter((s: any) => s.session_id !== sessionId) }
function onPinned(sessionId: string, pinned: boolean) { const s = sessions.value.find((s: any) => s.session_id === sessionId); if (s) s.pinned = pinned }
</script>
