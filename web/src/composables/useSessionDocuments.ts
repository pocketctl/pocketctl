import { ref, watch, type Ref } from 'vue'

import { useAuth } from './useAuth'
import {
  fetchSessionDocumentContent,
  listSessionDocuments,
  SessionDocumentApiError,
  type SessionDocumentMetadata,
} from '../services/sessionDocuments'

export type SessionDocumentListStatus = 'idle' | 'loading' | 'ready' | 'offline' | 'unavailable'
export type SessionDocumentViewerStatus =
  | 'closed'
  | 'loading'
  | 'ready'
  | 'unavailable'
  | 'invalid_encoding'
  | 'integrity_failed'
  | 'error'

export interface SessionDocumentViewerState {
  status: SessionDocumentViewerStatus
  document: SessionDocumentMetadata | null
  text: string
  offlineSnapshot: boolean
}

interface SessionDocumentStateOptions {
  accessToken?: Ref<string>
  debounceMs?: number
}

function emptyViewer(): SessionDocumentViewerState {
  return { status: 'closed', document: null, text: '', offlineSnapshot: false }
}

function unavailableStatus(document: SessionDocumentMetadata): SessionDocumentViewerStatus {
  if (document.reason === 'invalid_encoding') return 'invalid_encoding'
  if (document.reason === 'integrity_failed') return 'integrity_failed'
  return 'unavailable'
}

export function useSessionDocuments(sessionId: Readonly<Ref<string>>, options: SessionDocumentStateOptions = {}) {
  const auth = useAuth()
  const token = options.accessToken ?? auth.accessToken
  const documents = ref<SessionDocumentMetadata[]>([])
  const htmlRendering = ref(false)
  const listStatus = ref<SessionDocumentListStatus>('idle')
  const viewer = ref<SessionDocumentViewerState>(emptyViewer())
  let notificationTimer: ReturnType<typeof setTimeout> | null = null
  let generation = 0

  function close(): void {
    generation++
    viewer.value = emptyViewer()
  }

  function clear(): void {
    close()
    documents.value = []
    htmlRendering.value = false
    listStatus.value = 'idle'
    if (notificationTimer) clearTimeout(notificationTimer)
    notificationTimer = null
  }

  async function refresh(): Promise<void> {
    if (!sessionId.value || sessionId.value.startsWith('pending-') || !token.value) {
      clear()
      return
    }
    const requestedSession = sessionId.value
    listStatus.value = documents.value.length ? listStatus.value : 'loading'
    try {
      const result = await listSessionDocuments(requestedSession)
      if (requestedSession !== sessionId.value) return
      documents.value = result.documents
      htmlRendering.value = result.htmlRendering
      listStatus.value = 'ready'
      const selected = viewer.value.document
      if (selected && !result.documents.some((item) =>
        item.documentId === selected.documentId && item.versionId === selected.versionId)) close()
      else if (viewer.value.status === 'ready') viewer.value = { ...viewer.value, offlineSnapshot: false }
    } catch (error) {
      if (requestedSession !== sessionId.value) return
      if (error instanceof SessionDocumentApiError && error.code === 'ownership_failure') {
        clear()
        listStatus.value = 'unavailable'
        return
      }
      if (error instanceof SessionDocumentApiError && error.code === 'network_error') {
        listStatus.value = 'offline'
        if (viewer.value.status === 'ready' && viewer.value.text) {
          viewer.value = { ...viewer.value, offlineSnapshot: true }
        }
        return
      }
      listStatus.value = 'unavailable'
    }
  }

  async function open(document: SessionDocumentMetadata): Promise<void> {
    close()
    const requestGeneration = generation
    viewer.value = {
      status: document.state === 'available' ? 'loading' : unavailableStatus(document),
      document,
      text: '',
      offlineSnapshot: false,
    }
    if (document.state !== 'available') return
    try {
      const content = await fetchSessionDocumentContent(sessionId.value, document)
      if (generation !== requestGeneration || viewer.value.document?.versionId !== document.versionId) return
      viewer.value = { status: 'ready', document, text: content.text, offlineSnapshot: false }
    } catch (error) {
      if (generation !== requestGeneration) return
      const code = error instanceof SessionDocumentApiError ? error.code : 'request_failed'
      if (code === 'ownership_failure') {
        clear()
        listStatus.value = 'unavailable'
        return
      }
      viewer.value = {
        status: code === 'integrity_failed' || code === 'invalid_encoding' ? code : 'error',
        document,
        text: '',
        offlineSnapshot: false,
      }
    }
  }

  function notify(message: { session_id?: unknown }): void {
    if (message.session_id !== sessionId.value) return
    if (notificationTimer) clearTimeout(notificationTimer)
    notificationTimer = setTimeout(() => {
      notificationTimer = null
      void refresh()
    }, options.debounceMs ?? 250)
  }

  function sessionDeleted(deletedSessionId: string): void {
    if (deletedSessionId === sessionId.value) clear()
  }

  const stopSessionWatch = watch(sessionId, () => clear())
  const stopAuthWatch = watch(token, (value) => { if (!value) clear() })

  function dispose(): void {
    clear()
    stopSessionWatch()
    stopAuthWatch()
  }

  return {
    documents,
    htmlRendering,
    listStatus,
    viewer,
    refresh,
    open,
    close,
    notify,
    sessionDeleted,
    clear,
    dispose,
  }
}
