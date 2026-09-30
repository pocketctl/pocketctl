<template>
  <section class="tasks-panel" data-testid="team-tasks-panel">
    <div class="panel-toolbar">
      <div class="filter-tabs" role="tablist" :aria-label="t('team.task_filters')">
        <button v-for="filter in filters" :key="filter" type="button" :class="{ active: activeFilter === filter }" @click="activeFilter = filter">{{ t(`team.task_filter.${filter}`) }}</button>
      </div>
      <button v-if="writesEnabled" type="button" class="btn btn-primary" data-testid="team-new-task" @click="showCreate = !showCreate">+ {{ t('team.new_task') }}</button>
    </div>

    <div v-if="loading" class="panel-empty">{{ t('common.loading') }}</div>
    <div v-else-if="!visibleTasks.length" class="panel-empty"><strong>{{ t('team.tasks_empty') }}</strong><span>{{ t('team.tasks_empty_copy') }}</span></div>
    <div v-else class="task-grid">
      <article v-for="task in visibleTasks" :key="task.id" class="task-card" :data-task-id="task.id" role="button" tabindex="0" :aria-label="`打开任务：${task.title}`" @click="selectedTaskID = task.id" @keydown.enter="selectedTaskID = task.id" @keydown.space.prevent="selectedTaskID = task.id">
        <div class="task-card-head"><span class="task-state" :class="task.state">{{ t(`team.task_state.${task.state}`) }}</span><span>{{ task.session_ids.length }} {{ t('team.sessions_unit') }}</span></div>
        <h3>{{ task.title }}</h3><p>{{ task.background || t('team.no_background') }}</p>
        <div class="card-foot"><span>{{ holderLabels(task) }}</span><span>查看 →</span></div>
      </article>
    </div>
    <TeamOverlay v-if="showCreate" :title="t('team.new_task')" @close="showCreate = false">
    <form class="task-create" data-testid="team-task-create" @submit.prevent="createTask">
      <input v-model.trim="draftTitle" maxlength="160" required :placeholder="t('team.task_title')" />
      <textarea v-model="draftBackground" rows="3" :placeholder="t('team.task_background')" />
      <div><button type="button" class="btn btn-secondary" @click="showCreate = false">{{ t('common.cancel') }}</button><button class="btn btn-primary" :disabled="busy">{{ t('team.create_task') }}</button></div>
    </form>

    </TeamOverlay>
    <TeamOverlay v-if="selectedTask" title="任务" drawer @close="selectedTaskID = ''; editingTaskID = ''">
      <template v-for="task in [selectedTask]" :key="task.id">
        <span class="task-state" :class="task.state">{{ t(`team.task_state.${task.state}`) }}</span>
        <h2 class="task-detail-title">{{ task.title }}</h2>
        <form v-if="editingTaskID === task.id" class="task-edit" @submit.prevent="saveEdit(task)">
          <input v-model.trim="editTitle" maxlength="240" required />
          <textarea v-model="editBackground" rows="4" />
          <div><button type="button" @click="editingTaskID = ''">{{ t('common.cancel') }}</button><button :disabled="busy">{{ t('common.save') }}</button></div>
        </form>
        <div v-else class="task-description">{{ task.background || t('team.no_background') }}</div>
        <div class="holder-row"><span>共同持有</span><span v-for="holder in task.holder_user_ids" :key="holder" class="holder-pill">{{ members.find(member => member.user_id === holder)?.display_label || `成员 ${holder}` }}</span><span v-if="!task.holder_user_ids.length">{{ t('team.unclaimed') }}</span></div>
        <div v-if="writesEnabled && currentUserId === teamCreatorId && !['archived','deleted'].includes(task.state)" class="holder-editor"><label v-for="member in members" :key="member.id"><input type="checkbox" :checked="task.holder_user_ids.includes(member.user_id)" :disabled="busy" @change="mutate(() => setTeamTaskHolder(task, member.user_id, ($event.target as HTMLInputElement).checked))" />{{ member.display_label }}</label></div>
        <h3 class="detail-section-title">关联会话</h3>
        <div v-for="session in sessions.filter(item => item.task_id === task.id)" :key="session.id" class="linked-session"><div><strong>{{ session.title }}</strong><p>{{ session.participants.length }} 人 · {{ session.agent_bindings.length }} Agents</p></div><RouterLink :to="{name:'team-session',params:{teamId:teamId,id:session.id}}">打开</RouterLink></div>
        <p v-if="!sessions.some(item => item.task_id === task.id)" class="detail-empty">暂无关联会话。准备好后，带上 Agent 开始讨论。</p>
        <h3 class="detail-section-title">任务状态</h3>
        <div v-if="writesEnabled" class="task-actions">
          <template v-if="task.state !== 'archived' && task.state !== 'deleted'">
            <button type="button" @click="toggleClaim(task)">{{ task.holder_user_ids.includes(currentUserId) ? t('team.unclaim') : t('team.claim') }}</button>
            <button type="button" @click="startEdit(task)">{{ t('team.edit_task') }}</button>
            <select :value="task.state" :aria-label="t('team.task_state_label')" @change="changeState(task, $event)">
              <option v-for="state in nextStates(task)" :key="state" :value="state">{{ t(`team.task_state.${state}`) }}</option>
            </select>
            <button v-if="canManage(task)" type="button" @click="archiveTask(task)">{{ t('team.archive') }}</button>
            <button v-if="canManage(task)" type="button" class="danger" @click="removeTask(task)">{{ t('common.delete') }}</button>
          </template>
          <template v-else-if="canManage(task)"><button type="button" @click="restoreTask(task)">{{ t('team.restore') }}</button><button v-if="task.state === 'archived'" type="button" class="danger" @click="removeTask(task)">{{ t('common.delete') }}</button></template>
        </div>
        <p v-if="error" class="panel-error" role="alert">{{ error }}</p>
      </template>
      <template #footer><button v-if="writesEnabled && selectedTask.state !== 'deleted' && selectedTask.state !== 'archived'" class="btn btn-primary" @click="startSession(selectedTask.id)">+ 新建共享会话</button></template>
    </TeamOverlay>
    <p v-if="error" class="panel-error" role="status">{{ error }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import TeamOverlay from './TeamOverlay.vue'
import { useLocale } from '../../composables/useLocale'
import {
  createTeamTask,
  deleteTeamTask,
  listTeamTasks,
  restoreTeamTask,
  setTeamTaskSelfHolder,
  setTeamTaskHolder,
  updateTeamTask,
} from '../../services/teamClient'
import type { TeamTask, TeamMember, TeamSessionSummary } from '../../types/team'

const emit = defineEmits<{'create-session':[taskID:string]}>()
const props = withDefaults(defineProps<{ teamId: string; teamCreatorId: number; currentUserId: number; writesEnabled: boolean; members?: TeamMember[]; sessions?: TeamSessionSummary[] }>(), {members:()=>[],sessions:()=>[]})
const selectedTaskID = ref('')
const selectedTask = computed(() => tasks.value.find(task => task.id === selectedTaskID.value))
function holderLabels(task: TeamTask): string {return task.holder_user_ids.map(id => props.members.find(member => member.user_id === id)?.display_label || `成员 ${id}`).join('、') || t('team.unclaimed')}
const { t } = useLocale()
const filters = ['active', 'archived', 'deleted'] as const
const activeFilter = ref<typeof filters[number]>('active')
const tasks = ref<TeamTask[]>([])
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const showCreate = ref(false)
const draftTitle = ref('')
const draftBackground = ref('')
const editingTaskID = ref('')
const editTitle = ref('')
const editBackground = ref('')
const visibleTasks = computed(() => tasks.value.filter(task => activeFilter.value === 'active'
  ? task.state !== 'archived' && task.state !== 'deleted'
  : task.state === activeFilter.value))

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try { tasks.value = await listTeamTasks(props.teamId) }
  catch (failure) { error.value = message(failure) }
  finally { loading.value = false }
}
function message(failure: unknown): string { return failure instanceof Error ? failure.message : t('common.error') }
function startSession(taskID: string): void {
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
  busy.value = true; error.value = ''
  try { replace(await run()); return true } catch (failure) { error.value = message(failure); return false } finally { busy.value = false }
}
async function createTask(): Promise<void> {
  busy.value = true; error.value = ''
  try {
    tasks.value.unshift(await createTeamTask(props.teamId, draftTitle.value, draftBackground.value))
    draftTitle.value = ''; draftBackground.value = ''; showCreate.value = false; activeFilter.value = 'active'
  } catch (failure) { error.value = message(failure) } finally { busy.value = false }
}
async function toggleClaim(task: TeamTask): Promise<void> { await mutate(() => setTeamTaskSelfHolder(task, !task.holder_user_ids.includes(props.currentUserId))) }
function startEdit(task: TeamTask): void { editingTaskID.value = task.id; editTitle.value = task.title; editBackground.value = task.background }
async function saveEdit(task: TeamTask): Promise<void> { if (await mutate(() => updateTeamTask(task, { title: editTitle.value, background: editBackground.value }))) editingTaskID.value = '' }
async function changeState(task: TeamTask, event: Event): Promise<void> { await mutate(() => updateTeamTask(task, { state: (event.target as HTMLSelectElement).value as 'open' | 'in_progress' | 'completed' })) }
async function archiveTask(task: TeamTask): Promise<void> { await mutate(() => updateTeamTask(task, { state: 'archived' })) }
async function removeTask(task: TeamTask): Promise<void> { if (confirm(t('team.delete_task_confirm'))) await mutate(() => deleteTeamTask(task)) }
async function restoreTask(task: TeamTask): Promise<void> { await mutate(() => restoreTeamTask(task)) }

watch(() => props.teamId, () => { activeFilter.value = 'active'; showCreate.value = false; void load() })
onMounted(load)
</script>

<style scoped>
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
