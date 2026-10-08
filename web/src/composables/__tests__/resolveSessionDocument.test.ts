import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ref } from 'vue'
import { resolveSessionDocument } from '../resolveSessionDocument'
import { useWebSocket } from '../useWebSocket'
vi.mock('../useWebSocket', () => ({ useWebSocket: vi.fn() }))

describe('resolveSessionDocument', () => {
  let connected = ref(true), listeners: Set<(event: any) => void>, send: ReturnType<typeof vi.fn>
  beforeEach(() => {
    vi.useFakeTimers()
    connected = ref(true); listeners = new Set(); send = vi.fn((_message: any) => true)
    vi.mocked(useWebSocket).mockReturnValue({ connected, send, connect: vi.fn(), onEvent(callback: (event: any) => void) { listeners.add(callback); return () => listeners.delete(callback) } } as any)
  })
  afterEach(() => vi.useRealTimers())
  const emit = (event: any) => { for (const listener of listeners) listener(event) }
  test('matches both session and request and removes its listener after reply', async () => {
    const result = resolveSessionDocument('session', '/work/report.html', new AbortController().signal)
    await Promise.resolve()
    const request = send.mock.calls[0]![0] as any
    emit({ type: 'session_document_resolved', request_id: request.request_id, session_id: 'other', reason: 'forged' })
    expect(listeners.size).toBe(1)
    emit({ type: 'session_document_resolved', request_id: request.request_id, session_id: 'session', document_id: 'doc', version_id: 'version' })
    await expect(result).resolves.toEqual({ documentId: 'doc', versionId: 'version' })
    expect(listeners.size).toBe(0)
  })
  test('cancels an outstanding request when leaving the page', async () => {
    const controller = new AbortController()
    const result = resolveSessionDocument('session', 'report.html', controller.signal)
    await Promise.resolve(); controller.abort()
    await expect(result).rejects.toMatchObject({ reason: 'cancelled' })
    expect(listeners.size).toBe(0)
  })
  test('does not send a read request until connected and fails with an offline state', async () => {
    connected.value = false
    const result = resolveSessionDocument('session', 'report.html', new AbortController().signal)
    const rejected = expect(result).rejects.toMatchObject({ reason: 'daemon_offline' })
    await vi.advanceTimersByTimeAsync(5001)
    await rejected
    expect(send).not.toHaveBeenCalled()
  })
})
