<template>
  <section class="tasks-panel" data-testid="team-tasks-panel">
    <div class="module-intro"><div><h2><button class="task-filter-title" @click="openTaskFilters($event)">{{ activeFilter==='active'?t('replica.team_tasks'):t(`team.task_filter.${activeFilter}`) }}<WorkspaceIcon name="down" class="icon small" /></button></h2><p>{{ t('replica.team_tasks_copy') }}</p></div><button v-if="canWriteTasks" type="button" class="btn primary" data-testid="team-new-task" @click="showCreate=!showCreate"><WorkspaceIcon name="plus" class="icon small" />{{ t('team.new_task') }}</button></div>
    <ActionList v-if="taskFiltersOpen" :anchor="taskFilterAnchor" :title="t('team.task_filters')" @close="taskFiltersOpen=false"><button v-for="filter in filters" :key="filter" class="action-item" :class="{selected:activeFilter===filter}" @click="activeFilter=filter;taskFiltersOpen=false">{{ t(`team.task_filter.${filter}`) }}<WorkspaceIcon v-if="activeFilter===filter" name="check" class="icon small" /></button></ActionList>

    <label v-if="readinessEnabled&&activeFilter==='active'" class="pool-filter">{{ t('team.requirements.pool') }}<ActionSelect><select v-model="poolFilter" :aria-label="t('team.requirements.pool')"><option value="all">{{ t('team.requirements.pool_all') }}</option><option value="unclaimed">{{ t('team.requirements.pool_unclaimed') }}</option><option value="mine">{{ t('team.requirements.pool_mine') }}</option></select></ActionSelect></label>
    <p v-if="navigationCached || !online" role="status">{{ t('team.offline_navigation') }}</p>
    <div v-if="loading" class="panel-empty">{{ t('common.loading') }}</div>
    <div v-else class="kanban task-columns" :class="{'single-column':activeFilter!=='active'}">
      <section v-for="column in taskColumns" :key="column.state" class="kanban-column task-column"><h3 class="row between">{{ t(`team.task_state.${column.state}`) }}<span class="faint">{{ column.tasks.length }}</span></h3>
        <article v-for="task in column.tasks" :key="task.id" class="task-card card" :data-task-id="task.id" role="button" tabindex="0" :aria-label="task.title" @click="selectedTaskID=task.id" @keydown.enter.self="selectedTaskID=task.id" @keydown.space.self.prevent="selectedTaskID=task.id">
          <div class="row between"><span class="badge" :class="task.state==='completed'?'green':task.state==='in_progress'?'blue':''">{{ t(`team.task_state.${task.state}`) }}</span><button type="button" class="icon-btn flat" :aria-label="t('replica.task_details')" @click.stop="selectedTaskID=task.id"><WorkspaceIcon name="more" class="icon small" /></button></div>
          <h3>{{ task.title }}</h3><p>{{ task.background || t('team.no_background') }}</p>
          <div class="task-foot card-foot"><div class="avatars" :aria-label="holderLabels(task)"><span v-for="(holder,index) in task.holder_user_ids.slice(0,4)" :key="holder" class="avatar" :class="index%3===1?'purple':index%3===2?'green':''" :title="memberLabel(holder)">{{ memberLabel(holder).charAt(0).toUpperCase() }}</span><span v-if="task.holder_user_ids.length>4" class="avatar">+{{ task.holder_user_ids.length-4 }}</span><span v-if="!task.holder_user_ids.length" class="faint">{{ t('team.unclaimed') }}</span></div><button type="button" class="text-btn" @click.stop="selectedTaskID=task.id">{{ task.session_ids.length ? t('workspace.sessions_count',{count:task.session_ids.length}) : t('replica.view_task') }}<WorkspaceIcon name="chevron" class="icon small" /></button></div>
        </article>
        <div v-if="!column.tasks.length" class="compact-empty">{{ t('team.tasks_empty') }}</div>
      </section>
    </div>
    <TeamOverlay v-if="showCreate" :title="t('replica.new_team_task')" @close="showCreate = false">
    <form id="team-task-create-form" class="task-create" data-testid="team-task-create" @submit.prevent="createTask">
      <label class="team-form-field"><span>{{ t('replica.task_title') }}</span><input v-model.trim="draftTitle" maxlength="160" required :placeholder="t('team.task_title')" /></label>
      <label class="team-form-field"><span>{{ t('replica.task_description') }}</span><textarea v-model="draftBackground" rows="4" :placeholder="t('team.task_background')" /></label>
      <p v-if="error" class="panel-error" role="alert">{{ error }}</p>
    </form>

    <template #footer><button type="button" class="btn" :disabled="busy" @click="showCreate=false">{{ t('common.cancel') }}</button><button type="submit" form="team-task-create-form" class="btn primary" :disabled="busy || !canWriteTasks">{{ t('team.create_task') }}</button></template></TeamOverlay>
    <TeamOverlay v-if="selectedTask" :title="t('replica.task_details')" @close="selectedTaskID = ''; editingTaskID = ''">
      <template v-for="task in [selectedTask]" :key="task.id">
        <span class="task-state" :class="task.state">{{ t(`team.task_state.${task.state}`) }}</span>
        <h2 class="task-detail-title">{{ task.title }}</h2>
        <form v-if="editingTaskID === task.id" id="team-task-edit-form" class="task-edit" @submit.prevent="saveEdit(task)">
          <label class="team-form-field"><span>{{ t('replica.task_title') }}</span><input v-model.trim="editTitle" maxlength="240" required /></label>
          <label class="team-form-field"><span>{{ t('replica.task_description') }}</span><textarea v-model="editBackground" rows="4" /></label>
        </form>
        <div v-else class="task-description">{{ task.background || t('team.no_background') }}</div>
        <div class="holder-row"><span>{{ t('replica.task_holders') }}</span><span v-for="holder in task.holder_user_ids" :key="holder" class="holder-pill">{{ memberLabel(holder) }}</span><span v-if="!task.holder_user_ids.length">{{ t('team.unclaimed') }}</span></div>
        <div v-if="canWriteTasks && currentUserId === teamCreatorId && !['archived','deleted'].includes(task.state)" class="holder-editor"><label v-for="member in members.filter(member => member.user_id !== currentUserId)" :key="member.id"><input type="checkbox" :checked="task.holder_user_ids.includes(member.user_id)" :disabled="busy" @change="mutate(() => setTeamTaskHolder(task, member.user_id, ($event.target as HTMLInputElement).checked))" />{{ member.display_label }}</label></div>
        <TeamTaskHolderPanel :task-id="task.id" :team-id="teamId" :current-user-id="currentUserId" :writes-enabled="canWriteTasks" @changed="load" @refreshed="refreshTask" @revoked="deliveryRevoked" />
        <button v-if="readinessEnabled||task.requirements" class="text-btn" data-testid="task-requirements-open" @click="showRequirements=!showRequirements">{{ t('team.requirements.title') }}</button>
        <TeamTaskRequirementsPanel v-if="showRequirements&&(readinessEnabled||task.requirements)" :key="task.id" :task-id="task.id" :team-id="teamId" :current-user-id="currentUserId" :team-creator-id="teamCreatorId" :writes-enabled="canWriteTasks&&readinessEnabled===true" :members="members" @changed="load" @revoked="deliveryRevoked" />
        <button v-if="task.has_delivery_contract!==false" class="text-btn" data-testid="task-delivery-open" @click="showDelivery=!showDelivery">{{ showDelivery?'收起交付与验收':'交付与验收' }}</button>
        <TeamTaskDeliveryPanel v-if="showDelivery&&task.has_delivery_contract!==false" :key="task.id" :task-id="task.id" :current-user-id="currentUserId" :members="members" @changed="load" @revoked="deliveryRevoked" />
        <h3 class="detail-section-title">{{ t('replica.linked_sessions') }}</h3>
        <div v-for="session in linkedSessions(task)" :key="session.id" class="linked-session"><div><strong>{{ session.title }}</strong><p>{{ t('replica.session_participation',{participants:session.participants.length,agents:session.agent_bindings.length}) }}</p></div><RouterLink :to="{name:'team-session',params:{teamId:teamId,id:session.id}}">{{ t('replica.open') }}</RouterLink></div>
        <p v-if="!linkedSessions(task).length" class="detail-empty">{{ t('replica.no_linked_sessions') }}</p>
        <button v-if="canWriteTasks && task.state !== 'deleted' && task.state !== 'archived'" class="text-btn task-linked-action" @click="startSession(task.id)"><WorkspaceIcon name="plus" class="icon small" />{{ t('workspace.new_shared_session') }}</button>
        <h3 class="detail-section-title">{{ t('team.task_state_label') }}</h3>
        <div v-if="canWriteTasks" class="task-actions">
          <template v-if="task.state !== 'archived' && task.state !== 'deleted'">
            <ActionSelect><select :value="task.state" :aria-label="t('team.task_state_label')" @change="changeState(task, $event)">
              <option v-for="state in nextStates(task)" :key="state" :value="state">{{ t(`team.task_state.${state}`) }}</option>
            </select></ActionSelect>
            <button v-if="canManage(task)" type="button" @click="archiveTask(task)">{{ t('team.archive') }}</button>
            <button v-if="canManage(task)" type="button" class="danger" @click="removeTask(task)">{{ t('common.delete') }}</button>
          </template>
          <template v-else-if="canManage(task)"><button type="button" @click="restoreTask(task)">{{ t('team.restore') }}</button><button v-if="task.state === 'archived'" type="button" class="danger" @click="removeTask(task)">{{ t('common.delete') }}</button></template>
        </div>
        <p v-if="error" class="panel-error" role="alert">{{ error }}</p>
      </template>
      <template #footer><button type="button" class="btn" :disabled="busy" @click="editingTaskID?editingTaskID='':selectedTaskID=''">{{ t(editingTaskID?'common.cancel':'common.close') }}</button><button v-if="editingTaskID===selectedTask.id" type="submit" form="team-task-edit-form" class="btn primary" :disabled="busy || !canWriteTasks">{{ t('common.save') }}</button><button v-else-if="canWriteTasks && selectedTask.state!=='deleted' && selectedTask.state!=='archived'" class="btn primary" @click="startEdit(selectedTask)">{{ t('team.edit_task') }}</button></template>
    </TeamOverlay>
    <p v-if="error && !showCreate && !selectedTask" class="panel-error" role="status">{{ error }}</p>
  </section>
</template>

<script setup lang="ts">
import TeamTaskHolderPanel from './TeamTaskHolderPanel.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import TeamTaskRequirementsPanel from './TeamTaskRequirementsPanel.vue'
import TeamTaskDeliveryPanel from './TeamTaskDeliveryPanel.vue'
import TeamOverlay from './TeamOverlay.vue'
import ActionList from '../ActionList.vue'
import { loadTeamNavigation } from '../../services/teamNavigationCache'
import { deliveryCacheScope } from '../../services/teamDeliveryCache'
import ActionSelect from '../ActionSelect.vue'
import WorkspaceIcon from '../WorkspaceIcon.vue'
import { useLocale } from '../../composables/useLocale'
import { getRelayOrigin } from '../../composables/useEnv'
import {
  createTeamTask,
  deleteTeamTask,
  listTeamTasks,
  restoreTeamTask,
  setTeamTaskHolder,
  updateTeamTask,
  TeamApiError,
} from '../../services/teamClient'
import type { TeamTask, TeamMember, TeamSessionSummary, TeamTaskPoolFilter } from '../../types/team'

const emit = defineEmits<{'create-session':[taskID:string];'access-denied':[]}>()
const props = withDefaults(defineProps<{ teamId: string; teamCreatorId: number; currentUserId: number; writesEnabled: boolean; readinessEnabled?: boolean; initialTaskId?: string; members?: TeamMember[]; sessions?: TeamSessionSummary[] }>(), {members:()=>[],sessions:()=>[]})
const taskFiltersOpen=ref(false),taskFilterAnchor=ref<HTMLElement|null>(null)
function openTaskFilters(event:MouseEvent){taskFilterAnchor.value=event.currentTarget as HTMLElement;taskFiltersOpen.value=true}
const selectedTaskID = ref(props.initialTaskId||'')
const showRequirements=ref(false)
watch(selectedTaskID,()=>{showRequirements.value=false})
const showDelivery=ref(!!props.initialTaskId)
watch(()=>props.initialTaskId,id=>{if(id){selectedTaskID.value=id;showDelivery.value=true}})
watch(selectedTaskID,()=>{if(selectedTaskID.value!==props.initialTaskId)showDelivery.value=false})
const selectedTask = computed(() => tasks.value.find(task => task.id === selectedTaskID.value))
function memberLabel(id:number):string{return props.members.find(member=>member.user_id===id)?.display_label || t('replica.member_id',{id})}
function linkedSessions(task: TeamTask): TeamSessionSummary[] { return props.sessions.filter(session => task.session_ids.includes(session.id)) }
function refreshTask(task: TeamTask): void {
  if (task.team_id !== props.teamId) return
  tasks.value = tasks.value.map(current => current.id === task.id && task.revision >= current.revision ? task : current)
}
function holderLabels(task: TeamTask): string {return task.holder_user_ids.map(memberLabel).join('、') || t('team.unclaimed')}
const { t } = useLocale()
const filters = ['active', 'archived', 'deleted'] as const
const activeFilter = ref<typeof filters[number]>('active')
const poolFilter=ref<TeamTaskPoolFilter>('all')
watch(poolFilter,()=>{selectedTaskID.value='';void load()})
watch(activeFilter,()=>{if(activeFilter.value!=='active')poolFilter.value='all'})
const tasks = ref<TeamTask[]>([])
// A plain task has no delivery contract. Opening its delivery endpoint would
// invalidate this otherwise authorized task's navigation cache.
watch([()=>selectedTask.value?.id,()=>selectedTask.value?.has_delivery_contract,()=>props.readinessEnabled],([id,contract])=>{
  if(id===props.initialTaskId&&contract===false){showDelivery.value=false;showRequirements.value=true}
})
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const showCreate = ref(false)
const draftTitle = ref('')
const draftBackground = ref('')
const editingTaskID = ref('')
const editTitle = ref('')
const editBackground = ref('')
const editRevision = ref(0)
const visibleTasks = computed(() => tasks.value.filter(task => activeFilter.value === 'active'
  ? task.state !== 'archived' && task.state !== 'deleted'
  : task.state === activeFilter.value))

const taskColumns=computed(()=> (activeFilter.value==='active' ? ['open','in_progress','completed'] : [activeFilter.value]).map(state=>({state,tasks:visibleTasks.value.filter(task=>task.state===state)})))

const online = ref(navigator.onLine)
const navigationCached = ref(false)
const canWriteTasks = computed(() => props.writesEnabled && online.value && !navigationCached.value && !loading.value)
const navigationScope = () => deliveryCacheScope(props.currentUserId, getRelayOrigin())
let loadGeneration = 0
let identityGeneration = 0
function clearProtectedTasks(): void {
  identityGeneration++; loadGeneration++; tasks.value=[]; selectedTaskID.value=''; editingTaskID.value=''; showCreate.value=false
  draftTitle.value=''; draftBackground.value=''; editTitle.value=''; editBackground.value=''; busy.value=false; loading.value=false
}
function deliveryRevoked(): void { clearProtectedTasks(); void load() }
async function load(): Promise<void> {
  const generation = ++loadGeneration
  loading.value = true
  error.value = ''
  const scope = navigationScope(), team = props.teamId, filter = poolFilter.value
  try {
    const result = await loadTeamNavigation({ scope, kind: 'tasks', id: JSON.stringify([team, filter]), team,
      current: () => generation === loadGeneration && scope === navigationScope(),
      load: () => listTeamTasks(team, filter === 'all', filter) })
    if (generation === loadGeneration) { tasks.value = result.data; navigationCached.value = result.cached }
  }
  catch (failure) { if (generation === loadGeneration) { if (failure instanceof TeamApiError && ([401,403].includes(failure.status) || failure.status===404 && failure.code==='team_not_found')) { clearProtectedTasks(); emit('access-denied') }; error.value = message(failure) } }
  finally { if (generation === loadGeneration) loading.value = false }
}
function message(failure: unknown): string { return failure instanceof Error ? failure.message : t('common.error') }
function startSession(taskID: string): void {
  if (!canWriteTasks.value || busy.value) return
  selectedTaskID.value = ''; editingTaskID.value = ''
  emit('create-session', taskID)
}
function replace(task: TeamTask): void { tasks.value = tasks.value.map(current => current.id === task.id ? task : current) }
function canManage(task: TeamTask): boolean { return props.currentUserId === props.teamCreatorId || task.creator_user_id === props.currentUserId }
function nextStates(task: TeamTask): Array<'open' | 'in_progress' | 'completed'> {
  if (task.state === 'open') return ['open', 'in_progress']
  if (task.state === 'in_progress') return ['in_progress', 'open', 'completed']
  return ['completed']
}
async function mutate(run: () => Promise<TeamTask>): Promise<boolean> {
  if (!canWriteTasks.value || !navigator.onLine || busy.value) return false
  const generation = identityGeneration
  busy.value = true; error.value = ''
  try { const result=await run(); if(generation!==identityGeneration)return false; replace(result); return true } catch (failure) { if(generation===identityGeneration)error.value = message(failure); return false } finally { if(generation===identityGeneration)busy.value = false }
}
async function createTask(): Promise<void> {
  if (!canWriteTasks.value || !navigator.onLine || busy.value) return
  const generation = identityGeneration
  busy.value = true; error.value = ''
  try {
    const task=await createTeamTask(props.teamId, draftTitle.value, draftBackground.value)
    if(generation!==identityGeneration)return
    tasks.value.unshift(task)
    draftTitle.value = ''; draftBackground.value = ''; showCreate.value = false; activeFilter.value = 'active'
  } catch (failure) { if(generation===identityGeneration)error.value = message(failure) } finally { if(generation===identityGeneration)busy.value = false }
}
function startEdit(task: TeamTask): void { if (!canWriteTasks.value || busy.value) return; editRevision.value = task.revision; editingTaskID.value = task.id; editTitle.value = task.title; editBackground.value = task.background }
async function saveEdit(task: TeamTask): Promise<void> { if (await mutate(() => updateTeamTask({ ...task, revision: editRevision.value }, { title: editTitle.value, background: editBackground.value }))) editingTaskID.value = '' }
async function changeState(task: TeamTask, event: Event): Promise<void> { await mutate(() => updateTeamTask(task, { state: (event.target as HTMLSelectElement).value as 'open' | 'in_progress' | 'completed' })) }
async function archiveTask(task: TeamTask): Promise<void> { await mutate(() => updateTeamTask(task, { state: 'archived' })) }
async function removeTask(task: TeamTask): Promise<void> { if (canWriteTasks.value && !busy.value && confirm(t('team.delete_task_confirm'))) await mutate(() => deleteTeamTask(task)) }
async function restoreTask(task: TeamTask): Promise<void> { await mutate(() => restoreTeamTask(task)) }

watch([() => props.teamId,()=>props.currentUserId,()=>getRelayOrigin()], () => { clearProtectedTasks(); selectedTaskID.value=props.initialTaskId||''; showDelivery.value=!!props.initialTaskId; activeFilter.value = 'active'; poolFilter.value='all'; void load() })
function navigationRevoked(event: Event) {
  const detail = (event as CustomEvent).detail
  if (detail?.scope && detail.scope !== navigationScope() || detail?.filesOnly || detail?.team && detail.team !== props.teamId) return
  if (detail?.task && !tasks.value.some(task => task.id === detail.task)) return
  if (detail?.session) return
  tasks.value = []; selectedTaskID.value = ''; editingTaskID.value = ''; showCreate.value = false
  navigationCached.value = true
}
function connectivity(): void {
  online.value = navigator.onLine
  // An old successful transport response cannot grant writes after a disconnect.
  loadGeneration++; loading.value = false; navigationCached.value = true
  if (online.value) void load()
}
onMounted(() => { window.addEventListener('online', connectivity); window.addEventListener('offline', connectivity); window.addEventListener('team-delivery-cache-revoked', navigationRevoked); void load() })
onBeforeUnmount(() => { window.removeEventListener('online', connectivity); window.removeEventListener('offline', connectivity); window.removeEventListener('team-delivery-cache-revoked', navigationRevoked); clearProtectedTasks() })
</script>

<style scoped>
.pool-filter { display:flex; align-items:center; gap:10px; margin:12px 0; font-size:12px; color:var(--fg-secondary); }
.panel-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; }.filter-tabs { display: flex; gap: 4px; flex-wrap: wrap; }.filter-tabs button, .task-actions button, .task-actions select { min-height: 31px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--fg-secondary); background: var(--surface); font-size: 11px; cursor: pointer; }.filter-tabs button.active { border-color: transparent; color: var(--accent); background: var(--accent-muted); }
.task-create { margin: 16px 0; display: grid; gap: 9px; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }.task-create input, .task-create textarea { padding: 10px 11px; border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--fg); background: var(--bg); font: inherit; resize: vertical; }.task-create > div { display: flex; justify-content: flex-end; gap: 8px; }
.task-edit { display: grid; gap: 7px; margin: 13px 0; }.task-edit input, .task-edit textarea { padding: 8px 9px; border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--fg); background: var(--bg); font: inherit; resize: vertical; }.task-edit > div { display: flex; justify-content: flex-end; gap: 6px; }.task-edit button { padding: 6px 9px; border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--fg-secondary); background: var(--surface-hover); font-size: 10px; }
.task-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 18px; }.task-card { min-width: 0; padding: 18px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }.task-card-head, .task-meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--fg-tertiary); font-size: 10px; }.task-state { padding: 4px 7px; border-radius: 999px; color: var(--fg-secondary); background: var(--surface-hover); }.task-state.in_progress { color: var(--accent); background: var(--accent-muted); }.task-state.completed { color: var(--success); background: color-mix(in srgb, var(--success) 11%, transparent); }.task-card h3 { margin: 15px 0 8px; font-size: 14px; }.task-card p { min-height: 42px; margin: 0 0 18px; overflow: hidden; color: var(--fg-secondary); font-size: 11px; line-height: 1.7; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }.task-meta { padding-top: 12px; border-top: 1px solid var(--border); }.task-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 13px; }.task-actions .danger { color: var(--error); }.panel-empty { min-height: 250px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; color: var(--fg-tertiary); font-size: 11px; text-align: center; }.panel-empty strong { color: var(--fg-secondary); font-size: 14px; }.panel-error { color: var(--error); font-size: 11px; }
@media (max-width: 760px) { .panel-toolbar { align-items: stretch; flex-direction: column; }.task-grid { grid-template-columns: 1fr; } }

.filter-tabs button { border-color:transparent; background:transparent; padding:5px 8px; }
.task-grid { gap:16px; margin-top:20px; }.task-card { border-radius:9px; padding:20px; cursor:pointer; }.task-card:hover { border-color:var(--accent); }.task-card:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
.task-card-head { font-size:11px; }.task-state { padding:3px 7px; border-radius:5px; font-size:10px; }.task-card h3 { margin:14px 0 8px; font-weight:550; }.task-card p { min-height:0; margin:8px 0 15px; font-size:12px; line-height:1.8; -webkit-line-clamp:3; }.card-foot { display:flex; justify-content:space-between; align-items:center; margin-top:23px; color:var(--fg-secondary); font-size:11px; }
.task-detail-title { font-size:19px; font-weight:550; line-height:1.6; margin:12px 0; }.task-description { white-space:pre-wrap; padding:14px; border:1px solid var(--border); border-radius:7px; background:var(--surface); font-size:12px; line-height:1.8; color:var(--fg-secondary); }
.holder-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin:20px 0; font-size:11px; color:var(--fg-secondary); }.holder-pill { padding:3px 7px; border-radius:5px; background:var(--surface-active); }.detail-section-title { margin:23px 0 11px; font-size:13px; font-weight:550; }.detail-empty { color:var(--fg-secondary); font-size:12px; line-height:1.8; }.linked-session { display:flex; justify-content:space-between; gap:12px; padding:16px 0; border-bottom:1px solid var(--border); font-size:13px; }.linked-session p { color:var(--fg-secondary); font-size:11px; }.linked-session a { color:var(--accent); }
.task-create { margin:0; padding:0; border:0; background:transparent; }
.holder-editor { display:flex; flex-wrap:wrap; gap:10px; font-size:12px; color:var(--fg-secondary); }.holder-editor label { display:flex; gap:5px; align-items:center; }.holder-editor input { accent-color:var(--accent); }
</style>
