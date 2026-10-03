<template>
  <ActionList :title="t('plan.title')" :close-label="t('plan.close')" :width="480" @close="emit('close')">
    <section
      :class="['plan-bottom-sheet', { expanded }]"
      role="region"
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
        <PlanProgressContent :plan="plan" :connected="connected" />
      </div>
    </section>
  </ActionList>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { useVisualViewport } from '../../composables/useVisualViewport'
import type { AgentPlanSnapshot } from '../../utils/agentPlanMerge'
import PlanProgressContent from './PlanProgressContent.vue'
import ActionList from '../ActionList.vue'

defineProps<{ plan: AgentPlanSnapshot; connected: boolean }>()
const emit = defineEmits<{ (event: 'close'): void }>()
const { t } = useLocale()
useVisualViewport()
const expanded = ref(false)
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
})
onUnmounted(() => {
  window.removeEventListener('pointermove', moveDrag)
  window.removeEventListener('pointerup', endDrag)
})
</script>

<style scoped>
.plan-bottom-sheet { height: min(60dvh, 550px); min-height: 240px; display: flex; flex-direction: column; overflow: hidden; background: var(--surface); transition: height 200ms ease; }
.plan-bottom-sheet.expanded { height: min(75dvh, 700px); }
.plan-sheet-grabber { width: 100%; min-height: 44px; display: grid; place-items: center; flex: 0 0 44px; padding: 0; border: 0; background: transparent; cursor: ns-resize; touch-action: none; }
.plan-sheet-grabber > span { width: 38px; height: 5px; border-radius: var(--radius-full); background: var(--border-light); }
.plan-sheet-scroll { min-height: 0; flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 0 16px max(18px, env(safe-area-inset-bottom)); }
@media (prefers-reduced-motion: reduce) { .plan-bottom-sheet { transition: none; } }
</style>
