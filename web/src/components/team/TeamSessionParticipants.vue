<template>
  <ActionList :title="mode === 'picker' ? t('workspace.add_members') : mode === 'members' ? t('workspace.members') : t('workspace.participants')" :width="420" :back="mode !== 'summary'" @back="mode='summary'" @close="!busy && emit('close')">
    <div class="participants-body" data-testid="team-session-participants">
      <template v-if="mode === 'picker'">
        <input v-model="memberQuery" type="search" :aria-label="t('workspace.member_search')" :placeholder="t('workspace.member_search')" />
        <label v-for="member in searchedMembers" :key="member.id" class="member-option" :class="{joined:participantIDs.has(member.user_id)}">
          <input v-model="selectedUserIDs" type="checkbox" :value="member.user_id" :disabled="busy || participantIDs.has(member.user_id) || !canManage" />
          <span class="avatar">{{ member.display_label.charAt(0).toUpperCase() }}</span>
          <span><strong>{{ member.display_label }}</strong><small>{{ t(participantIDs.has(member.user_id) ? 'workspace.member_joined' : 'workspace.member_available') }}</small></span>
        </label>
        <p v-if="!searchedMembers.length">{{ t('workspace.no_match') }}</p>
      </template>
      <section v-else>
        <div class="member-section-heading"><small>{{ t('workspace.members') }}</small><button v-if="canManage && availableMembers.length" type="button" class="add-members" @click="openPicker">＋ {{ t('workspace.add_members') }}</button></div>
        <template v-if="mode === 'members'"><input v-model="memberQuery" type="search" :aria-label="t('workspace.member_search')" :placeholder="t('workspace.member_search')" /></template>
        <div v-for="participant in shownParticipants" :key="participant.id" class="person-row">
          <span class="avatar">{{ memberLabel(participant.user_id).charAt(0).toUpperCase() }}</span>
          <div><strong>{{ memberLabel(participant.user_id) }}</strong><em>{{ participant.user_id === currentUserId ? t('team.me') : t('team.member') }}</em></div>
          <button v-if="canManage && participant.user_id !== session.creator_user_id" type="button" :disabled="busy" @click="remove(participant.user_id)"> {{ t('memory.loadout.remove') }} </button>
        </div>
        <button v-if="mode === 'summary' && activeParticipants.length > 5" type="button" class="action-item" @click="mode='members'; memberQuery=''">{{ t('workspace.all_members', {count:activeParticipants.length}) }}</button>
      </section>
      <section v-if="mode==='summary'">
        <small> {{ t('workspace.agent_bindings') }} </small>
        <div v-for="binding in session.agent_bindings" :key="binding.id" class="agent-row">
          <span :class="['availability-dot', binding.availability]"></span>
          <div><strong>{{ teamProviderLabel(binding.provider) }}</strong><em>{{ binding.daemon_id }} · {{ binding.availability }}</em></div>
          <RouterLink v-if="binding.owner_user_id === currentUserId && binding.native_session_id" :to="nativeSessionLink(binding.native_session_id)"> {{ t('workspace.native_session') }} </RouterLink>
        </div>
      </section>
      <section v-if="mode==='summary' && ownOffers.length"><small> {{ t('workspace.my_agents') }} </small><p class="owner-boundary"> {{ t('workspace.own_agent_hint') }} </p><div v-for="offer in ownOffers" :key="offer.id" class="agent-row"><div><strong>{{ teamProviderLabel(offer.provider) }}</strong><em>{{ offer.daemon_id }}</em></div><button :disabled="busy || !writesEnabled || !['active','paused'].includes(session.state) || (!isBound(offer.id) && !offer.managed_callable)" @click="toggleBinding(offer.id)">{{ isBound(offer.id) ? t('workspace.withdraw') : t('workspace.join_session') }}</button></div></section>
      <p v-if="error" class="panel-error">{{ error }}</p>
      <p class="owner-boundary"> {{ t('workspace.agent_owner_boundary') }} </p>
    </div>
    <template v-if="mode==='picker'" #footer><span class="member-selection">{{ t('workspace.members_selected', {count:selectedUserIDs.length}) }}</span><button class="primary member-confirm" type="button" :disabled="busy || !canManage || !selectedUserIDs.length" @click="add">{{ t('workspace.add_selected') }}</button></template>
  </ActionList>
</template>

<script setup lang="ts">
import { teamProviderLabel } from '../../utils/teamProvider'
import { computed, ref } from 'vue'
import ActionList from '../ActionList.vue'
import { useLocale } from '../../composables/useLocale'
import { getTeamSession, setTeamSessionAgentBinding, setTeamSessionParticipant } from '../../services/teamClient'
import type { TeamAgentOffer, TeamMember, TeamSession } from '../../types/team'

const props = withDefaults(defineProps<{ session: TeamSession; members: TeamMember[]; currentUserId: number; offers?: TeamAgentOffer[]; writesEnabled?: boolean }>(),{offers:()=>[],writesEnabled:false})
const emit = defineEmits<{ close: []; updated: [session: TeamSession] }>()
const { t } = useLocale()
const mode = ref<'summary'|'members'|'picker'>('summary'), memberQuery = ref(''), selectedUserIDs = ref<number[]>([]), busy = ref(false), error = ref('')
const ownOffers = computed(()=>props.offers.filter(offer=>offer.owner_user_id===props.currentUserId && offer.state==='active'))
function isBound(id:string){return props.session.agent_bindings.some(binding=>binding.offer_id===id && binding.state==='active')}
async function toggleBinding(id:string){if(busy.value || !props.writesEnabled)return;busy.value=true;error.value='';try {const current=await getTeamSession(props.session.id);emit('updated',await setTeamSessionAgentBinding(current,id,!isBound(id)))}catch(failure){error.value=failureMessage(failure)}finally{busy.value=false}}
const canManage = computed(() => props.writesEnabled && props.session.creator_user_id === props.currentUserId && ['active','paused'].includes(props.session.state))
const participantIDs = computed(() => new Set(props.session.participants.filter(participant=>participant.state==='active').map(participant => participant.user_id)))
const availableMembers = computed(() => props.members.filter(member => member.state === 'active' && !participantIDs.value.has(member.user_id)))
const activeParticipants = computed(() => props.session.participants.filter(participant => participant.state === 'active'))
const shownParticipants = computed(() => mode.value === 'members' ? activeParticipants.value.filter(participant => memberLabel(participant.user_id).toLowerCase().includes(memberQuery.value.trim().toLowerCase())) : activeParticipants.value.slice(0,5))
const searchedMembers = computed(() => props.members.filter(member => member.state === 'active' && member.display_label.toLowerCase().includes(memberQuery.value.trim().toLowerCase())))
function openPicker() { selectedUserIDs.value=[]; memberQuery.value=''; mode.value='picker' }
function memberLabel(userID: number): string { return props.members.find(member => member.user_id === userID)?.display_label ?? t('workspace.user_label', {id:userID}) }
function nativeSessionLink(nativeSessionID: string): string { return `/session/${encodeURIComponent(nativeSessionID)}?return_team_session=${encodeURIComponent(props.session.id)}&team=${encodeURIComponent(props.session.team_id)}` }
function failureMessage(failure: unknown): string { return failure instanceof Error ? failure.message : t('workspace.operation_failed') }
async function add(): Promise<void> {
  if (busy.value || !canManage.value || !selectedUserIDs.value.length) return
  busy.value = true; error.value = ''
  try {
    let current = await getTeamSession(props.session.id)
    for (const userID of [...selectedUserIDs.value]) {
      if (!availableMembers.value.some(member => member.user_id === userID)) continue
      current = await setTeamSessionParticipant(current, userID, true)
      selectedUserIDs.value = selectedUserIDs.value.filter(id => id !== userID)
      emit('updated', current)
    }
    mode.value='summary'
  } catch (failure) { error.value = failureMessage(failure) } finally { busy.value = false }
}
async function remove(userID: number): Promise<void> {
  if (busy.value || !canManage.value) return
  busy.value = true; error.value = ''
  try { emit('updated', await setTeamSessionParticipant(props.session, userID, false)) }
  catch (failure) { error.value = failureMessage(failure) } finally { busy.value = false }
}
</script>

<style scoped>
.participants-panel { width: 320px; min-width: 270px; border-left: 1px solid var(--border); color: var(--fg); background: var(--surface); overflow-y: auto; }.participants-panel header { min-height: 62px; display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid var(--border); }.participants-panel header div { display: grid; gap: 3px; }.participants-panel header span { color: var(--fg-secondary); font-size: 10px; }.participants-panel header strong { font-size: 12px; }.participants-panel header button { border: 0; color: var(--fg-secondary); background: none; font-size: 22px; cursor: pointer; }.participants-body { padding: 16px; }.participants-body section { margin-bottom: 24px; }.participants-body section > small { display: block; margin-bottom: 9px; color: var(--accent); font: 650 9px var(--font-mono); letter-spacing: .08em; text-transform: uppercase; }.person-row,.agent-row { min-height: 48px; display: flex; align-items: center; gap: 9px; border-bottom: 1px solid var(--border); }.person-row > div,.agent-row > div { min-width: 0; display: grid; gap: 3px; flex: 1; }.person-row strong,.agent-row strong { overflow: hidden; font-size: 11px; text-overflow: ellipsis; }.person-row em,.agent-row em { overflow: hidden; color: var(--fg-tertiary); font: normal 9px var(--font-mono); text-overflow: ellipsis; }.person-row button,.agent-row a,.add-person button { border: 0; color: var(--accent); background: none; font-size: 9px; cursor: pointer; text-decoration: none; }.avatar { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%; color: var(--accent); background: var(--accent-muted); font-size: 10px; }.availability-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fg-tertiary); }.availability-dot.online { background: var(--success); }.availability-dot.offline,.availability-dot.occupied { background: var(--warning); }.add-person { display: flex; gap: 6px; margin-top: 10px; }.add-person select { min-width: 0; flex: 1; padding: 7px; border: 1px solid var(--border); border-radius: 7px; color: var(--fg); background: var(--bg); font-size: 10px; }.panel-error { color: var(--error); font-size: 10px; }.owner-boundary { color: var(--fg-tertiary); font-size: 10px; line-height: 1.55; }
@media (max-width: 900px) { .participants-panel { position: absolute; inset: 62px 0 0 auto; z-index: 80; width: min(350px, 90vw); box-shadow: -12px 0 30px rgba(0,0,0,.18); } }
.participants-panel { position:fixed; inset:0 0 0 auto; z-index:110; width:470px; max-width:100vw; min-width:0; box-shadow:var(--shadow-lg); box-sizing:border-box; background:var(--bg); }.participants-panel header { padding:20px 24px; min-height:70px; }.participants-panel header span { font-size:14px; color:var(--fg); }.participants-panel header strong { font-size:12px; }.participants-panel :deep(p),.participants-panel :deep(li) { font-size:12px; line-height:1.8; }
.agent-row button { border:1px solid var(--border); border-radius:6px; padding:6px 9px; color:var(--accent); background:none; font:11px var(--font-body); cursor:pointer; }.agent-row button:disabled { opacity:.45; cursor:default; }.participants-body { padding:22px 24px; }.participants-body section>small { font:550 12px var(--font-body); color:var(--fg-secondary); }.person-row strong,.agent-row strong { font-size:12px; }
</style>
<style scoped>
.participants-body{padding:4px 0}.participants-body section{margin-bottom:14px}.member-section-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 7px}.member-section-heading>small{font-size:12px;color:var(--fg-secondary)}.member-section-heading .add-members{flex:none;min-height:34px;padding:6px 10px;border:1px solid var(--border);border-radius:7px;background:var(--accent-muted);color:var(--accent);font:12px var(--font-body);cursor:pointer}.member-option{display:flex!important;align-items:center;gap:9px;padding:10px 5px;margin:0!important;min-height:60px;border-bottom:1px solid var(--border);cursor:pointer}.member-option>input{width:16px;height:16px;flex:none;accent-color:var(--accent)}.member-option>span:last-child{min-width:0;display:grid;gap:3px}.member-option strong{overflow-wrap:anywhere;font-size:12px;font-weight:550}.member-option small{color:var(--fg-tertiary);font-size:11px}.member-option.joined{opacity:.5;cursor:default}.member-option:has(input:checked){background:var(--accent-muted)}.member-selection{flex:1;padding:0 4px;color:var(--fg-secondary);font-size:11px}.workspace-action-list>footer>.member-confirm{flex:none}.person-row{min-height:54px}.person-row button{min-height:34px;font-size:12px}.agent-row strong{font-size:12px}
</style>
