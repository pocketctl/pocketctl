<template>
  <ActionList :title="t('workspace.autorun')" :width="480" @close="emit('close')">
    <div class="team-action-body" data-testid="team-run-panel">
    <p class="panel-version">{{ run ? t('workspace.run_id', {id:shortID(run.id)}) : t('workspace.run_not_started') }}</p>
    <div class="run-body">
      <template v-if="run">
        <section class="run-overview">
          <TeamRunStatus :state="run.state" :stop-requested="run.stop_requested" />
          <p v-if="run.stop_requested" class="notice warning"> {{ t('workspace.stop_reconciliation_hint') }} </p>
          <p v-else-if="reasonText" :class="['notice', run.state === 'blocked' || run.state === 'failed' ? 'danger' : '']">{{ reasonText }}</p>
        </section>

        <section>
          <small> {{ t('workspace.run_goal_snapshot') }} </small>
          <div class="snapshot-heading"><strong>Context v{{ run.context_version }}</strong><span> {{ t('workspace.frozen_at_start') }} </span></div>
          <p class="goal">{{ context?.goal || t('workspace.frozen_context_unavailable') }}</p>
          <div v-if="context" class="snapshot-counts"><span>{{ t('workspace.consensus_count', {count:context.consensus.length}) }}</span><span>{{ t('workspace.questions_count', {count:context.open_questions.length}) }}</span><span>{{ t('workspace.references_count', {count:context.references.length}) }}</span></div>
        </section>

        <section>
          <small> {{ t('workspace.coordination') }} </small>
          <div class="coordinator-row"><span class="agent-mark">◎</span><div><strong>{{ coordinatorLabel }}</strong><em>{{ t('workspace.coordinator_agent') }} · {{ coordinatorAvailability }}</em></div></div>
          <div class="participant-list"><span v-for="participant in session.participants" :key="participant.id">{{ memberLabel(participant.user_id) }}</span></div>
        </section>

        <section>
          <small> {{ t('workspace.bounded_budget') }} </small>
          <div class="budget-grid">
            <div><strong>{{ run.calls_used }} / {{ run.budget.max_calls }}</strong><span> {{ t('workspace.calls_used') }} </span></div>
            <div><strong>{{ run.budget.max_concurrent_calls }}</strong><span> {{ t('workspace.concurrency_limit') }} </span></div>
            <div><strong>{{ durationLabel }}</strong><span> {{ t('workspace.duration_limit') }} </span></div>
          </div>
          <p class="deadline">{{ t('workspace.run_deadline', {date:formatDate(run.deadline_at)}) }}</p>
        </section>

        <section class="task-boundary">
          <small> {{ t('workspace.user_task_state') }} </small>
          <div><strong>{{ task?.title || t('workspace.no_linked_task') }}</strong><span>{{ task ? taskStateLabel(task.state) : '—' }}</span></div>
          <p> {{ t('workspace.task_state_boundary') }} </p>
        </section>

        <section v-if="run.state === 'waiting_input'" class="input-request" data-testid="team-run-input-request">
          <small> {{ t('workspace.coordinator_needs_input') }} </small>
          <strong>{{ run.waiting_question || t('workspace.provide_run_input') }}</strong>
          <textarea v-model="supplement" rows="3" :disabled="busy" :placeholder="t('workspace.supplement_placeholder')" />
          <button type="button" :disabled="busy || supplementSubmitting || !supplement.trim()" @click="submitSupplement"> {{ t('workspace.submit_resume') }} </button>
        </section>

        <section v-if="!terminal" class="run-actions">
          <small> {{ t('workspace.run_controls') }} </small>
          <div v-if="isCreator" class="action-row">
            <button v-if="['ready', 'running'].includes(run.state)" type="button" :disabled="busy || run.stop_requested" @click="$emit('control', 'pause')"> {{ t('workspace.pause') }} </button>
            <button v-if="['paused', 'blocked'].includes(run.state)" type="button" :disabled="busy || !canResume" @click="$emit('control', 'resume')"> {{ t('workspace.resume') }} </button>
            <button v-if="!run.stop_requested" type="button" class="danger-action" :disabled="busy" @click="$emit('control', 'cancel')"> {{ t('workspace.request_stop') }} </button>
          </div>
          <button v-else type="button" :disabled="busy" @click="$emit('suggest-pause')"> {{ t('workspace.suggest_pause') }} </button>
          <p v-if="run.state === 'blocked' && !canResume"> {{ t('workspace.unknown_call_hint') }} </p>
        </section>
      </template>

      <section v-if="!run || terminal" class="start-run">
        <small>{{ run ? t('workspace.new_run') : t('workspace.start_autorun') }}</small>
        <p>{{ currentContext ? currentContext.goal : t('workspace.create_context_first') }}</p>
        <label> {{ t('workspace.coordinator_agent') }} <ActionSelect><select v-model="selectedCoordinator" :disabled="busy || !autorunEnabled"><option value=""> {{ t('workspace.select_available_agent') }} </option><option v-for="binding in callableBindings" :key="binding.id" :value="binding.offer_id">{{ bindingLabel(binding) }}</option></select></ActionSelect></label>
        <button type="button" :disabled="busy || !autorunEnabled || !currentContext || !selectedCoordinator" @click="$emit('start', selectedCoordinator)"> {{ t('workspace.start_bounded_run') }} </button>
        <p v-if="!autorunEnabled" class="notice"> {{ t('workspace.autorun_disabled') }} </p>
      </section>

      <section v-if="session.agent_bindings.some(binding => binding.owner_user_id === currentUserId && binding.state === 'active')" class="owned-agents">
        <small> {{ t('workspace.my_execution_agents') }} </small>
        <div v-for="binding in session.agent_bindings.filter(item => item.owner_user_id === currentUserId && item.state === 'active')" :key="binding.id" class="owned-agent-row">
          <div><strong>{{ bindingLabel(binding) }}</strong><span>{{ binding.availability === 'access_disabled' ? t('team.availability.access_disabled') : binding.availability }}</span></div>
          <button type="button" :disabled="busy" @click="$emit('withdraw-agent', binding.offer_id)"> {{ t('workspace.withdraw') }} </button>
        </div>
        <p> {{ t('workspace.withdraw_hint') }} </p>
      </section>

      <p v-if="error" class="panel-error" role="status">{{ error }}</p>
    </div>
    </div>
  </ActionList>
</template>

<script setup lang="ts">
import { useLocale } from "../../composables/useLocale"
const { t } = useLocale()
import { computed, ref, watch } from 'vue'
import ActionList from '../ActionList.vue'
import ActionSelect from '../ActionSelect.vue'
import type { TeamContextSnapshot, TeamMember, TeamRun, TeamSession, TeamSessionAgentBinding, TeamTask } from '../../types/team'
import TeamRunStatus from './TeamRunStatus.vue'

const props = defineProps<{
  session: TeamSession
  run: TeamRun | null
  context: TeamContextSnapshot | null
  currentContext: TeamContextSnapshot | null
  task: TeamTask | null
  members: TeamMember[]
  currentUserId: number
  autorunEnabled: boolean
  busy: boolean
  error?: string
}>()
const emit = defineEmits<{
  close: []
  start: [coordinatorOfferID: string]
  control: [action: 'pause' | 'resume' | 'cancel']
  supplement: [content: string]
  'suggest-pause': []
  'withdraw-agent': [offerID: string]
}>()

const supplement = ref('')
const supplementSubmitting = ref(false)
const selectedCoordinator = ref('')
const callableBindings = computed(() => props.session.agent_bindings.filter(binding => binding.state === 'active' && binding.availability === 'online'))
const isCreator = computed(() => props.session.creator_user_id === props.currentUserId)
const terminal = computed(() => Boolean(props.run && ['completed', 'failed', 'cancelled'].includes(props.run.state)))
const coordinator = computed(() => props.session.agent_bindings.find(binding => binding.offer_id === props.run?.coordinator_offer_id))
const coordinatorLabel = computed(() => coordinator.value ? bindingLabel(coordinator.value) : `Agent ${props.run?.coordinator_offer_id ?? ''}`)
const coordinatorAvailability = computed(() => coordinator.value?.availability === 'access_disabled' ? t('team.availability.access_disabled') : coordinator.value?.availability ?? t('workspace.removed'))
const canResume = computed(() => props.run?.terminal_reason !== 'dispatch_uncertain' && props.run?.terminal_reason !== 'run_deadline_reconcile_required')
const durationLabel = computed(() => {
  const seconds = props.run?.budget.max_duration_seconds ?? 0
  return seconds >= 3_600 && seconds % 3_600 === 0 ? t('workspace.hours_count', {count:seconds / 3_600}) : t('workspace.minutes_count', {count:Math.ceil(seconds / 60)})
})
const reasonText = computed(() => {
  if (!props.run) return ''
  if (props.run.state === 'waiting_input') return props.run.waiting_question || t('workspace.waiting_for_input')
  return ({
    coordinator_unavailable: t('workspace.coordinator_unavailable'),
    dispatch_uncertain: t('workspace.dispatch_uncertain'),
    run_deadline_reconcile_required: t('workspace.deadline_reconcile_required'),
    invalid_coordinator_decision: t('workspace.invalid_coordinator_decision'),
    budget_exhausted: t('workspace.budget_exhausted'),
    coordinator_completed: t('workspace.coordinator_completed'),
    stop_requested: t('workspace.run_stopped'),
  } as Record<string, string>)[props.run.terminal_reason ?? ''] ?? ''
})

watch(callableBindings, bindings => {
  if (!bindings.some(binding => binding.offer_id === selectedCoordinator.value)) selectedCoordinator.value = bindings[0]?.offer_id ?? ''
}, { immediate: true })
watch(() => [props.run?.id, props.run?.state], () => {
  if (props.run?.state !== 'waiting_input') supplement.value = ''
  supplementSubmitting.value = false
})
watch(() => props.busy, busy => { if (!busy && props.run?.state === 'waiting_input') supplementSubmitting.value = false })

function shortID(value: string): string { return value.replace(/^crn_/, '').slice(0, 8) }
function memberLabel(userID: number): string { return props.members.find(member => member.user_id === userID)?.display_label ?? t('workspace.member_id', {id:userID}) }
function bindingLabel(binding: TeamSessionAgentBinding): string { return `${binding.provider === 'codex' ? 'Codex' : 'Claude Code'} · ${binding.daemon_id}` }
function formatDate(value: string): string { return new Date(value).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
function taskStateLabel(state: TeamTask['state']): string { return ({ open: t('team.task_state.open'), in_progress: t('team.task_state.in_progress'), completed: t('team.task_state.completed'), archived: t('team.task_filter.archived'), deleted: t('workspace.deleted') } as Record<TeamTask['state'], string>)[state] }
function submitSupplement(): void {
  const content = supplement.value.trim()
  if (!content || props.busy || supplementSubmitting.value) return
  supplementSubmitting.value = true
  emit('supplement', content)
}
</script>

<style scoped>
.run-panel { width: 340px; min-width: 290px; border-left: 1px solid var(--border); color: var(--fg); background: var(--surface); overflow-y: auto; }.run-panel > header { min-height: 62px; display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid var(--border); box-sizing: border-box; }.run-panel > header div { display: grid; gap: 3px; }.run-panel > header span { color: var(--fg-secondary); font-size: 10px; }.run-panel > header strong { font-size: 12px; }.run-panel > header button { border: 0; color: var(--fg-secondary); background: none; font-size: 22px; cursor: pointer; }.run-body { padding: 16px; }.run-body section { margin-bottom: 23px; }.run-body section > small { display: block; margin-bottom: 9px; color: var(--accent); font: 650 9px var(--font-mono); letter-spacing: .08em; text-transform: uppercase; }.run-overview { display: grid; gap: 10px; }.notice,.run-actions p,.owned-agents p,.task-boundary p,.deadline,.start-run > p { margin: 7px 0 0; color: var(--fg-tertiary); font-size: 10px; line-height: 1.55; }.notice.warning { color: var(--warning); }.notice.danger,.panel-error { color: var(--error); }.snapshot-heading,.task-boundary > div { display: flex; align-items: center; justify-content: space-between; gap: 8px; }.snapshot-heading strong,.task-boundary strong { font-size: 11px; }.snapshot-heading span,.task-boundary span { color: var(--fg-tertiary); font: 9px var(--font-mono); }.goal { margin: 8px 0; color: var(--fg-secondary); font-size: 11px; line-height: 1.6; }.snapshot-counts,.participant-list { display: flex; flex-wrap: wrap; gap: 5px; }.snapshot-counts span,.participant-list span { padding: 4px 6px; border-radius: 6px; color: var(--fg-tertiary); background: var(--bg); font-size: 8px; }.coordinator-row { min-height: 45px; display: flex; align-items: center; gap: 9px; margin-bottom: 8px; }.coordinator-row > div { display: grid; gap: 3px; }.coordinator-row strong { font-size: 11px; }.coordinator-row em { color: var(--fg-tertiary); font: normal 9px var(--font-mono); }.agent-mark { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; color: var(--accent); background: var(--accent-muted); }.budget-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 5px; }.budget-grid div { display: grid; gap: 4px; padding: 9px 7px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); }.budget-grid strong { font: 650 11px var(--font-mono); }.budget-grid span { color: var(--fg-tertiary); font-size: 8px; }.input-request { padding: 12px; border: 1px solid color-mix(in srgb, var(--warning) 45%, var(--border)); border-radius: 10px; background: color-mix(in srgb, var(--warning) 8%, var(--surface)); }.input-request strong { display: block; margin-bottom: 9px; font-size: 11px; line-height: 1.5; }.input-request textarea { width: 100%; resize: vertical; box-sizing: border-box; padding: 8px; border: 1px solid var(--border); border-radius: 7px; color: var(--fg); background: var(--bg); font: 10px/1.5 var(--font-body); }.input-request button,.start-run > button { width: 100%; margin-top: 7px; padding: 8px; border: 0; border-radius: 7px; color: #fff; background: var(--accent); font-size: 10px; cursor: pointer; }.run-actions .action-row { display: flex; gap: 6px; }.run-actions button,.owned-agent-row button { padding: 6px 8px; border: 1px solid var(--border); border-radius: 7px; color: var(--fg-secondary); background: var(--bg); font-size: 9px; cursor: pointer; }.run-actions .danger-action,.owned-agent-row button { color: var(--error); }.start-run label { display: grid; gap: 5px; margin-top: 10px; color: var(--fg-secondary); font-size: 9px; }.start-run select { width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 7px; color: var(--fg); background: var(--bg); font-size: 10px; }.owned-agent-row { min-height: 42px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--border); }.owned-agent-row > div { min-width: 0; display: grid; gap: 3px; flex: 1; }.owned-agent-row strong { overflow: hidden; font-size: 10px; text-overflow: ellipsis; }.owned-agent-row span { color: var(--fg-tertiary); font: 8px var(--font-mono); }.panel-error { font-size: 10px; line-height: 1.5; }button:disabled,select:disabled,textarea:disabled { opacity: .45; cursor: not-allowed; }
@media (max-width: 900px) { .run-panel { position: absolute; inset: 62px 0 0 auto; z-index: 80; width: min(370px, 94vw); box-shadow: -12px 0 30px rgba(0,0,0,.18); } }
.run-panel { position:fixed; inset:0 0 0 auto; z-index:110; width:470px; max-width:100vw; min-width:0; box-shadow:var(--shadow-lg); box-sizing:border-box; background:var(--bg); }.run-panel header { padding:20px 24px; min-height:70px; }.run-panel header span { font-size:14px; color:var(--fg); }.run-panel header strong { font-size:12px; }.run-panel :deep(p),.run-panel :deep(li) { font-size:12px; line-height:1.8; }
</style>

<style scoped>
.team-action-body{min-width:0}.panel-version{margin:0 0 12px;color:var(--fg-tertiary);font-size:11px}.context-body,.context-editor,.run-body{padding:0}.team-action-body section{margin-bottom:16px}.team-action-body section>small{font:550 12px var(--font-body);color:var(--fg-secondary)}.team-action-body code{overflow-wrap:anywhere}.team-action-body .memory-option{max-width:100%}
</style>
