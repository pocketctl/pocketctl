import { watch } from 'vue'
import { useWebSocket } from './useWebSocket'

export class DocumentResolveError extends Error {
  constructor(readonly reason: string) { super(reason) }
}

export async function resolveSessionDocument(sessionId: string, path: string, signal: AbortSignal): Promise<{ documentId: string; versionId: string }> {
  const socket = useWebSocket()
  await new Promise<void>((resolve, reject) => {
    let stop = () => {}
    const finish = (reason?: string) => {
      clearTimeout(timer); stop(); signal.removeEventListener('abort', abort)
      if (reason) reject(new DocumentResolveError(reason)); else resolve()
    }
    const abort = () => finish('cancelled')
    const timer = setTimeout(() => finish('daemon_offline'), 5000)
    stop = watch(socket.connected, value => { if (value) finish() })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else if (socket.connected.value) finish()
    else void socket.connect()
  })
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID()
    const finish = (error?: string, result?: { documentId: string; versionId: string }) => {
      clearTimeout(timer); stop(); signal.removeEventListener('abort', abort)
      if (error) reject(new DocumentResolveError(error)); else resolve(result!)
    }
    const abort = () => finish('cancelled')
    const timer = setTimeout(() => finish('timeout'), 16000)
    const stop = socket.onEvent((event: any) => {
      if (event.request_id !== requestId || event.session_id !== sessionId) return
      if (event.type === 'error') finish('unavailable')
      if (event.type !== 'session_document_resolved') return
      if (event.reason) finish(event.reason)
      else if (typeof event.document_id === 'string' && typeof event.version_id === 'string') {
        finish(undefined, { documentId: event.document_id, versionId: event.version_id })
      } else finish('unavailable')
    })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else if (!socket.send({ type: 'session_document_resolve', session_id: sessionId, path, request_id: requestId })) finish('daemon_offline')
  })
}
