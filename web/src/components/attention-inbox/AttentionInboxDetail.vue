<template>
  <section class="attention-detail" data-testid="attention-detail" aria-live="polite">
    <header class="detail-head">
      <div>
        <span :class="['risk-tag', `risk-${item.risk.level}`]">{{ item.risk.level }} · {{ item.kind }}</span>
        <span v-if="item.expires_at" class="expiry">{{ t('attention.expires') }} {{ formatExpiry(item.expires_at) }}</span>
      </div>
      <button v-if="mobile" type="button" class="detail-close" :aria-label="t('common.back')" @click="$emit('close')">×</button>
    </header>

    <h2>{{ item.title }}</h2>
    <p class="detail-meta">{{ providerLabel }} · {{ item.daemon.display_name }} · {{ item.session.title }}</p>
    <p v-if="item.summary" class="detail-summary">{{ item.summary }}</p>

    <div v-if="contextText" class="context-card">
      <span>{{ contextLabel }}</span>
      <code>{{ contextText }}</code>
      <small v-if="item.context.cwd">{{ item.context.cwd }}</small>
    </div>

    <div v-if="questions.length" class="question-stack">
      <fieldset v-for="(question, questionIndex) in questions" :key="question.id || questionIndex">
        <legend>{{ question.header || question.question }}</legend>
        <p v-if="question.header">{{ question.question }}</p>
        <button
          v-for="option in normalizedOptions(question)"
          :key="option.label"
          type="button"
          class="question-option"
          :class="{ selected: selectedAnswers[questionIndex]?.includes(option.label) }"
          :data-option="option.label"
          @click="toggleOption(questionIndex, option.label, question.multiple === true)"
        >
          <span>{{ selectedAnswers[questionIndex]?.includes(option.label) ? '●' : '○' }}</span>
          <span><strong>{{ option.label }}</strong><small v-if="option.description">{{ option.description }}</small></span>
        </button>
        <input
          v-if="question.custom || normalizedOptions(question).length === 0"
          v-model="customAnswers[questionIndex]"
          :type="question.secret ? 'password' : 'text'"
          :autocomplete="question.secret ? 'new-password' : 'off'"
          :placeholder="t('attention.custom_answer')"
          @input="clearExclusiveOptions(questionIndex, question.multiple === true)"
        />
      </fieldset>
    </div>

    <section v-if="riskReasonLabels.length" class="risk-reasons" data-testid="attention-risk-reasons">
      <h3>{{ t('attention.risk_reasons') }}</h3>
      <ul>
        <li v-for="reason in riskReasonLabels" :key="reason">{{ reason }}</li>
      </ul>
    </section>

    <div v-if="item.risk.classification_incomplete" class="classification-note">
      <span aria-hidden="true">◇</span>
      <span>{{ t('attention.classification_incomplete') }}</span>
    </div>
    <div v-if="readOnly" class="read-only-note">{{ t('attention.observe_read_only') }}</div>
    <div v-else-if="item.state === 'result_unknown'" class="unknown-note">{{ t('attention.result_unknown_help') }}</div>

    <div class="detail-actions">
      <button
        v-for="action in actions"
        :key="action.id"
        type="button"
        :class="['action-button', action.style, { destructive: action.destructive }]"
        :data-action-id="action.id"
        :disabled="busy || (action.id === 'answer' && !answersComplete)"
        @click="submit(action.id)"
      >{{ actionLabel(action.id) }}</button>
      <button
        v-if="item.state === 'open'"
        type="button"
        class="action-button quiet"
        data-testid="attention-snooze"
        :disabled="busy"
        @click="$emit('snooze')"
      >{{ t('attention.snooze') }}</button>
      <button
        v-if="item.state === 'snoozed'"
        type="button"
        class="action-button quiet"
        data-testid="attention-restore"
        :disabled="busy"
        @click="$emit('restore')"
      >{{ t('attention.restore') }}</button>
    </div>

    <footer>
      <span>{{ t('attention.terminal_available') }}</span>
      <button type="button" data-testid="attention-open-session" @click="$emit('open-session')">{{ t('attention.open_session') }} →</button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { AttentionActionID, AttentionInboxAction, AttentionInboxItem, AttentionQuestion, AttentionQuestionOption } from '../../types/attentionInbox'

const props = defineProps<{
  item: AttentionInboxItem
  actions: AttentionInboxAction[]
  readOnly: boolean
  mobile?: boolean
  busy?: boolean
}>()
const emit = defineEmits<{
  (event: 'submit', actionID: AttentionActionID, answers?: string[][]): void
  (event: 'snooze'): void
  (event: 'restore'): void
  (event: 'open-session'): void
  (event: 'close'): void
}>()
const { t } = useLocale()
const selectedAnswers = ref<string[][]>([])
const customAnswers = ref<string[]>([])
const questions = computed(() => props.item.context.questions ?? [])
const providerLabel = computed(() => props.item.provider === 'opencode' ? 'OpenCode' : 'Codex')
const contextText = computed(() => props.item.context.command || props.item.context.description || props.item.context.permission_name || '')
const contextLabel = computed(() => props.item.context.command ? t('attention.command') : t('attention.context'))
const riskReasonKeys: Record<string, string> = {
  executes_command: 'attention.risk_reason.executes_command',
  changes_files: 'attention.risk_reason.changes_files',
  requests_permissions: 'attention.risk_reason.requests_permissions',
  requires_user_input: 'attention.risk_reason.requires_user_input',
}
const riskReasonLabels = computed(() => {
  const seen = new Set<string>()
  return props.item.risk.reasons
    .filter((reason) => riskReasonKeys[reason] && !seen.has(reason) && seen.add(reason))
    .slice(0, 4)
    .map((reason) => t(riskReasonKeys[reason]))
})

function resetAnswers(): void {
  selectedAnswers.value = questions.value.map(() => [])
  customAnswers.value = questions.value.map(() => '')
}
watch(() => props.item.item_id, resetAnswers, { immediate: true })

function normalizedOptions(question: AttentionQuestion): AttentionQuestionOption[] {
  return (question.options ?? []).map(option => typeof option === 'string' ? { label: option } : option)
}

function toggleOption(index: number, label: string, multiple: boolean): void {
  const values = selectedAnswers.value[index] ?? []
  if (!multiple) {
    selectedAnswers.value[index] = [label]
    customAnswers.value[index] = ''
    return
  }
  selectedAnswers.value[index] = values.includes(label) ? values.filter(value => value !== label) : [...values, label]
}

function clearExclusiveOptions(index: number, multiple: boolean): void {
  if (!multiple && customAnswers.value[index]?.trim()) selectedAnswers.value[index] = []
}

const answers = computed(() => questions.value.map((question, index) => {
  const values = [...(selectedAnswers.value[index] ?? [])]
  const custom = customAnswers.value[index]?.trim()
  if (custom && !values.includes(custom)) values.push(custom)
  return values
}))
const answersComplete = computed(() => questions.value.length > 0 && answers.value.every((values, index) =>
  values.length > 0 && (questions.value[index].multiple === true || values.length === 1),
))

function submit(actionID: AttentionActionID): void {
  emit('submit', actionID, actionID === 'answer' ? answers.value : undefined)
}

function actionLabel(actionID: AttentionActionID): string {
  return t(`attention.action.${actionID}`)
}

function formatExpiry(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}
</script>

<style scoped>
.attention-detail { min-width: 0; min-height: 100%; display: flex; flex-direction: column; padding: 27px; color: var(--fg); }
.detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.detail-head > div { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.risk-tag { padding: 5px 9px; border: 1px solid currentColor; border-radius: var(--radius-full); color: var(--accent); font: 700 10px var(--font-mono); letter-spacing: .06em; text-transform: uppercase; }
.risk-tag.risk-critical { color: var(--error); }.risk-tag.risk-high { color: var(--warning); }.risk-tag.risk-low { color: var(--success); }
.expiry { color: var(--fg-tertiary); font: 10px var(--font-mono); }
.detail-close { width: 32px; height: 32px; border: 0; border-radius: 50%; color: var(--fg-secondary); background: var(--surface-hover); font-size: 21px; }
h2 { margin: 20px 0 7px; font-size: clamp(20px, 2.2vw, 29px); line-height: 1.17; letter-spacing: -.035em; }
.detail-meta { margin: 0; color: var(--fg-tertiary); font: 11px var(--font-mono); }
.detail-summary { margin: 16px 0 0; color: var(--fg-secondary); font-size: 13px; line-height: 1.6; }
.context-card { display: flex; flex-direction: column; gap: 9px; margin-top: 20px; padding: 15px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg); }
.context-card > span { color: var(--fg-tertiary); font-size: 10px; font-weight: 720; letter-spacing: .08em; text-transform: uppercase; }
.context-card code { color: var(--fg); font: 12px/1.65 var(--font-mono); overflow-wrap: anywhere; white-space: pre-wrap; }
.context-card small { color: var(--fg-tertiary); font: 10px var(--font-mono); }
.question-stack { display: grid; gap: 13px; margin-top: 18px; }
fieldset { display: grid; gap: 8px; margin: 0; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-md); }
legend { padding: 0 5px; font-size: 13px; font-weight: 670; } fieldset p { margin: 0; color: var(--fg-secondary); font-size: 12px; }
.question-option { display: flex; align-items: flex-start; gap: 9px; width: 100%; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--fg); background: var(--surface); text-align: left; }
.question-option.selected { border-color: var(--accent); background: var(--accent-muted); }
.question-option strong, .question-option small { display: block; }.question-option small { margin-top: 3px; color: var(--fg-tertiary); }
fieldset input { width: 100%; padding: 10px 11px; border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--fg); background: var(--bg); }
.risk-reasons { margin-top: 18px; padding: 13px 14px; border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border)); border-radius: var(--radius-md); background: color-mix(in srgb, var(--accent) 6%, var(--surface)); }
.risk-reasons h3 { margin: 0 0 8px; color: var(--fg-tertiary); font: 720 10px var(--font-mono); letter-spacing: .08em; text-transform: uppercase; }
.risk-reasons ul { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.risk-reasons li { position: relative; padding-left: 15px; color: var(--fg-secondary); font-size: 12px; line-height: 1.45; }
.risk-reasons li::before { position: absolute; left: 0; color: var(--accent); content: "◆"; font-size: 7px; top: 4px; }
.classification-note, .read-only-note, .unknown-note { display: flex; gap: 8px; margin-top: 17px; padding: 10px 12px; border-radius: var(--radius-sm); color: var(--warning); background: color-mix(in srgb, var(--warning) 10%, transparent); font-size: 12px; }
.detail-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
.action-button { min-height: 40px; padding: 0 14px; border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--fg); background: var(--surface-hover); font-size: 12px; font-weight: 680; cursor: pointer; }
.action-button.primary { border-color: var(--accent); color: var(--bg); background: var(--accent); }
.action-button.destructive { color: var(--error); }.action-button:disabled { opacity: .45; cursor: default; }
footer { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-top: auto; padding-top: 24px; color: var(--fg-tertiary); font-size: 11px; }
footer button { padding: 0; border: 0; color: var(--accent); background: transparent; cursor: pointer; }
@media (max-width: 820px) { .attention-detail { min-height: calc(100dvh - 24px); padding: 20px 17px max(24px, env(safe-area-inset-bottom)); } }
</style>
