<template>
  <div class="tool-call-group">
    <div class="tool-group-card">
      <button type="button" class="tool-group-trigger" :aria-expanded="groupExpanded" :aria-controls="groupBodyId" @click="groupExpanded = !groupExpanded">
        <span class="tool-group-count">{{ messages.length }}</span>
        <span class="tool-group-copy">
          <strong class="tool-group-title">{{ t('session.tool_group_title', { n: messages.length }) }}</strong>
          <small>{{ groupSummary }}</small>
        </span>
        <span :class="['tool-group-status', groupStatusClass]">
          <span v-if="groupStatusClass === 'running'" class="tool-group-spinner"></span>
          <svg v-else-if="groupStatusClass === 'completed'" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4 10-10"/></svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/></svg>
          <span>{{ groupStatusLabel }}</span>
          <span v-if="groupDuration">{{ groupDuration }}</span>
        </span>
        <svg class="tool-group-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>
      </button>

      <div v-if="groupExpanded" :id="groupBodyId" class="tool-group-body">
        <div v-for="(message, index) in messages" :key="messageKey(message, index)" class="tool-step-item">
          <button
            type="button"
            class="tool-step"
            data-tool-detail-toggle
            :aria-expanded="selectedKey === messageKey(message, index)"
            :aria-controls="detailId(message, index)"
            @click="toggleDetail(message, index)"
          >
            <span :class="['tool-step-status', statusClass(message)]">
              <svg v-if="message.status === 'completed'" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4 10-10"/></svg>
              <span v-else-if="message.status === 'running'" class="tool-step-spinner"></span>
              <svg v-else viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/></svg>
            </span>
            <span class="tool-step-name">{{ actionLabel(message.tool) }}</span>
            <span class="tool-step-args">{{ argsFor(message) || message.tool || t('session.tool_unknown') }}</span>
            <span v-if="durationFor(message)" class="tool-step-duration">{{ durationFor(message) }}</span>
            <span class="tool-step-view">{{ t('session.tool_view_detail') }}</span>
            <svg class="tool-step-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 7 5 5-5 5"/></svg>
          </button>

          <section
            v-if="selectedKey === messageKey(message, index)"
            :id="detailId(message, index)"
            class="tool-step-detail"
            :data-tool-detail="message.call_id || message.id || index"
          >
            <div class="tool-detail-head">
              <div><strong>{{ actionLabel(message.tool) }}</strong><small>{{ detailMeta(message) }}</small></div>
              <button type="button" class="tool-detail-close" :aria-label="t('session.tool_close_detail')" @click="closeDetail(message, index, $event)">×</button>
            </div>
            <div class="tool-detail-tabs" role="tablist" :aria-label="t('session.tool_detail_tabs')">
              <button type="button" :class="{ active: tabFor(message, index) === 'input' }" data-detail-tab="input" role="tab" :aria-selected="tabFor(message, index) === 'input'" @click="setTab(message, index, 'input')">{{ t('session.tool_input') }}</button>
              <button type="button" :class="{ active: tabFor(message, index) === 'output' }" data-detail-tab="output" role="tab" :aria-selected="tabFor(message, index) === 'output'" @click="setTab(message, index, 'output')">{{ t('session.tool_output') }} <span v-if="outputText(message)">{{ t('session.tool_output_lines', { n: outputLineCount(message) }) }}</span></button>
            </div>
            <div class="tool-detail-panel" data-detail-panel="input" :hidden="tabFor(message, index) !== 'input'"><pre>{{ inputText(message) || '—' }}</pre></div>
            <div class="tool-detail-panel" data-detail-panel="output" :hidden="tabFor(message, index) !== 'output'">
              <div v-if="message.status === 'running' && !outputText(message)" class="tool-detail-pending"><span class="tool-step-spinner"></span>{{ t('session.tool_running') }}</div>
              <div v-else-if="message.status === 'timeout' && !outputText(message)" class="tool-detail-pending timeout">{{ t('session.tool_timeout') }}</div>
              <div v-else-if="message.status === 'unknown' && !outputText(message)" class="tool-detail-pending unknown">{{ t('session.tool_result_unknown') }}</div>
              <pre v-else :class="['tool-detail-output', { collapsed: isLongOutput(message) && !isOutputExpanded(message, index), expanded: isLongOutput(message) && isOutputExpanded(message, index) }]">{{ outputText(message) || '—' }}</pre>
              <div v-if="outputText(message)" class="tool-detail-actions">
                <span>{{ outputMeta(message) }}</span>
                <div>
                  <button v-if="isLongOutput(message)" type="button" data-output-expand @click="toggleOutput(message, index)">{{ isOutputExpanded(message, index) ? t('session.tool_collapse_output') : t('session.tool_expand') }}</button>
                  <button type="button" data-detail-copy @click="copyOutput(message, index)">{{ copiedKey === messageKey(message, index) ? t('common.copied') : t('session.tool_copy_output') }}</button>
                </div>
              </div>
            </div>
          </section>
        </div>
        <div class="tool-group-footer">
          <span>{{ footerLabel }}</span>
          <button type="button" data-copy-summary @click="copySummary">{{ summaryCopied ? t('common.copied') : t('session.tool_copy_summary') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { toolArgs, toolInputText } from '../../utils/toolDisplay'

const props = defineProps<{ messages: any[] }>()
const { t } = useLocale()
const attentionStatuses = new Set(['running', 'timeout', 'unknown', 'error', 'failed'])
const groupExpanded = ref(props.messages.some(message => attentionStatuses.has(message.status)))
const selectedKey = ref<string | null>(null)
const activeTabs = reactive<Record<string, 'input' | 'output'>>({})
const expandedOutputs = reactive<Record<string, boolean>>({})
const copiedKey = ref<string | null>(null)
const summaryCopied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

const groupBodyId = computed(() => 'tool-group-' + safeId(messageKey(props.messages[0], 0)))
const groupStatusClass = computed(() => {
  if (props.messages.some(message => message.status === 'running')) return 'running'
  if (props.messages.some(message => ['error', 'failed'].includes(message.status))) return 'error'
  if (props.messages.some(message => ['timeout', 'unknown'].includes(message.status))) return 'attention'
  return 'completed'
})
const groupStatusLabel = computed(() => {
  if (groupStatusClass.value === 'running') return t('session.tool_group_running')
  if (groupStatusClass.value === 'error') return t('session.tool_group_failed')
  if (groupStatusClass.value === 'attention') return t('session.tool_group_attention')
  return t('session.tool_group_completed')
})
const groupSummary = computed(() => {
  const counts = new Map<string, number>()
  for (const message of props.messages) {
    const label = actionLabel(message.tool)
    counts.set(label, (counts.get(label) || 0) + 1)
  }
  return [...counts].map(([label, count]) => label + ' ' + count).join(' · ')
})
const groupDuration = computed(() => {
  const values = props.messages.map(durationMs)
  return values.every(value => value !== null) ? formatDuration(values.reduce<number>((sum, value) => sum + (value || 0), 0)) : ''
})
const footerLabel = computed(() => groupStatusClass.value === 'completed' ? t('session.tool_group_footer_completed') : groupStatusLabel.value)

watch(() => props.messages.map(message => message.status).join('|'), () => {
  if (props.messages.some(message => attentionStatuses.has(message.status))) {
    groupExpanded.value = true
    return
  }
  if (props.messages.length > 0 && props.messages.every(message => message.status === 'completed')) {
    groupExpanded.value = false
    selectedKey.value = null
  }
})

function safeId(value: string): string { return value.replace(/[^a-zA-Z0-9_-]/g, '-') }
function messageKey(message: any, index: number): string { return String(message?.call_id || message?.id || 'tool-' + index) }
function detailId(message: any, index: number): string { return 'tool-detail-' + safeId(messageKey(message, index)) }
function actionLabel(tool: string): string {
  if (tool === 'Read') return t('session.tool_action_read')
  if (tool === 'Grep' || tool === 'Glob' || tool === 'WebSearch' || tool === 'WebFetch') return t('session.tool_action_search')
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'ApplyPatch' || tool === 'apply_patch') return t('session.tool_action_update')
  if (tool === 'Bash' || tool === 'Shell' || tool === 'exec_command') return t('session.tool_action_command')
  if (tool === 'Agent' || tool === 'Task') return t('session.tool_action_agent')
  return tool || t('session.tool_action_other')
}
function argsFor(message: any): string { return toolArgs(message) }
function inputText(message: any): string { return toolInputText(message) }
function outputText(message: any): string {
  const value = message?.output
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}
function outputLineCount(message: any): number { return outputText(message).split('\n').length }
function outputMeta(message: any): string {
  const text = outputText(message)
  return t('session.tool_output_meta', { lines: outputLineCount(message), size: new Blob([text]).size })
}
function isLongOutput(message: any): boolean { return outputLineCount(message) > 12 }
function tabFor(message: any, index: number): 'input' | 'output' { return activeTabs[messageKey(message, index)] || 'input' }
function setTab(message: any, index: number, tab: 'input' | 'output'): void { activeTabs[messageKey(message, index)] = tab }
function isOutputExpanded(message: any, index: number): boolean { return !!expandedOutputs[messageKey(message, index)] }
function toggleOutput(message: any, index: number): void {
  const key = messageKey(message, index)
  expandedOutputs[key] = !expandedOutputs[key]
}
function toggleDetail(message: any, index: number): void {
  const key = messageKey(message, index)
  selectedKey.value = selectedKey.value === key ? null : key
}
function closeDetail(message: any, index: number, event: MouseEvent): void {
  if (selectedKey.value !== messageKey(message, index)) return
  const row = (event.currentTarget as HTMLElement | null)?.closest('.tool-step-detail')?.previousElementSibling as HTMLElement | null
  selectedKey.value = null
  void nextTick(() => row?.focus())
}
function statusClass(message: any): string {
  if (message.status === 'running') return 'running'
  if (message.status === 'completed') return 'completed'
  if (message.status === 'error' || message.status === 'failed') return 'error'
  return 'attention'
}
function statusLabel(message: any): string {
  if (message.status === 'running') return t('session.tool_running')
  if (message.status === 'timeout') return t('session.tool_timeout')
  if (message.status === 'unknown') return t('session.tool_result_unknown')
  if (message.status === 'error' || message.status === 'failed') return t('session.tool_group_failed')
  return t('session.tool_group_completed')
}
function durationMs(message: any): number | null {
  const value = message?.duration_ms ?? message?.durationMs ?? message?.elapsed_ms ?? message?.elapsedMs
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}
function formatDuration(value: number): string { return value < 1000 ? Math.round(value) + 'ms' : (value / 1000).toFixed(1) + 's' }
function durationFor(message: any): string {
  const value = durationMs(message)
  return value === null ? '' : formatDuration(value)
}
function detailMeta(message: any): string { return [message.tool || t('session.tool_unknown'), statusLabel(message), durationFor(message)].filter(Boolean).join(' · ') }
async function copyOutput(message: any, index: number): Promise<void> {
  try {
    await navigator.clipboard.writeText(outputText(message))
    copiedKey.value = messageKey(message, index)
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copiedKey.value = null }, 1600)
  } catch {
    copiedKey.value = null
  }
}
async function copySummary(): Promise<void> {
  const summary = props.messages.map((message, index) => {
    const detail = argsFor(message) || message.tool || t('session.tool_unknown')
    return `${index + 1}. ${actionLabel(message.tool)} · ${detail} · ${statusLabel(message)}`
  }).join('\n')
  try {
    await navigator.clipboard.writeText(summary)
    summaryCopied.value = true
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { summaryCopied.value = false }, 1600)
  } catch {
    summaryCopied.value = false
  }
}
function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && selectedKey.value) selectedKey.value = null
}
onMounted(() => window.addEventListener('keydown', handleKeydown))
onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  if (copiedTimer) clearTimeout(copiedTimer)
})
</script>

<style scoped>
.tool-call-group { width: 100%; min-width: 0; }
.tool-group-card { min-width: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 9px; background: color-mix(in srgb, var(--surface) 70%, var(--bg)); }
.tool-group-trigger { width: 100%; min-height: 42px; display: grid; grid-template-columns: 24px minmax(0, 1fr) auto 13px; align-items: center; gap: 9px; padding: 5px 11px; border: 0; color: inherit; background: transparent; text-align: left; cursor: pointer; }
.tool-group-trigger:hover { background: var(--surface-hover); }
.tool-group-trigger:focus-visible, .tool-step:focus-visible, .tool-detail-tabs button:focus-visible, .tool-detail-actions button:focus-visible, .tool-detail-close:focus-visible { outline: 2px solid var(--border-focus); outline-offset: -2px; }
.tool-group-count { width: 24px; height: 24px; display: grid; place-items: center; border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border)); border-radius: 6px; color: var(--accent); background: var(--accent-subtle); font: 600 9px/1 var(--font-mono); }
.tool-group-copy { min-width: 0; }
.tool-group-copy strong, .tool-group-copy small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-group-copy strong { color: var(--fg); font-size: 11px; font-weight: 620; }
.tool-group-copy small { margin-top: 2px; color: var(--fg-tertiary); font: 9px/1.3 var(--font-mono); }
.tool-group-status { display: inline-flex; align-items: center; gap: 4px; color: var(--fg-tertiary); font: 9px/1 var(--font-mono); }
.tool-group-status svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.tool-group-status.completed { color: var(--success); }
.tool-group-status.running { color: var(--accent); }
.tool-group-status.attention { color: var(--warning); }
.tool-group-status.error { color: var(--error); }
.tool-group-spinner, .tool-step-spinner { width: 12px; height: 12px; display: inline-block; border: 2px solid color-mix(in srgb, currentColor 25%, transparent); border-top-color: currentColor; border-radius: 50%; animation: tool-group-spin .8s linear infinite; }
.tool-group-chevron { width: 14px; height: 14px; fill: none; stroke: var(--fg-tertiary); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; transition: transform .15s ease; }
.tool-group-trigger[aria-expanded="true"] .tool-group-chevron { transform: rotate(180deg); }
.tool-group-body { border-top: 1px solid var(--border); background: var(--bg); }
.tool-step-item { border-bottom: 1px solid color-mix(in srgb, var(--border) 72%, transparent); }
.tool-step { position: relative; width: 100%; min-height: 35px; display: grid; grid-template-columns: 18px auto minmax(0, 1fr) auto 30px 13px; align-items: center; gap: 7px; padding: 3px 11px 3px 14px; border: 0; color: inherit; background: transparent; text-align: left; cursor: pointer; }
.tool-step::before { content: ""; position: absolute; top: 0; bottom: 0; left: 22px; width: 1px; background: var(--border); }
.tool-step:hover { background: var(--surface-hover); }
.tool-step[aria-expanded="true"] { background: var(--surface-active); box-shadow: inset 2px 0 0 var(--accent); }
.tool-step-status { position: relative; z-index: 1; width: 18px; height: 18px; display: grid; place-items: center; border-radius: 50%; background: var(--bg); }
.tool-step-status svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.tool-step-status.completed { color: var(--success); }
.tool-step-status.running { color: var(--accent); }
.tool-step-status.attention { color: var(--warning); }
.tool-step-status.error { color: var(--error); }
.tool-step-name { color: var(--fg-secondary); font-size: 11px; font-weight: 610; white-space: nowrap; }
.tool-step-args { min-width: 0; overflow: hidden; color: var(--fg-tertiary); font: 10px/1.35 var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.tool-step-duration { color: var(--fg-tertiary); font: 9px/1 var(--font-mono); }
.tool-step-view { color: var(--fg-tertiary); font-size: 9px; }
.tool-step:hover .tool-step-view, .tool-step[aria-expanded="true"] .tool-step-view { color: var(--accent); }
.tool-step-chevron { width: 13px; height: 13px; fill: none; stroke: var(--fg-tertiary); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; transition: transform .15s ease; }
.tool-step[aria-expanded="true"] .tool-step-chevron { transform: rotate(90deg); stroke: var(--accent); }
.tool-step-detail { min-width: 0; border-top: 1px solid var(--border); background: color-mix(in srgb, var(--surface) 46%, var(--bg)); }
.tool-detail-head { min-height: 48px; display: flex; align-items: center; gap: 10px; padding: 8px 11px 7px 39px; }
.tool-detail-head > div { min-width: 0; flex: 1; }
.tool-detail-head strong, .tool-detail-head small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-detail-head strong { color: var(--fg); font-size: 11px; font-weight: 620; }
.tool-detail-head small { margin-top: 2px; color: var(--fg-tertiary); font: 9px/1.3 var(--font-mono); }
.tool-detail-close { width: 26px; height: 26px; flex: 0 0 auto; border: 0; border-radius: 6px; color: var(--fg-tertiary); background: transparent; cursor: pointer; }
.tool-detail-close:hover { color: var(--fg); background: var(--surface-hover); }
.tool-detail-tabs { display: flex; align-items: center; gap: 2px; padding: 0 11px 0 39px; border-bottom: 1px solid var(--border); }
.tool-detail-tabs button { min-height: 29px; padding: 0 10px; border: 0; border-bottom: 2px solid transparent; color: var(--fg-tertiary); background: transparent; font-size: 10px; cursor: pointer; }
.tool-detail-tabs button:hover { color: var(--fg-secondary); }
.tool-detail-tabs button.active { border-bottom-color: var(--accent); color: var(--accent); }
.tool-detail-tabs button span { margin-left: 3px; color: var(--fg-tertiary); font-size: 8px; }
.tool-detail-panel[hidden] { display: none; }
.tool-detail-panel pre { max-height: 230px; margin: 0; overflow: auto; padding: 12px 13px 13px 39px; color: var(--fg-secondary); background: var(--code-bg); font: 10px/1.62 var(--font-mono); tab-size: 2; white-space: pre-wrap; overflow-wrap: anywhere; }
.tool-detail-panel pre.tool-detail-output.collapsed { max-height: 132px; overflow: hidden; }
.tool-detail-panel pre.tool-detail-output.expanded { max-height: 360px; overflow: auto; }
.tool-detail-pending { min-height: 72px; display: flex; align-items: center; gap: 8px; padding: 14px 39px; color: var(--fg-secondary); background: var(--code-bg); font-size: 11px; }
.tool-detail-pending.timeout { color: var(--error); }
.tool-detail-pending.unknown { color: var(--warning); }
.tool-detail-actions { min-height: 36px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 5px 11px 5px 39px; border-top: 1px solid var(--border); color: var(--fg-tertiary); font: 9px/1.3 var(--font-mono); }
.tool-detail-actions > div { display: flex; align-items: center; gap: 4px; }
.tool-detail-actions button { min-height: 25px; padding: 0 7px; border: 1px solid transparent; border-radius: 5px; color: var(--fg-secondary); background: transparent; font: 9px/1 var(--font-body); cursor: pointer; }
.tool-detail-actions button:hover { border-color: var(--border); color: var(--fg); background: var(--surface-hover); }
.tool-group-footer { min-height: 30px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 5px 11px; color: var(--fg-tertiary); font-size: 9px; }
.tool-group-footer button { flex: 0 0 auto; border: 0; color: var(--accent); background: transparent; font-size: 9px; cursor: pointer; }
.tool-group-footer button:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
@media (max-width: 768px) {
  .tool-group-trigger { grid-template-columns: 24px minmax(0, 1fr) 13px; min-height: 44px; padding-inline: 9px; }
  .tool-group-status { display: none; }
  .tool-step { grid-template-columns: 18px auto minmax(0, 1fr) 13px; min-height: 40px; padding-right: 9px; }
  .tool-step-duration, .tool-step-view { display: none; }
  .tool-detail-head, .tool-detail-tabs, .tool-detail-panel pre, .tool-detail-actions { padding-left: 14px; }
  .tool-detail-panel pre { max-height: 190px; font-size: 10px; }
  .tool-detail-pending { padding-inline: 14px; }
  .tool-detail-actions { align-items: flex-start; }
  .tool-detail-actions > span { max-width: 42%; }
}
@media (prefers-reduced-motion: reduce) {
  .tool-group-chevron, .tool-step-chevron { transition: none; }
}
@keyframes tool-group-spin { to { transform: rotate(360deg); } }
</style>
