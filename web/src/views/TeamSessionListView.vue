<template>
  <main class="team-session-list-view" data-testid="team-session-list-view">
    <header class="page-header">
      <div><span>SESSION SCOPE</span><h1>共享会话</h1><p>团队记录独立于个人原生会话；筛选与数量来自当前团队合同。</p></div>
      <button v-if="callableOffers.length" type="button" class="primary" @click="createOpen = !createOpen">+ 新建共享会话</button>
    </header>
    <SessionScopeSwitcher :model-value="scope" :teams="teams" @update:model-value="changeScope" />
    <section class="toolbar">
      <select v-model="daemonID" aria-label="按主机筛选"><option value="">全部主机</option><option v-for="daemon in daemonOptions" :key="daemon" :value="daemon">{{ daemon }}</option></select>
      <select v-model="provider" aria-label="按 Agent 筛选"><option value="">全部 Agent</option><option value="codex">Codex</option><option value="claude-code">Claude Code</option></select>
      <span>{{ sessions.length }} / {{ totalCount }} 个会话</span>
    </section>
    <form v-if="createOpen" class="create-card" @submit.prevent="create">
      <input v-model.trim="title" maxlength="240" required placeholder="共享会话标题" data-testid="team-session-title" />
      <div class="offer-options">
        <label v-for="offer in offers" :key="offer.id" :class="{ unavailable: !offer.managed_callable }">
          <input v-model="selectedOfferIDs" type="checkbox" :value="offer.id" :disabled="!offer.managed_callable" />
          <span>{{ offer.provider === 'codex' ? 'Codex' : 'Claude Code' }} · {{ offer.daemon_id }}</span><small>{{ offer.availability }}</small>
        </label>
      </div>
      <div class="form-actions"><button type="button" @click="createOpen = false">取消</button><button class="primary" :disabled="creating || !title || !selectedOfferIDs.length">{{ creating ? '创建中…' : '开始协作' }}</button></div>
    </form>
    <p v-if="error" class="error">{{ error }}</p>
    <section v-if="loading" class="empty">正在加载共享会话…</section>
    <section v-else-if="sessions.length" class="session-list">
      <RouterLink v-for="session in sessions" :key="session.id" :to="sessionLink(session.id)" class="session-row">
        <span :class="['state-dot', session.state]"></span>
        <div><strong>{{ session.title }}</strong><small>{{ session.participants.length }} 人 · {{ session.agent_bindings.length }} Agents · Context v{{ session.current_context_version }}</small></div>
        <time>{{ formatTime(session.updated_at) }}</time><span class="chevron">›</span>
      </RouterLink>
    </section>
    <section v-else class="empty"><strong>没有匹配的共享会话</strong><span v-if="!callableOffers.length">团队中暂无可调用 Agent，不能发起真实协作。</span><span v-else>调整筛选，或新建一个共享会话。</span></section>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import SessionScopeSwitcher from '../components/session/SessionScopeSwitcher.vue'
import { createTeamSession, listTeamAgentOffers, listTeamSessions, listTeams } from '../services/teamClient'
import type { SessionScope } from '../composables/useScopedSessionState'
import type { TeamAgentOffer, TeamProvider, TeamSessionSummary, TeamSummary } from '../types/team'

const route = useRoute(), router = useRouter()
const teams = ref<TeamSummary[]>([]), offers = ref<TeamAgentOffer[]>([]), sessions = ref<TeamSessionSummary[]>([])
const totalCount = ref(0), daemonID = ref(''), provider = ref<'' | TeamProvider>(''), loading = ref(true), error = ref('')
const createOpen = ref(false), creating = ref(false), title = ref(''), selectedOfferIDs = ref<string[]>([])
const teamID = computed(() => String(route.params.teamId ?? ''))
const scope = computed<SessionScope>(() => ({ type: 'team', teamId: teamID.value }))
const callableOffers = computed(() => offers.value.filter(offer => offer.managed_callable))
const daemonOptions = computed(() => [...new Set(offers.value.map(offer => offer.daemon_id))])
let generation = 0

function failureMessage(failure: unknown): string { return failure instanceof Error ? failure.message : '请求失败' }
function formatTime(value: string): string { return new Date(value).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
function sessionLink(sessionID: string) { return { name: 'team-session', params: { teamId: teamID.value, id: sessionID }, query: { ...(daemonID.value ? { daemon: daemonID.value } : {}), ...(provider.value ? { provider: provider.value } : {}) } } }
function changeScope(next: SessionScope): void {
  if (next.type === 'personal') void router.push('/sessions')
  else void router.push({ name: 'team-sessions', params: { teamId: next.teamId } })
}
async function load(): Promise<void> {
  const current = ++generation; loading.value = true; error.value = ''
  try {
    const [nextTeams, nextOffers, allSessions, filteredSessions] = await Promise.all([
      listTeams(), listTeamAgentOffers(teamID.value), listTeamSessions(teamID.value),
      listTeamSessions(teamID.value, { daemonID: daemonID.value || undefined, provider: provider.value || undefined }),
    ])
    if (current !== generation) return
    teams.value = nextTeams; offers.value = nextOffers; totalCount.value = allSessions.length; sessions.value = filteredSessions
  } catch (failure) { if (current === generation) error.value = failureMessage(failure) }
  finally { if (current === generation) loading.value = false }
}
async function create(): Promise<void> {
  if (!title.value || !selectedOfferIDs.value.length) return
  creating.value = true; error.value = ''
  try {
    const session = await createTeamSession(teamID.value, { title: title.value, offerIDs: selectedOfferIDs.value })
    title.value = ''; selectedOfferIDs.value = []; createOpen.value = false
    await router.push({ name: 'team-session', params: { teamId: teamID.value, id: session.id } })
  } catch (failure) { error.value = failureMessage(failure) } finally { creating.value = false }
}
watch(teamID, () => { void load() })
watch([daemonID, provider], () => {
  void router.replace({ name: 'team-sessions', params: { teamId: teamID.value }, query: { ...(daemonID.value ? { daemon: daemonID.value } : {}), ...(provider.value ? { provider: provider.value } : {}) } })
  void load()
})
onMounted(() => { daemonID.value = typeof route.query.daemon === 'string' ? route.query.daemon : ''; provider.value = route.query.provider === 'codex' || route.query.provider === 'claude-code' ? route.query.provider : ''; void load() })
</script>

<style scoped>
.team-session-list-view { width: min(1050px, calc(100% - 48px)); min-height: calc(100dvh - 90px); margin: 0 auto; padding: 34px 0 50px; color: var(--fg); }.page-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; margin-bottom: 18px; }.page-header span { color: var(--accent); font: 700 9px var(--font-mono); letter-spacing: .14em; }.page-header h1 { margin: 7px 0 5px; font-size: 26px; }.page-header p { margin: 0; color: var(--fg-secondary); font-size: 11px; }.primary,.form-actions button,.page-header button { padding: 9px 13px; border: 1px solid var(--border); border-radius: 8px; color: var(--fg); background: var(--surface); cursor: pointer; }.primary { border-color: var(--accent); color: #fff; background: var(--accent); }.toolbar { display: flex; align-items: center; gap: 8px; margin: 16px 0; }.toolbar select,.create-card input { padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; color: var(--fg); background: var(--surface); font-size: 11px; }.toolbar span { margin-left: auto; color: var(--fg-tertiary); font: 10px var(--font-mono); }.create-card { margin-bottom: 16px; padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }.create-card > input { width: 100%; box-sizing: border-box; }.offer-options { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 7px; margin: 12px 0; }.offer-options label { display: flex; align-items: center; gap: 7px; padding: 9px; border: 1px solid var(--border); border-radius: 8px; font-size: 10px; }.offer-options label span { flex: 1; }.offer-options small { color: var(--fg-tertiary); }.offer-options .unavailable { opacity: .55; }.form-actions { display: flex; justify-content: flex-end; gap: 7px; }.session-list { border: 1px solid var(--border); border-radius: 12px; background: var(--surface); overflow: hidden; }.session-row { min-height: 72px; display: flex; align-items: center; gap: 12px; padding: 0 16px; border-bottom: 1px solid var(--border); color: inherit; text-decoration: none; }.session-row:last-child { border-bottom: 0; }.session-row:hover { background: var(--surface-hover); }.session-row > div { min-width: 0; display: grid; gap: 5px; flex: 1; }.session-row strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; }.session-row small,.session-row time { color: var(--fg-tertiary); font-size: 10px; }.state-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg-tertiary); }.state-dot.active { background: var(--success); }.state-dot.paused { background: var(--warning); }.chevron { color: var(--fg-tertiary); font-size: 20px; }.empty { min-height: 300px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--fg-tertiary); font-size: 11px; }.empty strong { color: var(--fg-secondary); font-size: 14px; }.error { color: var(--error); font-size: 11px; }
@media(max-width:700px){.team-session-list-view{width:100%;padding:20px 14px 80px;box-sizing:border-box}.page-header{align-items:flex-start;flex-direction:column}.offer-options{grid-template-columns:1fr}.toolbar{flex-wrap:wrap}.toolbar span{width:100%;margin-left:0}.session-row time{display:none}}
</style>
