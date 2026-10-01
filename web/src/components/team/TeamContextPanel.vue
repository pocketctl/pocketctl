<template>
  <aside ref="panel" class="context-panel" data-testid="team-context-panel" role="dialog" aria-modal="true" aria-label="共享 Context" tabindex="-1" @keydown.esc.stop.prevent="emit('close')" @keydown.tab="trapFocus">
    <header><div><span>共享 Context</span><strong>{{ context ? `v${context.version}` : '未建立' }}</strong></div><button type="button" aria-label="关闭 Context" @click="$emit('close')">×</button></header>
    <div v-if="context" class="context-body">
      <section><small>目标</small><p>{{ context.goal }}</p></section>
      <section><small>共识</small><ul v-if="context.consensus.length"><li v-for="item in context.consensus" :key="item">{{ item }}</li></ul><p v-else>暂无</p></section>
      <section><small>开放问题</small><ul v-if="context.open_questions.length"><li v-for="item in context.open_questions" :key="item">{{ item }}</li></ul><p v-else>暂无</p></section>
      <section><small>引用</small>
        <div v-for="reference in context.references" :key="`${reference.source_kind}:${reference.source_id}:${reference.source_version}`" class="reference-row">
          <strong>{{ referenceLabel(reference.source_kind) }}</strong><code>{{ reference.source_id.slice(0, 8) }}@{{ reference.source_version.slice(0, 8) }}</code>
        </div>
        <p v-if="!context.references.length">暂无</p>
      </section>
    </div>
    <div v-else class="context-empty">此会话还没有 Context 快照。消息仍会按当前事件历史发送给 Agent。</div>
    <form v-if="canEdit" class="context-editor" @submit.prevent="save">
      <small>编辑快照</small>
      <label>目标<textarea v-model="goal" rows="3" required /></label>
      <label>共识（每行一条）<textarea v-model="consensusText" rows="3" /></label>
      <label>开放问题（每行一条）<textarea v-model="questionsText" rows="3" /></label>
      <section class="selected-references" data-testid="selected-context-references" aria-label="待发布引用">
        <small>待发布引用 · {{ selected.length }}</small>
        <div v-for="(reference, index) in selected" :key="referenceKey(reference)" class="selected-reference" data-testid="selected-context-reference">
          <div class="reference-row">
            <strong>{{ referenceLabel(reference.source_kind) }}</strong>
            <p v-if="selectedLabels[referenceKey(reference)]">{{ selectedLabels[referenceKey(reference)] }}</p>
            <code>{{ reference.source_id }}@{{ reference.source_version }}</code>
          </div>
          <button type="button" class="remove-reference" :aria-label="`移除${referenceLabel(reference.source_kind)}引用 ${reference.source_id}`" :disabled="busy" @click="removeReference(index)">移除</button>
        </div>
        <p class="reference-hint">{{ selected.length ? '引用失效时，可移除对应项后再发布新版本。' : '暂无引用' }}</p>
      </section>
      <div v-if="binding?.access_state === 'available'" class="memory-picker">
        <label>团队知识<input v-model="query" type="search" placeholder="搜索已发布 Claim…" @input="scheduleSearch" /></label>
        <button v-for="option in options" :key="`${option.sourceId}:${option.sourceVersion}`" type="button" class="memory-option" @click="addReference(option)">
          <span>{{ option.label }}</span><code>{{ option.provenance }}</code>
        </button>
      </div>
      <p v-else-if="binding" class="panel-error">当前成员无权读取绑定的团队 Memory。</p>
      <p v-if="error" class="panel-error" role="status">{{ error }}</p>
      <button type="submit" class="save-context" :disabled="busy || !goal.trim()">{{ busy ? '保存中…' : '发布新版本' }}</button>
    </form>
  </aside>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { usePanelFocus } from '../../composables/usePanelFocus'
import { searchTeamContextClaimReferences, type TeamContextClaimReferenceOption } from '../../services/memoryClient'
import { createTeamContext, getTeamMemoryBinding } from '../../services/teamClient'
import type { TeamContextReference, TeamContextSnapshot, TeamMemoryBinding, TeamSession } from '../../types/team'

const props = defineProps<{ context: TeamContextSnapshot | null; session: TeamSession; currentUserId: number; readOnly?: boolean }>()
const emit = defineEmits<{ close: []; saved: [context: TeamContextSnapshot] }>()
const { panel, trapFocus } = usePanelFocus()
const goal = ref(''), consensusText = ref(''), questionsText = ref(''), query = ref('')
const binding = ref<TeamMemoryBinding | null>(null), options = ref<TeamContextClaimReferenceOption[]>([])
const selected = ref<TeamContextReference[]>([]), busy = ref(false), error = ref('')
const selectedLabels = ref<Record<string, string>>({})
const canEdit = computed(() => !props.readOnly && props.session.creator_user_id === props.currentUserId
  && ['active', 'paused'].includes(props.session.state))
let searchTimer: ReturnType<typeof setTimeout> | undefined
let controller: AbortController | undefined

function reset(snapshot: TeamContextSnapshot | null): void {
  goal.value = snapshot?.goal ?? ''
  consensusText.value = snapshot?.consensus.join('\n') ?? ''
  questionsText.value = snapshot?.open_questions.join('\n') ?? ''
  selected.value = [...(snapshot?.references ?? [])]
  selectedLabels.value = {}
}
watch(() => props.context, reset, { immediate: true })
onMounted(async () => {
  if (!canEdit.value) return
  try { binding.value = await getTeamMemoryBinding(props.session.team_id) }
  catch { binding.value = null }
})
function lines(value: string): string[] { return value.split('\n').map(item => item.trim()).filter(Boolean) }
function referenceLabel(kind: TeamContextReference['source_kind']): string {
  return ({ team_event: '共享事件', memory_claim: '团队 Claim', memory_evidence: '证据', wiki_section: 'Wiki 章节' })[kind]
}
function referenceKey(reference: TeamContextReference): string {
  return `${reference.source_kind}:${reference.source_id}:${reference.source_version}`
}
function removeReference(index: number): void { selected.value.splice(index, 1) }
function scheduleSearch(): void {
  if (searchTimer) clearTimeout(searchTimer)
  controller?.abort()
  if (!binding.value || query.value.trim().length < 2) { options.value = []; return }
  searchTimer = setTimeout(async () => {
    controller = new AbortController()
    try {
      options.value = await searchTeamContextClaimReferences(
        binding.value!.installation_id, binding.value!.owner_scope_id, query.value.trim(), controller.signal,
      )
    } catch (failure) {
      if (!(failure instanceof DOMException && failure.name === 'AbortError')) error.value = failure instanceof Error ? failure.message : '团队知识搜索失败'
    }
  }, 250)
}
function addReference(option: TeamContextClaimReferenceOption): void {
  const reference: TeamContextReference = {
    source_kind: option.sourceKind, source_id: option.sourceId, source_version: option.sourceVersion,
    owner_scope_id: option.ownerScopeId, installation_id: option.installationId,
  }
  if (!selected.value.some(item => item.source_kind === reference.source_kind
    && item.source_id === reference.source_id && item.source_version === reference.source_version)) {
    selected.value.push(reference)
  }
  selectedLabels.value[referenceKey(reference)] = option.label
  options.value = []; query.value = ''
}
async function save(): Promise<void> {
  busy.value = true; error.value = ''
  try {
    const context = await createTeamContext(props.session.id, {
      expectedRevision: props.context?.revision ?? 0,
      goal: goal.value.trim(), consensus: lines(consensusText.value), openQuestions: lines(questionsText.value),
      references: selected.value,
    })
    emit('saved', context)
  } catch (failure) { error.value = failure instanceof Error ? failure.message : 'Context 保存失败' }
  finally { busy.value = false }
}
</script>

<style scoped>
.context-panel { width: 300px; min-width: 260px; border-left: 1px solid var(--border); color: var(--fg); background: var(--surface); overflow-y: auto; }.context-panel header { min-height: 62px; display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid var(--border); }.context-panel header div { display: grid; gap: 3px; }.context-panel header span { color: var(--fg-secondary); font-size: 10px; }.context-panel header strong { font-size: 12px; }.context-panel header button { border: 0; color: var(--fg-secondary); background: none; font-size: 22px; cursor: pointer; }.context-body { padding: 16px; }.context-body section { margin-bottom: 22px; }.context-body small { color: var(--accent); font: 650 9px var(--font-mono); letter-spacing: .08em; text-transform: uppercase; }.context-body p,.context-body li { color: var(--fg-secondary); font-size: 11px; line-height: 1.65; }.context-body ul { padding-left: 17px; }.context-empty { padding: 22px 16px; color: var(--fg-tertiary); font-size: 11px; line-height: 1.7; }
.reference-row { display: grid; gap: 3px; padding: 7px 0; border-bottom: 1px solid var(--border); }.reference-row strong { font-size: 10px; }.reference-row code,.memory-option code { color: var(--fg-tertiary); font-size: 8px; }.context-editor { display: grid; gap: 10px; padding: 16px; border-top: 1px solid var(--border); }.context-editor > small { color: var(--accent); font: 650 9px var(--font-mono); text-transform: uppercase; }.context-editor label { display: grid; gap: 5px; color: var(--fg-secondary); font-size: 9px; }.context-editor textarea,.context-editor input { padding: 8px; border: 1px solid var(--border); border-radius: 7px; color: var(--fg); background: var(--bg); font-size: 10px; resize: vertical; }.memory-picker { display: grid; gap: 6px; }.memory-option { display: grid; gap: 4px; padding: 8px; border: 1px solid var(--border); border-radius: 7px; color: var(--fg); background: var(--surface); text-align: left; cursor: pointer; }.memory-option span { font-size: 10px; line-height: 1.4; }.save-context { padding: 8px; border: 0; border-radius: 7px; color: white; background: var(--accent); cursor: pointer; }.panel-error { color: var(--error); font-size: 10px; }
.selected-references { display: grid; gap: 6px; }.selected-references > small { color: var(--fg-secondary); font-size: 9px; }.selected-reference { display: flex; align-items: flex-start; gap: 8px; padding: 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg); }.selected-reference .reference-row { flex: 1; min-width: 0; padding: 0; border: 0; }.selected-reference p { margin: 2px 0; color: var(--fg-secondary); font-size: 10px; line-height: 1.4; }.selected-reference code { overflow-wrap: anywhere; }.remove-reference { flex-shrink: 0; padding: 3px 6px; border: 1px solid var(--border); border-radius: 5px; color: var(--fg-secondary); background: var(--surface); font-size: 9px; cursor: pointer; }.remove-reference:disabled { opacity: .5; cursor: default; }.reference-hint { margin: 0; color: var(--fg-tertiary); font-size: 9px; line-height: 1.5; }
@media (max-width: 900px) { .context-panel { position: absolute; inset: 62px 0 0 auto; z-index: 80; width: min(330px, 88vw); box-shadow: -12px 0 30px rgba(0,0,0,.18); } }
.context-panel { position:fixed; inset:0 0 0 auto; z-index:110; width:470px; max-width:100vw; min-width:0; box-shadow:var(--shadow-lg); box-sizing:border-box; background:var(--bg); }.context-panel header { padding:20px 24px; min-height:70px; }.context-panel header span { font-size:14px; color:var(--fg); }.context-panel header strong { font-size:12px; }.context-panel :deep(p),.context-panel :deep(li) { font-size:12px; line-height:1.8; }
</style>
