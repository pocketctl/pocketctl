<template>
  <main class="standalone-document-page">
    <SessionDocumentViewer v-if="state.viewer.value.status !== 'closed'" :viewer="state.viewer.value" :html-rendering="state.htmlRendering.value" :compact="isMobile" standalone @close="backToSession" @download="download" />
    <section v-else class="document-page-state" role="status">
      <p>{{ t(state.listStatus.value === 'loading' || state.listStatus.value === 'idle' ? 'session.documents.loading_content' : 'session.documents.unavailable_note') }}</p>
      <button class="btn btn-secondary" @click="load">{{ t('common.retry') }}</button>
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
import { fetchSessionDocumentDownload, type SessionDocumentMetadata } from '../services/sessionDocuments'
const route = useRoute(), router = useRouter(), { t } = useLocale(), { isMobile } = useResponsiveLayout()
const sessionId = computed(() => String(route.params.id || '')), state = useSessionDocuments(sessionId), downloadError = ref('')
let generation = 0
async function load() {
  const requested = ++generation
  await state.refresh()
  if (requested !== generation) return
  const document = state.documents.value.find(item => item.documentId === route.params.documentId && item.versionId === route.params.versionId)
  if (document) { window.document.title = `${document.displayName} · PocketCtl`; await state.open(document) }
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
onBeforeUnmount(() => { generation++; state.dispose(); document.title = 'PocketCtl' })
</script>
<style scoped>
.standalone-document-page{min-height:100dvh;background:var(--bg)}.document-page-state{display:flex;flex-wrap:wrap;justify-content:center;gap:12px;padding:48px 20px;color:var(--fg-secondary)}.document-page-state p{width:100%;text-align:center}.document-download-error{position:fixed;bottom:20px;left:20px;right:20px;z-index:1300;padding:12px;background:var(--error-bg);color:var(--error);border-radius:8px}
</style>
