<template>
  <main>
    <button id="document-harness-opener" ref="opener" type="button">Open document</button>
    <output id="document-harness-close-count">{{ closeCount }}</output>
    <SessionDocumentViewer
      :viewer="viewer"
      :html-rendering="htmlRendering"
      :compact="compact"
      :return-focus-to="opener"
      @close="closeViewer"
    />
  </main>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

import SessionDocumentViewer from '../src/components/session-documents/SessionDocumentViewer.vue'
import type { SessionDocumentViewerState } from '../src/composables/useSessionDocuments'
import type { SessionDocumentMetadata } from '../src/services/sessionDocuments'

const opener = ref<HTMLButtonElement | null>(null)
const compact = ref(false)
const htmlRendering = ref(true)
const closeCount = ref(0)
const messages: unknown[] = []
const baseDocument: SessionDocumentMetadata = {
  documentId: 'browser-doc',
  versionId: 'browser-version',
  displayName: 'hostile.html',
  format: 'html',
  state: 'available',
  reason: null,
  byteSize: 0,
  sha256: 'a'.repeat(64),
  sourceTurnId: 'browser-turn',
  sourceEventId: 'browser-event',
  capturedAt: '2026-09-12T00:00:00.000Z',
  committedAt: '2026-09-12T00:00:01.000Z',
}
const viewer = ref<SessionDocumentViewerState>({
  status: 'closed', document: null, text: '', offlineSnapshot: false,
})

function waitForPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

async function show(
  source: string,
  options: { compact?: boolean; offline?: boolean; format?: 'html' | 'markdown' } = {},
): Promise<Record<string, unknown>> {
  viewer.value = { status: 'closed', document: null, text: '', offlineSnapshot: false }
  await nextTick()
  document.body.dataset.compromised = ''
  messages.length = 0
  compact.value = options.compact === true
  const format = options.format ?? 'html'
  const documentMetadata: SessionDocumentMetadata = {
    ...baseDocument,
    format,
    displayName: format === 'html' ? 'hostile.html' : 'notes.md',
    byteSize: new TextEncoder().encode(source).length,
  }
  opener.value?.focus()
  viewer.value = {
    status: 'ready', document: documentMetadata, text: source,
    offlineSnapshot: options.offline === true,
  }
  await nextTick()
  await waitForPaint()
  return snapshot()
}

async function setStatus(status: SessionDocumentViewerState['status']): Promise<Record<string, unknown>> {
  if (status === 'closed') {
    viewer.value = { status: 'closed', document: null, text: '', offlineSnapshot: false }
  } else {
    viewer.value = { ...viewer.value, status, text: '' }
  }
  await nextTick()
  await waitForPaint()
  return snapshot()
}

function closeViewer(): void {
  closeCount.value += 1
  viewer.value = { status: 'closed', document: null, text: '', offlineSnapshot: false }
}

function snapshot(): Record<string, unknown> {
  const dialog = document.querySelector<HTMLElement>('.session-document-viewer')
  const frame = document.querySelector<HTMLIFrameElement>('.document-html-frame')
  const rect = dialog?.getBoundingClientRect()
  return {
    ready: true,
    viewerPresent: Boolean(dialog),
    frameCount: document.querySelectorAll('.document-html-frame').length,
    compactClass: document.querySelector('.session-document-viewer-layer')?.classList.contains('compact') ?? false,
    offlineBadge: Boolean(document.querySelector('.offline-badge')),
    activeElement: document.activeElement?.getAttribute('aria-label') || document.activeElement?.id || document.activeElement?.textContent?.trim() || '',
    compromised: document.body.dataset.compromised || '',
    messageCount: messages.length,
    closeCount: closeCount.value,
    bodyText: document.body.textContent || '',
    iframeSandbox: frame?.getAttribute('sandbox') ?? null,
    iframeReferrerPolicy: frame?.getAttribute('referrerpolicy') ?? null,
    viewport: { width: innerWidth, height: innerHeight },
    dialog: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
  }
}

function onMessage(event: MessageEvent): void { messages.push(event.data) }

onMounted(() => {
  window.addEventListener('message', onMessage)
  ;(window as typeof window & { __pocketctlHarness?: unknown }).__pocketctlHarness = {
    show,
    setStatus,
    close: closeViewer,
    snapshot,
  }
})
onBeforeUnmount(() => window.removeEventListener('message', onMessage))
</script>

<style>
:root {
  color-scheme: dark;
  --bg: #0d1117;
  --bg-secondary: #161b22;
  --surface: #21262d;
  --surface-active: #30363d;
  --border: #30363d;
  --border-light: #484f58;
  --fg: #f0f6fc;
  --fg-secondary: #c9d1d9;
  --fg-tertiary: #8b949e;
  --accent: #58a6ff;
  --success: #3fb950;
  --warning: #d29922;
  --danger: #f85149;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --font-sans: -apple-system, BlinkMacSystemFont, sans-serif;
}
html, body, #app { width: 100%; height: 100%; margin: 0; background: var(--bg); }
main { min-height: 100%; padding: 12px; box-sizing: border-box; }
#document-harness-close-count { margin-left: 12px; }
</style>
