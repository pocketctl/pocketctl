<template>
  <div class="team-session-layout" data-testid="team-session-detail">
    <aside class="session-panel">
      <div class="session-panel-header"><div><strong>{{ teamName }}</strong><small>{{ visibleSessions.length }} / {{ allSessions.length }} 个共享会话</small></div><RouterLink :to="listLink">＋</RouterLink></div>
      <SessionScopeSwitcher :model-value="scope" :teams="teams" @update:model-value="changeScope" />
      <div class="filters">
        <select v-model="daemonID" aria-label="按主机筛选"><option value="">全部主机</option><option v-for="daemon in daemonOptions" :key="daemon" :value="daemon">{{ daemon }}</option></select>
        <select v-model="provider" aria-label="按 Agent 筛选"><option value="">全部 Agent</option><option value="codex">Codex</option><option value="claude-code">Claude Code</option></select>
      </div>
      <nav class="session-list">
        <RouterLink v-for="item in visibleSessions" :key="item.id" :to="detailLink(item.id)" :class="{ active: item.id === sessionID }">
          <span :class="['state-dot', item.state]"></span><div><strong>{{ item.title }}</strong><small>{{ item.participants.length }} 人 · {{ item.agent_bindings.length }} Agents</small></div>
        </RouterLink>
      </nav>
    </aside>

    <main class="conversation">
      <header class="conversation-header">
        <RouterLink class="mobile-back" :to="listLink">‹</RouterLink>
        <div class="title-copy"><span>团队共享会话</span><strong>{{ session?.title || '加载中…' }}</strong></div>
        <div class="header-actions">
          <span v-if="session" :class="['session-state', session.state]">{{ stateLabel(session.state) }}</span>
          <button type="button" :class="{ active: showContext }" @click="showContext = !showContext; showParticipants = false">Context</button>
          <button type="button" :class="{ active: showParticipants }" @click="showParticipants = !showParticipants; showContext = false">成员</button>
          <button v-if="isCreator && session" type="button" @click="togglePaused">{{ session.state === 'paused' ? '恢复' : '暂停' }}</button>
        </div>
      </header>
      <div v-if="returnNotice" class="return-notice">已返回共享会话，原生会话关联保持不变。</div>
      <div v-if="error" class="error-banner" role="status">{{ error }}</div>
      <section ref="messagesElement" class="messages" @scroll="saveReadingPosition">
        <div v-if="loading && !events.length" class="empty">正在加载真实协作记录…</div>
        <div v-else-if="!events.length" class="empty"><strong>开始团队讨论</strong><span>选择全部、定向 Agent 或仅补充讨论后发送。事件会写入共享会话。</span></div>
        <article v-for="event in events" :id="`team-event-${event.id}`" :key="event.id" :class="['event', event.kind]">
          <div class="event-meta">
            <span>#{{ event.event_seq }} · {{ authorLabel(event) }}</span><time>{{ formatTime(event.created_at) }}</time>
          </div>
          <button v-if="event.reference" type="button" class="reference" @click="scrollToEvent(event.reference.event_id)">↪ 引用 #{{ event.reference.event_seq }}</button>
          <MessageUser v-if="event.kind === 'member_message'" :content="event.content" />
          <MessageAgent v-else-if="event.kind === 'agent_message'" :content="event.content" :agent-type="agentProvider(event.author_offer_id)" />
          <div v-else class="system-event"><strong>{{ kindLabel(event.kind) }}</strong><span>{{ event.content }}</span></div>
          <div class="event-actions"><span v-if="event.target_mode">{{ targetLabel(event) }}</span><button type="button" @click="referenceEvent = event">引用回复</button></div>
        </article>
      </section>

      <footer class="composer-shell">
        <div v-if="referenceEvent" class="reply-preview"><span>回复 #{{ referenceEvent.event_seq }} · {{ referenceEvent.content.slice(0, 80) }}</span><button type="button" @click="referenceEvent = null">×</button></div>
        <TeamAgentTargetPicker v-model="target" :bindings="session?.agent_bindings ?? []" />
        <div class="composer-row">
          <textarea v-model="draft" :disabled="!!readOnlyReason" rows="1" :placeholder="readOnlyReason || '发送真实协作消息…'" data-testid="team-session-composer" @keydown.enter.exact.prevent="send" />
          <button type="button" class="send-button" :disabled="!canSend || !draft.trim() || (target.mode === 'offers' && !target.offerIDs.length)" data-testid="team-session-send" @click="send">{{ sending ? '…' : '↑' }}</button>
        </div>
        <p v-if="readOnlyReason" class="composer-status">{{ readOnlyReason }}</p>
        <p v-else-if="target.mode === 'discussion'" class="composer-status">仅记录讨论，不触发 Agent 调用。</p>
      </footer>
    </main>

    <TeamContextPanel v-if="showContext" :context="context" @close="showContext = false" />
    <TeamSessionParticipants v-if="showParticipants && session" :session="session" :members="members" :current-user-id="currentUserID" @updated="session = $event" @close="showParticipants = false" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import MessageAgent from '../components/messages/MessageAgent.vue'
import MessageUser from '../components/messages/MessageUser.vue'
import SessionScopeSwitcher from '../components/session/SessionScopeSwitcher.vue'
import TeamAgentTargetPicker, { type TeamAgentTargetValue } from '../components/team/TeamAgentTargetPicker.vue'
import TeamContextPanel from '../components/team/TeamContextPanel.vue'
import TeamSessionParticipants from '../components/team/TeamSessionParticipants.vue'
import { useAuth } from '../composables/useAuth'
import { getScopedReadingPosition, setScopedReadingPosition, type SessionScope } from '../composables/useScopedSessionState'
import { useTeamSession } from '../composables/useTeamSession'
import { listTeamAgentOffers, listTeamMembers, listTeamSessions, listTeams, updateTeamSession } from '../services/teamClient'
import type { TeamAgentOffer, TeamEvent, TeamMember, TeamProvider, TeamSessionSummary, TeamSummary } from '../types/team'

const route = useRoute(), router = useRouter(), { user } = useAuth()
const teamID = computed(() => String(route.params.teamId ?? '')), sessionID = computed(() => String(route.params.id ?? ''))
const scope = computed<SessionScope>(() => ({ type: 'team', teamId: teamID.value }))
const { session, events, context, draft, loading, sending, error, readOnlyReason, canSend, sendMessage } = useTeamSession(teamID, sessionID)
const teams = ref<TeamSummary[]>([]), members = ref<TeamMember[]>([]), offers = ref<TeamAgentOffer[]>([]), allSessions = ref<TeamSessionSummary[]>([]), filteredSessions = ref<TeamSessionSummary[]>([])
const daemonID = ref(''), provider = ref<'' | TeamProvider>(''), showContext = ref(false), showParticipants = ref(false), referenceEvent = ref<TeamEvent | null>(null)
const target = ref<TeamAgentTargetValue>({ mode: 'all', offerIDs: [] }), messagesElement = ref<HTMLElement | null>(null)
const currentUserID = computed(() => user.value?.id ?? 0), isCreator = computed(() => session.value?.creator_user_id === currentUserID.value)
const teamName = computed(() => teams.value.find(team => team.id === teamID.value)?.name ?? '团队')
const daemonOptions = computed(() => [...new Set(offers.value.map(offer => offer.daemon_id))])
const visibleSessions = computed(() => {
  const list = [...filteredSessions.value]
  if (session.value && !list.some(item => item.id === session.value!.id)) list.unshift(session.value)
  return list
})
const returnNotice = computed(() => route.query.from_native === '1')
const listLink = computed(() => ({ name: 'team-sessions', params: { teamId: teamID.value }, query: { ...(daemonID.value ? { daemon: daemonID.value } : {}), ...(provider.value ? { provider: provider.value } : {}) } }))
let listGeneration = 0
let restoredSessionID = ''

function stateLabel(state: string): string { return ({ active: '进行中', paused: '已暂停', ended: '已结束', archived: '已归档' } as Record<string,string>)[state] ?? state }
function kindLabel(kind: string): string { return ({ status: 'Agent 状态', context: 'Context 更新', run: '协作运行', system: '系统事件' } as Record<string,string>)[kind] ?? kind }
function formatTime(value: string): string { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
function authorLabel(event: TeamEvent): string {
  if (event.author_user_id) return members.value.find(member => member.user_id === event.author_user_id)?.display_label ?? `成员 ${event.author_user_id}`
  if (event.author_offer_id) return agentProvider(event.author_offer_id) === 'codex' ? 'Codex' : 'Claude Code'
  return '系统'
}
function agentProvider(offerID: string | null): string { return offers.value.find(offer => offer.id === offerID)?.provider ?? 'agent' }
function targetLabel(event: TeamEvent): string {
  if (event.target_mode === 'discussion') return '仅讨论'
  if (event.target_mode === 'all') return '发送给全部可用 Agent'
  return `定向 ${event.target_offer_ids.length} 个 Agent`
}
function detailLink(id: string) { return { name: 'team-session', params: { teamId: teamID.value, id }, query: { ...(daemonID.value ? { daemon: daemonID.value } : {}), ...(provider.value ? { provider: provider.value } : {}) } } }
function changeScope(next: SessionScope): void {
  if (next.type === 'personal') void router.push('/sessions')
  else void router.push({ name: 'team-sessions', params: { teamId: next.teamId } })
}
async function loadList(): Promise<void> {
  const current = ++listGeneration
  try {
    const [nextTeams, nextMembers, nextOffers, nextAll, nextFiltered] = await Promise.all([
      listTeams(), listTeamMembers(teamID.value), listTeamAgentOffers(teamID.value), listTeamSessions(teamID.value),
      listTeamSessions(teamID.value, { daemonID: daemonID.value || undefined, provider: provider.value || undefined }),
    ])
    if (current !== listGeneration) return
    teams.value = nextTeams; members.value = nextMembers; offers.value = nextOffers; allSessions.value = nextAll; filteredSessions.value = nextFiltered
  } catch (failure) { if (!error.value) error.value = failure instanceof Error ? failure.message : '会话列表加载失败' }
}
async function togglePaused(): Promise<void> {
  if (!session.value || !isCreator.value || !['active', 'paused'].includes(session.value.state)) return
  try { session.value = await updateTeamSession(session.value, { state: session.value.state === 'paused' ? 'active' : 'paused' }) }
  catch (failure) { error.value = failure instanceof Error ? failure.message : '状态更新失败' }
}
async function send(): Promise<void> {
  const sent = await sendMessage({ targetMode: target.value.mode, targetOfferIDs: target.value.offerIDs, referenceEventID: referenceEvent.value?.id ?? null })
  if (sent) { referenceEvent.value = null; await nextTick(); scrollToBottom() }
}
function scrollToEvent(eventID: string): void { document.getElementById(`team-event-${eventID}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }
function scrollToBottom(): void { const element = messagesElement.value; if (element) element.scrollTop = element.scrollHeight }
function saveReadingPosition(): void { const element = messagesElement.value; if (element) setScopedReadingPosition(scope.value, sessionID.value, element.scrollTop) }
function restoreReadingPosition(): void {
  if (restoredSessionID === sessionID.value || !messagesElement.value || loading.value) return
  restoredSessionID = sessionID.value
  const position = getScopedReadingPosition(scope.value, sessionID.value)
  nextTick(() => { if (messagesElement.value) messagesElement.value.scrollTop = position ?? messagesElement.value.scrollHeight })
}
watch([teamID, daemonID, provider], () => { void loadList() })
watch(sessionID, () => { restoredSessionID = ''; referenceEvent.value = null })
watch([loading, () => events.value.length], restoreReadingPosition)
onMounted(() => {
  daemonID.value = typeof route.query.daemon === 'string' ? route.query.daemon : ''
  provider.value = route.query.provider === 'codex' || route.query.provider === 'claude-code' ? route.query.provider : ''
  void loadList()
})
onBeforeUnmount(saveReadingPosition)
</script>

<style scoped>
.team-session-layout { height: 100dvh; min-height: 0; display: flex; position: relative; color: var(--fg); background: var(--bg); overflow: hidden; }.session-panel { width: 282px; flex: 0 0 282px; display: flex; flex-direction: column; border-right: 1px solid var(--sidebar-border, var(--border)); background: var(--surface); }.session-panel-header { min-height: 66px; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 14px 10px 16px; border-bottom: 1px solid var(--border); box-sizing: border-box; }.session-panel-header > div { min-width: 0; display: grid; gap: 4px; }.session-panel-header strong { overflow: hidden; font-size: 13px; text-overflow: ellipsis; }.session-panel-header small { color: var(--fg-tertiary); font-size: 9px; }.session-panel-header a { color: var(--accent); font-size: 20px; text-decoration: none; }.session-panel :deep(.session-scope-switcher) { margin: 9px 9px 5px; }.filters { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; padding: 5px 9px 8px; }.filters select { min-width: 0; padding: 7px; border: 1px solid var(--border); border-radius: 7px; color: var(--fg-secondary); background: var(--bg); font-size: 9px; }.session-list { min-height: 0; flex: 1; overflow-y: auto; padding: 4px 8px 14px; }.session-list a { min-height: 54px; display: flex; align-items: center; gap: 9px; padding: 0 9px; border-radius: 8px; color: inherit; text-decoration: none; }.session-list a:hover,.session-list a.active { background: var(--surface-hover); }.session-list a.active { box-shadow: inset 2px 0 var(--accent); }.session-list a > div { min-width: 0; display: grid; gap: 4px; }.session-list strong { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.session-list small { color: var(--fg-tertiary); font-size: 9px; }.state-dot { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: var(--fg-tertiary); }.state-dot.active { background: var(--success); }.state-dot.paused { background: var(--warning); }.conversation { min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; position: relative; }.conversation-header { min-height: 62px; display: flex; align-items: center; gap: 12px; padding: 0 18px; border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--bg) 92%, transparent); box-sizing: border-box; }.title-copy { min-width: 0; display: grid; gap: 2px; flex: 1; }.title-copy span { color: var(--fg-tertiary); font-size: 9px; }.title-copy strong { overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }.header-actions { display: flex; align-items: center; gap: 6px; }.header-actions button,.session-state { padding: 6px 8px; border: 1px solid var(--border); border-radius: 7px; color: var(--fg-secondary); background: transparent; font-size: 9px; }.header-actions button { cursor: pointer; }.header-actions button.active { color: var(--accent); background: var(--accent-muted); }.session-state.active { color: var(--success); }.session-state.paused { color: var(--warning); }.mobile-back { display: none; color: var(--fg); font-size: 25px; text-decoration: none; }.return-notice,.error-banner { padding: 7px 16px; border-bottom: 1px solid var(--border); color: var(--fg-secondary); background: var(--surface); font-size: 10px; }.error-banner { color: var(--error); }.messages { min-height: 0; flex: 1; display: flex; flex-direction: column; gap: 16px; overflow-y: auto; padding: 24px clamp(18px, 5vw, 72px) 190px; scrollbar-gutter: stable; }.event { display: flex; flex-direction: column; gap: 6px; }.event-meta { display: flex; justify-content: space-between; color: var(--fg-tertiary); font: 9px var(--font-mono); }.reference { align-self: flex-start; padding: 3px 7px; border: 0; border-radius: 6px; color: var(--accent); background: var(--accent-muted); font-size: 9px; cursor: pointer; }.event-actions { min-height: 18px; display: flex; justify-content: flex-end; gap: 9px; color: var(--fg-tertiary); font-size: 9px; opacity: .72; }.event-actions button { border: 0; color: var(--fg-tertiary); background: none; font-size: 9px; cursor: pointer; }.event-actions button:hover { color: var(--accent); }.system-event { display: grid; gap: 5px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface); }.system-event strong { color: var(--fg-secondary); font-size: 10px; }.system-event span { white-space: pre-wrap; color: var(--fg-tertiary); font-size: 10px; line-height: 1.6; }.empty { min-height: 260px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--fg-tertiary); font-size: 11px; text-align: center; }.empty strong { color: var(--fg-secondary); font-size: 14px; }.composer-shell { position: absolute; right: clamp(18px,5vw,72px); bottom: 20px; left: clamp(18px,5vw,72px); z-index: 30; padding: 10px; border: 1px solid var(--border); border-radius: 14px; background: color-mix(in srgb, var(--surface) 94%, transparent); box-shadow: 0 10px 32px rgba(0,0,0,.16); backdrop-filter: blur(16px); }.reply-preview { display: flex; justify-content: space-between; gap: 10px; margin: -2px 0 8px; padding: 6px 8px; border-radius: 7px; color: var(--fg-secondary); background: var(--accent-muted); font-size: 9px; }.reply-preview span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.reply-preview button { border: 0; color: var(--fg-secondary); background: none; cursor: pointer; }.composer-row { display: flex; align-items: flex-end; gap: 8px; margin-top: 8px; }.composer-row textarea { min-height: 38px; max-height: 150px; flex: 1; resize: vertical; padding: 9px 10px; border: 0; outline: 0; color: var(--fg); background: transparent; font: 13px/1.5 var(--font-body); }.send-button { width: 34px; height: 34px; border: 0; border-radius: 9px; color: #fff; background: var(--accent); font-size: 17px; cursor: pointer; }.send-button:disabled { opacity: .4; cursor: not-allowed; }.composer-status { margin: 5px 3px 0; color: var(--fg-tertiary); font-size: 9px; }
@media(max-width:760px){.session-panel{display:none}.mobile-back{display:block}.conversation-header{padding:0 12px}.header-actions .session-state{display:none}.header-actions button{padding:6px}.messages{padding:18px 14px 180px}.composer-shell{right:10px;bottom:10px;left:10px}.event-meta time{display:none}}
</style>
