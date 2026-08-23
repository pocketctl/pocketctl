<template>
  <div class="file-change-sheet-layer">
    <button type="button" class="file-change-backdrop" data-testid="file-change-backdrop" :aria-label="t('session.file_change_close')" @click="emit('close')" />
    <section
      id="file-change-mobile-sheet"
      :class="['file-change-bottom-sheet', { expanded, 'reduced-motion': reducedMotion }]"
      data-testid="file-change-sheet"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
    >
      <button
        type="button"
        class="file-change-grabber"
        data-testid="file-change-grabber"
        :aria-expanded="expanded"
        :aria-label="title"
        @click="toggleExpanded"
        @pointerdown="startDrag"
      ><span /></button>
      <header class="file-change-sheet-header">
        <strong>{{ title }}</strong>
        <span class="file-change-sheet-stats"><span class="add">+{{ message.fileChange.additions }}</span> <span class="del">-{{ message.fileChange.deletions }}</span></span>
        <button ref="closeButton" type="button" class="file-change-close" data-testid="file-change-close" :aria-label="t('session.file_change_close')" @click="emit('close')">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
        </button>
      </header>
      <div class="file-change-sheet-content">
        <FileChangeDetail :message="message" />
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { useVisualViewport } from '../../composables/useVisualViewport'
import type { AgentFileChangeMessage } from '../../utils/agentFileChange'
import FileChangeDetail from './FileChangeDetail.vue'

const props = defineProps<{ message: AgentFileChangeMessage; returnFocusTo?: HTMLElement | null }>()
const emit = defineEmits<{ (event: 'close'): void }>()
const { t } = useLocale()
useVisualViewport()
const expanded = ref(false)
const closeButton = ref<HTMLButtonElement | null>(null)
const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
let dragStartY: number | null = null
let suppressNextClick = false
const title = computed(() => t(
  props.message.fileChange.files.length === 1 ? 'session.file_change_edited_file' : 'session.file_change_edited_files',
  { n: props.message.fileChange.files.length },
))

function startDrag(event: PointerEvent) {
  dragStartY = event.clientY
  suppressNextClick = false
}

function moveDrag(event: PointerEvent) {
  if (dragStartY === null) return
  const delta = event.clientY - dragStartY
  if (delta < -48) {
    expanded.value = true
    suppressNextClick = true
    dragStartY = null
  } else if (delta > 72) {
    suppressNextClick = true
    if (expanded.value) expanded.value = false
    else emit('close')
    dragStartY = null
  }
}

function endDrag() {
  dragStartY = null
  window.setTimeout(() => { suppressNextClick = false }, 0)
}

function toggleExpanded() {
  if (suppressNextClick) {
    suppressNextClick = false
    return
  }
  expanded.value = !expanded.value
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('pointermove', moveDrag)
  window.addEventListener('pointerup', endDrag)
  nextTick(() => closeButton.value?.focus())
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('pointermove', moveDrag)
  window.removeEventListener('pointerup', endDrag)
  props.returnFocusTo?.focus()
})
</script>

<style scoped>
.file-change-sheet-layer { position: fixed; z-index: 92; inset: 0; height: var(--visual-viewport-height, 100dvh); }
.file-change-backdrop { position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; border: 0; background: rgba(0, 0, 0, .42); }
.file-change-bottom-sheet { position: absolute; inset: auto 0 0; height: 70%; min-height: 360px; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--border); border-bottom: 0; border-radius: 18px 18px 0 0; background: var(--surface); box-shadow: 0 -12px 36px rgba(0, 0, 0, .28); transition: height 200ms ease; }
.file-change-bottom-sheet.expanded { height: calc(100% - max(12px, env(safe-area-inset-top))); }
.file-change-bottom-sheet.reduced-motion { transition: none; }
.file-change-grabber { width: 100%; min-height: 32px; display: grid; place-items: center; flex: 0 0 32px; padding: 0; border: 0; background: transparent; cursor: ns-resize; touch-action: none; }
.file-change-grabber > span { width: 38px; height: 5px; border-radius: var(--radius-full); background: var(--border-light); }
.file-change-sheet-header { min-height: 44px; display: flex; align-items: center; gap: 8px; padding: 0 10px 8px 16px; border-bottom: 1px solid var(--border); }
.file-change-sheet-header strong { min-width: 0; color: var(--fg); font-size: 13px; }
.file-change-sheet-stats { margin-left: auto; font: 11px/1 var(--font-mono); }
.add { color: var(--success); }
.del { color: var(--danger); }
.file-change-close { width: 44px; height: 44px; display: grid; place-items: center; padding: 0; border: 0; border-radius: var(--radius-md); color: var(--fg-secondary); background: transparent; }
.file-change-close:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.file-change-close svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
.file-change-sheet-content { min-height: 0; flex: 1; overflow: hidden; padding: 0 16px max(18px, env(safe-area-inset-bottom)); }
@media (prefers-reduced-motion: reduce) { .file-change-bottom-sheet { transition: none; } }
</style>
