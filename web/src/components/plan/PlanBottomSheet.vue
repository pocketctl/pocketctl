<template>
  <div class="plan-sheet-layer" @keydown.esc="$emit('close')">
    <button type="button" class="plan-sheet-backdrop" :aria-label="t('plan.close')" @click="$emit('close')" />
    <section
      :class="['plan-bottom-sheet', { expanded }]"
      role="dialog"
      aria-modal="true"
      :aria-label="t('plan.title')"
    >
      <button
        type="button"
        class="plan-sheet-grabber"
        :aria-label="expanded ? t('plan.collapse_sheet') : t('plan.expand_sheet')"
        :aria-expanded="expanded"
        @click="toggleExpanded"
        @pointerdown="startDrag"
      ><span /></button>
      <div class="plan-sheet-scroll">
        <PlanProgressContent :plan="plan" :connected="connected">
          <template #actions>
            <button ref="closeButton" type="button" class="plan-sheet-close" :aria-label="t('plan.close')" @click="$emit('close')">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
            </button>
          </template>
        </PlanProgressContent>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { useVisualViewport } from '../../composables/useVisualViewport'
import type { AgentPlanSnapshot } from '../../utils/agentPlanMerge'
import PlanProgressContent from './PlanProgressContent.vue'

defineProps<{ plan: AgentPlanSnapshot; connected: boolean }>()
const emit = defineEmits<{ (event: 'close'): void }>()
const { t } = useLocale()
useVisualViewport()
const expanded = ref(false)
const closeButton = ref<HTMLButtonElement | null>(null)
let dragStartY: number | null = null
let suppressNextClick = false

function startDrag(event: PointerEvent) {
  dragStartY = event.clientY
  suppressNextClick = false
}

function toggleExpanded() {
  if (suppressNextClick) {
    suppressNextClick = false
    return
  }
  expanded.value = !expanded.value
}

function moveDrag(event: PointerEvent) {
  if (dragStartY === null) return
  const delta = event.clientY - dragStartY
  if (delta < -48) {
    suppressNextClick = true
    expanded.value = true
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
  setTimeout(() => { suppressNextClick = false }, 0)
}

onMounted(() => {
  window.addEventListener('pointermove', moveDrag)
  window.addEventListener('pointerup', endDrag)
  nextTick(() => closeButton.value?.focus())
})
onUnmounted(() => {
  window.removeEventListener('pointermove', moveDrag)
  window.removeEventListener('pointerup', endDrag)
})
</script>

<style scoped>
.plan-sheet-layer { position: fixed; z-index: 90; inset: 0; height: var(--visual-viewport-height, 100dvh); }
.plan-sheet-backdrop { position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; border: 0; background: rgba(0, 0, 0, .42); }
.plan-bottom-sheet { position: absolute; inset: auto 0 0; height: 65%; min-height: 360px; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--border); border-bottom: 0; border-radius: 18px 18px 0 0; background: var(--surface); box-shadow: 0 -12px 36px rgba(0, 0, 0, .28); transition: height 200ms ease; }
.plan-bottom-sheet.expanded { height: calc(100% - max(12px, env(safe-area-inset-top))); }
.plan-sheet-grabber { width: 100%; min-height: 44px; display: grid; place-items: center; flex: 0 0 44px; padding: 0; border: 0; background: transparent; cursor: ns-resize; touch-action: none; }
.plan-sheet-grabber > span { width: 38px; height: 5px; border-radius: var(--radius-full); background: var(--border-light); }
.plan-sheet-scroll { min-height: 0; flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 0 16px max(18px, env(safe-area-inset-bottom)); }
.plan-sheet-close { width: 44px; height: 44px; display: grid; place-items: center; margin: -10px -10px 0 0; padding: 0; border: 0; border-radius: var(--radius-md); color: var(--fg-secondary); background: transparent; }
.plan-sheet-close:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.plan-sheet-close svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
@media (prefers-reduced-motion: reduce) { .plan-bottom-sheet { transition: none; } }
</style>
