<template>
  <section class="session-diagram" :aria-label="t('session.diagram.title')">
    <header class="diagram-toolbar">
      <button type="button" class="diagram-mode" @click="toggleView">{{ t(showDiagram ? 'session.diagram.source' : 'session.diagram.chart') }}</button>
      <button type="button" class="diagram-copy" aria-live="polite" @click="copy">{{ t('session.diagram.' + copyStatus) }}</button>
      <button v-if="showDiagram && picture" ref="expandButton" type="button" class="diagram-expand" :aria-label="t('session.diagram.expand')" :title="t('session.diagram.expand')" @click="expanded = true">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5m6 0h5v5m0 6v5h-5M9 20H4v-5"/></svg>
      </button>
    </header>
    <div v-if="failed" class="diagram-status" role="status">{{ t('session.diagram.failed') }}</div>
    <pre v-if="!showDiagram || !picture" class="diagram-source" tabindex="0"><code>{{ source }}</code></pre>
    <div v-else class="diagram-preview">
      <img :src="picture.url" :width="picture.width" :height="picture.height" :alt="t('session.diagram.title')" @error="failImage">
    </div>
    <div v-if="showDiagram && !picture" class="diagram-status" role="status">{{ t('session.diagram.loading') }}</div>
    <DiagramViewer v-if="expanded && picture" :picture="picture" :copy-label="t('session.diagram.' + copyStatus)" @copy="copy" @close="closeViewer" />
  </section>
</template>

<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { loadDiagramRuntime } from '../../utils/diagramRuntime'
import DiagramViewer from './DiagramViewer.vue'

const props = defineProps<{ source: string }>()
const { t } = useLocale()
const dark = ref(document.documentElement.dataset.theme !== 'light')
const picture = ref<{ url: string; width: number; height: number }>()
const failed = ref(false)
const showDiagram = ref(false)
const expanded = ref(false)
const expandButton = ref<HTMLButtonElement>()
const copyStatus = ref<'copy' | 'copied' | 'copy_failed'>('copy')
let copyTimer: ReturnType<typeof setTimeout> | undefined
const themeObserver = new MutationObserver(() => { dark.value = document.documentElement.dataset.theme !== 'light' })

let pictureDark: boolean | undefined
let version = 0
function toggleView() {
  showDiagram.value = !showDiagram.value
  if (showDiagram.value) {
    dark.value = document.documentElement.dataset.theme !== 'light'
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  } else {
    themeObserver.disconnect()
  }
}

watch([showDiagram, dark], async ([show, isDark], _, onCleanup) => {
  let current = true
  onCleanup(() => { current = false })
  if (!show || (picture.value && pictureDark === isDark)) return
  failed.value = false
  try {
    const runtime = await loadDiagramRuntime()
    if (!current) return
    const { svg, width, height } = await runtime.render(props.source, isDark)
    if (!current) return
    if (!(width > 0 && Number.isFinite(width) && height > 0 && Number.isFinite(height))) throw new Error('Invalid image dimensions')
    picture.value = { url: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), width, height }
    pictureDark = isDark
  } catch {
    if (current) failImage()
  }
})

watch(() => props.source, () => {
  ++version
  picture.value = undefined
  failed.value = false
  showDiagram.value = false
  expanded.value = false
  copyStatus.value = 'copy'
  themeObserver.disconnect()
})
function failImage() {
  picture.value = undefined
  failed.value = true
  showDiagram.value = false
  expanded.value = false
  themeObserver.disconnect()
}

async function copy() {
  const source = props.source
  const requestVersion = version
  try {
    await navigator.clipboard.writeText(source)
    if (requestVersion !== version) return
    copyStatus.value = 'copied'
  } catch {
    if (requestVersion !== version) return
    copyStatus.value = 'copy_failed'
    showDiagram.value = false
    expanded.value = false
    themeObserver.disconnect()
  }
  clearTimeout(copyTimer)
  copyTimer = setTimeout(() => { copyStatus.value = 'copy' }, 2200)
}
function closeViewer() {
  expanded.value = false
  nextTick(() => expandButton.value?.focus({ preventScroll: true }))
}
onUnmounted(() => { ++version; themeObserver.disconnect(); clearTimeout(copyTimer) })
</script>

<style scoped>
.session-diagram { min-width: 0; max-width: 100%; width: min(36rem, 100%); margin: .45em 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; color: var(--fg); background: var(--surface); white-space: normal; box-sizing: border-box; }
.diagram-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; padding: 4px 8px; border-bottom: 1px solid var(--border); }
.diagram-toolbar button { border: 0; background: transparent; color: var(--fg-secondary); font: inherit; font-size: 12px; border-radius: 5px; cursor: pointer; min-height: 30px; padding: 2px 7px; }
.diagram-toolbar .diagram-mode { background: var(--accent-muted); color: var(--accent); font-weight: 600; }
.diagram-toolbar button:hover:enabled { background: var(--surface-hover); }
.diagram-toolbar button:disabled { opacity: .5; cursor: default; }
.diagram-copy { margin-inline-start: auto; }
.diagram-expand svg { display: block; width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.diagram-preview { display: grid; place-items: center; padding: 12px; min-height: 70px; }
.diagram-preview img { display: block; max-width: 100%; max-height: 240px; width: auto; height: auto; object-fit: contain; }
.diagram-source { margin: 0; max-height: 260px; overflow: auto; padding: 10px 12px; background: var(--code-bg); font: 13px/1.6 var(--font-mono); white-space: pre; }
.diagram-status { padding: 10px 12px; font-size: 13px; color: var(--fg-secondary); }
@media (max-width: 768px) {
  .diagram-toolbar { padding: 0 4px; }
  .diagram-toolbar button { min-height: 44px; min-width: 44px; }
}
</style>
