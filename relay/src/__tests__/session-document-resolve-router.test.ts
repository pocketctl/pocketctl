import { afterEach, describe, expect, test, vi } from 'vitest'
import { Router } from '../router.js'
import { classifyDaemonEvent } from '../ingress/event-policy.js'
import * as db from '../db.js'

function socket(): any { return { readyState: 1, sent: [] as any[], send(raw: string) { this.sent.push(JSON.parse(raw)) } } }
function fixture() {
  vi.spyOn(db, 'getSessionRuntimePolicy').mockImplementation(async (_pool, id, user) => id === 'owned' && user === 7 ? { daemonId: 'd', agentType: 'codex', source: 'desktop', controlMode: null, capabilities: [], status: 'idle' } : null)
  const router = new Router({ query: vi.fn(async () => ({ rows: [] })) } as any, { sessionDocuments: { mode: 'on' } })
  const r = router as any, a = socket(), b = socket(), d = socket(), other = socket()
  r.clients.set(a, { userId: 7 }); r.clients.set(b, { userId: 7 })
  r.daemons.set('d', { ws: d, userId: 7, supportsDocumentResolve: true, lastHeartbeatAt: Date.now() })
  r.daemons.set('other', { ws: other, userId: 8, supportsDocumentResolve: true, lastHeartbeatAt: Date.now() })
  return { router, r, a, b, d, other }
}
afterEach(() => vi.restoreAllMocks())
const request = { type: 'session_document_resolve', session_id: 'owned', request_id: 'same', path: '/workspace/report.html' }
describe('session document resolve routing', () => {
  test('routes only to the session owner and correlates tabs privately', async () => {
    const { router, r, a, b, d, other } = fixture()
    for (const client of [a, b]) await router.handleClientMessage(client, { ...request, daemon_id: 'other' })
    expect(other.sent).toHaveLength(0)
    expect(d.sent).toHaveLength(2)
    expect(d.sent[0].request_id).not.toBe(d.sent[1].request_id)
    router.handleDaemonMessage('other', { type: 'session_document_resolved', request_id: d.sent[0].request_id, document_id: 'forged' })
    expect(a.sent).toHaveLength(0)
    router.handleDaemonMessage('d', { type: 'session_document_resolved', request_id: d.sent[0].request_id, document_id: 'doc-1', version_id: 'version-1' })
    expect(a.sent.at(-1)).toMatchObject({ session_id: 'owned', request_id: 'same', document_id: 'doc-1' })
    expect(b.sent).toHaveLength(0)
    router.unregisterClient(b); expect(r.documentRequests.size).toBe(0)
  })
  test('rejects foreign and unknown sessions, old daemons, and disabled capture', async () => {
    const { router, r, a, d } = fixture()
    for (const session_id of ['foreign', 'missing']) {
      await router.handleClientMessage(a, { ...request, session_id })
      expect(a.sent.at(-1).type).toBe('error')
    }
    expect(d.sent).toHaveLength(0)
    r.daemons.get('d').supportsDocumentResolve = false
    await router.handleClientMessage(a, request)
    expect(a.sent.at(-1).reason).toBe('unsupported')
    r.sessionDocumentsMode = 'off'
    await router.handleClientMessage(a, request)
    expect(a.sent.at(-1).reason).toBe('unsupported')
  })
  test('bounds concurrent work, times out, and never persists replies as session content', async () => {
    vi.useFakeTimers()
    try {
      const { router, r, a, d } = fixture()
      for (let n = 0; n < 3; n++) await router.handleClientMessage(a, { ...request, request_id: String(n) })
      expect(d.sent).toHaveLength(2); expect(a.sent.at(-1).reason).toBe('busy')
      await vi.advanceTimersByTimeAsync(15001)
      expect(r.documentRequests.size).toBe(0); expect(a.sent.at(-1).reason).toBe('timeout')
      expect(classifyDaemonEvent({ type: 'session_document_resolved' }).durable).toBe(false)
    } finally { vi.useRealTimers() }
  })
})
