<template>
  <section
    v-if="documents.length || listStatus === 'loading' || listStatus === 'offline'"
    class="session-document-shelf"
    aria-labelledby="session-document-shelf-title"
  >
    <header class="document-shelf-header">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 2.5h8l4 4v11H4zM12 2.5v4h4M7 10h6M7 13h6"/></svg>
      <strong id="session-document-shelf-title">{{ t('session.documents.title') }}</strong>
      <span class="document-count">{{ documents.length }}</span>
      <span class="snapshot-label">{{ t('session.documents.snapshot') }}</span>
    </header>
    <div v-if="listStatus === 'loading' && !documents.length" class="document-shelf-status" role="status">
      {{ t('session.documents.loading') }}
    </div>
    <div v-else class="session-document-list">
      <button
        v-for="document in documents"
        :key="`${document.documentId}:${document.versionId}`"
        type="button"
        class="session-document-row"
        :class="{ unavailable: document.state !== 'available' }"
        :disabled="document.state === 'pending'"
        :aria-label="rowAriaLabel(document)"
        @click="openDocument(document, $event)"
      >
        <span class="document-icon" :class="document.format">{{ document.format === 'markdown' ? 'MD' : 'H' }}</span>
        <span class="document-copy">
          <strong>{{ document.displayName }}</strong>
          <small>
            <span>{{ formatBytes(document.byteSize) }}</span>
            <span>·</span>
            <span :class="{ verified: document.state === 'available' }">{{ statusLabel(document) }}</span>
          </small>
        </span>
        <span class="document-open" aria-hidden="true">›</span>
      </button>
    </div>
    <p v-if="listStatus === 'offline'" class="document-shelf-note" role="status">
      {{ t('session.documents.offline') }}
    </p>
    <p v-if="hasUnavailable" class="document-shelf-note warning">
      {{ t('session.documents.unavailable_note') }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { SessionDocumentMetadata } from '../../services/sessionDocuments'
import type { SessionDocumentListStatus } from '../../composables/useSessionDocuments'

const props = defineProps<{
  documents: SessionDocumentMetadata[]
  listStatus: SessionDocumentListStatus
}>()
const emit = defineEmits<{ open: [document: SessionDocumentMetadata, opener: HTMLButtonElement] }>()
const { t } = useLocale()
const hasUnavailable = computed(() => props.documents.some((item) => item.state !== 'available'))

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
}

function statusLabel(document: SessionDocumentMetadata): string {
  if (document.state === 'pending') return t('session.documents.state.loading')
  if (document.state === 'available') return t('session.documents.state.verified')
  const key = document.reason ? `session.documents.reason.${document.reason}` : 'session.documents.state.unavailable'
  return t(key) === key ? t('session.documents.state.unavailable') : t(key)
}

function rowAriaLabel(document: SessionDocumentMetadata): string {
  return `${document.displayName}, ${formatBytes(document.byteSize)}, ${statusLabel(document)}`
}
function openDocument(document: SessionDocumentMetadata, event: MouseEvent): void {
  emit('open', document, event.currentTarget as HTMLButtonElement)
}
</script>

<style scoped>
.session-document-shelf{position:relative;overflow:hidden;border:1px solid var(--border-light);border-radius:12px;background:var(--surface);box-shadow:0 8px 28px #0000001f;animation:document-shelf-in .32s cubic-bezier(.2,.8,.2,1) both}
.session-document-shelf::before{content:"";position:absolute;inset:0 auto 0 0;width:2px;background:linear-gradient(#58a6ff,#e07a4f)}
.document-shelf-header{min-height:46px;display:flex;align-items:center;gap:9px;padding:0 14px;border-bottom:1px solid var(--border)}
.document-shelf-header svg{width:16px;height:16px;fill:none;stroke:var(--accent);stroke-width:1.8}
.document-shelf-header strong{font-size:12px}
.document-count{padding:1px 6px;border-radius:999px;color:var(--accent);background:var(--accent-muted);font:10px var(--font-mono)}
.snapshot-label{margin-left:auto;color:var(--fg-tertiary);font-size:10px}
.session-document-list{padding:5px}
.session-document-row{width:100%;min-height:58px;display:grid;grid-template-columns:36px minmax(0,1fr) auto;align-items:center;gap:10px;padding:8px 10px;border:0;border-radius:8px;color:var(--fg);background:transparent;text-align:left;cursor:pointer;transition:background .15s,transform .15s}
.session-document-row:hover{background:var(--surface-hover);transform:translateX(2px)}
.session-document-row:focus-visible{outline:2px solid var(--border-focus);outline-offset:-2px}
.session-document-row.unavailable{opacity:.72}.session-document-row:disabled{cursor:wait}
.document-icon{position:relative;width:32px;height:38px;display:grid;place-items:center;border:1px solid var(--border-light);border-radius:5px;background:var(--bg);font:700 10px var(--font-mono);box-shadow:0 3px 9px #00000029}
.document-icon.markdown{color:#58a6ff}.document-icon.html{color:#e07a4f}
.document-copy{min-width:0}.document-copy strong{display:block;overflow:hidden;font:11px/1.4 var(--font-mono);text-overflow:ellipsis;white-space:nowrap}.document-copy small{display:flex;align-items:center;gap:5px;margin-top:4px;color:var(--fg-tertiary);font-size:10px}.verified{color:var(--success)}
.document-open{color:var(--fg-tertiary);font-size:20px}.document-shelf-status,.document-shelf-note{margin:10px;padding:9px 10px;border-radius:7px;color:var(--accent);background:var(--accent-subtle);font-size:10px;line-height:1.5}.document-shelf-note.warning{color:var(--warning);background:var(--warning-bg)}
@keyframes document-shelf-in{from{opacity:0;transform:translateY(8px)}}
@media(max-width:768px){.session-document-shelf{overflow:visible;border:0;border-radius:0;background:transparent;box-shadow:none}.session-document-shelf::before,.document-shelf-header>svg{display:none}.document-shelf-header{min-height:34px;padding:0 2px;border:0}.document-shelf-header strong{color:var(--fg-secondary);font-size:11px}.document-count{padding:0;color:var(--fg-tertiary);background:transparent}.document-count::before{content:"· "}.snapshot-label{display:none}.session-document-list{overflow:hidden;padding:0;border:1px solid var(--border);border-radius:12px;background:var(--surface)}.session-document-row{min-height:58px;grid-template-columns:32px minmax(0,1fr) 18px;padding:8px 11px;border-radius:0}.session-document-row+.session-document-row{border-top:1px solid var(--border)}.session-document-row:hover{transform:none}.document-icon{width:28px;height:34px;box-shadow:none}.document-shelf-note{margin:8px 0 0}}
</style>
