import { describe, test, expect, vi, beforeEach } from 'vitest'
import { Router } from '../router.js'
import { getRecentEvents, getEventsBefore, getRecentSubagentEvents, getSubagentEventsBefore } from '../db.js'

// Reusable mocks (mirror router.test.ts patterns)
function createMockPool() {
  const queries: { sql: string; params: any[] }[] = []
  // Rows returned for the replay (events) query. The ownership gate now issues a
  // `SELECT 1 FROM sessions` BEFORE the replay query, so tests can no longer use
  // mockImplementationOnce (it would be consumed by the ownership check). Set the
  // replay payload via _setReplayRows instead.
  let replayRows: any[] = []
  const mockPool = {
    query: vi.fn((sql: string, params?: any[]) => {
      queries.push({ sql, params: params || [] })
      if (sql.includes('SELECT 1 FROM sessions')) return Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 })
      if (sql.includes('FROM events')) return Promise.resolve({ rows: replayRows })
      return Promise.resolve({ rows: [], rowCount: 0 })
    }),
    _queries: queries,
    _setReplayRows: (rows: any[]) => { replayRows = rows },
    connect: vi.fn(),
    end: vi.fn(),
  }
  return mockPool as any
}

function createMockWs(): any {
  const sent: any[] = []
  return {
    readyState: 1,
    send: vi.fn((data: string) => { sent.push(JSON.parse(data)) }),
    close: vi.fn(),
    _sent: sent,
  }
}

// --- 1.4 db unit tests: getRecentEvents / getEventsBefore / boundary ---
describe('db - backward pagination queries (session-history-pagination 1.4)', () => {
  let pool: any
  beforeEach(() => { pool = createMockPool() })

  test('getRecentEvents issues ORDER BY id DESC LIMIT with sessionId + limit', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 5 }, { id: 4 }, { id: 3 }] })
    const result = await getRecentEvents(pool, 'sess-1', 3)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY id DESC LIMIT $2'),
      ['sess-1', 3]
    )
    expect(result).toHaveLength(3)
    // DESC order (newest first)
    expect(result[0].id).toBe(5)
    expect(result[2].id).toBe(3)
  })

  test('getEventsBefore issues id < cursor ORDER BY id DESC LIMIT', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 5420 }, { id: 5419 }] })
    const result = await getEventsBefore(pool, 'sess-1', 5424, 2)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('id < $2'),
      ['sess-1', 5424, 2]
    )
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY id DESC LIMIT $3'),
      ['sess-1', 5424, 2]
    )
    expect(result).toHaveLength(2)
  })

  test('getEventsBefore with cursor = min id returns empty (no older rows)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] })
    const result = await getEventsBefore(pool, 'sess-1', 1, 50)
    expect(result).toHaveLength(0)
  })

  test('getRecentEvents limit boundary (limit=1 returns single newest)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 99 }] })
    const result = await getRecentEvents(pool, 'sess-1', 1)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(99)
  })

  test('getRecentSubagentEvents filters by payload agent_id', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 10, payload: { type: 'agent_text', agent_id: 'agent-a' } }] })
    const result = await getRecentSubagentEvents(pool, 'sess-1', 'agent-a', 20)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("payload->>'agent_id' = $2"),
      ['sess-1', 'agent-a', 20]
    )
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY id DESC LIMIT $3'),
      ['sess-1', 'agent-a', 20]
    )
    expect(result).toHaveLength(1)
  })

  test('getSubagentEventsBefore filters by agent_id and cursor', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 8, payload: { type: 'tool_call', agent_id: 'agent-a' } }] })
    const result = await getSubagentEventsBefore(pool, 'sess-1', 'agent-a', 10, 20)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('id < $3'),
      ['sess-1', 'agent-a', 10, 20]
    )
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY id DESC LIMIT $4'),
      ['sess-1', 'agent-a', 10, 20]
    )
    expect(result).toHaveLength(1)
  })
})

// --- 6.3 router unit tests: handleReplay direction routing + has_more ---
describe('Router - replay pagination (session-history-pagination 6.3)', () => {
  let pool: any
  let router: Router
  beforeEach(() => { pool = createMockPool(); router = new Router(pool) })

  test('forward replay (no direction, legacy) → getEventsAfter path, has_more=false', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    pool._setReplayRows([{ id: 1, payload: { type: 'agent_text', text: 'hi' } }])
    router.handleClientMessage(clientWs, { type: 'replay', session_id: 'sess-1', last_seq: 0 })
    await new Promise(r => setTimeout(r, 50))

    const end = clientWs._sent.find((m: any) => m.type === 'replay_end')
    expect(end).toBeDefined()
    expect(end.has_more).toBe(false) // forward never has_more
    // query used forward path (id > lastSeq ASC)
    expect(pool.query.mock.calls.some(([sql]: [string]) => sql.includes('id > $2') && sql.includes('ORDER BY id ASC'))).toBe(true)
  })

  test('backward replay (no last_seq) → getRecentEvents (recent N)', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    const events = Array.from({ length: 50 }, (_, i) => ({ id: 50 - i, payload: { type: 'agent_text', text: 'm' + i } }))
    pool._setReplayRows(events)
    router.handleClientMessage(clientWs, { type: 'replay', session_id: 'sess-1', direction: 'backward', limit: 50, req_id: 1 })
    await new Promise(r => setTimeout(r, 50))

    const end = clientWs._sent.find((m: any) => m.type === 'replay_end')
    expect(end).toBeDefined()
    expect(end.has_more).toBe(true)  // full page (50 = limit) → has_more
    expect(end.count).toBe(50)
    expect(end.req_id).toBe(1)
    // query was getRecentEvents (ORDER BY id DESC LIMIT, no id <)
    expect(pool.query.mock.calls.some(([sql]: [string]) => sql.includes('ORDER BY id DESC LIMIT') && !sql.includes('id <'))).toBe(true)
  })

  test('subagent replay returns only requested agent events with backward pagination metadata', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    const events = Array.from({ length: 2 }, (_, i) => ({
      id: 20 - i,
      payload: { type: 'agent_text', session_id: 'sess-1', agent_id: 'agent-a', text: 'm' + i },
    }))
    pool._setReplayRows(events)
    await router.handleClientMessage(clientWs, { type: 'replay_subagent', session_id: 'sess-1', agent_id: 'agent-a', limit: 20 })
    await new Promise(r => setTimeout(r, 50))

    const batch = clientWs._sent.find((m: any) => m.type === 'replay_batch')
    const end = clientWs._sent.find((m: any) => m.type === 'replay_end')
    expect(batch).toBeDefined()
    expect(batch.agent_id).toBe('agent-a')
    expect(batch.direction).toBe('backward')
    expect(end).toBeDefined()
    expect(end.agent_id).toBe('agent-a')
    expect(end.count).toBe(2)
    expect(end.has_more).toBe(false)
    expect(pool.query.mock.calls.some(([sql, params]: [string, any[]]) =>
      sql.includes("payload->>'agent_id' = $2") && params.includes('agent-a')
    )).toBe(true)
  })

  test('backward replay (last_seq cursor) → getEventsBefore (id < cursor)', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    // fewer than limit → has_more false
    pool._setReplayRows([{ id: 5420, payload: { type: 'agent_text' } }])
    router.handleClientMessage(clientWs, { type: 'replay', session_id: 'sess-1', direction: 'backward', last_seq: 5424, limit: 50, req_id: 2 })
    await new Promise(r => setTimeout(r, 50))

    const end = clientWs._sent.find((m: any) => m.type === 'replay_end')
    expect(end).toBeDefined()
    expect(end.has_more).toBe(false) // < full page → no more
    expect(end.req_id).toBe(2)
    const q = pool.query.mock.calls.find(([sql]: [string]) => sql.includes('id < $2') && sql.includes('ORDER BY id DESC'))
    expect(q).toBeDefined()
    expect(q[1]).toContain(5424)
  })

  test('backward full page (count = limit) → has_more=true', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    const events = Array.from({ length: 50 }, (_, i) => ({ id: 100 - i, payload: {} }))
    pool._setReplayRows(events)
    router.handleClientMessage(clientWs, { type: 'replay', session_id: 'sess-1', direction: 'backward', last_seq: 200, limit: 50 })
    await new Promise(r => setTimeout(r, 50))
    const end = clientWs._sent.find((m: any) => m.type === 'replay_end')
    expect(end.has_more).toBe(true)
  })

  test('replay_batch carries direction field for backward', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    pool._setReplayRows([{ id: 3, payload: { type: 'agent_text', text: 'a' } }])
    router.handleClientMessage(clientWs, { type: 'replay', session_id: 'sess-1', direction: 'backward', limit: 50 })
    await new Promise(r => setTimeout(r, 50))
    const batch = clientWs._sent.find((m: any) => m.type === 'replay_batch')
    expect(batch).toBeDefined()
    expect(batch.direction).toBe('backward')
  })

  test('empty backward result → replay_end has_more=false, count=0', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    pool._setReplayRows([])
    router.handleClientMessage(clientWs, { type: 'replay', session_id: 'sess-1', direction: 'backward', limit: 50 })
    await new Promise(r => setTimeout(r, 50))
    const end = clientWs._sent.find((m: any) => m.type === 'replay_end')
    expect(end.count).toBe(0)
    expect(end.has_more).toBe(false)
  })
})
