<template>
  <section class="tasks-panel" data-testid="team-tasks-panel">
    <div class="panel-toolbar">
      <div class="filter-tabs" role="tablist" :aria-label="t('team.task_filters')">
        <button v-for="filter in filters" :key="filter" type="button" :class="{ active: activeFilter === filter }" @click="activeFilter = filter">{{ t(`team.task_filter.${filter}`) }}</button>
      </div>
      <button v-if="writesEnabled" type="button" class="btn btn-primary" data-testid="team-new-task" @click="showCreate = !showCreate">+ {{ t('team.new_task') }}</button>
    </div>

    <form v-if="showCreate" class="task-create" data-testid="team-task-create" @submit.prevent="createTask">
      <input v-model.trim="draftTitle" maxlength="160" required :placeholder="t('team.task_title')" />
      <textarea v-model="draftBackground" rows="3" :placeholder="t('team.task_background')" />
      <div><button type="button" class="btn btn-secondary" @click="showCreate = false">{{ t('common.cancel') }}</button><button class="btn btn-primary" :disabled="busy">{{ t('team.create_task') }}</button></div>
    </form>

    <div v-if="loading" class="panel-empty">{{ t('common.loading') }}</div>
    <div v-else-if="!visibleTasks.length" class="panel-empty"><strong>{{ t('team.tasks_empty') }}</strong><span>{{ t('team.tasks_empty_copy') }}</span></div>
    <div v-else class="task-grid">
      <article v-for="task in visibleTasks" :key="task.id" class="task-card" :data-task-id="task.id">
        <div class="task-card-head"><span class="task-state" :class="task.state">{{ t(`team.task_state.${task.state}`) }}</span><span>{{ task.session_ids.length }} {{ t('team.sessions_unit') }}</span></div>
        <form v-if="editingTaskID === task.id" class="task-edit" @submit.prevent="saveEdit(task)">
          <input v-model.trim="editTitle" maxlength="240" required />
          <textarea v-model="editBackground" rows="4" />
          <div><button type="button" @click="editingTaskID = ''">{{ t('common.cancel') }}</button><button :disabled="busy">{{ t('common.save') }}</button></div>
        </form>
        <template v-else><h3>{{ task.title }}</h3><p>{{ task.background || t('team.no_background') }}</p></template>
        <div class="task-meta"><span>{{ task.holder_user_ids.length ? t('team.holders_count', { count: task.holder_user_ids.length }) : t('team.unclaimed') }}</span><span>{{ formatDate(task.updated_at) }}</span></div>
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
      </article>
    </div>
    <p v-if="error" class="panel-error" role="status">{{ error }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import {
  createTeamTask,
  deleteTeamTask,
  listTeamTasks,
  restoreTeamTask,
  setTeamTaskSelfHolder,
  updateTeamTask,
} from '../../services/teamClient'
import type { TeamTask } from '../../types/team'

const props = defineProps<{ teamId: string; teamCreatorId: number; currentUserId: number; writesEnabled: boolean }>()
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
function replace(task: TeamTask): void { tasks.value = tasks.value.map(current => current.id === task.id ? task : current) }
function canManage(task: TeamTask): boolean { return props.currentUserId === props.teamCreatorId || task.creator_user_id === props.currentUserId }
function nextStates(task: TeamTask): Array<'open' | 'in_progress' | 'completed'> {
  if (task.state === 'open') return ['open', 'in_progress']
  if (task.state === 'in_progress') return ['in_progress', 'open', 'completed']
  return ['completed']
}
function formatDate(value: string): string { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value)) }
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
</style>
