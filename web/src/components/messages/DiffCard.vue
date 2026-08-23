<template>
  <!-- Diff card for Edit/MultiEdit/Write tool calls. Same full-width card
       shell as ToolCallCard, but the body renders a line-level diff view
       (green additions / red deletions) instead of a flat code block. -->
  <div class="tool-wrap">
    <div :class="['tool-card', { expanded: message.expanded }]" @click="toggleExpand">
      <!-- Header (mirrors ToolCallCard) -->
      <div class="tool-header">
        <ToolIcon :tool="message.tool || ''" class="tool-icon" />
        <span class="tool-name">{{ message.tool || 'Unknown' }}</span>
        <span class="tool-args">{{ filePath || '' }}</span>
        <span v-if="isNewFile" class="diff-badge new">{{ t('session.diff_new_file') }}</span>
        <span class="tool-status">
          <svg v-if="message.status === 'completed'" class="status-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 6L9 17l-5-5" />
          </svg>
          <svg v-else-if="message.status === 'timeout'" class="status-timeout" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>
          </svg>
          <svg v-else-if="message.status === 'unknown'" class="status-unknown" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>
          </svg>
          <span v-else class="spinner"></span>
        </span>
        <svg class="tool-chevron" :class="{ open: message.expanded }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </div>

      <!-- Body: line-level diff -->
      <div v-if="message.expanded" class="tool-body" @click.stop>
        <!-- Running / timeout placeholder -->
        <div v-if="message.status === 'timeout'" class="tool-running timeout">
          <span class="status-timeout-text">{{ t('session.tool_timeout') }}</span>
        </div>
        <div v-else-if="message.status === 'unknown'" class="tool-running unknown">
          <span class="status-unknown-text">{{ t('session.tool_result_unknown') }}</span>
        </div>
        <div v-else-if="message.status !== 'completed'" class="tool-running">
          <span class="spinner"></span>
          <span>{{ t('session.tool_running') }}</span>
        </div>

        <template v-else>
          <!-- Summary: +N -M -->
          <div class="diff-summary">
            <span class="diff-add-count">+{{ summary.additions }}</span>
            <span class="diff-del-count">-{{ summary.deletions }}</span>
          </div>

          <!-- One table per diff block (MultiEdit → multiple blocks) -->
          <div
            v-for="block in visibleBlocks"
            :key="block.index ?? 's'"
            class="diff-block"
          >
            <div v-if="block.index != null" class="diff-block-label">
              {{ t('session.diff_edit_n', { n: block.index }) }}
            </div>
            <div class="diff-table-wrap">
              <table class="diff-table">
                <tbody>
                  <tr v-for="(line, li) in block.lines" :key="li" :class="'diff-line diff-' + line.type">
                    <td class="diff-lineno old">{{ line.oldLine ?? '' }}</td>
                    <td class="diff-lineno new">{{ line.newLine ?? '' }}</td>
                    <td class="diff-sign">{{ line.type === 'add' ? '+' : line.type === 'del' ? '-' : '' }}</td>
                    <td class="diff-code"><pre>{{ line.text }}</pre></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- Collapse / expand for long diffs -->
          <button
            v-if="isLong"
            class="toggle-expand"
            @click.stop="toggleExpandOutput"
          >{{ message.outputExpanded ? t('session.tool_collapse') : t('session.tool_expand') }}</button>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'
import ToolIcon from './ToolIcon.vue'
import { buildDiffBlocks, sumChanges, diffFilePath, type DiffBlock } from '../../utils/diffRender'

const { t } = useLocale()

const props = defineProps<{ message: any }>()
const emit = defineEmits<{ (e: 'toggleExpand'): void; (e: 'toggleOutput'): void }>()

const filePath = computed(() => diffFilePath(props.message.input))
const blocks = computed<DiffBlock[]>(() => buildDiffBlocks(props.message.input, props.message.tool))
const summary = computed(() => sumChanges(blocks.value))
const isNewFile = computed(() => props.message.tool === 'Write' && summary.value.deletions === 0)

const totalLines = computed(() => blocks.value.reduce((n, b) => n + b.lines.length, 0))
const COLLAPSED_LINES = 50
const isLong = computed(() => totalLines.value > COLLAPSED_LINES)

const visibleBlocks = computed<DiffBlock[]>(() => {
  if (!isLong.value || props.message.outputExpanded) return blocks.value
  // Collapse: show only the first COLLAPSED_LINES across all blocks.
  let remaining = COLLAPSED_LINES
  const out: DiffBlock[] = []
  for (const b of blocks.value) {
    if (remaining <= 0) break
    const take = b.lines.slice(0, remaining)
    if (take.length === b.lines.length) {
      out.push(b)
    } else {
      out.push({ ...b, lines: take })
    }
    remaining -= take.length
  }
  return out
})

function toggleExpand() { emit('toggleExpand') }
function toggleExpandOutput() { emit('toggleOutput') }
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
.diff-badge {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.diff-badge.new {
  color: var(--success);
  background: rgba(63, 185, 80, 0.14);
}
.tool-status { flex-shrink: 0; display: flex; align-items: center; }
.status-check { color: var(--success); }
.status-timeout { color: #e5484d; }
.status-timeout-text { color: #e5484d; font-size: 12px; }
.status-unknown { color: #b7791f; }
.status-unknown-text { color: #b7791f; font-size: 12px; }
.tool-running.timeout { opacity: 0.8; }
.tool-running.unknown { opacity: 0.8; }
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
  min-width: 0;
  overflow: hidden;
}

/* ---- Summary ---- */
.diff-summary {
  display: flex;
  gap: 12px;
  font-size: 12px;
  font-family: var(--font-mono);
  margin-bottom: 6px;
}
.diff-add-count { color: var(--success); font-weight: 600; }
.diff-del-count { color: #e5484d; font-weight: 600; }

/* ---- Diff table ---- */
.diff-block { margin-bottom: 8px; }
.diff-block:last-child { margin-bottom: 0; }
.diff-block-label {
  font-size: 11px;
  color: var(--fg-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 6px 0 4px;
}
.diff-table-wrap {
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow-x: auto;
  max-width: 100%;
  min-width: 0;
  background: var(--code-bg);
}
.diff-table {
  border-collapse: collapse;
  width: 100%;
  min-width: 0;
  table-layout: fixed;
  /* Allow the code column to expand beyond viewport when lines are long;
     the wrapping .diff-table-wrap handles horizontal scrolling. */
}
.diff-table td {
  padding: 0;
  vertical-align: top;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
}
.diff-lineno {
  width: 38px;
  min-width: 38px;
  text-align: right;
  padding: 0 8px;
  color: var(--fg-tertiary);
  user-select: none;
  white-space: nowrap;
  border-right: 1px solid var(--border);
  opacity: 0.8;
}
.diff-sign {
  width: 18px;
  min-width: 18px;
  text-align: center;
  user-select: none;
  font-weight: 700;
}
.diff-code {
  /* Take remaining space; allow <pre> to overflow-scroll inside the wrap. */
  padding-left: 8px;
  color: var(--fg);
  white-space: normal;
}
.diff-code pre {
  margin: 0;
  padding: 0;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
  white-space: pre;
  background: none;
  display: inline-block;
  min-width: 100%;
}

/* Line backgrounds + sign color by type */
.diff-line.diff-add { background: rgba(63, 185, 80, 0.12); }
.diff-line.diff-add .diff-sign { color: var(--success); }
.diff-line.diff-del { background: rgba(248, 81, 73, 0.12); }
.diff-line.diff-del .diff-sign { color: #e5484d; }
.diff-line.diff-ctx .diff-sign { color: transparent; }

/* ---- Placeholder / buttons ---- */
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
