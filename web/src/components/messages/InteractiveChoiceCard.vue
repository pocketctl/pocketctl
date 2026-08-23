<template>
  <!--
    Interactive selection card — rendered inline when the daemon scans a
    selection menu the agent's TUI drew to the PTY (e.g. a host PreToolUse
    hook's "Do you want to proceed? ❶ Yes ❷ No" prompt that never reaches the
    JSONL history). Shows the prompt text and a clickable, numbered option
    list; clicking one sends interactive_response back so the daemon writes the
    index to the PTY and the agent continues. After answering, the chosen row
    is highlighted and the rest are dimmed.
  -->
  <div class="choice-card-wrap">
    <div class="choice-card">
      <!-- Header -->
      <div class="choice-header">
        <span class="choice-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </span>
        <span class="choice-tag">{{ t('interactive.title') }}</span>
        <span v-if="isPending" class="choice-waiting">{{ t('interactive.waiting') }}</span>
      </div>

      <!-- Prompt text (the question phrase parsed from the menu) -->
      <div v-if="promptText" class="choice-prompt">{{ promptText }}</div>
      <div v-if="isPending && disabledReason" class="interaction-readiness" role="status">
        <span>{{ disabledReason }}</span>
        <button v-if="message.resultUnknown" type="button" @click.stop="$emit('resync')">{{ t('interaction.resync') }}</button>
      </div>

      <!-- Options -->
      <div class="choice-options">
        <button
          v-for="opt in options"
          :key="opt.index"
          class="choice-option"
          :class="{ selected: !isPending && message.selectedChoice === opt.index, dim: !isPending && message.selectedChoice !== opt.index }"
          :disabled="!isPending || disabled || message.submitting || message.resultUnknown"
          @click.stop="choose(opt)"
        >
          <span class="choice-index">{{ opt.index }}</span>
          <span class="choice-label">{{ opt.label }}</span>
          <svg v-if="!isPending && message.selectedChoice === opt.index" class="choice-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'

const { t } = useLocale()
const props = withDefaults(defineProps<{ message: any; disabled?: boolean; disabledReason?: string }>(), {
  disabled: false,
  disabledReason: '',
})
const emit = defineEmits<{
  (e: 'respond', message: any, choice: string): void
  (e: 'resync'): void
}>()

const isPending = computed(() => props.message.status === 'pending')
const promptText = computed(() => props.message.prompt || '')

interface ChoiceOption { index: string; label: string }
const options = computed<ChoiceOption[]>(() => props.message.options || [])

function choose(opt: ChoiceOption) {
  if (!isPending.value || props.disabled || props.message.submitting || props.message.resultUnknown) return
  emit('respond', props.message, opt.index)
}
</script>

<style scoped>
.choice-card-wrap { width: 100%; animation: fade-in 0.2s ease; }

.choice-card {
  display: flex; flex-direction: column; gap: 10px;
  padding: 14px 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--warning, #F59E0B);
  border-radius: var(--radius-lg);
}

.choice-header { display: flex; align-items: center; gap: 6px; }
.choice-icon { color: var(--warning, #F59E0B); display: flex; }
.choice-tag {
  font-size: 11px; font-weight: 700; color: var(--warning, #F59E0B);
  text-transform: uppercase; letter-spacing: 0.6px;
}
.choice-waiting {
  margin-left: auto; font-size: 11px; color: var(--fg-tertiary);
  display: flex; align-items: center; gap: 5px;
}
.choice-waiting::before {
  content: ''; width: 6px; height: 6px; border-radius: 50%;
  background: var(--warning, #F59E0B); animation: pulse 1.2s ease-in-out infinite;
}

.choice-prompt {
  font-size: 13px; line-height: 1.5; color: var(--fg);
  font-family: var(--font-mono); white-space: pre-wrap; word-break: break-word;
}
.interaction-readiness { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--warning); font-size: 12px; }
.interaction-readiness button { padding: 5px 9px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-active); color: var(--fg); cursor: pointer; }

.choice-options { display: flex; flex-direction: column; gap: 6px; }

.choice-option {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  text-align: left; cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.choice-option:hover:not(:disabled) { border-color: var(--accent); }
.choice-option:disabled { cursor: default; }

.choice-index {
  display: flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border-radius: 50%;
  background: var(--accent-muted); color: var(--accent);
  font-family: var(--font-mono); font-size: 12px; font-weight: 700; flex-shrink: 0;
}
.choice-label { font-size: 13px; font-weight: 500; color: var(--fg); }

.choice-option.selected { border-color: var(--success, #10B981); background: var(--success-muted, rgba(16,185,129,0.08)); }
.choice-option.selected .choice-index { background: var(--success, #10B981); color: #fff; }
.choice-option.selected .choice-label { color: var(--success, #10B981); font-weight: 600; }
.choice-check { margin-left: auto; color: var(--success, #10B981); flex-shrink: 0; }
.choice-option.dim { opacity: 0.45; }

@keyframes fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
</style>
