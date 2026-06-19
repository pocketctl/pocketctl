<template>
  <!-- Tool call: full-width card. No left bar (too noisy); the card itself
       (border + surface bg) is the visual container, matching codex/zcode. -->
  <div class="tool-wrap">
    <div :class="['tool-card', { expanded: message.expanded }]" @click="toggleExpand">
      <!-- Header -->
      <div class="tool-header">
        <ToolIcon :tool="message.tool || ''" class="tool-icon" />
        <span class="tool-name">{{ message.tool || 'Unknown' }}</span>
        <span class="tool-args">{{ args }}</span>
        <span class="tool-status">
          <!-- check icon -->
          <svg v-if="message.status === 'completed'" class="status-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 6L9 17l-5-5" />
          </svg>
          <span v-else class="spinner"></span>
        </span>
        <!-- chevron icon -->
        <svg class="tool-chevron" :class="{ open: message.expanded }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </div>

      <!-- Body -->
      <div v-if="message.expanded" class="tool-body" @click.stop>
        <!-- Input -->
        <div class="tool-section">
          <div class="tool-label">{{ t('session.tool_input') }}</div>
        </div>
        <div class="tool-code tool-input">{{ inputText }}</div>

        <!-- Output -->
        <template v-if="fullOutput">
          <div class="tool-section">
            <div class="tool-label">{{ t('session.tool_output') }}</div>
          </div>
          <div class="tool-output-wrap">
            <!-- Fenced code block → MarkdownRenderer applies syntax highlight + copy -->
            <MarkdownRenderer :content="fencedOutput" />
          </div>
          <button
            v-if="isLongOutput"
            class="toggle-expand"
            @click.stop="toggleOutput"
          >{{ message.outputExpanded ? t('session.tool_collapse') : `${t('session.tool_expand')} (${outputLineCount})` }}</button>
        </template>

        <!-- Running placeholder -->
        <div v-else-if="message.status !== 'completed'" class="tool-running">
          <span class="spinner"></span>
          <span>{{ t('session.tool_running') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'
import MarkdownRenderer from '../MarkdownRenderer.vue'
import ToolIcon from './ToolIcon.vue'
import { toolArgs, toolInputText, inferOutputLanguage } from '../../utils/toolDisplay'

const { t } = useLocale()

const props = defineProps<{ message: any }>()
const emit = defineEmits<{ (e: 'toggleExpand'): void; (e: 'toggleOutput'): void }>()

const args = computed(() => toolArgs(props.message))
const inputText = computed(() => toolInputText(props.message))

const outputLang = computed(() => inferOutputLanguage(props.message.tool, props.message.inputDesc || ''))

const fullOutput = computed(() => props.message.output || '')

const COLLAPSED_OUTPUT_LINES = 25
const outputLineCount = computed(() => fullOutput.value.split('\n').length)
const isLongOutput = computed(() => outputLineCount.value > COLLAPSED_OUTPUT_LINES)

const displayOutput = computed(() => {
  if (!isLongOutput.value || props.message.outputExpanded) return fullOutput.value
  return fullOutput.value.split('\n').slice(0, COLLAPSED_OUTPUT_LINES).join('\n')
})

const fencedOutput = computed(() => {
  const lang = outputLang.value || ''
  return '```' + lang + '\n' + displayOutput.value + '\n```'
})

function toggleExpand() { emit('toggleExpand') }
function toggleOutput() { emit('toggleOutput') }
</script>

<style scoped>
.tool-wrap {
  width: 100%;
  min-width: 0;
  animation: fade-in 0.2s ease;
}

.tool-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  cursor: pointer;
  /* min-width:0 so long code/output inside doesn't stretch the card width */
  min-width: 0;
  transition: background var(--transition), border-color var(--transition);
}
.tool-card:hover { border-color: var(--border-light); }

.tool-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  min-width: 0;
}
.tool-icon { color: var(--accent); flex-shrink: 0; }
.tool-name {
  font-weight: 600;
  font-size: 13px;
  color: var(--accent);
  flex-shrink: 0;
}
.tool-args {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--fg-tertiary);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-status { flex-shrink: 0; display: flex; align-items: center; }
.status-check { color: var(--success); }
.tool-status .spinner {
  width: 13px;
  height: 13px;
  border: 2px solid transparent;
  border-top-color: var(--fg-secondary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  display: inline-block;
}
.tool-chevron {
  color: var(--fg-tertiary);
  flex-shrink: 0;
  transition: transform 0.15s;
}
.tool-chevron.open { transform: rotate(180deg); }

.tool-body {
  border-top: 1px solid var(--border);
  padding: 8px 14px 10px;
  /* CRITICAL: allow body to shrink below its content's intrinsic min-width
     (which equals the longest code line). Without this, long tool output
     stretches the body → card → chat column. */
  min-width: 0;
  overflow: hidden;
}
.tool-section { padding: 4px 0; }
.tool-label {
  font-size: 11px;
  color: var(--fg-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 4px;
}
.tool-code {
  background: var(--code-bg);
  padding: 8px 12px;
  font-family: var(--font-mono);
  font-size: 12px;
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-all;
}
.tool-input { color: var(--success); }
.tool-output-wrap { min-width: 0; }
.tool-output-wrap :deep(.md-code-block) {
  margin: 4px 0 0;
  /* Constrain code block so very long single-line content (e.g. minified
     JSON / system init blobs) scrolls inside the block instead of stretching
     the whole chat column. */
  max-width: 100%;
  min-width: 0;
}
.tool-running {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  font-size: 13px;
  color: var(--fg-secondary);
}
.toggle-expand {
  background: none;
  border: none;
  color: var(--accent);
  font-size: 12px;
  padding: 6px 0 0;
  cursor: pointer;
  font-family: var(--font-body);
}

@keyframes spin { to { transform: rotate(360deg); } }
@keyframes fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
