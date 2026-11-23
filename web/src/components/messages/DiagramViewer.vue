<template>
  <Teleport to="body">
    <dialog ref="dialog" class="diagram-dialog" :aria-label="t('session.diagram.title')"
      @keydown="keyDown" @cancel.prevent="emit('close')">
      <header>
        <strong>{{ t('session.diagram.title') }}</strong>
        <div class="viewer-controls">
          <button type="button" :aria-label="t('session.diagram.zoom_out')" :disabled="zoom <= .25" @click="scale(zoom / 1.4)">−</button>
          <button type="button" :aria-label="t('session.diagram.fit')" :title="t('session.diagram.fit')" @click="fit">{{ Math.round(zoom * 100) }}%</button>
          <button type="button" :aria-label="t('session.diagram.zoom_in')" :disabled="zoom >= 8" @click="scale(zoom * 1.4)">+</button>
          <button type="button" aria-live="polite" @click="emit('copy')">{{ copyLabel }}</button>
          <button type="button" autofocus @click="emit('close')">{{ t('session.diagram.close') }}</button>
        </div>
      </header>
      <div ref="canvas" class="diagram-canvas" tabindex="0" :aria-label="t('session.diagram.navigation')"
        @pointerdown="start" @pointermove="move" @pointerup="release" @pointercancel="release"
        @lostpointercapture="release" @wheel.prevent="wheel">
        <img :src="picture.url" :alt="t('session.diagram.title')" draggable="false"
          :style="{ width: displayedWidth + 'px', height: displayedHeight + 'px',
            transform: 'translate(' + panX + 'px, ' + panY + 'px)' }">
      </div>
    </dialog>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'

const props = defineProps<{ picture: { url: string; width: number; height: number }; copyLabel: string }>()
const emit = defineEmits<{ close: []; copy: [] }>()
const { t } = useLocale()
const dialog = ref<HTMLDialogElement>()
const canvas = ref<HTMLElement>()
const width = ref(0), height = ref(0)
const zoom = ref(1), panX = ref(0), panY = ref(0)
const fittedScale = computed(() => Math.min(Math.max(1, width.value - 24) / props.picture.width, Math.max(1, height.value - 24) / props.picture.height))
const displayedWidth = computed(() => props.picture.width * fittedScale.value * zoom.value)
const displayedHeight = computed(() => props.picture.height * fittedScale.value * zoom.value)
type Point = { x: number; y: number }
const pointers = new Map<number, Point>()

function clamp(value: number, limit: number) { return Math.max(-limit, Math.min(limit, value)) }
function pan(x: number, y: number) {
  panX.value = clamp(x, Math.max(0, (displayedWidth.value - width.value) / 2))
  panY.value = clamp(y, Math.max(0, (displayedHeight.value - height.value) / 2))
}
function scale(next: number, origin: Point = { x: 0, y: 0 }) {
  const previous = zoom.value
  zoom.value = Math.max(.25, Math.min(8, next))
  const ratio = zoom.value / previous
  pan(origin.x + (panX.value - origin.x) * ratio, origin.y + (panY.value - origin.y) * ratio)
}
function fit() { zoom.value = 1; pan(0, 0) }
function localPoint(e: MouseEvent): Point {
  const rect = canvas.value!.getBoundingClientRect()
  return { x: e.clientX - rect.left - rect.width / 2, y: e.clientY - rect.top - rect.height / 2 }
}
function start(e: PointerEvent) {
  if (e.button !== 0 || pointers.size >= 2) return
  canvas.value?.setPointerCapture(e.pointerId)
  pointers.set(e.pointerId, localPoint(e))
}
function move(e: PointerEvent) {
  const previous = pointers.get(e.pointerId)
  if (!previous) return
  const next = localPoint(e)
  pointers.set(e.pointerId, next)
  const other = [...pointers].find(([id]) => id !== e.pointerId)?.[1]
  if (!other) { pan(panX.value + next.x - previous.x, panY.value + next.y - previous.y); return }
  const before = Math.hypot(previous.x - other.x, previous.y - other.y)
  if (before > 1) scale(zoom.value * Math.hypot(next.x - other.x, next.y - other.y) / before, other)
}
function release(e: PointerEvent) { pointers.delete(e.pointerId) }
function wheel(e: WheelEvent) {
  scale(zoom.value * Math.exp(-Math.max(-100, Math.min(100, e.deltaY)) * .005), localPoint(e))
}
function keyDown(e: KeyboardEvent) {
  switch (e.key) {
    case 'Escape': emit('close'); break
    case '+': case '=': scale(zoom.value * 1.4); break
    case '-': scale(zoom.value / 1.4); break
    case '0': case 'Home': fit(); break
    case 'ArrowLeft': pan(panX.value + 48, panY.value); break
    case 'ArrowRight': pan(panX.value - 48, panY.value); break
    case 'ArrowUp': pan(panX.value, panY.value + 48); break
    case 'ArrowDown': pan(panX.value, panY.value - 48); break
    default: return
  }
  e.preventDefault()
  e.stopPropagation()
}

let observer: ResizeObserver | undefined
onMounted(async () => {
  dialog.value?.showModal()
  await nextTick()
  if (!canvas.value) return
  function measure() {
    if (!canvas.value) return
    width.value = canvas.value.clientWidth
    height.value = canvas.value.clientHeight
    pan(panX.value, panY.value)
  }
  measure()
  observer = new ResizeObserver(measure)
  observer.observe(canvas.value)
})
onUnmounted(() => observer?.disconnect())
</script>

<style scoped>
.diagram-dialog[open] { display: flex; flex-direction: column; }
.diagram-dialog { position: fixed; inset: 0; box-sizing: border-box; width: 100%; max-width: none; height: 100dvh; max-height: none; margin: 0; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); border: 0; background: var(--surface); color: var(--fg); }
.diagram-dialog header { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; padding: 6px 12px; border-bottom: 1px solid var(--border); }
.diagram-dialog strong { font-size: 14px; }
.viewer-controls { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.viewer-controls button { min-width: 44px; min-height: 44px; padding: 4px 8px; border: 0; border-radius: 5px; background: transparent; color: var(--fg); font: inherit; font-variant-numeric: tabular-nums; cursor: pointer; }
.viewer-controls button:hover { background: var(--surface-hover); }
.viewer-controls button:disabled { opacity: .45; }
.diagram-canvas { flex: 1; min-height: 0; position: relative; overflow: hidden; touch-action: none; cursor: grab; user-select: none; }
.diagram-canvas:active { cursor: grabbing; }
.diagram-canvas img { position: absolute; left: 50%; top: 50%; max-width: none; max-height: none; pointer-events: none; translate: -50% -50%; }
</style>
