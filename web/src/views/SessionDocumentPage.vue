<template>
  <main class="standalone-document-page">
    <SessionDocumentViewer v-if="state.viewer.value.status !== 'closed'" :viewer="state.viewer.value" :html-rendering="state.htmlRendering.value" :compact="isMobile" standalone @close="backToSession" @download="download" />
    <section v-else class="document-page-state" role="status">
      <p>{{ resolveError || t(resolving ? 'session.documents.resolving_link' : state.listStatus.value === 'loading' || state.listStatus.value === 'idle' ? 'session.documents.loading_content' : 'session.documents.unavailable_note') }}</p>
      <button class="btn btn-secondary" :disabled="resolving" @click="load">{{ t('common.retry') }}</button>
      <button class="btn btn-secondary" @click="backToSession">{{ t('mobile.back_to_sessions') }}</button>
    </section>
    <p v-if="downloadError" class="document-download-error" role="alert">{{ downloadError }}</p>
  </main>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import SessionDocumentViewer from '../components/session-documents/SessionDocumentViewer.vue'
import { useSessionDocuments } from '../composables/useSessionDocuments'
import { useLocale } from '../composables/useLocale'
import { useResponsiveLayout } from '../composables/useResponsiveLayout'
import { resolveSessionDocument, DocumentResolveError } from '../composables/resolveSessionDocument'
import { localDocumentPath } from '../utils/sessionDocumentLinks'
import { fetchSessionDocumentDownload, type SessionDocumentMetadata } from '../services/sessionDocuments'
const route = useRoute(), router = useRouter(), { t } = useLocale(), { isMobile } = useResponsiveLayout()
const sessionId = computed(() => String(route.params.id || '')), state = useSessionDocuments(sessionId), downloadError = ref('')
let generation = 0
let controller: AbortController | null = null
const resolving = ref(false), resolveError = ref('')
async function load() {
  const requested = ++generation
  controller?.abort()
  controller = new AbortController()
  const signal = controller.signal
  resolveError.value = ''
  state.close()
  resolving.value = route.name === 'session-document-link'
  try {
    if (resolving.value) {
      const path = new URLSearchParams(window.location.hash.slice(1)).get('path')
      if (!path || localDocumentPath(encodeURI(path).replace(/#/g, '%23').replace(/\?/g, '%3F')) !== path) throw new DocumentResolveError('unavailable')
      const target = await resolveSessionDocument(sessionId.value, path, signal)
      // Acknowledging capture does not mean the durable worker has committed it.
      // Open only after the authenticated list exposes the requested version.
      for (let attempt = 0; attempt < 20; attempt++) {
        if (signal.aborted || requested !== generation) return
        await state.refresh()
        if (signal.aborted || requested !== generation) return
        const ready = state.documents.value.find(item => item.documentId === target.documentId && item.versionId === target.versionId && item.state === 'available')
        if (ready) {
          await router.replace({ name: 'session-document', params: { id: sessionId.value, documentId: ready.documentId, versionId: ready.versionId } })
          return
        }
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      throw new DocumentResolveError('timeout')
    }
    await state.refresh()
    if (requested !== generation) return
    const document = state.documents.value.find(item => item.documentId === route.params.documentId && item.versionId === route.params.versionId)
    if (document) { window.document.title = `${document.displayName} · PocketCtl`; await state.open(document) }
  } catch (error) {
    if (signal.aborted || requested !== generation) return
    const reason = error instanceof DocumentResolveError ? error.reason : 'unavailable'
    const key = ['daemon_offline', 'unsupported', 'timeout', 'busy', 'rate_limited'].includes(reason) ? reason : 'unavailable'
    resolveError.value = t('session.documents.resolve.' + key)
  } finally { if (requested === generation) resolving.value = false }
}
function backToSession() { void router.push(`/session/${encodeURIComponent(sessionId.value)}`) }
async function download(document: SessionDocumentMetadata) {
  downloadError.value = ''
  try {
    const blob = await fetchSessionDocumentDownload(sessionId.value, document), url = URL.createObjectURL(blob), anchor = window.document.createElement('a')
    anchor.href = url; anchor.download = document.format === 'html' ? `${document.displayName.replace(/\.html?$/i, '')}.static.html` : document.displayName
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch { downloadError.value = t('session.documents.download_failed') }
}
watch(() => route.fullPath, () => { void load() }, { immediate: true })
onBeforeUnmount(() => { generation++; controller?.abort(); state.dispose(); document.title = 'PocketCtl' })
</script>
<style scoped>
.standalone-document-page{min-height:100dvh;background:var(--bg)}.document-page-state{display:flex;flex-wrap:wrap;justify-content:center;gap:12px;padding:48px 20px;color:var(--fg-secondary)}.document-page-state p{width:100%;text-align:center}.document-download-error{position:fixed;bottom:20px;left:20px;right:20px;z-index:1300;padding:12px;background:var(--error-bg);color:var(--error);border-radius:8px}
</style>
