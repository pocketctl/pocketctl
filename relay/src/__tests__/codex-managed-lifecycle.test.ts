import { describe, expect, test, vi } from 'vitest'

import { Router } from '../router.js'

type RecordedQuery = {
  sql: string
  params: any[]
}

function createRecordingPool(): any {
  const queries: RecordedQuery[] = []
  let eventID = 0
  const pool: any = {
    query: vi.fn(async (sql: string, params?: any[]) => {
      queries.push({ sql, params: params || [] })
      if (sql.includes('INSERT INTO daemons') && sql.includes('RETURNING daemon_id')) {
        return { rows: [{ daemon_id: 'daemon-1' }], rowCount: 1 }
      }
      if (sql.includes('session_allowed')) {
        // Daemon-session ownership probe: treat every session as owned.
        return { rows: [{ session_exists: true, session_allowed: true }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO sessions') && sql.includes('RETURNING session_id')) {
        // Guarded session upsert reports a successful owner-checked write.
        return { rows: [{ session_id: params?.[0] ?? null }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO events') && sql.includes('RETURNING id')) {
        return {
          rows: [{ id: ++eventID, inserted: true, effect_status: 'pending', effect_step: 0 }],
          rowCount: 1,
        }
      }
      if (sql.includes('UPDATE sessions SET')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }),
    _queries: queries,
  }
  pool.connect = vi.fn(async () => ({ query: pool.query, release: vi.fn() }))
  return pool
}

function createMockWs(): any {
  const sent: any[] = []
  return {
    readyState: 1,
    send: vi.fn((data: string) => sent.push(JSON.parse(data))),
    close: vi.fn(),
    _sent: sent,
  }
}

function queriesMatching(pool: any, fragment: string): RecordedQuery[] {
  return pool._queries.filter((query: RecordedQuery) => query.sql.includes(fragment))
}

describe('Codex managed lifecycle relay contract', () => {
  test('durably persists and broadcasts daemon-authoritative managed Codex statuses verbatim', async () => {
    const pool = createRecordingPool()
    const router = new Router(pool)
    const daemon = createMockWs()
    const client = createMockWs()

    await router.registerDaemon(daemon, {
      type: 'register',
      daemon_id: 'daemon-1',
      hostname: 'host',
      agents: [],
    }, 1)
    router.registerClient(client, 1)

    router.handleDaemonMessage('daemon-1', {
      type: 'session_discovered',
      session_id: 'thr_1',
      agent: 'codex',
      source: 'terminal',
      control_mode: 'managed',
      status: 'running',
      seq: 1,
    })

    await vi.waitFor(() => {
      expect(queriesMatching(pool, 'INSERT INTO sessions')).toContainEqual(expect.objectContaining({
        params: ['thr_1', 'daemon-1', 'codex', '', null, 'terminal', 'running', null, 1, null, 'managed', null],
      }))
      expect(queriesMatching(pool, 'INSERT INTO events')).toContainEqual(expect.objectContaining({
        params: [
          'thr_1', 'session_discovered', expect.stringContaining('"control_mode":"managed"'),
          expect.any(String), 1,
        ],
      }))
      expect(queriesMatching(pool, "UPDATE events SET effect_status = 'completed'")).toContainEqual(expect.objectContaining({
        params: [1],
      }))
    })

    ;(router as any).clients.get(client).subscribedSessions.add('thr_1')
    client._sent.length = 0

    router.handleDaemonMessage('daemon-1', {
      type: 'session_status',
      session_id: 'thr_1',
      status: 'idle',
      seq: 2,
    })

    await vi.waitFor(() => {
      expect(queriesMatching(pool, 'session_status_decision')).toContainEqual(expect.objectContaining({
        params: [2, 1, 1_000_000_000, 'thr_1', 'daemon-1', 'idle', null, 1, null],
      }))
      expect(queriesMatching(pool, 'INSERT INTO events')).toContainEqual(expect.objectContaining({
        params: [
          'thr_1', 'session_status', expect.stringContaining('"status":"idle"'),
          expect.any(String), 1,
        ],
      }))
      expect(queriesMatching(pool, "UPDATE events SET effect_status = 'completed'")).toContainEqual(expect.objectContaining({
        params: [2],
      }))
      expect(client._sent).toContainEqual(expect.objectContaining({
        type: 'session_status',
        session_id: 'thr_1',
        status: 'idle',
      }))
    })

    client._sent.length = 0
    router.handleDaemonMessage('daemon-1', {
      type: 'session_status',
      session_id: 'thr_1',
      status: 'completed',
      seq: 3,
    })

    await vi.waitFor(() => {
      expect(queriesMatching(pool, 'session_status_decision')).toContainEqual(expect.objectContaining({
        params: [3, 1, 1_000_000_000, 'thr_1', 'daemon-1', 'completed', null, 1, null],
      }))
      expect(client._sent).toContainEqual(expect.objectContaining({
        type: 'session_status',
        session_id: 'thr_1',
        status: 'completed',
      }))
    })
  })
})
