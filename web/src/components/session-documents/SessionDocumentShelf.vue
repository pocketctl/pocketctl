<template>
  <section
    v-if="documents.length || listStatus === 'loading' || listStatus === 'offline' || listStatus === 'unavailable'"
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
        v-for="document in documents.slice(0, 3)"
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
    <button v-if="documents.length > 3" ref="moreButton" type="button" class="document-more" data-testid="documents-more" @click="showList">
      {{ t('session.documents.more') }} ({{ documents.length }})
    </button>
    <Teleport to="body">
      <div v-if="listOpen" class="document-list-overlay" @click.self="closeList">
        <section ref="dialog" class="document-list-dialog" role="dialog" aria-modal="true" :aria-label="t('session.documents.title')" tabindex="-1" @keydown.esc.stop.prevent="closeList" @keydown.tab="trapFocus">
          <header class="document-shelf-header">
            <strong>{{ t('session.documents.title') }}</strong>
            <button type="button" class="document-more" @click="closeList">{{ t('common.close') }}</button>
          </header>
          <div class="session-document-list document-page" :key="page">
            <button
              v-for="document in pageDocuments"
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
          <footer class="document-pagination">
            <button type="button" :disabled="page === 0" @click="page--">{{ t('session.documents.previous') }}</button>
            <span aria-live="polite">{{ page + 1 }} / {{ pageCount }}</span>
            <button type="button" data-testid="documents-next" :disabled="page + 1 >= pageCount" @click="page++">{{ t('session.documents.next') }}</button>
          </footer>
        </section>
      </div>
    </Teleport>
    <p v-if="listStatus === 'offline'" class="document-shelf-note" role="status">
      {{ t('session.documents.offline') }}
    </p>
    <p v-if="listStatus === 'unavailable'" class="document-shelf-note warning" role="status">
      {{ t('session.documents.list_failed') }}
      <button type="button" @click="$emit('refresh')">{{ t('common.retry') }}</button>
    </p>
    <p v-if="hasUnavailable" class="document-shelf-note warning">
      {{ t('session.documents.unavailable_note') }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { SessionDocumentMetadata } from '../../services/sessionDocuments'
import type { SessionDocumentListStatus } from '../../composables/useSessionDocuments'

const props = defineProps<{
  documents: SessionDocumentMetadata[]
  listStatus: SessionDocumentListStatus
}>()
const emit = defineEmits<{ open: [document: SessionDocumentMetadata, opener: HTMLButtonElement]; refresh: [] }>()
const { t } = useLocale()
const hasUnavailable = computed(() => props.documents.some((item) => item.state !== 'available'))

// Relay returns a bounded (at most 50), newest-first metadata list.
const listOpen = ref(false)
const page = ref(0)
const pageCount = computed(() => Math.max(1, Math.ceil(props.documents.length / 10)))
const pageDocuments = computed(() => props.documents.slice(page.value * 10, (page.value + 1) * 10))
const dialog = ref<HTMLElement | null>(null)
const moreButton = ref<HTMLButtonElement | null>(null)
watch(pageCount, count => { page.value = Math.min(page.value, count - 1) })
watch(() => props.documents.length, count => { if (!count) closeList() })
async function showList() {
  page.value = 0
  listOpen.value = true
  await nextTick()
  dialog.value?.focus()
}
function closeList() {
  listOpen.value = false
  moreButton.value?.focus()
}
function trapFocus(event: KeyboardEvent) {
  const buttons = Array.from(dialog.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
  const first = buttons[0], last = buttons.at(-1)
  if (!buttons.includes(document.activeElement as HTMLButtonElement)) {
    event.preventDefault()
    ;(event.shiftKey ? last : first)?.focus()
    return
  }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) {
    event.preventDefault(); last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault(); first?.focus()
  }
}

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
.document-more,.document-pagination button{padding:10px 14px;border:0;border-radius:6px;color:var(--accent);background:transparent;cursor:pointer}
.document-list-overlay{position:fixed;inset:0;z-index:1100;display:flex;align-items:center;justify-content:center;padding:20px;background:#010409bd;overscroll-behavior:contain}
.document-list-dialog{width:min(640px,100%);max-height:85dvh;display:flex;flex-direction:column;background:var(--surface);color:var(--fg);border:1px solid var(--border-light);border-radius:12px;overflow:hidden}
.document-list-dialog header{justify-content:space-between;flex-shrink:0}
.document-page{overflow:auto;overscroll-behavior:contain}
.document-pagination{display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--border);flex-shrink:0}
.document-pagination button:disabled{opacity:.4;cursor:default}

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
