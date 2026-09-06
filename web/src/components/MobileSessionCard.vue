<template>
  <div class="mobile-card-stack" :class="{ 'actions-open': actionsRevealed }">
    <div class="mobile-card-actions" :class="{ revealed: actionsRevealed }" :aria-hidden="!actionsRevealed">
      <button class="mobile-action-pin" type="button" :tabindex="actionsRevealed ? 0 : -1" @click.stop="togglePin">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v5M9 10.8V4h6v6.8l3 3.2v2H6v-2l3-3.2z" /></svg>
        <span>{{ session.pinned ? '取消置顶' : '置顶' }}</span>
      </button>
      <button v-if="isTerminal" class="mobile-action-delete" type="button" :tabindex="actionsRevealed ? 0 : -1" @click.stop="requestDelete">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6" /></svg>
        <span>删除</span>
      </button>
    </div>

    <article
      class="mobile-session-card"
      :class="{ 'pending-delete': session.__pendingDelete }"
      :style="{ transform: `translateX(${swipeOffset}px)` }"
      role="button"
      tabindex="0"
      @click="openSession"
      @keydown.enter.prevent="openSession"
      @keydown.space.prevent="openSession"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="cancelPointer"
    >
      <span class="mobile-status-dot" :class="effectiveStatus" aria-hidden="true">
        <span v-if="isActive" class="pulse-ring"></span>
        <span v-if="effectiveStatus === 'completed'" class="status-icon">✓</span>
        <span v-else-if="effectiveStatus === 'killed'" class="status-icon">✕</span>
      </span>

      <div class="mobile-card-content">
        <div class="mobile-card-title-row">
          <span class="mobile-card-title">{{ session.title || session.session_id.slice(0, 8) }}</span>
          <svg v-if="session.pinned" class="mobile-pin" viewBox="0 0 16 16" aria-label="已置顶">
            <path d="M10.8 1.6 14.4 5.2l-2 1.2-.8 3.2-1 1-2.2-2.2-4.8 4.8-.8-.8 4.8-4.8-2.2-2.2 1-1 3.2-.8 1.2-2Z" />
          </svg>
        </div>

        <div v-if="hasContext" class="mobile-card-context">
          <template v-if="agentLabel"><span>{{ agentLabel }}</span></template>
          <span v-if="agentLabel && session.model" class="context-separator" aria-hidden="true"></span>
          <span v-if="session.model" class="mobile-model" :title="session.model">{{ session.model }}</span>
          <span v-if="(agentLabel || session.model) && subagentBadgeCount > 0" class="context-separator" aria-hidden="true"></span>
          <span v-if="subagentBadgeCount > 0" class="mobile-subagents">{{ subagentBadgeCount }} 子智能体</span>
          <span v-if="subagentBadgeCount > 0 && sdkChildCount > 0" class="context-separator" aria-hidden="true"></span>
          <span v-if="sdkChildCount > 0" class="mobile-system-sessions">{{ sdkChildCount }} 系统审查</span>
          <span v-if="(agentLabel || session.model || session.subagent_count > 0) && isExited" class="context-separator" aria-hidden="true"></span>
          <span v-if="isExited" class="mobile-exited-label">已退出</span>
        </div>
      </div>

      <div class="mobile-card-trailing">
        <span class="mobile-relative-time">{{ relativeTime }}</span>
        <button
          v-if="canInlineExpand"
          class="mobile-subagent-toggle"
          type="button"
          :aria-label="expanded ? '收起子智能体' : '展开子智能体'"
          :aria-expanded="expanded"
          @click.stop="$emit('toggle-subagents')"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" :class="{ expanded }"><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>
        </button>
        <span v-else class="mobile-navigation-chevron" aria-hidden="true">
          <svg viewBox="0 0 16 16"><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>
        </span>
      </div>

      <span v-if="copied" class="mobile-copy-feedback" role="status">已复制会话 ID</span>
    </article>

    <div v-if="isExited" class="mobile-exit-card">
      <span class="mobile-exit-mark" aria-hidden="true">!</span>
      <span class="mobile-exit-reason">{{ exitReasonLabel }}</span>
      <button v-if="hasChildren" type="button" @click="$emit('toggle-subagents')">
        {{ session.children.length }} 子智能体 <span aria-hidden="true">›</span>
      </button>
      <button v-if="!isReadOnlyObserver" type="button" class="mobile-resume" @click="$emit('open')">恢复会话</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { agentDisplayName } from '../utils/agentDisplay'
import { isReadOnlyObserverAgent } from '../utils/observerSession'

const props = defineProps<{
  session: any
  effectiveStatus: string
  relativeTime: string
  expanded: boolean
}>()

const emit = defineEmits<{
  open: []
  'toggle-subagents': []
  'toggle-pin': [session: any]
  delete: [session: any]
}>()

const swipeOffset = ref(0)
const actionsRevealed = ref(false)
const copied = ref(false)
let pointerStart: { x: number; y: number } | null = null
let dragged = false
let longPressed = false
let longPressTimer: ReturnType<typeof setTimeout> | null = null
let copiedTimer: ReturnType<typeof setTimeout> | null = null

const isActive = computed(() => ['running', 'busy', 'retry'].includes(props.effectiveStatus))
const isExited = computed(() => props.session.status === 'exited' || props.effectiveStatus === 'exited')
const isTerminal = computed(() => ['exited', 'completed', 'killed', 'error'].includes(props.session.status))
const hasChildren = computed(() => Boolean(props.session.children?.length))
// Children mix real subagents and SDK-spawned system sessions (kind
// sdk_session); badges count them separately, falling back to the scalar
// subagent_count when the children array is not loaded yet.
const subagentBadgeCount = computed(() => {
  if (props.session.children?.length) {
    return props.session.children.filter((c: any) => c.kind !== 'sdk_session').length
  }
  return props.session.subagent_count || 0
})
const sdkChildCount = computed(() => (props.session.children || []).filter((c: any) => c.kind === 'sdk_session').length)
const canInlineExpand = computed(() => hasChildren.value && !isExited.value)
const hasContext = computed(() => Boolean(agentLabel.value || props.session.model || props.session.subagent_count > 0 || isExited.value))
const actionWidth = computed(() => isTerminal.value ? 144 : 72)
const normalizedAgent = computed(() => props.session.agent === 'claude' ? 'claude-code' : props.session.agent || '')
const isReadOnlyObserver = computed(() => isReadOnlyObserverAgent(normalizedAgent.value))
const agentLabel = computed(() => agentDisplayName(normalizedAgent.value))
const exitReasonLabel = computed(() => ({
  normal_exit: '进程正常退出',
  user_interrupt: '由用户结束',
  signal_kill: '进程被终止',
  process_crash: '进程异常退出',
} as Record<string, string>)[props.session.exit_reason] || props.session.exit_reason || '退出原因未知')

function clearLongPress() {
  if (longPressTimer) clearTimeout(longPressTimer)
  longPressTimer = null
}

function onPointerDown(event: PointerEvent) {
  if (event.button !== undefined && event.button !== 0) return
  pointerStart = { x: event.clientX, y: event.clientY }
  dragged = false
  longPressed = false
  clearLongPress()
  longPressTimer = setTimeout(copySessionId, 500)
}

function onPointerMove(event: PointerEvent) {
  if (!pointerStart) return
  const dx = event.clientX - pointerStart.x
  const dy = event.clientY - pointerStart.y
  if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) {
    cancelPointer()
    return
  }
  if (Math.abs(dx) < 6) return
  dragged = true
  clearLongPress()
  const origin = actionsRevealed.value ? -actionWidth.value : 0
  swipeOffset.value = Math.max(-actionWidth.value, Math.min(0, origin + dx))
}

function onPointerUp() {
  clearLongPress()
  if (dragged) {
    actionsRevealed.value = swipeOffset.value < -36
    swipeOffset.value = actionsRevealed.value ? -actionWidth.value : 0
  }
  pointerStart = null
}

function cancelPointer() {
  clearLongPress()
  pointerStart = null
  if (!dragged) return
  swipeOffset.value = actionsRevealed.value ? -actionWidth.value : 0
}

function openSession() {
  if (props.session.__pendingDelete || dragged || longPressed) {
    dragged = false
    longPressed = false
    return
  }
  if (actionsRevealed.value) {
    actionsRevealed.value = false
    swipeOffset.value = 0
    return
  }
  emit('open')
}

function copySessionId() {
  if (!props.session.session_id) return
  longPressed = true
  clearLongPress()
  navigator.clipboard?.writeText(props.session.session_id).catch(() => undefined)
  copied.value = true
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copied.value = false }, 1200)
}

function togglePin() {
  actionsRevealed.value = false
  swipeOffset.value = 0
  emit('toggle-pin', props.session)
}

function requestDelete() {
  actionsRevealed.value = false
  swipeOffset.value = 0
  emit('delete', props.session)
}

onBeforeUnmount(() => {
  clearLongPress()
  if (copiedTimer) clearTimeout(copiedTimer)
})
</script>

<style scoped>
.mobile-card-stack { position: relative; overflow: hidden; border-radius: 12px; }
.mobile-card-actions {
  position: absolute;
  inset: 0 0 auto auto;
  display: flex;
  height: 73px;
  opacity: 0;
  transition: opacity .16s ease;
}
.mobile-card-actions.revealed { opacity: 1; }
.mobile-card-actions button {
  width: 72px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  border: 0;
  color: #fff;
  font-size: 10px;
}
.mobile-card-actions svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.mobile-action-pin { background: var(--accent, #58a6ff); }
.mobile-action-delete { background: var(--error, #f85149); }
.mobile-session-card {
  position: relative;
  z-index: 1;
  display: flex;
  min-height: 73px;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 10px 12px 14px;
  border: 1px solid var(--border, #21262d);
  border-radius: 12px;
  background: var(--surface, #161b22);
  cursor: pointer;
  touch-action: pan-y;
  transition: transform .18s ease, border-color .15s, background .15s, opacity .25s;
}
.mobile-session-card:active { background: var(--surface-hover, #1c2129); }
.mobile-session-card:focus-visible { outline: 2px solid var(--accent, #58a6ff); outline-offset: -2px; }
.mobile-session-card.pending-delete { pointer-events: none; opacity: .35; }
.mobile-status-dot {
  position: relative;
  display: grid;
  width: 8px;
  height: 8px;
  flex: 0 0 8px;
  place-items: center;
  margin-top: 6px;
  border-radius: 50%;
  background: #6b7280;
}
.mobile-status-dot.running { background: #22c55e; }
.mobile-status-dot.busy, .mobile-status-dot.retry { background: #d29922; }
.mobile-status-dot.idle { background: #eab308; }
.mobile-status-dot.waiting_approval { background: #f97316; }
.mobile-status-dot.waiting_question { background: #a855f7; }
.mobile-status-dot.completed { background: #9ca3af; color: white; }
.mobile-status-dot.error { background: #ef4444; }
.mobile-status-dot.killed { background: #dc2626; color: white; }
.mobile-status-dot.disconnected { border: 1.5px dashed #3b82f6; background: transparent; }
.pulse-ring { position: absolute; inset: -3px; border: 1.5px solid currentColor; border-radius: 50%; color: inherit; animation: mobile-pulse 1.5s infinite; }
.mobile-status-dot.running .pulse-ring { color: #22c55e; }
.mobile-status-dot.busy .pulse-ring, .mobile-status-dot.retry .pulse-ring { color: #d29922; }
.status-icon { font-size: 7px; font-weight: 800; line-height: 1; }
.mobile-card-content { min-width: 0; flex: 1; padding-top: 1px; }
.mobile-card-title-row { display: flex; min-width: 0; align-items: center; gap: 6px; }
.mobile-card-title { min-width: 0; overflow: hidden; color: var(--fg, #e6edf3); font-size: 14px; font-weight: 600; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; }
.mobile-pin { width: 11px; height: 11px; flex: 0 0 11px; fill: color-mix(in srgb, var(--fg-secondary, #c9d1d9) 80%, transparent); }
.mobile-card-context {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  overflow: hidden;
  color: var(--fg-secondary, #c9d1d9);
  font-size: 11px;
  line-height: 14px;
  white-space: nowrap;
}
.mobile-model { min-width: 0; overflow: hidden; font-family: var(--font-mono, ui-monospace, monospace); text-overflow: ellipsis; }
.mobile-subagents { flex: 0 0 auto; }
.mobile-system-sessions { flex: 0 0 auto; color: #d2a8ff; }
.mobile-exited-label { flex: 0 0 auto; color: var(--warning, #d29922); }
.context-separator { width: 3px; height: 3px; flex: 0 0 3px; border-radius: 50%; background: var(--fg-tertiary, #6e7681); }
.mobile-card-trailing { width: 42px; flex: 0 0 42px; display: flex; flex-direction: column; align-items: flex-end; gap: 5px; }
.mobile-relative-time { color: #6e7681; font-size: 11px; line-height: 14px; white-space: nowrap; }
.mobile-subagent-toggle, .mobile-navigation-chevron {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  background: transparent;
}
.mobile-subagent-toggle::before, .mobile-navigation-chevron::before { content: ''; grid-area: 1 / 1; width: 26px; height: 26px; border-radius: 50%; background: var(--accent-muted, rgba(88, 166, 255, .12)); }
.mobile-navigation-chevron::before { background: var(--border, #30363d); }
.mobile-subagent-toggle svg, .mobile-navigation-chevron svg { z-index: 1; grid-area: 1 / 1; width: 12px; height: 12px; fill: none; stroke: var(--accent, #58a6ff); stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; transition: transform .22s ease; }
.mobile-navigation-chevron svg { stroke: var(--fg-secondary, #c9d1d9); }
.mobile-subagent-toggle svg.expanded { transform: rotate(90deg); }
.mobile-copy-feedback { position: absolute; inset: 50% auto auto 50%; z-index: 3; transform: translate(-50%, -50%); padding: 6px 10px; border-radius: 6px; color: var(--fg, #e6edf3); background: var(--accent, #58a6ff); font-size: 12px; font-weight: 600; white-space: nowrap; }
.mobile-exit-card {
  position: relative;
  z-index: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  margin: -2px 7px 0;
  padding: 9px 11px 7px;
  border: 1px solid color-mix(in srgb, var(--border-light, #30363d) 18%, transparent);
  border-top: 0;
  border-radius: 0 0 10px 10px;
  background: color-mix(in srgb, var(--fg-secondary, #c9d1d9) 5.5%, transparent);
  color: var(--fg-secondary, #c9d1d9);
  font-size: 10px;
}
.mobile-exit-mark { color: var(--warning, #d29922); font-weight: 700; }
.mobile-exit-reason { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mobile-exit-card button { padding: 0; border: 0; color: var(--fg-tertiary, #8b949e); background: transparent; font-size: 10px; white-space: nowrap; }
.mobile-exit-card .mobile-resume { color: var(--fg, #e6edf3); font-weight: 600; }
@keyframes mobile-pulse { 0% { opacity: .8; transform: scale(1); } 100% { opacity: 0; transform: scale(1.6); } }
@media (prefers-reduced-motion: reduce) { .pulse-ring { animation: none; } .mobile-session-card, .mobile-subagent-toggle svg { transition: none; } }
</style>
