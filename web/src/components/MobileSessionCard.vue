<template>
  <div ref="stack" class="mobile-card-stack" :class="{ 'tray-open': trayOpen, 'drag-placeholder': dragging }">
    <div class="mobile-card-tray" :aria-hidden="!trayOpen" :inert="!trayOpen">
      <button v-if="!archived" type="button" class="tray-pin" @click="act('pin')"><WorkspaceIcon name="pin" /><span>{{ t(session.pinned ? 'session.actions.unpin' : 'session.actions.pin') }}</span></button>
      <button type="button" class="tray-more" @click="act('more')"><WorkspaceIcon name="more" /><span>{{ t('mobile.sessions_more') }}</span></button>
      <button v-if="terminal" type="button" class="tray-delete" @click="act('delete')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6" /></svg><span>{{ t('session.actions.delete') }}</span></button>
    </div>
    <div class="mobile-card-slide" :class="{ swiping: gesture === 'swipe' }" :style="{ transform: `translateX(${offset}px)` }">
    <article
      class="mobile-session-card"
      :class="{ 'pending-delete': session.__pendingDelete, pressing: longPressing }"
      :aria-description="t('mobile.sessions_card_hint')"
      role="button"
      tabindex="0"
      @click="openSession"
      @keydown.enter.self.prevent="openSession"
      @keydown.space.self.prevent="openSession"
      @pointerdown="pointerDown"
      @pointermove="pointerMove"
      @pointerup="pointerUp"
      @pointercancel="$event.pointerType !== 'touch' && cancelPointer()"
      @touchstart.passive="touchStart"
      @touchmove="touchMove"
      @touchend="touchEnd"
      @touchcancel="cancelPointer"
      @keydown.left.prevent="setTray(true)"
      @keydown.right.prevent="setTray(false)"
      @keydown.esc.prevent="setTray(false)"
      @keydown.shift.f10.prevent="act('more')"
      @contextmenu.prevent="!reorderable || !pointerStart ? act('more') : undefined"
    >
      <span class="mobile-status-dot" :class="effectiveStatus" aria-hidden="true">
        <span v-if="isActive" class="pulse-ring"></span>
        <span v-if="effectiveStatus === 'completed'" class="status-icon">✓</span>
        <span v-else-if="effectiveStatus === 'killed'" class="status-icon">✕</span>
      </span>

      <div class="mobile-card-content">
        <div class="mobile-card-title-row">
          <span class="mobile-card-title">{{ session.title || session.session_id.slice(0, 8) }}</span>
          <SessionPinBadge v-if="session.pinned && !archived" /><span v-if="session.new_badge_pending" class="mobile-new-badge">NEW</span>
        </div>

        <div v-if="hasContext" class="mobile-card-context">
          <template v-if="agentLabel"><span>{{ agentLabel }}</span></template>
          <span v-if="agentLabel && session.model" class="context-separator" aria-hidden="true"></span>
          <span v-if="session.model" class="mobile-model" :title="session.model">{{ session.model }}</span>
          <span v-if="(agentLabel || session.model) && subagentBadgeCount > 0" class="context-separator" aria-hidden="true"></span>
          <span v-if="subagentBadgeCount > 0" class="mobile-subagents">{{ t('mobile.sessions_subagents', { count: subagentBadgeCount }) }}</span>
          <span v-if="subagentBadgeCount > 0 && sdkChildCount > 0" class="context-separator" aria-hidden="true"></span>
          <span v-if="sdkChildCount > 0" class="mobile-system-sessions">{{ t('mobile.sessions_system_reviews', { count: sdkChildCount }) }}</span>
          <template v-if="session.effort"><span class="context-separator" aria-hidden="true"></span><span class="mobile-effort">{{ t('session.effort_short') }} · {{ t('session.effort.' + session.effort) }}</span></template>
          <span v-if="(agentLabel || session.model || session.subagent_count > 0) && isExited" class="context-separator" aria-hidden="true"></span>
          <span v-if="isExited" class="mobile-exited-label">{{ t('session.status.exited') }}</span>
        </div>
      </div>

      <div class="mobile-card-trailing">
        <span class="mobile-relative-time">{{ relativeTime }}</span>
        <button
          v-if="canInlineExpand"
          class="mobile-subagent-toggle"
          type="button"
          :aria-label="t(expanded ? 'mobile.sessions_collapse_children' : 'mobile.sessions_expand_children')"
          :aria-expanded="expanded"
          @click.stop="$emit('toggle-subagents')"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" :class="{ expanded }"><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>
        </button>
        <span v-else class="mobile-navigation-chevron" aria-hidden="true">
          <svg viewBox="0 0 16 16"><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>
        </span>
      </div>

    </article>

    <div v-if="isExited" class="mobile-exit-card">
      <span class="mobile-exit-mark" aria-hidden="true">!</span>
      <span class="mobile-exit-reason">{{ exitReasonLabel }}</span>
      <button v-if="hasChildren" type="button" @click="$emit('show-children')">
        {{ t('mobile.sessions_subagents', { count: session.children.length }) }} <span aria-hidden="true">›</span>
      </button>
      <button v-if="!isReadOnlyObserver && !archived" type="button" class="mobile-resume" @click="$emit('open')">{{ t('mobile.sessions_resume') }}</button>
    </div>
    <slot v-if="!archived" />
    </div>
    <Teleport to="body"><div v-if="dragging" class="mobile-session-drag-ghost" :style="{ left: `${dragPosition.x}px`, top: `${dragPosition.y}px`, width: `${dragWidth}px` }">{{ session.title || session.session_id.slice(0, 8) }}</div></Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import SessionPinBadge from './SessionPinBadge.vue'
import WorkspaceIcon from './WorkspaceIcon.vue'
import { useLocale } from '../composables/useLocale'
const { t } = useLocale()
import { agentDisplayName } from '../utils/agentDisplay'
import { isReadOnlyObserverAgent } from '../utils/observerSession'

const props = defineProps<{
  session: any
  effectiveStatus: string
  relativeTime: string
  expanded: boolean
  archived?: boolean
  reorderable?: boolean
}>()

const emit = defineEmits<{
  open: []
  'toggle-subagents': []
  'show-children': []
  'long-press': [session: any]
  pin: []
  delete: []
  drop: [target: HTMLElement]
}>()

const LONG_PRESS_MS = 550
const MOVE_TOLERANCE = 12
const stack = ref<HTMLElement>()
const longPressing = ref(false)
const dragging = ref(false)
const dragPosition = ref({ x: 0, y: 0 })
const dragWidth = ref(0)
const trayOpen = ref(false)
const offset = ref(0)
const gesture = ref<'swipe' | 'scroll' | 'drag' | null>(null)
const terminal = computed(() => ['exited', 'completed', 'killed', 'error'].includes(props.session.status))
const trayWidth = computed(() => (1 + Number(!props.archived) + Number(terminal.value)) * 76 - 8)
let pointerStart: { x: number; y: number; offset: number } | null = null
let dragOrigin = { x: 0, y: 0 }
let dropTarget: HTMLElement | null = null
let longPressed = false
let suppressClickUntil = 0
let longPressTimer: ReturnType<typeof setTimeout> | null = null

const isActive = computed(() => ['running', 'busy', 'retry'].includes(props.effectiveStatus))
const isExited = computed(() => props.session.status === 'exited' || props.effectiveStatus === 'exited')
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
const canInlineExpand = computed(() => hasChildren.value && !isExited.value && !props.archived)
const hasContext = computed(() => Boolean(agentLabel.value || props.session.model || props.session.subagent_count > 0 || isExited.value))
const normalizedAgent = computed(() => (props.session.agent || props.session.agent_type) === 'claude' ? 'claude-code' : props.session.agent || props.session.agent_type || '')
const isReadOnlyObserver = computed(() => isReadOnlyObserverAgent(normalizedAgent.value))
const agentLabel = computed(() => agentDisplayName(normalizedAgent.value))
const exitReasonLabel = computed(() => ({
  normal_exit: t('workspace.normal_exit'),
  user_interrupt: t('workspace.user_interrupted'),
  signal_kill: t('workspace.terminated'),
  process_crash: t('workspace.process_crash'),
} as Record<string, string>)[props.session.exit_reason] || props.session.exit_reason || t('session.status.exited'))

function clearLongPress() {
  if (longPressTimer) clearTimeout(longPressTimer)
  longPressTimer = null
}

function setTray(open: boolean) {
  trayOpen.value = open
  offset.value = open ? -trayWidth.value : 0
  if (open) document.dispatchEvent(new CustomEvent('pocketctl:session-tray', { detail: props.session.session_id }))
}
function act(action: 'pin' | 'more' | 'delete') {
  setTray(false)
  if (action === 'more') emit('long-press', props.session)
  else if (action === 'pin') emit('pin')
  else emit('delete')
}
function onPointerDown(event: { clientX: number; clientY: number; target: EventTarget | null }) {
  if (props.session.__pendingDelete || (event.target as HTMLElement)?.closest('button')) return
  pointerStart = { x: event.clientX, y: event.clientY, offset: offset.value }
  longPressed = false; gesture.value = null; longPressing.value = true
  clearLongPress()
  longPressTimer = setTimeout(fireLongPress, LONG_PRESS_MS)
}
function onPointerMove(event: { clientX: number; clientY: number; preventDefault: () => void }) {
  if (!pointerStart) return
  const dx = event.clientX - pointerStart.x, dy = event.clientY - pointerStart.y
  if (gesture.value === 'drag') {
    event.preventDefault()
    dragPosition.value = { x: dragOrigin.x + dx, y: dragOrigin.y + dy }
    dropTarget?.classList.remove('mobile-drop-active')
    dropTarget = document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>('[data-session-drop],[data-project-drop]') || null
    if (dropTarget && dropTarget.dataset.daemonDrop === props.session.daemon_id) dropTarget.classList.add('mobile-drop-active')
    let scroller = stack.value?.parentElement
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
    scroller ||= document.scrollingElement as HTMLElement
    if (event.clientY < 100) scroller.scrollTop -= 12
    if (event.clientY > window.innerHeight - 100) scroller.scrollTop += 12
    return
  }
  if (!gesture.value && Math.hypot(dx,dy) > MOVE_TOLERANCE) {
    clearLongPress(); longPressing.value = false
    gesture.value = Math.abs(dx) > Math.abs(dy) ? 'swipe' : 'scroll'
  }
  if (gesture.value !== 'swipe') return
  event.preventDefault()
  offset.value = Math.max(-trayWidth.value, Math.min(0,pointerStart.offset + dx))
}
function onPointerUp() {
  if (gesture.value === 'swipe') { setTray(offset.value < -trayWidth.value / 3); suppressClickUntil = Date.now() + 500 }
  if (gesture.value === 'drag') { if (dropTarget) emit('drop',dropTarget); suppressClickUntil = Date.now() + 500 }
  cancelPointer()
}
function cancelPointer() {
  clearLongPress(); longPressing.value = false; pointerStart = null
  dragging.value = false; gesture.value = null
  dropTarget?.classList.remove('mobile-drop-active'); dropTarget = null
  offset.value = trayOpen.value ? -trayWidth.value : 0
}
function fireLongPress() {
  if (!pointerStart) return
  longPressed = true; longPressing.value = false
  if (navigator.vibrate) navigator.vibrate(15)
  if (!props.reorderable) { emit('long-press', props.session); pointerStart = null; return }
  setTray(false)
  gesture.value = 'drag'; dragging.value = true
  const rect = stack.value!.getBoundingClientRect()
  dragOrigin = { x: rect.left, y: rect.top }; dragPosition.value = dragOrigin; dragWidth.value = rect.width
}
function pointerDown(event: PointerEvent) {
  if (event.pointerType === 'touch' || (event.button !== undefined && event.button !== 0)) return
  onPointerDown(event)
  if (pointerStart) (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
}
function pointerMove(event: PointerEvent) { if (event.pointerType !== 'touch') onPointerMove(event) }
function pointerUp(event: PointerEvent) { if (event.pointerType !== 'touch') onPointerUp() }
function touchStart(event: TouchEvent) { if (event.touches.length === 1) onPointerDown({ clientX:event.touches[0].clientX,clientY:event.touches[0].clientY,target:event.target }); else cancelPointer() }
function touchMove(event: TouchEvent) { if (event.touches.length === 1) onPointerMove({ clientX:event.touches[0].clientX,clientY:event.touches[0].clientY,preventDefault:()=>event.preventDefault() }); else cancelPointer() }
function touchEnd() { onPointerUp() }
function outside(event: Event) { if (trayOpen.value && !stack.value?.contains(event.target as Node)) setTray(false) }
function otherTray(event: Event) { if ((event as CustomEvent).detail !== props.session.session_id) setTray(false) }
function openSession() {
  if (props.session.__pendingDelete || longPressed || Date.now() < suppressClickUntil) { longPressed = false; return }
  if (trayOpen.value) { setTray(false); return }
  emit('open')
}
onMounted(() => { document.addEventListener('pointerdown',outside); document.addEventListener('pocketctl:session-tray',otherTray) })
onBeforeUnmount(() => { cancelPointer(); document.removeEventListener('pointerdown',outside); document.removeEventListener('pocketctl:session-tray',otherTray) })
</script>

<style scoped>
.mobile-card-stack { position: relative; overflow: hidden; border-radius: 12px; }
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
  user-select: none;
  -webkit-touch-callout: none;
  transition: transform .18s ease, border-color .15s, background .15s, opacity .25s;
}
.mobile-session-card:active { background: var(--surface-hover, #1c2129); }
.mobile-session-card.pressing { transform: scale(.98); background: var(--surface-active, #21262d); }
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
.mobile-card-trailing { width: max-content; min-width: 42px; flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 5px; }
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

/* Compact iOS list card: one title row and one metadata row. */
.mobile-session-card { min-height: 66px; gap: 9px; padding: 12px 11px; border-radius: 12px; }
.mobile-card-context { margin-top: 6px; gap: 5px; color: var(--fg-tertiary); }
.mobile-card-trailing { gap: 3px; }
.mobile-subagent-toggle,.mobile-navigation-chevron { width: 28px; height: 28px; }
.mobile-subagent-toggle::before,.mobile-navigation-chevron::before { width: 23px; height: 23px; }
.mobile-navigation-chevron::before { background: var(--surface-hover); }
.mobile-navigation-chevron svg { stroke: var(--fg-tertiary); }
.mobile-new-badge { flex-shrink: 0; padding: 3px 5px; border-radius: 4px; color: var(--accent); background: var(--accent-muted); font: 600 9px/1.2 var(--font-mono); }
.pulse-ring { animation: none; opacity: 0; }
.mobile-session-card.pressing { transform: none; opacity: .7; }

.mobile-card-slide { position: relative; z-index: 1; transition: transform .2s ease; }
.mobile-card-slide.swiping { transition: none; }
.mobile-card-tray { position: absolute; inset: 0 0 0 auto; display: flex; gap: 8px; align-items: stretch; }
.mobile-card-tray button { width: 68px; padding: 8px 4px; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 5px; border: 0; border-radius: 11px; color: white; font-size: 10px; }
.mobile-card-tray svg { width: 19px; height: 19px; }
.tray-pin { background: #3478f6; }.tray-more { background: #586574; }.tray-delete { background: #d94444; }
.mobile-card-stack.drag-placeholder { opacity: .35; }
.mobile-session-drag-ghost { position: fixed; z-index: 500; pointer-events: none; padding: 20px 14px; border: 1px solid var(--accent); border-radius: 12px; background: var(--surface); color: var(--fg); box-shadow: 0 12px 32px #0004; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media(prefers-reduced-motion: reduce) { .mobile-card-slide { transition: none; } }
</style>
