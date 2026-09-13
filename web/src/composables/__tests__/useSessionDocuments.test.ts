import { beforeEach, describe, expect, test, vi } from 'vitest'
import { nextTick, ref } from 'vue'

vi.mock('../../services/sessionDocuments', () => ({
  listSessionDocuments: vi.fn(),
  fetchSessionDocumentContent: vi.fn(),
  SessionDocumentApiError: class SessionDocumentApiError extends Error {
    constructor(public status: number, public code: string) { super(code) }
  },
}))

import { fetchSessionDocumentContent, listSessionDocuments, SessionDocumentApiError } from '../../services/sessionDocuments'
import { useSessionDocuments } from '../useSessionDocuments'

const metadata = {
  documentId: 'doc-1', versionId: 'ver-1', displayName: 'notes.md', format: 'markdown' as const,
  state: 'available' as const, reason: null, byteSize: 5, sha256: 'a'.repeat(64),
  sourceTurnId: 'turn-1', sourceEventId: 'event-1', capturedAt: 'now', committedAt: 'now',
}

describe('useSessionDocuments', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(listSessionDocuments).mockReset().mockResolvedValue({ htmlRendering: false, documents: [metadata] })
    vi.mocked(fetchSessionDocumentContent).mockReset().mockResolvedValue({
      text: 'hello', bytes: new Uint8Array(5), format: 'markdown', byteSize: 5, sha256: metadata.sha256,
    })
  })

  test('loads metadata first and fetches a body only when opened', async () => {
    const state = useSessionDocuments(ref('session-1'), { accessToken: ref('token') })
    await state.refresh()
    expect(state.documents.value).toEqual([metadata])
    expect(fetchSessionDocumentContent).not.toHaveBeenCalled()

    await state.open(metadata)
    expect(fetchSessionDocumentContent).toHaveBeenCalledWith('session-1', metadata)
    expect(state.viewer.value).toMatchObject({ status: 'ready', text: 'hello', offlineSnapshot: false })
    state.dispose()
  })

  test('debounces body-free notifications for only the current session', async () => {
    const state = useSessionDocuments(ref('session-1'), { accessToken: ref('token'), debounceMs: 200 })
    state.notify({ session_id: 'other' })
    state.notify({ session_id: 'session-1' })
    state.notify({ session_id: 'session-1' })
    await vi.advanceTimersByTimeAsync(199)
    expect(listSessionDocuments).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(listSessionDocuments).toHaveBeenCalledTimes(1)
    state.dispose()
  })

  test('keeps an already verified open snapshot during a network refresh failure', async () => {
    const state = useSessionDocuments(ref('session-1'), { accessToken: ref('token') })
    await state.refresh()
    await state.open(metadata)
    vi.mocked(listSessionDocuments).mockRejectedValueOnce(new SessionDocumentApiError(0, 'network_error'))
    await state.refresh()
    expect(state.viewer.value).toMatchObject({ status: 'ready', text: 'hello', offlineSnapshot: true })
    expect(state.listStatus.value).toBe('offline')
    state.dispose()
  })

  test('clears verified bytes on close, logout, ownership failure, deletion, and session switch', async () => {
    const sessionId = ref('session-1')
    const accessToken = ref('token')
    const state = useSessionDocuments(sessionId, { accessToken })
    await state.refresh(); await state.open(metadata); state.close()
    expect(state.viewer.value.text).toBe('')

    await state.open(metadata)
    accessToken.value = ''
    await nextTick()
    expect(state.viewer.value.text).toBe('')
    expect(state.documents.value).toEqual([])

    accessToken.value = 'token'
    await state.refresh(); await state.open(metadata)
    vi.mocked(listSessionDocuments).mockRejectedValueOnce(new SessionDocumentApiError(404, 'ownership_failure'))
    await state.refresh()
    expect(state.viewer.value.text).toBe('')

    vi.mocked(listSessionDocuments).mockResolvedValue({ htmlRendering: false, documents: [metadata] })
    await state.refresh(); await state.open(metadata); state.sessionDeleted('session-1')
    expect(state.viewer.value.text).toBe('')

    await state.refresh(); await state.open(metadata)
    sessionId.value = 'session-2'
    await nextTick()
    expect(state.viewer.value.text).toBe('')
    state.dispose()
  })

  test('never exposes corrupt content to the viewer', async () => {
    vi.mocked(fetchSessionDocumentContent).mockRejectedValueOnce(new SessionDocumentApiError(200, 'integrity_failed'))
    const state = useSessionDocuments(ref('session-1'), { accessToken: ref('token') })
    await state.refresh(); await state.open(metadata)
    expect(state.viewer.value).toMatchObject({ status: 'integrity_failed', text: '' })
    state.dispose()
  })
})
