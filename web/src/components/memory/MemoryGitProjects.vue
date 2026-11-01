<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import ActionSelect from '../ActionSelect.vue'
import MemoryGitProjectSetup from './MemoryGitProjectSetup.vue'
import { useAuth } from '../../composables/useAuth'
import { useLocale } from '../../composables/useLocale'
import { getRelayOrigin } from '../../composables/useEnv'
import { createClientId } from '../../utils/clientId'
import { memoryGitProjects, type GitOpsProject, type GitOpsProjectTeam } from '../../services/memoryGitProjects'

const { t } = useLocale(), { user } = useAuth()
const emit=defineEmits<{changed:[]}>()
const teams = ref<GitOpsProjectTeam[]>([]), projects = ref<GitOpsProject[]>([])
const loading = ref(false), busy = ref(false), open = ref(false), unknown = ref(false), error = ref(''), success = ref(false)
const teamId = ref(''), name = ref(''), repositoryUrl = ref(''), branch = ref('main'), requestId = ref('')
const nameField = ref<HTMLInputElement>()
const writableTeams = computed(() => teams.value.filter(team => team.can_create))
const canCreate = computed(() => writableTeams.value.some(team => team.id === teamId.value))
let epoch = 0, loadSerial = 0
const identity = (generation: number) => ({ userId: user.value?.id ?? 0, origin: getRelayOrigin(), isCurrent: () => epoch === generation })
function message(reason: unknown): string {
  const code = (reason as { code?: string })?.code
  const keys: Record<string, string> = { invalid_request: 'invalid', creator_required: 'admin_only', team_access_denied: 'access_lost', project_exists: 'exists', idempotency_conflict: 'changed_request', team_feature_disabled: 'unavailable' }
  return t(`memory.git_project.${keys[code ?? ''] ?? 'failed'}`)
}
async function load() {
  const generation = epoch, serial = ++loadSerial
  loading.value = true; error.value = ''
  try {
    const result = await memoryGitProjects.list(identity(generation))
    if (epoch !== generation || serial !== loadSerial) return
    teams.value = result.teams; projects.value = result.projects
    if (!writableTeams.value.some(team => team.id === teamId.value) && !unknown.value) teamId.value = writableTeams.value[0]?.id ?? ''
    if (unknown.value && result.projects.some(project => project.request_id === requestId.value)) {
      unknown.value = false; open.value = false; success.value = true
      name.value = ''; repositoryUrl.value = ''; branch.value = 'main'; requestId.value = ''
    }
  } catch (reason) {
    if (epoch !== generation || serial !== loadSerial) return
    error.value = message(reason)
    if ([401, 403].includes((reason as { status?: number })?.status ?? 0)) { teams.value = []; projects.value = []; open.value = false }
  } finally { if (epoch === generation && serial === loadSerial) loading.value = false }
}
async function showForm() {
  open.value = true; success.value = false
  if (!requestId.value) requestId.value = `git-project-${createClientId()}`
  await nextTick(); nameField.value?.focus()
}
async function setupChanged(){success.value=false;await load();emit('changed')}
async function submit() {
  if (busy.value || !canCreate.value || !name.value.trim() || !repositoryUrl.value.trim() || !branch.value.trim()) return
  const generation = epoch
  loadSerial++; loading.value = false
  busy.value = true; error.value = ''; success.value = false
  try {
    const { project } = await memoryGitProjects.create(teamId.value, { name: name.value.trim(), repository_url: repositoryUrl.value.trim(), branch: branch.value.trim(), request_id: requestId.value }, identity(generation))
    if (epoch !== generation) return
    projects.value = [project, ...projects.value.filter(row => row.id !== project.id)]
    unknown.value = false; open.value = false; success.value = true
    name.value = ''; repositoryUrl.value = ''; branch.value = 'main'; requestId.value = ''
  } catch (reason) {
    if (epoch !== generation) return
    const status = (reason as { status?: number })?.status ?? 0
    unknown.value = status === 0 || status >= 500 && (reason as { code?: string })?.code !== 'team_feature_disabled'
    error.value = message(reason)
    if ([401, 403].includes(status)) { teams.value = []; projects.value = []; open.value = false; unknown.value = false }
  } finally { if (epoch === generation) busy.value = false }
}
watch(() => [user.value?.id, getRelayOrigin()], () => {
  epoch++; loadSerial++; teams.value = []; projects.value = []; open.value = false; unknown.value = false
  busy.value = false; success.value = false; requestId.value = ''; name.value = ''; repositoryUrl.value = ''; branch.value = 'main'; teamId.value = ''
  void load()
}, { immediate: true })
onBeforeUnmount(() => { epoch++; loadSerial++ })
</script>

<template>
  <section class="git-projects" :aria-label="t('memory.git_project.title')" data-testid="git-projects">
    <header class="git-projects-head">
      <div><h3>{{ t('memory.git_project.title') }}</h3><p>{{ t('memory.git_project.copy') }}</p></div>
      <div class="git-projects-actions">
        <button class="memory-button" :disabled="loading || busy" @click="load">{{ t('memory.git.refresh') }}</button>
        <button class="memory-button is-primary" data-testid="git-project-create" :disabled="loading || busy || !writableTeams.length" @click="showForm">{{ t(unknown ? 'memory.git_project.check_result' : 'memory.git_project.new') }}</button>
      </div>
    </header>
    <p v-if="error" class="memory-notice is-error" role="alert">{{ error }}</p>
    <p v-if="success" class="memory-notice" role="status" data-testid="git-project-created">{{ t('memory.git_project.created') }}</p>
    <p v-if="unknown" class="memory-notice" role="status">{{ t('memory.git_project.unknown') }}</p>
    <p v-if="loading && !projects.length" role="status">{{ t('memory.git.loading') }}</p>
    <template v-else-if="!error && !teams.length"><p>{{ t('memory.git_project.no_team') }}</p><RouterLink class="memory-button" to="/teams">{{ t('memory.git_project.manage_teams') }}</RouterLink></template>
    <p v-else-if="!loading && teams.length && !writableTeams.length">{{ t('memory.git_project.admin_only') }}</p>
    <form v-if="open" class="git-project-form" data-testid="git-project-form" @submit.prevent="submit" @keydown.esc.stop="!busy && (open = false)">
      <h4>{{ t('memory.git_project.new') }}</h4>
      <fieldset :disabled="busy || unknown">
        <label>{{ t('memory.git_project.team') }}<ActionSelect><select v-model="teamId" required data-testid="git-project-team"><option v-for="team in writableTeams" :key="team.id" :value="team.id">{{ team.name }}</option></select></ActionSelect></label>
        <label>{{ t('memory.git_project.name') }}<input ref="nameField" v-model="name" maxlength="120" required data-testid="git-project-name" /></label>
        <label class="git-project-wide">{{ t('memory.git_project.url') }}<input v-model="repositoryUrl" maxlength="2048" required placeholder="https://github.com/owner/repository" autocomplete="off" autocapitalize="none" spellcheck="false" data-testid="git-project-url" /></label>
        <label>{{ t('memory.git_project.branch') }}<input v-model="branch" maxlength="200" required autocapitalize="none" spellcheck="false" data-testid="git-project-branch" /></label>
      </fieldset>
      <p>{{ t('memory.git_project.boundary') }}</p>
      <div class="git-projects-actions"><button type="button" class="memory-button" :disabled="busy" @click="open = false">{{ t('common.cancel') }}</button><button type="submit" class="memory-button is-primary" :disabled="busy || !canCreate" data-testid="git-project-save">{{ t(busy ? 'memory.git_project.saving' : unknown ? 'memory.git_project.retry_original' : 'memory.git_project.new') }}</button></div>
    </form>
    <p v-if="!loading && !projects.length && teams.length && !open">{{ t('memory.git_project.empty') }}</p>
    <article v-for="project in projects" :key="project.id" class="git-project-card" data-testid="git-project-card">
      <div class="git-projects-head"><div><h4>{{ project.name }}</h4><p>{{ project.team_name }} · {{ project.provider === 'github' ? 'GitHub' : 'Gitee' }}</p></div><span v-if="project.memory_status!=='active'" class="git-project-status">{{ t(project.memory_status==='pending'?'memory.git_setup.initializing':project.memory_installation_id?'memory.git_setup.memory_unavailable':`memory.git_project.${project.setup}`) }}</span></div>
      <p class="git-project-url">{{ project.repository_url }}</p><p>{{ t('memory.git_project.branch') }}：{{ project.branch }}</p>
      <details><summary>{{ t('memory.git_project.next_steps') }}</summary><ol><li>{{ t('memory.git_project.step_memory') }}</li><li>{{ t('memory.git_project.step_authorization') }}</li><li>{{ t('memory.git_project.step_sync') }}</li></ol></details>
      <MemoryGitProjectSetup :project="project" @changed="setupChanged" />
    </article>
  </section>
</template>

<style scoped>
.git-projects { margin-bottom: 24px; }
.git-projects-head { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap; }
.git-projects h3,.git-projects h4 { margin:0 0 6px; }
.git-projects p { color:var(--fg-secondary); font-size:13px; line-height:1.7; margin:6px 0 12px; }
.git-projects-actions { display:flex; gap:8px; flex-wrap:wrap; }
.git-project-form,.git-project-card { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:20px; margin:16px 0; }
.git-project-form fieldset { border:0; padding:0; margin:16px 0; display:grid; grid-template-columns:1fr 1fr; gap:16px; min-width:0; }
.git-project-form label { display:grid; gap:7px; min-width:0; font-size:13px; }
.git-project-form input { width:100%; min-width:0; padding:10px 12px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--fg); font:inherit; box-sizing:border-box; }
.git-project-wide { grid-column:1/-1; }
.git-project-status { padding:5px 9px; border-radius:6px; color:var(--fg-secondary); background:var(--surface-hover); font-size:12px; }
.git-project-url { overflow-wrap:anywhere; }
.git-project-card summary { cursor:pointer; font-size:13px; }
.git-project-card ol { padding-left:20px; font-size:13px; line-height:1.9; color:var(--fg-secondary); }
@media(max-width:640px) { .git-project-form fieldset { grid-template-columns:1fr; } .git-project-form,.git-project-card { padding:16px; } }
</style>
