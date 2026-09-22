import { describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Router } from '../router.js'

function socket() {
  const sent: any[] = []
  return {
    OPEN: 1,
    readyState: 1,
    send: vi.fn((raw: string) => sent.push(JSON.parse(raw))),
    close: vi.fn(),
    sent,
  } as any
}

function attachDaemon(router: Router, ws: any) {
  ;(router as any).daemons.set('daemon-a', {
    ws, daemonId: 'daemon-a', hostname: 'host-a', agents: [], userId: 7,
    registrationId: 'registration-a', startedAt: 11, lastHeartbeatAt: Date.now(),
  })
  ;(router as any).daemonSeq.set('daemon-a', {
    startedAt: 11, persistedHigh: 0, pending: new Set(), effects: new Map(),
    draining: false, inflight: new Set(), baselineSet: false, accepting: true,
  })
}

describe('session history read router control plane', () => {
  test('production wiring is explicitly feature-gated', () => {
    const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
    expect(source).toContain("process.env.SESSION_HISTORY_MCP === 'on'")
    expect(source).toContain('createSessionHistoryReadBroker({')
  })

  test('derives account and daemon identity from the authenticated socket', async () => {
    const ws = socket()
    const broker = {
      read: vi.fn(async () => ({
        type: 'session_history_read_result', source_session_id: 'source-a',
        target_session_id: 'target-b', messages: [], has_more: false,
        large_session: false, snapshot_through_event_id: '0', synced_through_at: null,
        possibly_incomplete: false, untrusted_content: true,
      })),
    }
    const router = new Router({ query: vi.fn() } as any, { sessionHistoryReadBroker: broker as any })
    attachDaemon(router, ws)

    router.handleDaemonMessage('daemon-a', {
      type: 'session_history_read', request_id: 'request-1',
      source_session_id: 'source-a', target_session_id: 'target-b',
      user_id: 999,
    }, ws, 11)
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1))

    expect(broker.read).not.toHaveBeenCalled()
    expect(ws.sent[0]).toEqual({
      type: 'session_history_read_error', request_id: 'request-1', code: 'invalid_request',
    })
    router.stop()
  })

  test('routes a valid request without persisting it as an event', async () => {
    const ws = socket()
    const pool = { query: vi.fn() }
    const broker = {
      read: vi.fn(async (identity: any) => ({
        type: 'session_history_read_result', source_session_id: 'source-a',
        target_session_id: 'target-b', messages: [], has_more: false,
        large_session: false, snapshot_through_event_id: '0', synced_through_at: null,
        possibly_incomplete: false, untrusted_content: true, identity,
      })),
    }
    const router = new Router(pool as any, { sessionHistoryReadBroker: broker as any })
    attachDaemon(router, ws)

    router.handleDaemonMessage('daemon-a', {
      type: 'session_history_read', request_id: 'request-2',
      source_session_id: 'source-a', target_session_id: 'target-b',
    }, ws, 11)
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1))

    expect(broker.read).toHaveBeenCalledWith(
      { userId: 7, daemonId: 'daemon-a' },
      { sourceSessionId: 'source-a', targetSessionId: 'target-b' },
    )
    expect(pool.query).not.toHaveBeenCalled()
    expect(ws.sent[0]).toMatchObject({
      type: 'session_history_read_result', request_id: 'request-2',
      identity: { userId: 7, daemonId: 'daemon-a' },
    })
    router.stop()
  })

  test('answers feature_disabled when Relay has no read broker', async () => {
    const ws = socket()
    const router = new Router({ query: vi.fn() } as any)
    attachDaemon(router, ws)
    router.handleDaemonMessage('daemon-a', {
      type: 'session_history_read', request_id: 'request-3',
      source_session_id: 'source-a', target_session_id: 'target-b',
    }, ws, 11)
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1))
    expect(ws.sent[0]).toEqual({
      type: 'session_history_read_error', request_id: 'request-3', code: 'feature_disabled',
    })
    router.stop()
  })
})
