<template>
  <div class="team-session-layout" data-testid="team-session-detail">
    <aside class="session-panel">
      <TeamSessionBrowser v-if="browseScope.type === 'team'" ref="teamBrowser" :key="browseScope.teamId" :team-id="browseScope.teamId" :current-session-id="sessionID" :current-team-id="teamID" @update:scope="changeScope" @filtered="outsideBrowse = $event" @updated="applyBrowserUpdate" />
      <PersonalSessionBrowser v-else @update:scope="changeScope" />
    </aside>

    <main class="conversation">
      <div v-if="browseScope.type === 'personal' || outsideBrowse" class="session-filter-notice" role="status"><span> {{ t('workspace.outside_filter_hint') }} </span><button @click="revealCurrent"> {{ t('workspace.reveal_in_list') }} </button></div>
      <header class="conversation-header">
        <RouterLink class="mobile-back" :aria-label="t('workspace.return_session_list')" :to="listLink">‹</RouterLink>
        <div class="title-copy"><strong>{{ session?.title || t('common.loading') }}</strong><span>{{ t('workspace.created_by_agents', {creator:members.find(member => member.user_id === session?.creator_user_id)?.display_label || t('team.member'), count:session?.agent_bindings.length || 0}) }}</span></div>
        <div class="header-actions">
          <TopbarGithubLink />
          <span v-if="session" :class="['session-state', session.state]">{{ stateLabel(session.state) }}</span>
          <div class="session-id-box"><span>{{ sessionID.slice(0,8) }}</span><button type="button" :aria-label="t('session.actions.copy_id')" @click="copySessionID"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button></div>
          <div ref="moreRoot" class="session-more" @keydown.esc.stop="moreOpen = false"><button :aria-label="t('workspace.more_session_actions')" :aria-expanded="moreOpen" @click="moreOpen = !moreOpen">···</button><div v-if="moreOpen" class="session-more-menu"><button v-if="isCreator && session" @click="togglePaused(); moreOpen = false">{{ session.state === 'paused' ? t('workspace.resume') : t('workspace.pause') }}</button><button @click="copySessionID(); moreOpen = false"> {{ t('session.actions.copy_id') }} </button></div></div>
        </div>
      </header>
      <div v-if="task" class="task-strip"><button @click="showTask = true">{{ task.title }}</button><span>{{ ({open:t('team.task_state.open'),in_progress:t('team.task_state.in_progress'),completed:t('team.task_state.completed'),archived:t('team.task_filter.archived'),deleted:t('workspace.deleted')})[task.state] }}</span></div>
      <div class="people-strip">
        <div class="participant-avatars"><span v-for="member in members.filter(item => session?.participants.some(participant => participant.user_id === item.user_id && participant.state === 'active'))" :key="member.id">{{ member.display_label.slice(0,1) }}</span></div>
        <button @click="showParticipants = !showParticipants; showContext = false; showRun = false">{{ t('workspace.participants_count', {count:session?.participants.filter(item => item.state === 'active').length || 0}) }}</button>
        <span class="strip-divider"></span><button v-for="binding in session?.agent_bindings.filter(item => item.state === 'active')" :key="binding.id" class="agent-chip" @click="showParticipants = true; showContext = false; showRun = false"><i :class="{online:binding.availability === 'online'}"></i>{{ teamProviderLabel(binding.provider) }} · {{ members.find(member => member.user_id === binding.owner_user_id)?.display_label || t('team.member') }}</button>
        <span class="strip-divider"></span>
          <button type="button" :class="{ active: showContext }" @click="historyContext = null; showContext = !showContext; showParticipants = false; showRun = false">Context v{{ session?.current_context_version || 0 }}</button>
          <button v-if="autorunEnabled || latestRun" type="button" :class="{ active: showRun }" @click="showRun = !showRun; showContext = false; showParticipants = false"> {{ t('workspace.autorun') }} </button>
          <button type="button" :class="{ active: showParticipants }" @click="showParticipants = !showParticipants; showContext = false; showRun = false"> {{ t('workspace.my_agents') }} </button>
      </div>
      <div v-if="returnNotice" class="return-notice"> {{ t('workspace.returned_shared_session') }} </div>
      <div v-if="error" class="error-banner" role="status">{{ error }}</div>
      <section ref="messagesElement" :style="{'--composer-reserve':composerHeight + 'px'}" class="messages" @scroll="saveReadingPosition">
        <div v-if="loading && !events.length" class="empty"> {{ t('workspace.loading_collaboration') }} </div>
        <div v-else-if="!events.length" class="empty"><strong> {{ t('workspace.start_team_discussion') }} </strong><span> {{ t('workspace.team_discussion_hint') }} </span></div>
        <article v-for="event in displayEvents" :id="`team-event-${event.id}`" :key="event.id" :class="['event', event.kind]">
          <span v-if="event.kind === 'member_message' || event.kind === 'agent_message'" :class="['message-avatar',{agent:event.kind === 'agent_message'}]">{{ authorLabel(event).slice(0,1) }}</span>
          <div class="event-body">
          <div class="event-meta">
            <span>{{ authorLabel(event) }}</span><small v-if="event.author_offer_id">{{ t('workspace.owners_agent', {owner:members.find(member => member.user_id === offers.find(offer => offer.id === event.author_offer_id)?.owner_user_id)?.display_label || t('team.member')}) }}</small><time>{{ formatTime(event.created_at) }}</time>
          </div>
          <button v-if="event.reference" type="button" class="reference" @click="scrollToEvent(event.reference.event_id)">{{ t('workspace.reference_event', {seq:event.reference.event_seq}) }}</button>
          <MessageUser v-if="event.kind === 'member_message'" :content="event.content" />
          <MessageAgent v-else-if="event.kind === 'agent_message'" :content="event.content" :agent-type="agentProvider(event.author_offer_id)" />
          <div v-else class="system-event"><strong>{{ kindLabel(event.kind) }}</strong><span>{{ event.kind === 'status' ? statusLabel(event.content) : teamSystemEventText(event) }}</span></div>
          <div v-for="call in callsByEvent.get(event.id) ?? []" :key="call.id" :class="['call-status', call.state]" role="status">
            <span>{{ agentProvider(call.offer_id) }} · {{ callLabel(call) }}</span>
            <small v-if="call.state === 'uncertain'"> {{ t('workspace.call_result_unknown') }} </small>
            <RouterLink v-if="ownerNativeLink(call.offer_id)" :to="ownerNativeLink(call.offer_id)!"> {{ t('workspace.open_own_native_session') }} </RouterLink>
          </div>
          <div class="event-actions"><span v-if="event.target_mode">{{ targetLabel(event) }}</span><button v-if="event.context_version" class="context-receipt" @click="openContextVersion(event.context_version)">Context v{{ event.context_version }}</button><button type="button" @click="referenceEvent = event"> {{ t('workspace.references') }} </button></div>
          </div>
        </article>
      </section>

      <footer ref="composerElement" class="composer-shell">
        <div class="composer-container">
        <div class="textarea-resize-handle" role="separator" :aria-label="t('workspace.resize_composer')" aria-orientation="horizontal" @pointerdown="beginResize"></div>
        <div v-if="referenceEvent" class="reply-preview"><span>{{ t('workspace.reply_event', {seq:referenceEvent.event_seq, content:referenceEvent.content.slice(0,80)}) }}</span><button type="button" @click="referenceEvent = null">×</button></div>
        <div class="composer-row">
          <textarea v-model="draft" :style="{height:textareaHeight + 'px'}" :disabled="!!readOnlyReason" rows="1" :placeholder="readOnlyReason || t('workspace.team_composer_placeholder')" data-testid="team-session-composer" @keydown.enter.exact.prevent="send" />
        </div>
        <div class="composer-controls"><TeamAgentTargetPicker v-model="target" :bindings="session?.agent_bindings ?? []" :members="members" /><span class="composer-context">Context v{{ session?.current_context_version || 0 }}</span><button class="materials-button" @click="historyContext = null; showContext = true; showParticipants = false; showRun = false"> {{ t('workspace.materials') }} </button>
          <button type="button" class="send-button" :disabled="!canSend || !draft.trim() || !!targetUnavailableReason" data-testid="team-session-send" @click="send">{{ sending ? '…' : '↑' }}</button>
        </div>
        </div>
        <p v-if="readOnlyReason" class="composer-status">{{ readOnlyReason }}</p>
        <p v-else-if="targetUnavailableReason" class="composer-status">{{ targetUnavailableReason }}</p>
        <p v-else class="composer-status">{{ target.mode === 'discussion' ? t('workspace.discussion_only_hint') : t('workspace.agent_context_hint') }}</p>
      </footer>
    </main>

    <TeamOverlay actions v-if="showTask && task" :title="t('team.tab.tasks')" drawer @close="showTask = false"><h2>{{ task.title }}</h2><p style="white-space:pre-wrap;line-height:1.8;font-size:12px;color:var(--fg-secondary)">{{ task.background }}</p></TeamOverlay>
    <TeamContextPanel v-if="showContext && session" :context="historyContext || context" :read-only="!!historyContext || session.current_user_role === 'viewer' || teamAccess.capabilities.value?.writes_enabled !== true" :session="session" :current-user-id="currentUserID" @saved="context = $event" @close="showContext = false; historyContext = null" />
    <TeamSessionParticipants v-if="showParticipants && session" :session="session" :members="members" :offers="offers" :writes-enabled="teamAccess.capabilities.value?.writes_enabled === true && session.current_user_role!=='viewer'" :current-user-id="currentUserID" @updated="session = $event" @close="showParticipants = false" />
    <TeamRunPanel
      v-if="showRun && session"
      :session="session"
      :run="latestRun"
      :context="runContext"
      :current-context="context"
      :task="task"
      :members="members"
      :current-user-id="currentUserID"
      :autorun-enabled="autorunEnabled"
      :busy="runBusy"
      :error="runError"
      @close="showRun = false"
      @start="createRun"
      @control="controlRun"
      @supplement="supplementRunInput"
      @suggest-pause="suggestRunPause"
      @withdraw-agent="withdrawAgent"
    />
  </div>
</template>

<script setup lang="ts">
import { teamProviderLabel } from '../utils/teamProvider'
import TopbarGithubLink from '../components/TopbarGithubLink.vue'
import { useLocale } from "../composables/useLocale"
const { t } = useLocale()
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import MessageAgent from '../components/messages/MessageAgent.vue'
import MessageUser from '../components/messages/MessageUser.vue'
import TeamSessionBrowser from '../components/session/TeamSessionBrowser.vue'
import PersonalSessionBrowser from '../components/session/PersonalSessionBrowser.vue'
import { teamSystemEventText } from '../utils/teamEventPresentation'
import TeamOverlay from '../components/team/TeamOverlay.vue'
import TeamAgentTargetPicker, { type TeamAgentTargetValue } from '../components/team/TeamAgentTargetPicker.vue'
import TeamContextPanel from '../components/team/TeamContextPanel.vue'
import TeamSessionParticipants from '../components/team/TeamSessionParticipants.vue'
import TeamRunPanel from '../components/team/TeamRunPanel.vue'
import { useTeamAccess } from '../composables/useTeamAccess'
import { useAuth } from '../composables/useAuth'
import { getScopedReadingPosition, setScopedReadingPosition, type SessionScope } from '../composables/useScopedSessionState'
import { useTeamSession } from '../composables/useTeamSession'
import { getTeamContext, listTeamAgentOffers, listTeamMembers, listTeams, updateTeamSession } from '../services/teamClient'
import { isTeamProvider } from '../types/team'
import type { TeamSession, TeamContextSnapshot, TeamCallSummary, TeamAgentOffer, TeamEvent, TeamMember, TeamProvider, TeamSummary } from '../types/team'

const route = useRoute(), { user } = useAuth(), teamAccess=useTeamAccess()
const teamID = computed(() => String(route.params.teamId ?? '')), sessionID = computed(() => String(route.params.id ?? ''))
const scope = computed<SessionScope>(() => ({ type: 'team', teamId: teamID.value }))
const browseScope = ref<SessionScope>({type:'team',teamId:teamID.value})
const moreRoot=ref<HTMLElement|null>(null)
function closeMore(event:MouseEvent){if(!moreRoot.value?.contains(event.target as Node))moreOpen.value=false}
const outsideBrowse = ref(false), moreOpen = ref(false), showTask = ref(false)
const teamBrowser = ref<InstanceType<typeof TeamSessionBrowser>|null>(null)
function revealCurrent(){browseScope.value={type:'team',teamId:teamID.value};outsideBrowse.value=false;void nextTick(()=>teamBrowser.value?.revealCurrent())}
async function copySessionID(){try{await navigator.clipboard.writeText(sessionID.value)}catch{error.value=t('workspace.copy_failed')}}
const {
  session, events, calls, context, runContext, latestRun, task, draft, loading, sending, runBusy, error, runError,
  autorunEnabled, readOnlyReason, canSend, sendMessage, createRun, controlRun, supplementRunInput,
  suggestRunPause, withdrawAgent,
} = useTeamSession(teamID, sessionID)
function applyBrowserUpdate(updated: TeamSession) {
  if (updated.id === sessionID.value && updated.team_id === teamID.value) session.value = updated
}
const historyContext = ref<TeamContextSnapshot|null>(null)
let historyGeneration = 0
async function openContextVersion(version:number) {
  const generation=++historyGeneration
  try {const snapshot=await getTeamContext(sessionID.value,version);if(generation!==historyGeneration)return;if(!snapshot)throw new Error('Context unavailable');historyContext.value=snapshot;showContext.value=true;showRun.value=false;showParticipants.value=false}
  catch(failure) {if(generation===historyGeneration)error.value=failure instanceof Error?failure.message:'Context unavailable'}
}
const teams = ref<TeamSummary[]>([]), members = ref<TeamMember[]>([]), offers = ref<TeamAgentOffer[]>([])
const daemonID = ref(''), provider = ref<'' | TeamProvider>(''), showContext = ref(false), showParticipants = ref(false), showRun = ref(false), referenceEvent = ref<TeamEvent | null>(null)
const composerElement=ref<HTMLElement|null>(null),composerHeight=ref(190),textareaHeight=ref(64)
let composerObserver:ResizeObserver|null=null,resizeCleanup:(()=>void)|null=null
function beginResize(event:PointerEvent){event.preventDefault();resizeCleanup?.();const start=event.clientY,height=textareaHeight.value;const move=(next:PointerEvent)=>{textareaHeight.value=Math.max(64,Math.min(400,height+start-next.clientY))};const finish=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);resizeCleanup=null};resizeCleanup=finish;window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish,{once:true})}
onMounted(()=>{if(typeof ResizeObserver!=='undefined'&&composerElement.value){composerObserver=new ResizeObserver(()=>{composerHeight.value=composerElement.value?.offsetHeight??190});composerObserver.observe(composerElement.value)}})
onBeforeUnmount(()=>{composerObserver?.disconnect();resizeCleanup?.()})
const target = ref<TeamAgentTargetValue>({ mode: 'all', offerIDs: [] }), messagesElement = ref<HTMLElement | null>(null)
const targetUnavailableReason = computed(() => {
  if (target.value.mode === 'discussion') return ''
  const callable = session.value?.agent_bindings.filter(binding => binding.state === 'active' && binding.availability === 'online') ?? []
  if (!callable.length) return t('workspace.no_callable_agents')
  if (target.value.mode === 'offers' && (!target.value.offerIDs.length || target.value.offerIDs.some(id => !callable.some(binding => binding.offer_id === id)))) return t('workspace.choose_callable_agent')
  return ''
})
const currentUserID = computed(() => user.value?.id ?? 0), isCreator = computed(() => session.value?.creator_user_id === currentUserID.value && session.value?.current_user_role !== 'viewer' && teamAccess.capabilities.value?.writes_enabled === true)
// Keep immutable source events for references and cursors; only coalesce display.
const displayEvents = computed(() => {
  const result: TeamEvent[] = [], replies = new Map<string, TeamEvent>()
  for (const event of events.value) {
    const key = event.kind === 'agent_message' && event.call_id ? `${event.call_id}:${event.author_offer_id}` : null
    const existing = key ? replies.get(key) : undefined
    if (existing) existing.content += event.content
    else {
      const copy = { ...event }; result.push(copy)
      if (key) replies.set(key, copy)
    }
  }
  return result
})
const callsByEvent = computed(() => {
  const byEvent = new Map<string, TeamCallSummary[]>()
  for (const call of calls?.value ?? []) byEvent.set(call.event_id, [...(byEvent.get(call.event_id) ?? []), call])
  return byEvent
})
function callLabel(call: TeamCallSummary): string {
  if (call.state === 'failed' && call.outcome === 'memory_adapter_unsupported') return t('workspace.shared_memory_unsupported')
  if (call.outcome === 'waiting_owner' && ['accepted', 'dispatched'].includes(call.state)) return t('workspace.waiting_agent_owner')
  return ({ pending: t('workspace.call_pending'), dispatched: t('workspace.call_dispatched'), accepted: t('session.tool_group_running'), completed: t('team.task_state.completed'), failed: t('session.execution_failed'), blocked: t('workspace.call_blocked'), uncertain: t('attention.state_unknown') })[call.state]
}
function ownerNativeLink(offerID: string) {
  const binding = session.value?.agent_bindings.find(item => item.offer_id === offerID && item.owner_user_id === currentUserID.value)
  return binding?.native_session_id ? { path: `/session/${binding.native_session_id}`, query: { team: teamID.value, return_team_session: sessionID.value } } : null
}
const returnNotice = computed(() => route.query.from_native === '1')
const listLink = computed(() => ({ name: 'team-sessions', params: { teamId: browseScope.value.type === 'team' ? browseScope.value.teamId || teamID.value : teamID.value }, query: browseScope.value.type === 'personal' ? { scope:'personal' } : {} }))
let listGeneration = 0
let restoredSessionID = ''

function stateLabel(state: string): string { return ({ active: t('team.task_state.in_progress'), paused: t('team.session_state.paused'), ended: t('team.session_state.ended'), archived: t('team.task_filter.archived') } as Record<string,string>)[state] ?? state }
function statusLabel(status: string): string { return ({ waiting_owner: t('workspace.waiting_agent_owner'), completed: t('team.task_state.completed'), failed: t('session.execution_failed'), interrupted: t('workspace.interrupted'), abandoned: t('workspace.abandoned') } as Record<string, string>)[status] ?? status }
function kindLabel(kind: string): string { return ({ status: t('workspace.agent_status'), context: t('workspace.context_updated'), run: t('workspace.collaboration_run'), system: t('workspace.system_event') } as Record<string,string>)[kind] ?? kind }
function formatTime(value: string): string { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
function authorLabel(event: TeamEvent): string {
  if (event.author_user_id) return members.value.find(member => member.user_id === event.author_user_id)?.display_label ?? t('workspace.member_id', {id:event.author_user_id})
  if (event.author_offer_id) return teamProviderLabel(agentProvider(event.author_offer_id))
  return t('hosts.os')
}
function agentProvider(offerID: string | null): string { return offers.value.find(offer => offer.id === offerID)?.provider ?? 'agent' }
function targetLabel(event: TeamEvent): string {
  if (event.target_mode === 'discussion') return t('workspace.discussion_only_short')
  if (event.target_mode === 'all') return t('workspace.send_all_agents')
  return t('workspace.target_agents_count', {count:event.target_offer_ids.length})
}
function changeScope(next: SessionScope): void { browseScope.value=next }

async function loadList(): Promise<void> {
  const current = ++listGeneration
  try {
    const [nextTeams, nextMembers, nextOffers] = await Promise.all([
      listTeams(), listTeamMembers(teamID.value), listTeamAgentOffers(teamID.value),
    ])
    if (current !== listGeneration) return
    teams.value = nextTeams; members.value = nextMembers; offers.value = nextOffers
  } catch (failure) { if (!error.value) error.value = failure instanceof Error ? failure.message : t('workspace.session_list_load_failed') }
}
async function togglePaused(): Promise<void> {
  if (!session.value || !isCreator.value || !['active', 'paused'].includes(session.value.state)) return
  try { session.value = await updateTeamSession(session.value, { state: session.value.state === 'paused' ? 'active' : 'paused' }) }
  catch (failure) { error.value = failure instanceof Error ? failure.message : t('workspace.state_update_failed') }
}
async function send(): Promise<void> {
  const sent = await sendMessage({ targetMode: target.value.mode, targetOfferIDs: target.value.offerIDs, referenceEventID: referenceEvent.value?.id ?? null })
  if (sent) { referenceEvent.value = null; await nextTick(); scrollToBottom() }
}
function scrollToEvent(eventID: string): void {
  const source = events.value.find(event => event.id === eventID)
  const target = source?.kind === 'agent_message' && source.call_id
    ? displayEvents.value.find(event => event.call_id === source.call_id && event.author_offer_id === source.author_offer_id)?.id ?? eventID
    : eventID
  document.getElementById(`team-event-${target}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }
function scrollToBottom(): void { const element = messagesElement.value; if (element) element.scrollTop = element.scrollHeight }
function saveReadingPosition(): void { const element = messagesElement.value; if (element) setScopedReadingPosition(scope.value, sessionID.value, element.scrollTop) }
function restoreReadingPosition(): void {
  if (restoredSessionID === sessionID.value || !messagesElement.value || loading.value) return
  restoredSessionID = sessionID.value
  const position = getScopedReadingPosition(scope.value, sessionID.value)
  nextTick(() => { if (messagesElement.value) messagesElement.value.scrollTop = position ?? messagesElement.value.scrollHeight })
}
watch([teamID, daemonID, provider], () => { void loadList() })
watch(sessionID, () => { historyGeneration++; historyContext.value=null; restoredSessionID = ''; referenceEvent.value = null; browseScope.value={type:'team',teamId:teamID.value} })
watch([loading, () => events.value.length], restoreReadingPosition)
onMounted(() => {
  daemonID.value = typeof route.query.daemon === 'string' ? route.query.daemon : ''
  provider.value = isTeamProvider(route.query.provider) ? route.query.provider : ''
  void loadList()
})
onMounted(()=>document.addEventListener('click',closeMore))
onBeforeUnmount(()=>{document.removeEventListener('click',closeMore);historyGeneration++;saveReadingPosition()})
</script>

<style scoped>
.call-status { display: flex; flex-wrap: wrap; gap: 6px 12px; color: var(--fg-secondary); font-size: 11px; }
.call-status.uncertain,.call-status.blocked { color: var(--warning); }
.call-status.failed { color: var(--error); }
.call-status a { color: var(--accent); }

.team-session-layout { height: 100dvh; min-height: 0; display: flex; position: relative; color: var(--fg); background: var(--bg); overflow: hidden; }.session-panel { width: 282px; flex: 0 0 282px; display: flex; flex-direction: column; border-right: 1px solid var(--sidebar-border, var(--border)); background: var(--surface); }.session-panel-header { min-height: 66px; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 14px 10px 16px; border-bottom: 1px solid var(--border); box-sizing: border-box; }.session-panel-header > div { min-width: 0; display: grid; gap: 4px; }.session-panel-header strong { overflow: hidden; font-size: 13px; text-overflow: ellipsis; }.session-panel-header small { color: var(--fg-tertiary); font-size: 9px; }.session-panel-header a { color: var(--accent); font-size: 20px; text-decoration: none; }.filters { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; padding: 5px 9px 8px; }.filters select { min-width: 0; padding: 7px; border: 1px solid var(--border); border-radius: 7px; color: var(--fg-secondary); background: var(--bg); font-size: 9px; }.session-list { min-height: 0; flex: 1; overflow-y: auto; padding: 4px 8px 14px; }.session-list a { min-height: 54px; display: flex; align-items: center; gap: 9px; padding: 0 9px; border-radius: 8px; color: inherit; text-decoration: none; }.session-list a:hover,.session-list a.active { background: var(--surface-hover); }.session-list a.active { box-shadow: inset 2px 0 var(--accent); }.session-list a > div { min-width: 0; display: grid; gap: 4px; }.session-list strong { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.session-list small { color: var(--fg-tertiary); font-size: 9px; }.state-dot { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: var(--fg-tertiary); }.state-dot.active { background: var(--success); }.state-dot.paused { background: var(--warning); }.conversation { min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; position: relative; }.conversation-header { min-height: 62px; display: flex; align-items: center; gap: 12px; padding: 0 18px; border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--bg) 92%, transparent); box-sizing: border-box; }.title-copy { min-width: 0; display: grid; gap: 2px; flex: 1; }.title-copy span { color: var(--fg-tertiary); font-size: 9px; }.title-copy strong { overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }.header-actions { display: flex; align-items: center; gap: 6px; }.header-actions button,.session-state { padding: 6px 8px; border: 1px solid var(--border); border-radius: 7px; color: var(--fg-secondary); background: transparent; font-size: 9px; }.header-actions button { cursor: pointer; }.header-actions button.active { color: var(--accent); background: var(--accent-muted); }.session-state.active { color: var(--success); }.session-state.paused { color: var(--warning); }.mobile-back { display: none; color: var(--fg); font-size: 25px; text-decoration: none; }.return-notice,.error-banner { padding: 7px 16px; border-bottom: 1px solid var(--border); color: var(--fg-secondary); background: var(--surface); font-size: 10px; }.error-banner { color: var(--error); }.messages { min-height: 0; flex: 1; display: flex; flex-direction: column; gap: 16px; overflow-y: auto; padding: 24px clamp(18px, 5vw, 72px) 190px; scrollbar-gutter: stable; }.event { display: flex; flex-direction: column; gap: 6px; }.event-meta { display: flex; justify-content: space-between; color: var(--fg-tertiary); font: 9px var(--font-mono); }.reference { align-self: flex-start; padding: 3px 7px; border: 0; border-radius: 6px; color: var(--accent); background: var(--accent-muted); font-size: 9px; cursor: pointer; }.event-actions { min-height: 18px; display: flex; justify-content: flex-end; gap: 9px; color: var(--fg-tertiary); font-size: 9px; opacity: .72; }.event-actions button { border: 0; color: var(--fg-tertiary); background: none; font-size: 9px; cursor: pointer; }.event-actions button:hover { color: var(--accent); }.system-event { display: grid; gap: 5px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface); }.system-event strong { color: var(--fg-secondary); font-size: 10px; }.system-event span { white-space: pre-wrap; color: var(--fg-tertiary); font-size: 10px; line-height: 1.6; }.empty { min-height: 260px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--fg-tertiary); font-size: 11px; text-align: center; }.empty strong { color: var(--fg-secondary); font-size: 14px; }.composer-shell { position: absolute; right: clamp(18px,5vw,72px); bottom: 20px; left: clamp(18px,5vw,72px); z-index: 30; padding: 10px; border: 1px solid var(--border); border-radius: 14px; background: color-mix(in srgb, var(--surface) 94%, transparent); box-shadow: 0 10px 32px rgba(0,0,0,.16); backdrop-filter: blur(16px); }.reply-preview { display: flex; justify-content: space-between; gap: 10px; margin: -2px 0 8px; padding: 6px 8px; border-radius: 7px; color: var(--fg-secondary); background: var(--accent-muted); font-size: 9px; }.reply-preview span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.reply-preview button { border: 0; color: var(--fg-secondary); background: none; cursor: pointer; }.composer-row { display: flex; align-items: flex-end; gap: 8px; margin-top: 8px; }.composer-row textarea { min-height: 38px; max-height: 150px; flex: 1; resize: vertical; padding: 9px 10px; border: 0; outline: 0; color: var(--fg); background: transparent; font: 13px/1.5 var(--font-body); }.send-button { width: 34px; height: 34px; border: 0; border-radius: 9px; color: #fff; background: var(--accent); font-size: 17px; cursor: pointer; }.send-button:disabled { opacity: .4; cursor: not-allowed; }.composer-status { margin: 5px 3px 0; color: var(--fg-tertiary); font-size: 9px; }
@media(max-width:768px){.session-panel{display:none}.mobile-back{display:block}.conversation-header{padding:0 12px}.header-actions .session-state{display:none}.header-actions button{padding:6px}.messages{padding:18px 14px 180px}.composer-shell{right:10px;bottom:10px;left:10px}.event-meta time{display:none}}

/* Shared conversation layout from team-collaboration.html. */
.conversation-header { height:62px; min-height:62px; flex:0 0 auto; padding:0 18px; background:var(--bg); }
.title-copy { gap:2px; }.title-copy strong { font-size:14px; font-weight:650; line-height:19px; letter-spacing:-.01em; }.title-copy span { font:10.5px/14px var(--font-mono); color:var(--fg-tertiary); }
.session-state { border-radius:999px; padding:4px 10px; font-size:12px; }.session-id-box { display:flex; align-items:center; gap:6px; min-height:32px; padding:3px 5px 3px 9px; border:1px solid var(--border); border-radius:var(--radius-md); color:var(--fg-secondary); font:12px var(--font-mono); }.session-id-box button { border:0; padding:0; width:22px; height:22px; }.session-id-box svg { width:13px; height:13px; fill:none; stroke:currentColor; stroke-width:1.7; }.session-more { position:relative; }.session-more > button { width:32px; height:32px; border-radius:var(--radius-md); font-size:20px; }.session-more-menu { position:absolute; right:0; top:calc(100% + 5px); z-index:40; min-width:160px; display:grid; padding:5px; background:var(--surface); border:1px solid var(--border-light); border-radius:8px; box-shadow:var(--shadow-lg); }.session-more-menu button { border:0; text-align:left; padding:9px 10px; border-radius:5px; }
.task-strip { min-height:34px; display:flex; align-items:center; gap:8px; padding:5px 20px; border-bottom:1px solid var(--border); color:var(--fg-secondary); font-size:11px; }.task-strip button { color:var(--accent); border:0; background:none; cursor:pointer; font:inherit; }.task-strip > span { padding:3px 7px; background:var(--surface-active); border-radius:5px; font-size:10px; }
.people-strip { display:flex; flex:0 0 auto; align-items:center; gap:8px; padding:10px 20px; border-bottom:1px solid var(--border); overflow-x:auto; white-space:nowrap; font-size:11px; }.people-strip button { flex:none; border:0; background:none; padding:5px 0; color:var(--accent); font:inherit; cursor:pointer; }.people-strip .agent-chip { display:flex; align-items:center; gap:5px; padding:6px 8px; border:1px solid var(--border); border-radius:5px; color:var(--fg-secondary); background:var(--surface); font-size:10px; }.agent-chip i { width:5px; height:5px; border-radius:50%; background:var(--fg-tertiary); }.agent-chip i.online { background:var(--success); }.participant-avatars { display:flex; gap:3px; }.participant-avatars span { display:grid; place-items:center; width:21px; height:21px; border:1px solid var(--border-light); border-radius:50%; color:var(--accent); background:var(--accent-muted); font-size:10px; }.strip-divider { height:18px; width:1px; flex:none; background:var(--border); margin:0 3px; }.people-strip button.active { color:var(--fg); }.people-strip > button:nth-last-child(3),.people-strip > button:nth-last-child(2) { border:1px solid var(--border); border-radius:6px; padding:8px 12px; color:var(--fg-secondary); }
.session-filter-notice { flex:none; display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:7px 18px; background:var(--accent-subtle); border-bottom:1px solid var(--border); color:var(--fg-secondary); font-size:11px; }.session-filter-notice button { border:0; background:none; color:var(--accent); cursor:pointer; font:inherit; }
.messages { gap:14px; padding:24px max(20px,calc(50% - 460px)) calc(var(--composer-reserve,190px) + 45px); }.event { display:flex; flex-direction:row; gap:11px; margin:0; max-width:none; }.event-body { flex:1; min-width:0; }.message-avatar { flex:0 0 27px; width:27px; height:27px; display:grid; place-items:center; border-radius:50%; color:var(--accent); background:var(--accent-muted); border:1px solid var(--border-light); font-size:11px; }.message-avatar.agent { border-radius:7px; color:var(--fg); background:var(--surface-active); font:11px var(--font-mono); }.event-meta { font-size:11px; color:var(--fg-secondary); margin:0 0 7px; justify-content:flex-start; gap:9px; }.event-meta span { color:var(--fg); font-weight:550; }.event-meta time { font-size:10px; color:var(--fg-tertiary); }
.event :deep(.msg-user) { max-width:100%; width:100%; box-sizing:border-box; color:var(--fg); background:var(--surface); border:1px solid var(--border); border-radius:0 8px 8px 8px; font-size:13px; line-height:1.85; padding:12px 15px; }.event :deep(.msg-agent) { width:100%; max-width:none; padding:0; }.event :deep(.block-role) { display:none; }.event :deep(.agent-body) { font-size:13px; line-height:1.8; }.event-actions { margin-top:8px; gap:8px; font-size:10px; }.event-actions button { margin-left:auto; color:var(--fg-secondary); }.event:not(.member_message):not(.agent_message) { color:var(--fg-secondary); font-size:11px; padding-left:39px; }.event:not(.member_message):not(.agent_message) .event-meta { display:none; }
.composer-shell { left:max(20px,calc(50% - 460px)); right:max(20px,calc(50% - 460px)); bottom:18px; padding:0; border:0; background:none; box-shadow:none; border-radius:0; }.composer-container { padding:0; background:var(--surface); border:1px solid var(--border-light); border-radius:var(--radius-xl); box-shadow:var(--shadow-md); }.textarea-resize-handle { height:6px; margin:4px 8px 0; cursor:ns-resize; display:flex; align-items:center; justify-content:center; }.textarea-resize-handle::after { content:''; width:32px; height:3px; border-radius:2px; background:var(--border-light); }.composer-row { display:block; padding:0; margin:0; }.composer-row textarea { width:100%; min-height:64px; max-height:400px; box-sizing:border-box; padding:13px 16px 5px; margin:0; border:0; background:none; resize:none; color:var(--fg); font:14px/1.55 var(--font-body); outline:none; }.composer-controls { display:flex; align-items:center; gap:8px; padding:8px 12px 11px; }.composer-context { margin-left:auto; color:var(--fg-tertiary); font:11px var(--font-mono); white-space:nowrap; }.send-button { width:32px; height:32px; flex:0 0 32px; border-radius:50%; font-size:18px; padding:0; }.composer-status { font-size:10px; margin:8px 0 0; color:var(--fg-tertiary); line-height:1.6; }
@media(max-width:768px){.conversation-header{padding:0 12px}.session-id-box{display:none}.messages{padding:20px 14px calc(var(--composer-reserve,190px) + 30px)}.event{gap:8px}.people-strip{padding:10px 13px}.task-strip{padding:8px 13px}.composer-shell{left:12px;right:12px;bottom:12px}.composer-context{display:none}.composer-controls{gap:5px}.send-button{width:32px;height:32px}.conversation-header .session-state{display:inline-flex}}
.side-panel-backdrop { position:fixed; inset:0; z-index:109; background:var(--overlay); backdrop-filter:blur(2px); }
.event-meta { font-family:var(--font-body); }.event-meta small { color:var(--fg-secondary); font-size:11px; }.event-actions .context-receipt { margin-left:0; color:var(--accent); }.event-actions button:last-child { margin-left:auto; }.system-event { display:block; border:0; background:none; padding:0; text-align:center; font-size:11px; line-height:1.8; }.system-event strong { display:none; }.system-event span { font-size:11px; }.people-strip { padding:7px 18px; min-height:44px; box-sizing:border-box; }.people-strip .agent-chip { border-color:transparent; background:var(--surface-active); padding:4px 7px; }.people-strip>button:nth-last-child(3),.people-strip>button:nth-last-child(2) { padding:4px 8px; border-color:transparent; background:none; font-size:11px; }.materials-button { border:1px solid var(--border); border-radius:6px; padding:5px 8px; color:var(--fg-secondary); background:none; font:11px var(--font-body); cursor:pointer; }.composer-shell { bottom:20px; }.composer-status { display:flex; justify-content:space-between; }
@media(max-width:768px){.event :deep(.msg-user),.event :deep(.agent-body){font-size:12px}.composer-row textarea{font-size:16px}.people-strip{padding:6px 12px}.messages{padding:14px 12px calc(var(--composer-reserve,190px) + 30px);gap:12px}.composer-status{display:none}.composer-shell{bottom:12px}}
.people-strip { flex-wrap:wrap; overflow:visible; white-space:normal; }
.people-strip button { white-space:nowrap; }
@media(max-width:768px) { .people-strip { gap:6px; }.people-strip .strip-divider { display:none; }.materials-button { margin-left:auto; } }
</style>
