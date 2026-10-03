<template>
  <Teleport to="body">
    <section ref="panel" class="workspace-action-list" :class="{ 'mobile-action-sheet': mobileSheet }" :role="mobileSheet ? 'dialog' : 'region'" :aria-label="title" :style="[position, sheetOffset ? { transform: `translateY(${sheetOffset}px)` } : {}]" tabindex="-1" @keydown.esc.stop.prevent="emit('close')">
      <div v-if="mobileSheet" class="action-sheet-grip" aria-hidden="true" @pointerdown="startSheetDrag" @pointermove="moveSheetDrag" @pointerup="finishSheetDrag" @pointercancel="sheetOffset = 0; sheetStart = null"><span /></div>
      <header><button v-if="back" type="button" :aria-label="t('common.back')" @click="emit('back')"><WorkspaceIcon name="back" /></button><h2>{{ title }}</h2><button type="button" :aria-label="closeLabel || t('common.close')" @click="emit('close')"><WorkspaceIcon name="close" /></button></header>
      <div class="action-list-content"><slot /></div>
      <footer v-if="$slots.footer"><slot name="footer" /></footer>
    </section>
  </Teleport>
</template>
<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, onUpdated, ref } from 'vue'
import WorkspaceIcon from './WorkspaceIcon.vue'
import { useLocale } from '../composables/useLocale'
import '../assets/action-list.css'
const props = withDefaults(defineProps<{ title: string; anchor?: HTMLElement | null; width?: number; back?: boolean; closeLabel?: string; mobileSheet?: boolean }>(), { width: 340, back: false })
const emit = defineEmits<{ close: []; back: [] }>()
const { t } = useLocale()
const panel = ref<HTMLElement>(), position = ref<Record<string, string>>({})
let opener: HTMLElement | null = null
const sheetOffset = ref(0)
let sheetStart: number | null = null
function startSheetDrag(event: PointerEvent) {
  if (event.button !== 0) return
  sheetStart = event.clientY
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
}
function moveSheetDrag(event: PointerEvent) { if (sheetStart !== null) sheetOffset.value = Math.max(0, event.clientY - sheetStart) }
function finishSheetDrag() {
  if (sheetOffset.value > Math.min(120, (panel.value?.offsetHeight || 400) * .22)) emit('close')
  sheetOffset.value = 0; sheetStart = null
}
function place() {
  if (!panel.value) return
  const width = Math.min(props.width, window.innerWidth - 20)
  const anchor = props.anchor || opener
  const rect = anchor?.isConnected ? anchor.getBoundingClientRect() : null
  const height = Math.min(panel.value.scrollHeight, window.innerHeight - 32)
  const left = rect ? Math.max(10, Math.min(rect.right - width, window.innerWidth - width - 10)) : (window.innerWidth - width) / 2
  const top = rect ? Math.max(10, Math.min(rect.bottom + 6, window.innerHeight - height - 10)) : Math.max(16, Math.min(80, (window.innerHeight - height) / 2))
  const next = { width: `${width}px`, left: `${left}px`, top: `${top}px`, maxHeight: `${window.innerHeight - top - 10}px` }
  if (JSON.stringify(next) !== JSON.stringify(position.value)) position.value = next
}
function outside(event: PointerEvent) {
  const target = event.target as HTMLElement
  if (!panel.value?.contains(target) && !target.closest('.action-select-content') && !props.anchor?.contains(target)) emit('close')
}
function focusOut(event: FocusEvent) {
  const target = event.target as HTMLElement | null
  if (target && !panel.value?.contains(target) && !target.closest('.action-select-content') && !props.anchor?.contains(target)) emit('close')
}
onMounted(async () => {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  await nextTick(); place(); (panel.value?.querySelector<HTMLElement>('button') || panel.value)?.focus()
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('focusin', focusOut)
  window.addEventListener('resize', place)
})
onUpdated(place)
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', focusOut); window.removeEventListener('resize', place)
  if (panel.value?.contains(document.activeElement)) (props.anchor || opener)?.focus()
})
</script>

<style>
.action-sheet-grip { display: none; }
@media(max-width:768px) {
  .workspace-action-list.mobile-action-sheet { top: auto !important; bottom: 0; left: 0 !important; width: 100% !important; max-height: min(80dvh, 720px) !important; border-radius: 20px 20px 0 0; padding-bottom: env(safe-area-inset-bottom); }
  .mobile-action-sheet > .action-sheet-grip { display: grid; place-items: center; height: 20px; flex-shrink: 0; touch-action: none; cursor: grab; }
  .action-sheet-grip span { width: 36px; height: 4px; border-radius: 4px; background: var(--border-light); }
  .workspace-action-list.mobile-action-sheet > header { min-height: 50px; padding: 8px 16px; }
  .workspace-action-list.mobile-action-sheet > header h2 { font-size: 17px; color: var(--fg); }
  .workspace-action-list.mobile-action-sheet > header button { width: 36px; height: 36px; }
  .workspace-action-list.mobile-action-sheet .action-list-content { padding: 0 20px 16px; }
}
</style>
