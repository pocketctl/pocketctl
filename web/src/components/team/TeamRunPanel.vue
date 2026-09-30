<template>
  <aside ref="panel" class="run-panel" data-testid="team-run-panel" role="dialog" aria-modal="true" aria-label="自动协作" tabindex="-1" @keydown.esc.stop.prevent="emit('close')" @keydown.tab="trapFocus">
    <header>
      <div><span>自动协作</span><strong>{{ run ? `运行 ${shortID(run.id)}` : '尚未发起' }}</strong></div>
      <button type="button" aria-label="关闭自动协作" @click="$emit('close')">×</button>
    </header>

    <div class="run-body">
      <template v-if="run">
        <section class="run-overview">
          <TeamRunStatus :state="run.state" :stop-requested="run.stop_requested" />
          <p v-if="run.stop_requested" class="notice warning">已请求停止。正在执行或结果未知的调用必须先完成对账，界面不会提前显示为已取消。</p>
          <p v-else-if="reasonText" :class="['notice', run.state === 'blocked' || run.state === 'failed' ? 'danger' : '']">{{ reasonText }}</p>
        </section>

        <section>
          <small>本轮目标与快照</small>
          <div class="snapshot-heading"><strong>Context v{{ run.context_version }}</strong><span>冻结于发起时</span></div>
          <p class="goal">{{ context?.goal || '冻结 Context 暂不可读取' }}</p>
          <div v-if="context" class="snapshot-counts"><span>{{ context.consensus.length }} 条共识</span><span>{{ context.open_questions.length }} 个开放问题</span><span>{{ context.references.length }} 个引用</span></div>
        </section>

        <section>
          <small>协调与参与</small>
          <div class="coordinator-row"><span class="agent-mark">◎</span><div><strong>{{ coordinatorLabel }}</strong><em>协调 Agent · {{ coordinatorAvailability }}</em></div></div>
          <div class="participant-list"><span v-for="participant in session.participants" :key="participant.id">{{ memberLabel(participant.user_id) }}</span></div>
        </section>

        <section>
          <small>有界预算</small>
          <div class="budget-grid">
            <div><strong>{{ run.calls_used }} / {{ run.budget.max_calls }}</strong><span>已用调用</span></div>
            <div><strong>{{ run.budget.max_concurrent_calls }}</strong><span>并发上限</span></div>
            <div><strong>{{ durationLabel }}</strong><span>时长上限</span></div>
          </div>
          <p class="deadline">最晚结束：{{ formatDate(run.deadline_at) }}</p>
        </section>

        <section class="task-boundary">
          <small>用户任务状态</small>
          <div><strong>{{ task?.title || '未关联任务' }}</strong><span>{{ task ? taskStateLabel(task.state) : '—' }}</span></div>
          <p>模型回复完成、Run 结束与用户任务状态互相独立；自动协作不会替你完成任务。</p>
        </section>

        <section v-if="run.state === 'waiting_input'" class="input-request" data-testid="team-run-input-request">
          <small>协调 Agent 需要补充</small>
          <strong>{{ run.waiting_question || '请补充继续协作所需的信息。' }}</strong>
          <textarea v-model="supplement" rows="3" :disabled="busy" placeholder="补充信息会作为新事件追加，不会改写冻结快照。" />
          <button type="button" :disabled="busy || supplementSubmitting || !supplement.trim()" @click="submitSupplement">提交并恢复</button>
        </section>

        <section v-if="!terminal" class="run-actions">
          <small>运行控制</small>
          <div v-if="isCreator" class="action-row">
            <button v-if="['ready', 'running'].includes(run.state)" type="button" :disabled="busy || run.stop_requested" @click="$emit('control', 'pause')">暂停</button>
            <button v-if="['paused', 'blocked'].includes(run.state)" type="button" :disabled="busy || !canResume" @click="$emit('control', 'resume')">恢复</button>
            <button v-if="!run.stop_requested" type="button" class="danger-action" :disabled="busy" @click="$emit('control', 'cancel')">请求停止</button>
          </div>
          <button v-else type="button" :disabled="busy" @click="$emit('suggest-pause')">提出暂停建议</button>
          <p v-if="run.state === 'blocked' && !canResume">存在结果未知的调用，需先由服务端完成对账，不能直接恢复或重复执行。</p>
        </section>
      </template>

      <section v-if="!run || terminal" class="start-run">
        <small>{{ run ? '发起新一轮' : '发起自动协作' }}</small>
        <p>{{ currentContext ? currentContext.goal : '需要先建立共享 Context，才能冻结目标并发起运行。' }}</p>
        <label>协调 Agent<select v-model="selectedCoordinator" :disabled="busy || !autorunEnabled"><option value="">选择可用 Agent…</option><option v-for="binding in callableBindings" :key="binding.id" :value="binding.offer_id">{{ bindingLabel(binding) }}</option></select></label>
        <button type="button" :disabled="busy || !autorunEnabled || !currentContext || !selectedCoordinator" @click="$emit('start', selectedCoordinator)">开始有界协作</button>
        <p v-if="!autorunEnabled" class="notice">当前 Relay 未开放自动协作写入。</p>
      </section>

      <section v-if="session.agent_bindings.some(binding => binding.owner_user_id === currentUserId && binding.state === 'active')" class="owned-agents">
        <small>我的执行能力</small>
        <div v-for="binding in session.agent_bindings.filter(item => item.owner_user_id === currentUserId && item.state === 'active')" :key="binding.id" class="owned-agent-row">
          <div><strong>{{ bindingLabel(binding) }}</strong><span>{{ binding.availability === 'access_disabled' ? '账号未开通 Team' : binding.availability }}</span></div>
          <button type="button" :disabled="busy" @click="$emit('withdraw-agent', binding.offer_id)">撤回</button>
        </div>
        <p>撤回只阻止新的共享调用；原生会话中的工具审批仍由你处理。</p>
      </section>

      <p v-if="error" class="panel-error" role="status">{{ error }}</p>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { usePanelFocus } from '../../composables/usePanelFocus'
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
const { panel, trapFocus } = usePanelFocus()

const supplement = ref('')
const supplementSubmitting = ref(false)
const selectedCoordinator = ref('')
const callableBindings = computed(() => props.session.agent_bindings.filter(binding => binding.state === 'active' && binding.availability === 'online'))
const isCreator = computed(() => props.session.creator_user_id === props.currentUserId)
const terminal = computed(() => Boolean(props.run && ['completed', 'failed', 'cancelled'].includes(props.run.state)))
const coordinator = computed(() => props.session.agent_bindings.find(binding => binding.offer_id === props.run?.coordinator_offer_id))
const coordinatorLabel = computed(() => coordinator.value ? bindingLabel(coordinator.value) : `Agent ${props.run?.coordinator_offer_id ?? ''}`)
const coordinatorAvailability = computed(() => coordinator.value?.availability === 'access_disabled' ? '账号未开通 Team' : coordinator.value?.availability ?? '已移除')
const canResume = computed(() => props.run?.terminal_reason !== 'dispatch_uncertain' && props.run?.terminal_reason !== 'run_deadline_reconcile_required')
const durationLabel = computed(() => {
  const seconds = props.run?.budget.max_duration_seconds ?? 0
  return seconds >= 3_600 && seconds % 3_600 === 0 ? `${seconds / 3_600} 小时` : `${Math.ceil(seconds / 60)} 分钟`
})
const reasonText = computed(() => {
  if (!props.run) return ''
  if (props.run.state === 'waiting_input') return props.run.waiting_question || '等待参与者补充信息。'
  return ({
    coordinator_unavailable: '协调 Agent 当前不可用。恢复其执行能力后，可由创建人继续运行。',
    dispatch_uncertain: '调用结果未知。为避免重复执行，运行已阻塞并等待对账。',
    run_deadline_reconcile_required: '运行已超过时长预算，但仍有调用需要对账。',
    invalid_coordinator_decision: '协调 Agent 返回了不符合约束的决策。',
    budget_exhausted: '本轮调用数或时长预算已经用尽。',
    coordinator_completed: '协调 Agent 已提交本轮总结。',
    stop_requested: '本轮已安全停止。',
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
function memberLabel(userID: number): string { return props.members.find(member => member.user_id === userID)?.display_label ?? `成员 ${userID}` }
function bindingLabel(binding: TeamSessionAgentBinding): string { return `${binding.provider === 'codex' ? 'Codex' : 'Claude Code'} · ${binding.daemon_id}` }
function formatDate(value: string): string { return new Date(value).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
function taskStateLabel(state: TeamTask['state']): string { return ({ open: '待开始', in_progress: '进行中', completed: '已完成', archived: '已归档', deleted: '已删除' } as Record<TeamTask['state'], string>)[state] }
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
</style>
