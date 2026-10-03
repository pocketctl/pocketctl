<template>
  <section class="members-panel" data-testid="team-members-panel">
    <div class="module-intro panel-toolbar">
      <div class="member-intro"><h2>{{ t('team.tab.members') }}</h2><p>{{ t('replica.team_members_copy') }}</p></div>
      <button v-if="writesEnabled && isAdmin" type="button" class="btn primary" @click="showInvite=true"><WorkspaceIcon name="plus" class="icon small" />{{ t('team.invite_member') }}</button>
    </div>

    <section class="card reference-members"><div class="table-scroll"><table class="data-table">
      <thead><tr><th>{{ t('team.members') }}</th><th>{{ t('replica.role') }}</th><th>{{ t('replica.available_agents') }}</th><th>{{ t('replica.actions') }}</th></tr></thead>
      <tbody><tr v-for="(member,index) in members" :key="member.id">
        <td><div class="row"><span class="avatar" :class="avatarTone(index)">{{ member.display_label.charAt(0).toUpperCase() }}</span><div><strong>{{ member.display_label }}</strong><p class="faint">{{ member.user_id===team.creator_user_id ? t(member.user_id===currentUserId?'replica.you_creator':'team.creator') : t(member.user_id===currentUserId?'team.me':'team.active_member') }}</p></div></div></td>
        <td><span class="badge" :class="member.user_id===team.creator_user_id?'blue':''">{{ t('team.role.'+(member.user_id===team.creator_user_id?'admin':member.role||'member')) }}</span></td>
        <td><div class="member-agents"><div v-for="offer in memberOffers(member.user_id)" :key="offer.id" class="row"><AgentBadge :agent="offer.provider" size="sm" /><span class="badge" :class="availabilityTone(offer.availability)">{{ t(`team.availability.${offer.availability}`) }}</span></div><span v-if="!memberOffers(member.user_id).length" class="faint">—</span></div></td>
        <td><button class="btn small" :data-testid="`team-member-manage-${member.user_id}`" @click="member.user_id===currentUserId?openMyAgents():openMember(member,$event)">{{ t(member.user_id===currentUserId?'replica.my_agents':'replica.manage') }}</button></td>
      </tr></tbody>
    </table></div></section>

    <section ref="myAgentsSection" class="card reference-team-agents" data-testid="team-my-agents">
      <header class="card-head"><h3>{{ t('replica.my_agents') }}</h3><span class="sub">{{ t('replica.shared_to_current_team') }}</span></header>
      <div v-for="agent in myAgents" :key="agent.key" class="setting-row" :data-agent-key="agent.key">
        <AgentBadge :agent="agent.provider" size="md" /><span class="sub grow">{{ agent.hostname }}</span>
        <span class="badge" :class="agent.offer?availabilityTone(agent.offer.availability):''">{{ agent.offer?t(agent.offer.managed_callable?'replica.agent_available':`team.availability.${agent.offer.availability}`):t('replica.agent_not_shared') }}</span>
        <button v-if="writesEnabled" class="btn small" :disabled="!agent.offer && (!agent.candidate?.installed || agent.candidate.availability==='occupied')" @click="openAgent(agent,$event)">{{ t(agent.offer?'replica.manage_sharing':'replica.share_to_team') }}</button>
      </div>
      <div v-if="!myAgents.length" class="card-body sub">{{ t('team.agents_empty') }}</div>
    </section>

    <details v-if="isAdmin" class="team-invitations card"><summary>{{ t('team.invitations') }}<span class="badge">{{ invitations.length }}</span><WorkspaceIcon name="down" class="icon small" /></summary>
      <div class="invitations-list"><div v-for="invitation in invitations" :key="invitation.id" class="member-row"><div><strong>{{ invitation.recipient_email }}</strong><small>{{ t(`team.invitation_state.${invitation.state}`) }}</small></div><button v-if="invitation.state==='pending' && writesEnabled" type="button" class="btn small" :disabled="busy" @click="revokeInvitation(invitation)">{{ t('team.revoke') }}</button></div><div v-if="!invitations.length" class="compact-empty">{{ t('team.invitations_empty') }}</div></div>
    </details>
    <div class="team-boundary"><span>{{ t('team.agent_owner_boundary') }}</span><button v-if="writesEnabled" type="button" class="danger-action" :disabled="busy" @click="leaveOrDissolve">{{ isCreator?t('team.dissolve'):t('team.leave') }}</button></div>
    <p v-if="error && !showInvite && !showAgents && !managedMember && !managedAgent" class="panel-error" role="status">{{ error }}</p>

    <TeamOverlay v-if="showInvite" :title="t('replica.invite_team_member')" @close="showInvite=false">
      <form id="team-invite-form" class="team-form" @submit.prevent="invite"><label class="team-form-field"><span>{{ t('login.email_label') }}</span><input v-model.trim="inviteEmail" type="email" required :placeholder="t('team.member_email')" /></label><div class="team-form-field"><span>{{ t('replica.role') }}</span><ActionSelect><select v-model="inviteRole" :aria-label="t('replica.role')"><option v-for="role in roles" :value="role" :key="role">{{ t('team.role.'+role) }}</option></select></ActionSelect></div><p class="notice">{{ t('replica.team_invite_copy') }}</p><p v-if="error" class="panel-error" role="alert">{{ error }}</p></form>
      <template #footer><button type="button" class="btn" :disabled="busy" @click="showInvite=false">{{ t('common.cancel') }}</button><button type="submit" form="team-invite-form" class="btn primary" :disabled="busy">{{ t('team.create_invitation') }}</button></template>
    </TeamOverlay>
    <TeamOverlay v-if="showAgents" :title="t('replica.share_my_agents')" @close="showAgents=false"><p class="notice">{{ t('replica.share_agents_copy') }}</p><div class="agent-add"><TeamAgentPicker v-model="selectedAgentKeys" :candidates="availableCandidates" :disabled="busy" /></div><p v-if="error" class="panel-error" role="alert">{{ error }}</p><template #footer><button type="button" class="btn" :disabled="busy" @click="showAgents=false">{{ t('common.cancel') }}</button><button type="button" class="btn primary" :disabled="busy || !selectedAgentKeys.length" @click="addAgents">{{ t('team.add_selected_agents') }}</button></template></TeamOverlay>
    <ActionList v-if="managedMember" :anchor="managementAnchor" :title="managedMember.display_label" @close="managedMember=null">
      <div class="team-member-preview"><span class="avatar">{{ managedMember.display_label.charAt(0).toUpperCase() }}</span><div><strong>{{ managedMember.display_label }}</strong><p>{{ t('team.role.'+(managedMember.user_id===team.creator_user_id?'admin':managedMember.role||'member')) }}</p></div></div>
      <div v-for="offer in memberOffers(managedMember.user_id)" :key="offer.id" class="team-member-agent"><AgentBadge :agent="offer.provider" /><span class="badge" :class="availabilityTone(offer.availability)">{{ t(`team.availability.${offer.availability}`) }}</span></div>
      <div v-if="isAdmin && managedMember.user_id!==team.creator_user_id && writesEnabled" class="team-member-agent"><span>{{ t('replica.role') }}</span><ActionSelect><select :value="managedMember.role||'member'" :disabled="busy" :aria-label="t('replica.role')" @change="updateRole(($event.target as HTMLSelectElement).value)"><option v-for="role in roles" :value="role" :key="role">{{ t('team.role.'+role) }}</option></select></ActionSelect></div>
      <p v-if="!memberOffers(managedMember.user_id).length" class="sub">{{ t('team.offers_empty') }}</p>
      <button v-if="isAdmin && managedMember.user_id!==team.creator_user_id && writesEnabled" class="action-item danger" :disabled="busy" @click="removeManagedMember">{{ t('team.remove') }}</button><p v-if="error" class="panel-error" role="alert">{{ error }}</p>
    </ActionList>
    <ActionList v-if="managedAgent" :anchor="managementAnchor" :title="t('replica.manage_sharing')" @close="managedAgent=null"><div class="team-member-agent"><AgentBadge :agent="managedAgent.provider" /><span class="sub">{{ managedAgent.hostname }}</span></div><p class="notice">{{ t('team.agent_owner_boundary') }}</p><button v-if="writesEnabled" class="action-item" :class="{danger:!!managedAgent.offer}" :disabled="busy" @click="applyAgentSharing">{{ t(managedAgent.offer?'team.remove_from_team':'replica.share_to_team') }}</button><p v-if="error" class="panel-error" role="alert">{{ error }}</p></ActionList>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import {
  addTeamAgentOffer,
  dissolveTeam,
  inviteTeamMember,
  leaveTeam,
  removeTeamMember,
  revokeTeamAgentOffer,
  revokeTeamInvitation,
} from '../../services/teamClient'
import type { TeamAgentCandidate, TeamAgentOffer, TeamInvitation, TeamMember, TeamSummary } from '../../types/team'
import TeamAgentPicker from './TeamAgentPicker.vue'
import AgentBadge from '../AgentBadge.vue'
import TeamOverlay from './TeamOverlay.vue'
import WorkspaceIcon from '../WorkspaceIcon.vue'
import ActionList from '../ActionList.vue'
import ActionSelect from '../ActionSelect.vue'
import { changeTeamMemberRole } from '../../services/teamClient'
import type { TeamRole } from '../../types/team'

const props = defineProps<{
  team: TeamSummary
  members: TeamMember[]
  offers: TeamAgentOffer[]
  invitations: TeamInvitation[]
  candidates: TeamAgentCandidate[]
  currentUserId: number
  writesEnabled: boolean
}>()
const emit = defineEmits<{ refresh: []; removed: [] }>()
const { t } = useLocale()
const busy = ref(false), error = ref(''), showInvite = ref(false), showAgents = ref(false), inviteEmail = ref(''), selectedAgentKeys = ref<string[]>([])
const roles:TeamRole[]=['member','admin','viewer']
const inviteRole=ref<TeamRole>('member')
const isAdmin=computed(()=>isCreator.value || props.members.find(member=>member.user_id===props.currentUserId)?.role==='admin')
async function updateRole(role:string){if(managedMember.value && roles.includes(role as TeamRole) && await action(()=>changeTeamMemberRole(props.team.id,managedMember.value!,role as TeamRole)))managedMember.value=null}
const isCreator = computed(() => props.team.creator_user_id === props.currentUserId)
const activeOffers = computed(() => props.offers.filter(offer => offer.state === 'active'))
const myOffers = computed(() => activeOffers.value.filter(offer => offer.owner_user_id === props.currentUserId))
const key = (candidate: Pick<TeamAgentCandidate, 'daemon_id' | 'provider'>) => `${candidate.daemon_id}:${candidate.provider}`
type MyAgent = { key:string; hostname:string; provider:TeamAgentCandidate['provider']; candidate?:TeamAgentCandidate; offer?:TeamAgentOffer }
const myAgents = computed<MyAgent[]>(() => {
  const rows = props.candidates.map(candidate => ({ key:key(candidate), hostname:candidate.hostname || candidate.daemon_id, provider:candidate.provider, candidate, offer:myOffers.value.find(offer=>key(offer)===key(candidate)) })) as MyAgent[]
  for (const offer of myOffers.value) if (!rows.some(row=>row.key===key(offer))) rows.push({key:key(offer),hostname:offer.daemon_id,provider:offer.provider,offer})
  return rows
})
const availableCandidates = computed(()=>props.candidates.filter(candidate=>!myOffers.value.some(offer=>key(offer)===key(candidate))))
const managedMember=ref<TeamMember|null>(null),managedAgent=ref<MyAgent|null>(null),managementAnchor=ref<HTMLElement|null>(null),myAgentsSection=ref<HTMLElement|null>(null)
const avatarTone=(index:number)=>index%3===1?'purple':index%3===2?'green':''
function availabilityTone(availability:string):string{return availability==='online'?'green':['offline','occupied','access_disabled'].includes(availability)?'amber':''}
function memberOffers(userID:number):TeamAgentOffer[]{return activeOffers.value.filter(offer=>offer.owner_user_id===userID)}
function openMember(member:TeamMember,event:MouseEvent):void{error.value='';managementAnchor.value=event.currentTarget as HTMLElement;managedMember.value=member}
function openAgent(agent:MyAgent,event:MouseEvent):void{error.value='';managementAnchor.value=event.currentTarget as HTMLElement;managedAgent.value=agent}
function openMyAgents():void{
  if(props.writesEnabled && availableCandidates.value.length){selectedAgentKeys.value=[];showAgents.value=true}
  else myAgentsSection.value?.scrollIntoView({block:'nearest',behavior:'smooth'})
}
async function removeManagedMember():Promise<void>{if(managedMember.value && await removeMember(managedMember.value))managedMember.value=null}
async function applyAgentSharing():Promise<void>{
  const agent=managedAgent.value
  if(!agent || !props.writesEnabled)return
  if(agent.offer){if(await action(()=>revokeTeamAgentOffer(agent.offer!)))managedAgent.value=null}
  else if(agent.candidate && agent.candidate.installed && agent.candidate.availability!=='occupied'){if(await action(()=>addTeamAgentOffer(props.team.id,agent.candidate!,props.team.revision)))managedAgent.value=null}
}
function failureMessage(failure: unknown): string { return failure instanceof Error ? failure.message : t('common.error') }
async function action(run: () => Promise<unknown>, refresh = true): Promise<boolean> { busy.value = true; error.value = ''; try { await run(); if (refresh) emit('refresh'); return true } catch (failure) { error.value = failureMessage(failure); return false } finally { busy.value = false } }
async function invite(): Promise<void> { if (await action(() => inviteTeamMember(props.team.id, inviteEmail.value, props.team.revision, inviteRole.value))) { inviteEmail.value = ''; showInvite.value = false } }
async function addAgents(): Promise<void> {
  let revision = props.team.revision
  const agents = props.candidates.filter(candidate => selectedAgentKeys.value.includes(key(candidate)))
  const ok = await action(async () => { for (const candidate of agents) { await addTeamAgentOffer(props.team.id, candidate, revision); revision++ } })
  if (ok) { selectedAgentKeys.value = []; showAgents.value = false }
}
async function removeMember(member: TeamMember): Promise<boolean> { return confirm(t('team.remove_member_confirm')) ? action(() => removeTeamMember(props.team.id, member)) : false }
async function revokeInvitation(invitation: TeamInvitation): Promise<void> { await action(() => revokeTeamInvitation(invitation)) }
async function leaveOrDissolve(): Promise<void> {
  if (!confirm(t(isCreator.value ? 'team.dissolve_confirm' : 'team.leave_confirm'))) return
  const ownMembership = props.members.find(member => member.user_id === props.currentUserId)
  const ok = await action(() => isCreator.value ? dissolveTeam(props.team) : leaveTeam(props.team, ownMembership?.revision ?? 1), false)
  if (ok) emit('removed')
}
</script>

<style scoped>
.panel-toolbar, .team-boundary { display: flex; align-items: center; justify-content: space-between; gap: 14px; color: var(--fg-secondary); font-size: 11px; }.panel-toolbar > div { display: flex; gap: 8px; }.inline-form { display: flex; gap: 8px; margin-top: 14px; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }.inline-form input { min-width: 0; flex: 1; padding: 9px 10px; border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--fg); background: var(--bg); }.agent-add { margin-top: 14px; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }.agent-add > div:last-child { display: flex; justify-content: flex-end; margin-top: 10px; }
.section-title { margin: 25px 0 10px; color: var(--fg-secondary); font-size: 11px; font-weight: 600; }.row-card { padding: 0 16px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }.member-row { min-height: 68px; display: flex; align-items: center; gap: 11px; border-bottom: 1px solid var(--border); }.member-row:last-child { border-bottom: 0; }.member-row > div { min-width: 0; display: grid; gap: 4px; flex: 1; }.member-row strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; }.member-row small { color: var(--fg-tertiary); font-size: 10px; }.avatar { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 50%; color: var(--accent); background: var(--accent-muted); font-size: 12px; font-weight: 700; }.role, .availability { padding: 4px 7px; border-radius: 999px; color: var(--fg-secondary); background: var(--surface-hover); font-size: 10px; }.availability.online { color: var(--success); background: color-mix(in srgb, var(--success) 12%, transparent); }.availability.offline, .availability.occupied { color: var(--warning); }.quiet-action, .danger-action { padding: 7px 9px; border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--fg-secondary); background: transparent; font-size: 10px; cursor: pointer; }.danger-action { color: var(--error); }
.offer-grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 12px; }.offer-card { padding: 15px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }.offer-card > div { display: flex; align-items: center; gap: 10px; }.offer-card > div > div { min-width: 0; display: grid; gap: 3px; flex: 1; }.offer-card strong { font-size: 12px; }.offer-card small { overflow: hidden; color: var(--fg-tertiary); font: 10px var(--font-mono); text-overflow: ellipsis; }.offer-card p { min-height: 32px; color: var(--fg-secondary); font-size: 10px; line-height: 1.6; }.provider-mark { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 8px; color: var(--accent); background: var(--accent-muted); font: 700 9px var(--font-mono); }.compact-empty { padding: 18px 0; color: var(--fg-tertiary); font-size: 11px; }.team-boundary { margin-top: 25px; padding-top: 18px; border-top: 1px solid var(--border); }.team-boundary span { max-width: 520px; line-height: 1.6; }.panel-error { color: var(--error); font-size: 11px; }
@media (max-width: 700px) { .panel-toolbar { align-items: stretch; flex-direction: column; }.panel-toolbar > div { display: grid; grid-template-columns: 1fr 1fr; }.offer-grid { grid-template-columns: 1fr; }.inline-form { flex-direction: column; }.team-boundary { align-items: flex-start; flex-direction: column; } }

.panel-toolbar { font-size:14px; }.section-title { margin:24px 0 12px; color:var(--fg-secondary); font-size:12px; font-weight:500; }.row-card { padding:20px; border-radius:9px; }.member-row { min-height:0; padding:16px 0; gap:12px; }.member-row strong { font-size:13px; font-weight:550; }.member-row small { margin-top:6px; font-size:11px; line-height:1.65; }.avatar { width:27px; height:27px; border-radius:50%; font-size:11px; border:1px solid var(--border-light); }.role { padding:3px 7px; border-radius:5px; font-size:10px; background:var(--surface-active); }
.offer-grid { gap:16px; }.offer-card { padding:20px; border-radius:9px; }.offer-card strong { font-size:14px; font-weight:550; }.offer-card p { font-size:12px; line-height:1.8; margin:8px 0 15px; }.provider-mark { width:27px; height:27px; border-radius:7px; color:var(--fg); background:var(--surface-active); border:1px solid var(--border-light); font-size:11px; }.availability { padding:3px 7px; border-radius:5px; font-size:10px; }.team-boundary { margin-top:24px; font-size:11px; }
.agent-add,.inline-form { margin:0; padding:0; border:0; background:none; }.invite-note { color:var(--fg-secondary); font-size:12px; line-height:1.8; margin:0 0 18px; }.inline-form { margin-bottom:16px; }
.team-member-preview{display:flex;align-items:center;gap:10px;padding:8px 2px 14px;color:var(--fg);font-size:12px}.team-member-preview p{margin:4px 0 0;color:var(--fg-secondary);font-size:11px}.team-member-agent{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 2px;color:var(--fg-secondary);font-size:12px}.notice{padding:12px 15px;border:1px solid var(--border);border-radius:8px;color:var(--fg-secondary);font-size:12px;line-height:1.7;background:var(--surface-hover)}
</style>
