<template>
  <!--
    AskUserQuestion card — renders Claude's AskUserQuestion tool call as a
    readable question + options card instead of raw JSON.
    Display only (no click-to-answer in this version).
  -->
  <div class="question-card-wrap">
    <div v-for="(q, qi) in questions" :key="qi" class="question-block">
      <!-- Question header -->
      <div class="q-header">
        <svg class="q-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <span class="q-header-tag" v-if="q.header">{{ q.header }}</span>
        <span v-if="q.multiSelect" class="q-multi-badge">多选</span>
      </div>

      <!-- Question text -->
      <div class="q-text">{{ q.question }}</div>

      <!-- Options -->
      <div class="q-options">
        <div v-for="(opt, oi) in (q.options || [])" :key="oi" class="q-option">
          <div class="q-option-label">
            <span class="q-option-letter">{{ String.fromCharCode(65 + oi) }}</span>
            <span class="q-option-title">{{ opt.label }}</span>
          </div>
          <span v-if="opt.description" class="q-option-desc">{{ opt.description }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ message: any }>()

interface Question {
  question: string
  header?: string
  multiSelect?: boolean
  options?: Array<{ label: string; description?: string; preview?: string }>
}

const questions = computed<Question[]>(() => {
  const input = props.message?.input
  if (!input) return []
  // input may be a parsed object or a JSON string
  let parsed = input
  if (typeof input === 'string') {
    try { parsed = JSON.parse(input) } catch { return [] }
  }
  if (Array.isArray(parsed?.questions)) return parsed.questions
  return []
})
</script>

<style scoped>
.question-card-wrap { width: 100%; max-width: 100%; min-width: 0; animation: fade-in 0.2s ease; }

.question-block {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 14px 16px;
}

.q-header { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.q-icon { color: var(--accent); flex-shrink: 0; }
.q-header-tag {
  font-size: 11px; font-weight: 700; color: var(--accent);
  text-transform: uppercase; letter-spacing: 0.6px;
}
.q-multi-badge {
  font-size: 10px; font-weight: 600; color: var(--fg-tertiary);
  background: var(--surface-hover); padding: 1px 6px; border-radius: var(--radius-full);
}

.q-text { font-size: 14px; line-height: 1.6; color: var(--fg); margin-bottom: 12px; font-weight: 500; }

.q-options { display: flex; flex-direction: column; gap: 6px; }
.q-option {
  display: flex; flex-direction: column; gap: 2px;
  padding: 10px 12px; background: var(--bg);
  border: 1px solid var(--border); border-radius: var(--radius-md);
  transition: border-color 0.15s;
}
.q-option:hover { border-color: var(--border-light); }
.q-option-label { display: flex; align-items: center; gap: 8px; }
.q-option-letter {
  display: flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; border-radius: 50%;
  background: var(--accent-muted); color: var(--accent);
  font-size: 11px; font-weight: 700; flex-shrink: 0;
  font-family: var(--font-mono);
}
.q-option-title { font-size: 13px; font-weight: 600; color: var(--fg); }
.q-option-desc { font-size: 12px; color: var(--fg-tertiary); line-height: 1.4; margin-left: 28px; }

@keyframes fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
