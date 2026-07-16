<template>
  <div class="opencode-question-card">
    <div class="question-header">
      <span class="question-icon">?</span>
      <strong>{{ t('question.title') }}</strong>
      <span v-if="isPending" class="question-waiting">{{ message.submitting ? t('question.submitting') : t('question.waiting') }}</span>
    </div>

    <div v-for="(question, questionIndex) in questions" :key="questionIndex" class="question-block">
      <div class="question-label">
        <span v-if="question.header" class="question-tag">{{ question.header }}</span>
        <span v-if="question.multiple" class="question-multiple">{{ t('question.multiple') }}</span>
      </div>
      <div class="question-text">{{ question.question }}</div>
      <div class="question-options">
        <button
          v-for="option in question.options || []"
          :key="option.label"
          type="button"
          class="question-option"
          :class="{ selected: selected[questionIndex]?.has(option.label) }"
          :disabled="controlsDisabled"
          @click="toggleOption(questionIndex, option.label)"
        >
          <span class="option-mark">{{ question.multiple ? '✓' : '●' }}</span>
          <span><strong>{{ option.label }}</strong><small v-if="option.description">{{ option.description }}</small></span>
        </button>
      </div>
      <input
        v-if="question.custom"
        v-model="custom[questionIndex]"
        class="question-custom"
        type="text"
        maxlength="4096"
        :disabled="controlsDisabled"
        :placeholder="t('question.custom_placeholder')"
        @input="onCustomInput(questionIndex)"
      />
    </div>

    <div v-if="message.error" class="question-error">{{ message.error }}</div>
    <div v-if="isPending" class="question-actions">
      <button class="question-submit" type="button" :disabled="controlsDisabled || !valid" @click="submit">{{ t('question.submit') }}</button>
      <button class="question-reject" type="button" :disabled="controlsDisabled" @click="$emit('reject', message)">{{ t('question.reject') }}</button>
    </div>
    <div v-else class="question-result">{{ message.rejected ? t('question.rejected') : t('question.answered') }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'

interface QuestionOption { label: string; description?: string }
interface QuestionInfo { header?: string; question: string; options?: QuestionOption[]; multiple?: boolean; custom?: boolean }

const { t } = useLocale()
const props = withDefaults(defineProps<{ message: any; disabled?: boolean }>(), { disabled: false })
const emit = defineEmits<{
  (event: 'submit', message: any, answers: string[][]): void
  (event: 'reject', message: any): void
}>()

const questions = computed<QuestionInfo[]>(() => Array.isArray(props.message.questions) ? props.message.questions : [])
const selected = reactive<Array<Set<string>>>([])
const custom = reactive<string[]>([])
const isPending = computed(() => props.message.status === 'pending')
const controlsDisabled = computed(() => props.disabled || !!props.message.submitting || !isPending.value)

function resetState() {
  selected.splice(0, selected.length, ...questions.value.map(() => new Set<string>()))
  custom.splice(0, custom.length, ...questions.value.map(() => ''))
}
watch(() => props.message.request_id, resetState, { immediate: true })

function toggleOption(questionIndex: number, label: string) {
  if (controlsDisabled.value) return
  const question = questions.value[questionIndex]
  if (!question.multiple) {
    selected[questionIndex].clear()
    custom[questionIndex] = ''
  }
  if (question.multiple && selected[questionIndex].has(label)) selected[questionIndex].delete(label)
  else selected[questionIndex].add(label)
}

function onCustomInput(questionIndex: number) {
  if (!questions.value[questionIndex].multiple && custom[questionIndex].trim()) selected[questionIndex].clear()
}

function answers(): string[][] {
  return questions.value.map((question, index) => {
    const ordered = (question.options || []).map(option => option.label).filter(label => selected[index]?.has(label))
    const value = custom[index]?.trim()
    if (value) ordered.push(value)
    return ordered
  })
}
const valid = computed(() => questions.value.length > 0 && answers().every((answer, index) => answer.length > 0 && (questions.value[index].multiple || answer.length === 1)))

function submit() {
  if (!valid.value || controlsDisabled.value) return
  emit('submit', props.message, answers())
}
</script>

<style scoped>
.opencode-question-card { width: 100%; display: flex; flex-direction: column; gap: 12px; padding: 14px 16px; background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: var(--radius-lg); }
.question-header { display: flex; align-items: center; gap: 7px; color: var(--accent); font-size: 12px; }
.question-icon { display: grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: var(--accent-muted); font-weight: 800; }
.question-waiting { margin-left: auto; color: var(--fg-tertiary); font-weight: 400; }
.question-block { display: flex; flex-direction: column; gap: 8px; padding-top: 10px; border-top: 1px solid var(--border); }
.question-label { display: flex; align-items: center; gap: 6px; }
.question-tag, .question-multiple { font-size: 10px; color: var(--fg-tertiary); text-transform: uppercase; letter-spacing: .5px; }
.question-multiple { padding: 1px 5px; background: var(--surface-hover); border-radius: var(--radius-full); }
.question-text { color: var(--fg); font-size: 14px; font-weight: 600; }
.question-options { display: flex; flex-direction: column; gap: 6px; }
.question-option { display: flex; align-items: flex-start; gap: 8px; width: 100%; padding: 8px 10px; text-align: left; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg); color: var(--fg); cursor: pointer; }
.question-option.selected { border-color: var(--accent); background: var(--accent-muted); }
.question-option:disabled { cursor: not-allowed; opacity: .55; }
.option-mark { width: 16px; color: var(--accent); opacity: .35; }
.selected .option-mark { opacity: 1; }
.question-option strong { display: block; font-size: 12px; }
.question-option small { display: block; margin-top: 2px; color: var(--fg-tertiary); font-size: 11px; }
.question-custom { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg); color: var(--fg); outline: none; }
.question-custom:focus { border-color: var(--accent); }
.question-actions { display: flex; gap: 8px; }
.question-submit, .question-reject { padding: 7px 13px; border-radius: var(--radius-md); font-size: 12px; font-weight: 600; cursor: pointer; }
.question-submit { border: 1px solid var(--accent); background: var(--accent); color: #fff; }
.question-reject { border: 1px solid var(--border); background: var(--surface-active); color: var(--fg-secondary); }
.question-submit:disabled, .question-reject:disabled { cursor: not-allowed; opacity: .45; }
.question-error { color: var(--error, #ef4444); font-size: 11px; }
.question-result { color: var(--fg-secondary); font-size: 12px; font-weight: 600; }
</style>
