<template>
  <div class="teams-view" data-testid="teams-view">
    <header class="page-head">
      <div><p class="overline">{{ t('team.overline') }}</p><h1>{{ t('team.title') }}</h1><p>{{ t('team.subtitle') }}</p></div>
      <button v-if="capabilities?.writes_enabled" type="button" class="btn btn-primary" data-testid="team-create-open" @click="openCreate">+ {{ t('team.create') }}</button>
    </header>

    <div v-if="capabilities && !capabilities.collaboration" class="capability-banner" data-testid="team-disabled">{{ t('team.disabled_copy') }}</div>
    <div v-if="warning" class="capability-banner warning" role="status">{{ warning }}</div>
    <div v-if="loading" class="workspace-empty">{{ t('common.loading') }}</div>
    <div v-else-if="error && !teams.length" class="workspace-empty"><strong>{{ t('team.load_failed') }}</strong><span>{{ error }}</span><button type="button" class="btn btn-secondary" @click="loadTeams">{{ t('team.retry') }}</button></div>
    <template v-else>
      <div v-if="teams.length" class="team-switcher" role="list" :aria-label="t('team.switcher')">
        <button v-for="team in teams" :key="team.id" type="button" :class="{ active: team.id === selectedTeamID }" :data-team-id="team.id" @click="selectTeam(team.id)">{{ team.name }}</button>
      </div>

      <div v-if="selectedTeam" class="team-workspace">
        <section class="team-overview">
          <div><h2>{{ selectedTeam.name }}</h2><p>{{ t('team.workspace_copy') }}</p></div>
          <div class="summary-badges"><span>{{ members.length || selectedTeam.member_count }} {{ t('team.people_unit') }}</span><span>{{ activeOffers.length }} Agents</span><span class="online">{{ onlineOfferCount }} {{ t('team.online') }}</span></div>
        </section>
        <div class="team-tabs" role="tablist" :aria-label="t('team.workspace_tabs')">
          <button v-for="tab in tabs" :id="`team-tab-${tab}`" :key="tab" type="button" role="tab" :aria-selected="activeTab === tab" :class="{ active: activeTab === tab }" :data-testid="`team-tab-${tab}`" @click="setTab(tab)">{{ t(`team.tab.${tab}`) }}</button>
        </div>

        <div v-if="workspaceLoading" class="workspace-empty compact">{{ t('common.loading') }}</div>
        <TeamTasksPanel v-else-if="activeTab === 'tasks'" :key="selectedTeam.id" :team-id="selectedTeam.id" :team-creator-id="selectedTeam.creator_user_id" :current-user-id="currentUserID" :writes-enabled="capabilities?.writes_enabled === true" />
        <section v-else-if="activeTab === 'sessions'" class="sessions-panel" data-testid="team-sessions-panel">
          <div class="panel-intro"><span>{{ t('team.sessions_copy') }}</span><div><small>{{ t('team.sessions_management_boundary') }}</small><RouterLink :to="{ name: 'team-sessions', params: { teamId: selectedTeam.id } }">打开共享会话</RouterLink></div></div>
          <div v-if="sessions.length" class="session-list">
            <RouterLink v-for="session in sessions" :key="session.id" :to="{ name: 'team-session', params: { teamId: selectedTeam.id, id: session.id } }" class="team-session-link"><div><strong>{{ session.title }}</strong><span>{{ t(`team.session_state.${session.state}`) }} · {{ session.participants.length }} {{ t('team.people_unit') }} · {{ session.agent_bindings.length }} Agents</span></div><small>Context v{{ session.current_context_version }} · #{{ session.latest_event_seq }}</small></RouterLink>
          </div>
          <div v-else class="workspace-empty compact"><strong>{{ t('team.sessions_empty') }}</strong><span>{{ t('team.sessions_empty_copy') }}</span></div>
        </section>
        <TeamMembersPanel
          v-else
          :team="selectedTeam"
          :members="members"
          :offers="offers"
          :invitations="invitations"
          :candidates="candidates"
          :current-user-id="currentUserID"
          :writes-enabled="capabilities?.writes_enabled === true"
          @refresh="loadWorkspace"
          @removed="handleTeamRemoved"
        />
        <p v-if="error" class="workspace-error" role="status">{{ error }}</p>
      </div>

      <div v-else class="workspace-empty large" data-testid="teams-empty">
        <span class="empty-mark">T</span><strong>{{ t('team.empty_title') }}</strong><p>{{ t('team.empty_copy') }}</p><button v-if="capabilities?.writes_enabled" type="button" class="btn btn-primary" @click="openCreate">{{ t('team.create') }}</button>
      </div>
    </template>

    <TeamCreateDialog :open="createOpen" :candidates="createCandidates" :candidates-loading="createCandidatesLoading" :busy="creating" :error="createError" @close="createOpen = false" @submit="submitCreate" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TeamCreateDialog from '../components/team/TeamCreateDialog.vue'
import TeamMembersPanel from '../components/team/TeamMembersPanel.vue'
import TeamTasksPanel from '../components/team/TeamTasksPanel.vue'
import { useAuth } from '../composables/useAuth'
import { useLocale } from '../composables/useLocale'
import {
  createTeamWorkspace,
  getTeam,
  getTeamCapabilities,
  listMyTeamAgentCandidates,
  listTeamAgentCandidates,
  listTeamAgentOffers,
  listTeamInvitations,
  listTeamMembers,
  listTeams,
  listTeamSessions,
} from '../services/teamClient'
import type { TeamAgentCandidate, TeamAgentOffer, TeamCapabilities, TeamInvitation, TeamMember, TeamSessionSummary, TeamSummary } from '../types/team'

const tabs = ['tasks', 'sessions', 'members'] as const
type TeamTab = typeof tabs[number]
const route = useRoute(), router = useRouter(), { user } = useAuth(), { t } = useLocale()
const capabilities = ref<TeamCapabilities | null>(null), teams = ref<TeamSummary[]>([]), selectedTeamID = ref(''), activeTab = ref<TeamTab>('tasks')
const members = ref<TeamMember[]>([]), offers = ref<TeamAgentOffer[]>([]), invitations = ref<TeamInvitation[]>([]), candidates = ref<TeamAgentCandidate[]>([]), sessions = ref<TeamSessionSummary[]>([])
const loading = ref(true), workspaceLoading = ref(false), error = ref(''), warning = ref(''), createOpen = ref(false), creating = ref(false), createError = ref(''), createCandidates = ref<TeamAgentCandidate[]>([]), createCandidatesLoading = ref(false)
let workspaceGeneration = 0
const currentUserID = computed(() => user.value?.id ?? 0)
const selectedTeam = computed(() => teams.value.find(team => team.id === selectedTeamID.value) ?? null)
const activeOffers = computed(() => offers.value.filter(offer => offer.state === 'active'))
const onlineOfferCount = computed(() => activeOffers.value.filter(offer => offer.managed_callable).length)
function message(failure: unknown): string { return failure instanceof Error ? failure.message : t('common.error') }

async function loadTeams(): Promise<void> {
  loading.value = true; error.value = ''
  try {
    const [nextCapabilities, nextTeams] = await Promise.all([getTeamCapabilities(), listTeams()])
    capabilities.value = nextCapabilities; teams.value = nextTeams
    const queryTeam = typeof route.query.team === 'string' ? route.query.team : ''
    const nextID = nextTeams.some(team => team.id === queryTeam) ? queryTeam : nextTeams[0]?.id ?? ''
    selectedTeamID.value = nextID
  } catch (failure) { error.value = message(failure) }
  finally { loading.value = false }
}

async function loadWorkspace(): Promise<void> {
  const teamID = selectedTeamID.value
  const generation = ++workspaceGeneration
  members.value = []; offers.value = []; invitations.value = []; candidates.value = []; sessions.value = []
  if (!teamID) return
  workspaceLoading.value = true; error.value = ''
  try {
    const [team, nextMembers, nextOffers, nextInvitations, nextCandidates, nextSessions] = await Promise.all([
      getTeam(teamID), listTeamMembers(teamID), listTeamAgentOffers(teamID), listTeamInvitations(teamID), listTeamAgentCandidates(teamID), listTeamSessions(teamID),
    ])
    if (generation !== workspaceGeneration || selectedTeamID.value !== teamID) return
    teams.value = teams.value.map(current => current.id === team.id ? team : current)
    members.value = nextMembers; offers.value = nextOffers; invitations.value = nextInvitations; candidates.value = nextCandidates; sessions.value = nextSessions
  } catch (failure) { if (generation === workspaceGeneration) error.value = message(failure) }
  finally { if (generation === workspaceGeneration) workspaceLoading.value = false }
}

function selectTeam(teamID: string): void { selectedTeamID.value = teamID }
function setTab(tab: TeamTab): void { activeTab.value = tab }
async function syncRoute(): Promise<void> {
  const query = { ...route.query, ...(selectedTeamID.value ? { team: selectedTeamID.value } : {}), tab: activeTab.value }
  await router.replace({ path: '/teams', query })
}
async function openCreate(): Promise<void> {
  createOpen.value = true; createError.value = ''; createCandidatesLoading.value = true
  try { createCandidates.value = await listMyTeamAgentCandidates() } catch (failure) { createError.value = message(failure) }
  finally { createCandidatesLoading.value = false }
}
async function submitCreate(input: { name: string; invitationEmails: string[]; agents: TeamAgentCandidate[] }): Promise<void> {
  creating.value = true; createError.value = ''; warning.value = ''
  try {
    const result = await createTeamWorkspace(input)
    teams.value.push(result.team); selectedTeamID.value = result.team.id; activeTab.value = 'members'; createOpen.value = false
    if (result.warnings.length) warning.value = t('team.partial_create', { count: result.warnings.length })
  } catch (failure) { createError.value = message(failure) } finally { creating.value = false }
}
async function handleTeamRemoved(): Promise<void> { selectedTeamID.value = ''; await loadTeams() }

watch([selectedTeamID, activeTab], () => { void syncRoute() })
watch(selectedTeamID, () => { void loadWorkspace() })
onMounted(() => {
  const requestedTab = typeof route.query.tab === 'string' ? route.query.tab : ''
  if (tabs.includes(requestedTab as TeamTab)) activeTab.value = requestedTab as TeamTab
  void loadTeams()
})
</script>

<style scoped>
.teams-view { width: min(1250px, calc(100% - 56px)); min-height: calc(100dvh - 118px); margin: 0 auto; padding: 33px 0 48px; color: var(--fg); }.page-head { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 24px; }.overline { margin: 0 0 8px; color: var(--accent); font: 750 10px var(--font-mono); letter-spacing: .15em; text-transform: uppercase; }.page-head h1 { margin: 0; font-size: 27px; letter-spacing: -.04em; }.page-head > div > p:last-child { margin: 8px 0 0; color: var(--fg-secondary); font-size: 12px; }.capability-banner { margin-bottom: 14px; padding: 11px 13px; border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--fg-secondary); background: var(--surface); font-size: 11px; }.capability-banner.warning { border-color: color-mix(in srgb, var(--warning) 35%, var(--border)); color: var(--warning); }
.team-switcher { display: flex; gap: 7px; overflow-x: auto; padding-bottom: 5px; }.team-switcher button { flex: 0 0 auto; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--fg-secondary); background: var(--surface); font-size: 11px; cursor: pointer; }.team-switcher button.active { border-color: var(--accent-muted); color: var(--accent); background: var(--accent-muted); }.team-overview { min-height: 104px; display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 22px 2px 13px; }.team-overview h2 { margin: 0 0 7px; font-size: 20px; }.team-overview p { margin: 0; color: var(--fg-secondary); font-size: 11px; }.summary-badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 7px; }.summary-badges span { padding: 5px 8px; border-radius: 999px; color: var(--accent); background: var(--accent-muted); font-size: 10px; }.summary-badges .online { color: var(--success); background: color-mix(in srgb, var(--success) 11%, transparent); }
.team-tabs { display: flex; gap: 4px; margin-bottom: 22px; border-bottom: 1px solid var(--border); }.team-tabs button { padding: 11px 13px; border: 0; border-bottom: 2px solid transparent; color: var(--fg-secondary); background: transparent; font-size: 12px; cursor: pointer; }.team-tabs button.active { border-bottom-color: var(--accent); color: var(--fg); }.workspace-empty { min-height: 360px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 9px; color: var(--fg-tertiary); font-size: 11px; text-align: center; }.workspace-empty.compact { min-height: 260px; }.workspace-empty.large { min-height: 500px; }.workspace-empty strong { color: var(--fg-secondary); font-size: 14px; }.workspace-empty p { max-width: 420px; line-height: 1.7; }.empty-mark { width: 52px; height: 52px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 15px; color: var(--accent); background: var(--accent-muted); font-size: 22px; font-weight: 800; }.workspace-error { color: var(--error); font-size: 11px; }
.panel-intro { display: flex; justify-content: space-between; gap: 20px; color: var(--fg-secondary); font-size: 11px; }.panel-intro > div { display: flex; align-items: center; gap: 10px; }.panel-intro small { max-width: 450px; color: var(--fg-tertiary); text-align: right; }.panel-intro a { padding: 6px 8px; border: 1px solid var(--border); border-radius: 7px; color: var(--accent); text-decoration: none; white-space: nowrap; }.session-list { margin-top: 17px; padding: 0 16px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }.team-session-link { min-height: 72px; display: flex; align-items: center; justify-content: space-between; gap: 18px; border-bottom: 1px solid var(--border); color: inherit; text-decoration: none; }.team-session-link:last-child { border-bottom: 0; }.team-session-link > div { min-width: 0; display: grid; gap: 5px; }.team-session-link:hover strong { color: var(--accent); }.session-list strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; }.session-list span, .session-list small { color: var(--fg-tertiary); font-size: 10px; }.session-list small { font-family: var(--font-mono); }
@media (max-width: 760px) { .teams-view { width: 100%; min-height: 100dvh; padding: 20px 14px max(30px, env(safe-area-inset-bottom)); }.page-head { align-items: flex-start; }.page-head h1 { font-size: 24px; }.team-overview { align-items: flex-start; flex-direction: column; }.summary-badges { justify-content: flex-start; }.panel-intro,.panel-intro > div { align-items: flex-start; flex-direction: column; }.panel-intro small { text-align: left; }.team-session-link { align-items: flex-start; flex-direction: column; padding: 15px 0; } }
</style>
