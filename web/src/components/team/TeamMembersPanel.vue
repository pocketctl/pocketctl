<template>
  <section class="members-panel" data-testid="team-members-panel">
    <div class="panel-toolbar">
      <span>{{ t('team.people_agents_copy') }}</span>
      <div v-if="writesEnabled"><button v-if="isCreator" type="button" class="btn btn-secondary" @click="showInvite = !showInvite">{{ t('team.invite_member') }}</button><button type="button" class="btn btn-primary" @click="showAgents = !showAgents">+ {{ t('team.add_my_agents') }}</button></div>
    </div>
    <form v-if="showInvite" class="inline-form" @submit.prevent="invite"><input v-model.trim="inviteEmail" type="email" required :placeholder="t('team.member_email')" /><button class="btn btn-primary" :disabled="busy">{{ t('team.create_invitation') }}</button></form>
    <div v-if="showAgents" class="agent-add"><TeamAgentPicker v-model="selectedAgentKeys" :candidates="candidates" :disabled="busy" /><div><button type="button" class="btn btn-primary" :disabled="busy || !selectedAgentKeys.length" @click="addAgents">{{ t('team.add_selected_agents') }}</button></div></div>

    <h3 class="section-title">{{ t('team.members') }} · {{ members.length }}</h3>
    <div class="row-card">
      <div v-for="member in members" :key="member.id" class="member-row">
        <span class="avatar">{{ member.display_label.charAt(0).toUpperCase() }}</span>
        <div><strong>{{ member.display_label }}</strong><small>{{ member.user_id === currentUserId ? t('team.me') : t('team.active_member') }}</small></div>
        <span class="role">{{ member.user_id === team.creator_user_id ? t('team.creator') : t('team.member') }}</span>
        <button v-if="isCreator && member.user_id !== team.creator_user_id && writesEnabled" type="button" class="quiet-action" @click="removeMember(member)">{{ t('team.remove') }}</button>
      </div>
    </div>

    <h3 class="section-title">Agent · {{ activeOffers.length }}</h3>
    <div v-if="activeOffers.length" class="offer-grid">
      <article v-for="offer in activeOffers" :key="offer.id" class="offer-card">
        <div><span class="provider-mark">{{ offer.provider === 'codex' ? 'C' : 'CC' }}</span><div><strong>{{ offer.provider === 'codex' ? 'Codex' : 'Claude Code' }}</strong><small>{{ offer.daemon_id }}</small></div><span class="availability" :class="offer.availability">{{ t(`team.availability.${offer.availability}`) }}</span></div>
        <p>{{ offer.managed_callable ? t('team.agent_callable') : t('team.offer_unavailable_copy') }}</p>
        <button v-if="offer.owner_user_id === currentUserId && writesEnabled" type="button" class="quiet-action" @click="removeOffer(offer)">{{ t('team.remove_from_team') }}</button>
      </article>
    </div>
    <div v-else class="compact-empty">{{ t('team.offers_empty') }}</div>

    <template v-if="isCreator">
      <h3 class="section-title">{{ t('team.invitations') }}</h3>
      <div class="row-card">
        <div v-for="invitation in invitations" :key="invitation.id" class="member-row"><div><strong>{{ invitation.recipient_email }}</strong><small>{{ t(`team.invitation_state.${invitation.state}`) }}</small></div><button v-if="invitation.state === 'pending' && writesEnabled" type="button" class="quiet-action" @click="revokeInvitation(invitation)">{{ t('team.revoke') }}</button></div>
        <div v-if="!invitations.length" class="compact-empty">{{ t('team.invitations_empty') }}</div>
      </div>
    </template>
    <div class="team-boundary"><span>{{ t('team.agent_owner_boundary') }}</span><button v-if="writesEnabled" type="button" class="danger-action" @click="leaveOrDissolve">{{ isCreator ? t('team.dissolve') : t('team.leave') }}</button></div>
    <p v-if="error" class="panel-error" role="status">{{ error }}</p>
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
const isCreator = computed(() => props.team.creator_user_id === props.currentUserId)
const activeOffers = computed(() => props.offers.filter(offer => offer.state === 'active'))
const key = (candidate: Pick<TeamAgentCandidate, 'daemon_id' | 'provider'>) => `${candidate.daemon_id}:${candidate.provider}`
function failureMessage(failure: unknown): string { return failure instanceof Error ? failure.message : t('common.error') }
async function action(run: () => Promise<unknown>, refresh = true): Promise<boolean> { busy.value = true; error.value = ''; try { await run(); if (refresh) emit('refresh'); return true } catch (failure) { error.value = failureMessage(failure); return false } finally { busy.value = false } }
async function invite(): Promise<void> { if (await action(() => inviteTeamMember(props.team.id, inviteEmail.value, props.team.revision))) { inviteEmail.value = ''; showInvite.value = false } }
async function addAgents(): Promise<void> {
  let revision = props.team.revision
  const agents = props.candidates.filter(candidate => selectedAgentKeys.value.includes(key(candidate)))
  const ok = await action(async () => { for (const candidate of agents) { await addTeamAgentOffer(props.team.id, candidate, revision); revision++ } })
  if (ok) { selectedAgentKeys.value = []; showAgents.value = false }
}
async function removeMember(member: TeamMember): Promise<void> { if (confirm(t('team.remove_member_confirm'))) await action(() => removeTeamMember(props.team.id, member)) }
async function removeOffer(offer: TeamAgentOffer): Promise<void> { await action(() => revokeTeamAgentOffer(offer)) }
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
</style>
