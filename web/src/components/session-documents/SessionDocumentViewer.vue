<template>
  <Teleport to="body">
    <div
      v-if="viewer.status !== 'closed'"
      class="session-document-viewer-layer"
      :class="{ compact }"
      @click.self="emitClose"
      @keydown.esc.prevent="emitClose"
    >
      <section
        ref="dialog"
        class="session-document-viewer"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        @keydown.tab="trapFocus"
      >
        <header class="document-viewer-header">
          <span class="viewer-document-icon" :class="currentDocument?.format" aria-hidden="true">{{ currentDocument?.format === 'html' ? 'H' : 'MD' }}</span>
          <div class="viewer-title">
            <strong :id="titleId">{{ currentDocument?.displayName }}</strong>
            <small v-if="currentDocument">{{ metadataLabel }}</small>
          </div>
          <span class="viewer-safety-badge">◆ {{ t('session.documents.static_isolation') }}</span>
          <button v-if="viewer.status === 'ready' && currentDocument" type="button" class="viewer-button download" :aria-label="t('session.documents.download')" @click="$emit('download', currentDocument)">
            <span class="desktop-label">{{ t('session.documents.download') }}</span><span class="compact-label">⇩</span>
          </button>
          <button type="button" class="viewer-button close" :aria-label="compact ? t('common.back') : t('common.close')" @click="emitClose">
            <span class="desktop-label">×</span><span class="compact-label">‹</span>
          </button>
        </header>
        <div class="document-viewer-toolbar">
          <div class="viewer-tabs" role="tablist" :aria-label="t('session.documents.view_mode')">
            <button type="button" role="tab" :aria-selected="tab === 'preview'" :class="{ active: tab === 'preview' }" @click="tab = 'preview'">{{ t('session.documents.preview') }}</button>
            <button type="button" role="tab" :aria-selected="tab === 'source'" :class="{ active: tab === 'source' }" @click="tab = 'source'">{{ t('session.documents.source') }}</button>
          </div>
          <span v-if="viewer.offlineSnapshot" class="offline-badge" role="status">{{ t('session.documents.offline_snapshot') }}</span>
        </div>
        <div class="document-viewer-body" role="status" aria-live="polite">
          <p v-if="viewer.status === 'loading'" class="viewer-state">{{ t('session.documents.loading_content') }}</p>
          <p v-else-if="viewer.status !== 'ready'" class="viewer-state error">{{ viewerError }}</p>
          <pre v-else-if="tab === 'source'" class="document-source"><code>{{ viewer.text }}</code></pre>
          <div v-else-if="currentDocument?.format === 'markdown'" class="document-markdown"><MarkdownRenderer :content="viewer.text" /></div>
          <iframe
            v-else-if="currentDocument?.format === 'html' && htmlRendering"
            :key="`${currentDocument.documentId}:${currentDocument.versionId}`"
            class="document-html-frame"
            sandbox=""
            referrerpolicy="no-referrer"
            :title="currentDocument.displayName"
            :srcdoc="htmlSrcdoc"
          ></iframe>
          <p v-else class="viewer-state">{{ t('session.documents.html_disabled') }}</p>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import MarkdownRenderer from '../MarkdownRenderer.vue'
import { useLocale } from '../../composables/useLocale'
import type { SessionDocumentMetadata } from '../../services/sessionDocuments'
import type { SessionDocumentViewerState } from '../../composables/useSessionDocuments'
import { buildStaticDocumentSrcdoc } from '../../utils/staticHtmlSnapshot'

const props = defineProps<{ viewer: SessionDocumentViewerState; htmlRendering: boolean; compact: boolean; returnFocusTo?: HTMLElement | null }>()
const emit = defineEmits<{ close: []; download: [document: SessionDocumentMetadata] }>()
const { t } = useLocale()
const dialog = ref<HTMLElement | null>(null)
const tab = ref<'preview' | 'source'>('preview')
const titleId = `session-document-viewer-title-${Math.random().toString(36).slice(2)}`
let previousFocus: HTMLElement | null = null
const currentDocument = computed(() => props.viewer.document)
const htmlSrcdoc = computed(() => buildStaticDocumentSrcdoc(props.viewer.text))
const metadataLabel = computed(() => {
  const item = currentDocument.value
  if (!item) return ''
  return `${formatBytes(item.byteSize)} · SHA-256 ${item.sha256.slice(0, 8)}…${item.sha256.slice(-4)} · ${formatTime(item.capturedAt)}`
})
const viewerError = computed(() => t(`session.documents.viewer.${props.viewer.status}`))

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
}
function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
function emitClose(): void { emit('close') }
function trapFocus(event: KeyboardEvent): void {
  const nodes = Array.from(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],iframe,[tabindex]:not([tabindex="-1"])') ?? [])
  const first = nodes[0]
  const last = nodes.at(-1)
  if (!first) { event.preventDefault(); dialog.value?.focus(); return }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) {
    event.preventDefault(); last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault(); first.focus()
  }
}

watch(() => props.viewer.status, async (status, oldStatus) => {
  if (status !== 'closed') {
    if (oldStatus === 'closed' || !previousFocus) previousFocus = props.returnFocusTo ?? globalThis.document.activeElement as HTMLElement | null
    tab.value = 'preview'
    await nextTick()
    ;(dialog.value?.querySelector<HTMLElement>('button') ?? dialog.value)?.focus()
  } else {
    previousFocus?.focus()
    previousFocus = null
  }
}, { immediate: true })

onUnmounted(() => previousFocus?.focus())
</script>

<style scoped>
.session-document-viewer-layer{position:fixed;z-index:1200;inset:0;display:flex;align-items:center;justify-content:center;padding:34px;background:#010409bd;backdrop-filter:blur(8px)}
.session-document-viewer{width:min(1120px,100%);height:min(780px,92vh);display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--border-light);border-radius:14px;background:var(--surface);box-shadow:0 30px 90px #0009;animation:document-viewer-in .24s cubic-bezier(.2,.8,.2,1) both}
.document-viewer-header{min-height:58px;display:flex;align-items:center;gap:11px;padding:0 14px;border-bottom:1px solid var(--border);background:var(--surface)}
.viewer-document-icon{width:32px;height:38px;display:grid;place-items:center;border:1px solid var(--border-light);border-radius:5px;background:var(--bg);font:700 10px var(--font-mono)}.viewer-document-icon.markdown{color:#58a6ff}.viewer-document-icon.html{color:#e07a4f}
.viewer-title{min-width:0;flex:1}.viewer-title strong{display:block;overflow:hidden;font:11px/1.4 var(--font-mono);text-overflow:ellipsis;white-space:nowrap}.viewer-title small{display:block;margin-top:3px;color:var(--fg-tertiary);font-size:9px}
.viewer-safety-badge{color:var(--success);font:9px var(--font-mono)}
.viewer-button{height:31px;padding:0 10px;border:1px solid var(--border);border-radius:7px;color:var(--fg-secondary);background:var(--surface);font-size:10px;cursor:pointer}.viewer-button.close{width:31px;padding:0;font-size:17px}.compact-label{display:none}
.document-viewer-toolbar{min-height:44px;display:flex;align-items:center;padding:0 14px;border-bottom:1px solid var(--border);background:var(--bg-secondary)}.viewer-tabs{display:flex;gap:8px}.viewer-tabs button{height:28px;padding:0 9px;border:0;border-radius:6px;color:var(--fg-tertiary);background:transparent;font-size:10px;cursor:pointer}.viewer-tabs button.active{color:var(--fg);background:var(--surface-active)}.offline-badge{margin-left:auto;color:var(--warning);font-size:10px}
.document-viewer-body{min-height:0;flex:1;overflow:auto;background:color-mix(in srgb,var(--bg-secondary) 70%,var(--bg))}.document-markdown,.document-source{width:min(820px,calc(100% - 48px));min-height:calc(100% - 48px);margin:24px auto;padding:38px;border:1px solid var(--border);border-radius:5px;background:var(--surface);box-shadow:0 12px 40px #0002}.document-source{box-sizing:border-box;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--fg-secondary);font:12px/1.7 var(--font-mono)}.document-html-frame{display:block;width:min(980px,calc(100% - 48px));height:calc(100% - 48px);min-height:420px;margin:24px auto;border:1px solid var(--border);border-radius:6px;background:white}.viewer-state{margin:40px auto;padding:20px;max-width:520px;color:var(--fg-secondary);text-align:center}.viewer-state.error{color:var(--danger)}
@keyframes document-viewer-in{from{opacity:0;transform:translateY(10px) scale(.985)}}
@media(max-width:768px){.session-document-viewer-layer,.session-document-viewer-layer.compact{padding:0;align-items:stretch;background:var(--bg);backdrop-filter:none}.session-document-viewer{width:100%;height:100%;height:100dvh;border:0;border-radius:0;box-shadow:none;animation:compact-viewer-in .22s cubic-bezier(.2,.8,.2,1) both}.document-viewer-header{min-height:calc(54px + env(safe-area-inset-top));display:grid;grid-template-columns:38px minmax(0,1fr) 38px;gap:4px;padding:env(safe-area-inset-top) 8px 0}.viewer-document-icon,.viewer-safety-badge{display:none}.viewer-title{grid-column:2;grid-row:1;text-align:center}.viewer-title strong{font-family:var(--font-sans);font-size:12px}.viewer-title small{display:none}.viewer-button.close{grid-column:1;grid-row:1}.viewer-button.download{grid-column:3;grid-row:1}.viewer-button{width:34px;padding:0;border:0;color:var(--accent);background:transparent;font-size:20px}.desktop-label{display:none}.compact-label{display:inline}.document-viewer-toolbar{min-height:42px;justify-content:center;padding:0 10px}.offline-badge{position:absolute;right:10px}.document-markdown,.document-source{box-sizing:border-box;width:100%;min-height:100%;margin:0;padding:28px 18px calc(48px + env(safe-area-inset-bottom));border:0;border-radius:0;box-shadow:none}.document-html-frame{width:100%;height:100%;min-height:0;margin:0;border:0;border-radius:0}@keyframes compact-viewer-in{from{opacity:.6;transform:translateX(24px)}}}
</style>
