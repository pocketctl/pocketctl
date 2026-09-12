import { describe, expect, test, vi } from 'vitest'

import { Router } from '../router.js'

function socket() {
  const sent: any[] = []
  return {
    readyState: 1,
    send: vi.fn((raw: string) => sent.push(JSON.parse(raw))),
    close: vi.fn(),
    _sent: sent,
  } as any
}

describe('session document metadata notification', () => {
  test('broadcasts body-free metadata only to authenticated sockets of the same user', () => {
    const router = new Router({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) } as any)
    const ownerA = socket()
    const ownerB = socket()
    const foreign = socket()
    router.registerClient(ownerA, 7)
    router.registerClient(ownerB, 7)
    router.registerClient(foreign, 8)

    router.deliverMaterializedEvent({
      inboxId: 11, daemonId: 'daemon-1', eventId: null, userId: 7, audience: 'user',
      sessionId: 'session-1', requestId: null, ordinal: 0,
      deliveryKey: 'document:document-1:version-1:user:0', type: 'session_documents_changed',
      payload: {
        type: 'session_documents_changed', session_id: 'session-1',
        document_id: 'document-1', version_id: 'version-1',
      },
    })

    expect(ownerA._sent).toContainEqual(expect.objectContaining({ type: 'session_documents_changed' }))
    expect(ownerB._sent).toContainEqual(expect.objectContaining({ type: 'session_documents_changed' }))
    expect(foreign._sent).toEqual([])
    expect(JSON.stringify(ownerA._sent)).not.toContain('content')
    router.stop()
  })
})
