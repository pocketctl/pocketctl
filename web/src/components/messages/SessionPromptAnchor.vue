<template>
  <button v-if="visible && message" type="button" class="session-prompt-anchor"
    :aria-label="t('session.prompt_return', { text: message.text })" :title="t('session.prompt_return_short')"
    @click="jump">
    <span class="prompt-author" aria-hidden="true">{{ t('session.prompt_you') }}</span>
    <span class="prompt-text" aria-hidden="true">{{ message.text }}</span>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>
  </button>
  <span v-if="error" class="prompt-error" role="status">{{ t('session.prompt_unavailable') }}</span>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted, nextTick } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { SessionPrompt } from '../../utils/sessionPrompt'

const props = defineProps<{ message: SessionPrompt | null; container: HTMLElement | null; context: string }>()
const emit = defineEmits<{ navigate: [] }>()
const { t } = useLocale()
const visible = ref(false)
const error = ref(false)
let cleanup: (() => void) | undefined
let highlighted: HTMLElement | undefined
let highlightTimer: ReturnType<typeof setTimeout> | undefined
let generation = 0

function source(): HTMLElement | undefined {
  return Array.from(props.container?.querySelectorAll<HTMLElement>('[data-user-message-id]') || [])
    .find(element => element.dataset.userMessageId === props.message?.id)
}
function measure() {
  const element = source(), container = props.container
  // Missing DOM is not evidence of scrolling past a message.
  visible.value = !!element && !!container && container.clientHeight > 0
    && element.getBoundingClientRect().height > 0
    && element.getBoundingClientRect().bottom < container.getBoundingClientRect().top - 2
}
function clearHighlight() {
  clearTimeout(highlightTimer)
  highlighted?.classList.remove('prompt-return-highlight')
  highlighted = undefined
}
async function jump() {
  const stamp = generation
  emit('navigate')
  error.value = false
  await nextTick()
  if (stamp !== generation) return
  const element = source(), container = props.container
  if (!element || !container) { error.value = true; return }
  clearHighlight()
  const top = container.scrollTop + element.getBoundingClientRect().top - container.getBoundingClientRect().top - 12
  element.focus({ preventScroll: true })
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  container.scrollTo({ top: Math.max(0, top), behavior: reduced || Math.abs(top - container.scrollTop) > container.clientHeight * 2 ? 'instant' : 'smooth' })
  element.classList.add('prompt-return-highlight')
  highlighted = element
  highlightTimer = setTimeout(clearHighlight, 1400)
}

watch(() => [props.container, props.message?.id, props.message?.text, props.context] as const, async (_, __, onCleanup) => {
  cleanup?.()
  const stamp = ++generation
  visible.value = false
  error.value = false
  clearHighlight()
  await nextTick()
  if (stamp !== generation || !props.container) return
  const container = props.container
  let frame = 0
  const schedule = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(measure)
  }
  const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : undefined
  resize?.observe(container)
  const element = source()
  if (element) resize?.observe(element)
  const mutation = new MutationObserver(schedule)
  mutation.observe(container, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'open', 'hidden'] })
  container.addEventListener('scroll', schedule, { passive: true })
  const stopSmoothScroll = () => container.scrollTo({ top: container.scrollTop, behavior: 'instant' })
  container.addEventListener('wheel', stopSmoothScroll, { passive: true })
  container.addEventListener('touchstart', stopSmoothScroll, { passive: true })
  cleanup = () => {
    cancelAnimationFrame(frame)
    resize?.disconnect(); mutation.disconnect()
    container.removeEventListener('scroll', schedule)
    container.removeEventListener('wheel', stopSmoothScroll)
    container.removeEventListener('touchstart', stopSmoothScroll)
  }
  onCleanup(cleanup)
  measure()
}, { immediate: true, flush: 'post' })
onUnmounted(() => { generation++; cleanup?.(); clearHighlight() })
</script>

<style scoped>
.session-prompt-anchor { position:absolute; z-index:3; top:0; left:0; right:0; display:flex; align-items:center; gap:10px; width:100%; min-height:36px; padding:7px var(--session-content-gutter,20px); border:0; border-bottom:1px solid var(--border); border-radius:0; background:var(--bg); color:var(--fg); text-align:left; font:13px/20px var(--font-body); cursor:pointer; box-shadow:0 2px 5px #00000008; }
.prompt-author { flex:none; color:var(--fg-secondary); font-size:12px; }
.prompt-text { flex:1; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
svg { flex:none; width:16px; height:16px; fill:none; stroke:var(--accent); stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
.session-prompt-anchor:hover { background:var(--surface-hover); }
.session-prompt-anchor:active { background:var(--accent-muted); }
.session-prompt-anchor:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
.prompt-error { position:absolute; z-index:3; top:40px; left:16px; right:16px; padding:8px; background:var(--surface); color:var(--fg-secondary); font-size:12px; }
@media(max-width:768px) { .session-prompt-anchor { min-height:44px; font-size:14px; padding:11px 16px; } .prompt-error {top:48px;} }
</style>
