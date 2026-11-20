import {isHistoryEventAuthorityQuery, nativeAliasUnitResult} from './fixtures/native-alias-unit.js'
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { Router } from '../router.js'
import { getCompleteBackwardReplayPage, getCompleteForwardReplayPage, getLatestAgentPlan, getLatestAgentTaskLists, getRecentEvents, getEventsBefore, getRecentSubagentEvents, getSubagentEventsBefore, listSessionsPageByDaemon } from '../db.js'

// Reusable mocks (mirror router.test.ts patterns)
function createMockPool() {
  const queries: { sql: string; params: any[] }[] = []
  // Rows returned for the replay (events) query. The ownership gate now issues a
  // `SELECT 1 FROM sessions` BEFORE the replay query, so tests can no longer use
  // mockImplementationOnce (it would be consumed by the ownership check). Set the
  // replay payload via _setReplayRows instead.
  let replayRows: any[] = []
  let latestTypedRow: any | undefined
  let childSessionHit = false
  const mockPool = {
    query: vi.fn((sql: string, params?: any[]) => {
      queries.push({ sql, params: params || [] })
      const native=nativeAliasUnitResult(sql,params);if(native)return Promise.resolve(native)
      if (sql.includes('is_subagent') && sql.includes('parent_session_id')) {
        return Promise.resolve({ rows: childSessionHit ? [{ session_id: params ? params[0] : '' }] : [], rowCount: childSessionHit ? 1 : 0 })
      }
      if (sql.includes('SELECT 1 FROM sessions')) return Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 })
      if (sql.includes('SELECT 1 FROM events')) return Promise.resolve({ rows: [] })
      if (sql.includes('DISTINCT ON') || sql.includes("event_type = 'agent_plan'")) return Promise.resolve({ rows: latestTypedRow ? [latestTypedRow] : [] })
      if (sql.includes('FROM events')) return Promise.resolve({ rows: replayRows })
      return Promise.resolve({ rows: [], rowCount: 0 })
    }),
    _queries: queries,
    _setReplayRows: (rows: any[]) => { replayRows = rows },
    _setChildSession: (hit: boolean) => { childSessionHit = hit },
    _setLatestTypedRow: (row: any | undefined) => { latestTypedRow = row },
    connect: vi.fn(async () => ({ query: mockPool.query, release: vi.fn() })),
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
    pool.query.mockResolvedValueOnce({ rows: [{ id: 5, payload: {} }, { id: 4, payload: {} }, { id: 3, payload: {} }] })
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
    pool.query.mockResolvedValueOnce({ rows: [{ id: 5420, payload: {} }, { id: 5419, payload: {} }] })
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
    pool.query.mockResolvedValueOnce({ rows: [{ id: 99, payload: {} }] })
    const result = await getRecentEvents(pool, 'sess-1', 1)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(99)
  })

  test('getRecentSubagentEvents filters by payload agent_id', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 10, payload: { type: 'agent_text', agent_id: 'agent-a' } }] })
    const result = await getRecentSubagentEvents(pool, 'sess-1', 'agent-a', 20)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("COALESCE(payload,body_header)->>'agent_id' = $2"),
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

describe('db - session list activity ordering', () => {
  test('falls back to created_at instead of metadata updated_at', async () => {
    const queries: string[] = []
    const pool: any = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql)
        return { rows: [] }
      }),
    }

    await listSessionsPageByDaemon(pool, { daemonId: 'daemon-1', limit: 20 })

    expect(queries[0]).toContain('COALESCE(s.last_activity_at, s.created_at)')
    expect(queries[0]).not.toContain('COALESCE(s.last_activity_at, s.updated_at)')
  })

  test('rejects pre-v2 cursors after the activity sort key changes', async () => {
    const calls: any[][] = []
    const pool: any = {
      query: vi.fn(async (_sql: string, params: any[]) => {
        calls.push(params)
        return { rows: [] }
      }),
    }
    const oldCursor = Buffer.from(JSON.stringify({
      pinned: 0,
      pinnedAt: '1970-01-01T00:00:00.000Z',
      activityAt: '2026-09-04T04:22:00.000Z',
      sessionId: 'old-session',
    }), 'utf8').toString('base64url')

    await listSessionsPageByDaemon(pool, { daemonId: 'daemon-1', limit: 20, cursor: oldCursor })

    expect(calls[0]).toEqual(['daemon-1', 21])
  })
})

describe('db - complete backward replay pages', () => {
  function streamRows(fromSequence: number, toSequence: number) {
    return Array.from({ length: fromSequence - toSequence + 1 }, (_, index) => {
      const chunkSeq = fromSequence - index
      return {
        id: chunkSeq + 923,
        payload: {
          type: 'agent_text',
          stream_id: 'stream-a',
          chunk_seq: chunkSeq,
          byte_offset: chunkSeq,
          final: chunkSeq === 77,
        },
      }
    })
  }

  test('scans past an event window and returns a complete stream in ascending order', async () => {
    const scans = [streamRows(177, 78), streamRows(77, 0)]
    const pool = {
      query: vi.fn((sql: string, params:any[]=[]) => {
        const native=nativeAliasUnitResult(sql,params);if(native)return Promise.resolve(native)
        if (sql.includes('SELECT 1 FROM events')) return Promise.resolve({ rows: [{ exists: true }] })
        if (sql.includes('FROM events')) return Promise.resolve({ rows: scans.shift() ?? [] })
        return Promise.resolve({ rows: [] })
      }),
    } as any

    const page = await getCompleteBackwardReplayPage(pool, 'sess-1', undefined, 1)

    expect(page.events.map(event => event.payload.chunk_seq)).toEqual(Array.from({ length: 178 }, (_, i) => i))
    expect(page.oldestId).toBe(923)
    expect(page.logicalCount).toBe(1)
    expect(page.hasMore).toBe(true)
    const scansIssued = pool.query.mock.calls.filter(([sql]: [string]) =>
      sql.includes('FROM events') && !sql.includes('SELECT 1 FROM events') && !isHistoryEventAuthorityQuery(sql)
    )
    expect(scansIssued).toHaveLength(2)
    expect(scansIssued[1][0]).toContain('id <')
  })

  function backwardFixture(heads: any[]) {
    const limits: number[] = []
    const pool = { query: vi.fn(async (sql: string, args: any[] = []) => {
      const native = nativeAliasUnitResult(sql, args)
      if (native) return native
      if (sql.includes('ORDER BY id DESC LIMIT')) {
        const limit = args.at(-1)
        limits.push(limit)
        const before = args.length === 3 ? args[1] : Infinity
        return { rows: heads.filter(row => row.id < before).slice(0, limit) }
      }
      if (sql.includes('SELECT 1 FROM events')) return { rows: heads.filter(row => row.id < args[1]).slice(0, 1) }
      return { rows: [] }
    }) } as any
    return { pool, limits }
  }

  test('expands only continuation scans of long streams and preserves the next page cursor', async () => {
    const chunks = streamRows(1989, 0)
    const older = Array.from({ length: 25 }, (_, i) => ({ id: 922 - i, payload: { type: 'user_text' } }))
    const { pool, limits } = backwardFixture([...chunks, ...older])
    const page = await getCompleteBackwardReplayPage(pool, 's', undefined, 20)
    expect(limits[0]).toBe(100)
    expect(limits).toContain(256)
    expect(limits.length).toBeLessThan(12)
    expect(page.events.map(row => row.id)).toEqual([...chunks, ...older.slice(0, 19)].reverse().map(row => row.id))
    expect(page).toMatchObject({ logicalCount: 20, hasMore: true, oldestId: older[18].id })
    limits.length = 0
    const previous = await getCompleteBackwardReplayPage(pool, 's', page.oldestId, 20)
    expect(limits).toEqual([100])
    expect(previous.events.map(row => row.id)).toEqual(older.slice(19).reverse().map(row => row.id))
  })

  test('handles interleaved streams, a sequence gap and an unreadable cold row beyond the ordinary window', async () => {
    const heads: any[] = streamRows(700, 601)
    const older = Array.from({ length: 210 }, (_, i) => ({ id: 600 - i, payload: { type: 'user_text' } }))
    heads.push(
      { id: 604, payload: { type: 'tool_result', stream_id: 'b', chunk_seq: 7, byte_offset: 7 } },
      { id: 603, payload: { ...heads[0].payload, chunk_seq: 0, byte_offset: 0 } },
      { id: 602, payload: { type: 'tool_result', stream_id: 'b', chunk_seq: 0, byte_offset: 0 } },
      ...older,
    )
    heads[250] = { ...heads[250], body_storage: 'cold', payload: null }
    const { pool, limits } = backwardFixture(heads)
    const page = await getCompleteBackwardReplayPage(pool, 's', undefined, 1)
    expect(limits).toEqual([100, 256])
    expect(page).toMatchObject({ oldestId: 602, logicalCount: 2, hasMore: true })
    expect(page.events.map(row => row.id)).toEqual(heads.slice(0, 103).reverse().map(row => row.id))
  })

  test('returns to the original window boundary after widening, without reading an older cold body', async () => {
    const stream = streamRows(612, 257)
    const older = Array.from({ length: 270 }, (_, i) => ({ id: 900 - i, payload: { type: 'user_text' } }))
    const heads: any[] = [...stream, { id: 922, payload: { ...stream[0].payload, chunk_seq: 0, byte_offset: 0 } }, ...older]
    heads[414] = { ...heads[414], body_storage: 'cold', payload: null }
    const { pool, limits } = backwardFixture(heads)
    const page = await getCompleteBackwardReplayPage(pool, 's', undefined, 1)
    expect(limits).toEqual([100, 256, 256])
    expect(page.events).toHaveLength(357)
    expect(page).toMatchObject({ oldestId: 922, logicalCount: 1, hasMore: true })
  })

  test('a full window of retired heads does not hide an older authorized zero chunk', async () => {
    const heads = streamRows(600, 0).map(row => ({
      ...row, owner_retired: row.payload.chunk_seq > 500,
    }))
    const { pool } = backwardFixture(heads)
    const page = await getCompleteBackwardReplayPage(pool, 's', undefined, 1)
    expect(page.events.map(row => row.payload.chunk_seq)).toEqual(Array.from({ length: 501 }, (_, i) => i))
    expect(page.hasMore).toBe(false)
  })

  test('keeps the subagent filter for scans and has-more lookup', async () => {
    const pool = {
      query: vi.fn((sql: string, params:any[]=[]) => {
        const native=nativeAliasUnitResult(sql,params);if(native)return Promise.resolve(native)
        if (sql.includes('SELECT 1 FROM events')) return Promise.resolve({ rows: [] })
        if (sql.includes('FROM events')) {
          return Promise.resolve({ rows: [{
            id: 8,
            payload: { type: 'agent_text', agent_id: 'agent-a', stream_id: 'stream-a', chunk_seq: 0, byte_offset: 0, final: true },
          }] })
        }
        return Promise.resolve({ rows: [] })
      }),
    } as any

    const page = await getCompleteBackwardReplayPage(pool, 'sess-1', 9, 1, 'agent-a')

    expect(page.events).toHaveLength(1)
    const eventQueries = pool.query.mock.calls.filter(([sql]: [string]) => sql.includes('FROM events') && !isHistoryEventAuthorityQuery(sql))
    expect(eventQueries).toHaveLength(2)
    expect(eventQueries.every(([sql]: [string]) => sql.includes("COALESCE(payload,body_header)->>'agent_id'"))).toBe(true)
  })
})

describe('db - complete forward replay pages', () => {
  function streamRows(fromSequence: number, toSequence: number) {
    return Array.from({ length: toSequence - fromSequence + 1 }, (_, index) => {
      const chunkSeq = fromSequence + index
      return {
        id: chunkSeq + 1_001,
        payload: {
          type: 'agent_text',
          stream_id: 'stream-forward',
          chunk_seq: chunkSeq,
          byte_offset: chunkSeq,
          final: chunkSeq === 177,
        },
      }
    })
  }

  test('scans past an event window and returns a complete forward stream', async () => {
    const scans = [streamRows(0, 99), streamRows(100, 177)]
    const pool = {
      query: vi.fn((sql: string, params:any[]=[]) => {
        const native=nativeAliasUnitResult(sql,params);if(native)return Promise.resolve(native)
        if (sql.includes('SELECT 1 FROM events')) return Promise.resolve({ rows: [] })
        if (sql.includes('FROM events')) return Promise.resolve({ rows: scans.shift() ?? [] })
        return Promise.resolve({ rows: [] })
      }),
    } as any

    const page = await getCompleteForwardReplayPage(pool, 'sess-1', 1_000, 1)

    expect(page.events.map(event => event.payload.chunk_seq)).toEqual(Array.from({ length: 178 }, (_, i) => i))
    expect(page.oldestId).toBe(1_001)
    expect(page.newestId).toBe(1_178)
    expect(page.logicalCount).toBe(1)
    expect(page.hasMore).toBe(false)
    const scansIssued = pool.query.mock.calls.filter(([sql]: [string]) =>
      sql.includes('FROM events') && !sql.includes('SELECT 1 FROM events') && !isHistoryEventAuthorityQuery(sql)
    )
    expect(scansIssued).toHaveLength(2)
    expect(scansIssued[1][0]).toContain('id >')
  })

  test('stops at a complete logical boundary and reports buffered newer rows', async () => {
    const pool = {
      query: vi.fn((sql: string, params:any[]=[]) => {
        const native=nativeAliasUnitResult(sql,params);if(native)return Promise.resolve(native)
        if (sql.includes('SELECT 1 FROM events')) return Promise.resolve({ rows: [] })
        if (sql.includes('FROM events')) {
          return Promise.resolve({ rows: [
            { id: 11, payload: { type: 'user_text', text: 'one' } },
            { id: 12, payload: { type: 'agent_text', text: 'two' } },
          ] })
        }
        return Promise.resolve({ rows: [] })
      }),
    } as any

    const page = await getCompleteForwardReplayPage(pool, 'sess-1', 10, 1)

    expect(page.events.map(event => event.id)).toEqual([11])
    expect(page.oldestId).toBe(11)
    expect(page.newestId).toBe(11)
    expect(page.logicalCount).toBe(1)
    expect(page.hasMore).toBe(true)
  })

  test('keeps the subagent filter for forward scans and has-more lookup', async () => {
    const pool = {
      query: vi.fn((sql: string, params:any[]=[]) => {
        const native=nativeAliasUnitResult(sql,params);if(native)return Promise.resolve(native)
        if (sql.includes('SELECT 1 FROM events')) return Promise.resolve({ rows: [] })
        if (sql.includes('FROM events')) {
          return Promise.resolve({ rows: [{
            id: 21,
            payload: { type: 'agent_text', agent_id: 'agent-a', stream_id: 'stream-a', chunk_seq: 0, byte_offset: 0, final: true },
          }] })
        }
        return Promise.resolve({ rows: [] })
      }),
    } as any

    const page = await getCompleteForwardReplayPage(pool, 'sess-1', 20, 1, 'agent-a')

    expect(page.events).toHaveLength(1)
    const eventQueries = pool.query.mock.calls.filter(([sql]: [string]) => sql.includes('FROM events') && !isHistoryEventAuthorityQuery(sql))
    expect(eventQueries.every(([sql]: [string]) => sql.includes("COALESCE(payload,body_header)->>'agent_id'"))).toBe(true)
  })
})

describe('db - latest event by type', () => {
  test('orders Plan snapshots by validated semantic revision before database id', async () => {
    const pool = createMockPool()
    const plan = { id: 17, event_type: 'agent_plan', payload: { type: 'agent_plan', revision: 3 } }
    pool._setLatestTypedRow(plan)

    await expect(getLatestAgentPlan(pool, 'sess-1')).resolves.toEqual(plan)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("event_type = 'agent_plan'"),
      ['sess-1'],
    )
    const query = pool.query.mock.calls.find(([sql]: [string, any[]]) => sql.includes("event_type = 'agent_plan'"))?.[0]
    expect(query).toContain("jsonb_typeof(COALESCE(payload,body_header)->'revision') = 'number'")
    expect(query).toContain("(COALESCE(payload,body_header)->>'revision') ~ '^[1-9][0-9]*$'")
    expect(query).toContain("(COALESCE(payload,body_header)->>'revision')::numeric")
    expect(query).toMatch(/DESC NULLS LAST,\s*id DESC\s*LIMIT 1/)
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

  test('explicit forward replay returns one complete page and newest metadata', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    pool._setReplayRows([
      { id: 11, payload: { type: 'user_text', text: 'one' } },
      { id: 12, payload: { type: 'agent_text', text: 'two' } },
    ])

    router.handleClientMessage(clientWs, {
      type: 'replay', session_id: 'sess-1', direction: 'forward', last_seq: 10, limit: 1, req_id: 71,
    })
    await new Promise(r => setTimeout(r, 50))

    const batches = clientWs._sent.filter((message: any) => message.type === 'replay_batch')
    const end = clientWs._sent.find((message: any) => message.type === 'replay_end')
    expect(batches.flatMap((batch: any) => batch.events).map((event: any) => event.text)).toEqual(['one'])
    expect(end).toMatchObject({ req_id: 71, count: 1, logical_count: 1, last_seq: 11, newest_seq: 11, has_more: true })
  })

  test('backward replay returns the complete page in ascending order', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    const events = Array.from({ length: 50 }, (_, i) => ({ id: 50 - i, payload: { type: 'agent_text', text: 'm' + i } }))
    pool._setReplayRows(events)
    router.handleClientMessage(clientWs, { type: 'replay', session_id: 'sess-1', direction: 'backward', limit: 50, req_id: 1 })
    await new Promise(r => setTimeout(r, 50))

    const end = clientWs._sent.find((m: any) => m.type === 'replay_end')
    expect(end).toBeDefined()
    expect(end.has_more).toBe(false) // exact older-row lookup found no older event
    expect(end.count).toBe(50)
    expect(end.logical_count).toBe(50)
    expect(end.req_id).toBe(1)
    expect(end.newest_seq).toBe(50)
    // the scan query is newest-first, but the client receives the selected page ASC.
    expect(pool.query.mock.calls.some(([sql]: [string]) => sql.includes('ORDER BY id DESC LIMIT') && !sql.includes('id <'))).toBe(true)
    const batch = clientWs._sent.find((message: any) => message.type === 'replay_batch')
    expect(batch.events.map((event: any) => event.text)).toEqual(Array.from({ length: 50 }, (_, index) => `m${49 - index}`))
  })

  test('initial backward replay supplements the latest plan without changing the history cursor', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    pool._setReplayRows([
      { id: 102, payload: { type: 'agent_text', text: 'newer' } },
      { id: 101, payload: { type: 'agent_text', text: 'older' } },
    ])
    pool._setLatestTypedRow({
      id: 40,
      payload: {
        type: 'agent_plan', session_id: 'sess-1', part_id: 'plan:sess-1', revision: 4,
        plan: [{ step: 'Implement UI', status: 'in_progress' }],
      },
    })

    router.handleClientMessage(clientWs, {
      type: 'replay', session_id: 'sess-1', direction: 'backward', limit: 2, req_id: 7,
    })
    await new Promise(r => setTimeout(r, 50))

    const replayed = clientWs._sent
      .filter((message: any) => message.type === 'replay_batch')
      .flatMap((message: any) => message.events)
    expect(replayed.map((event: any) => event.type)).toEqual(['agent_text', 'agent_text', 'agent_plan'])
    const end = clientWs._sent.find((message: any) => message.type === 'replay_end')
    expect(end).toMatchObject({ req_id: 7, count: 3, logical_count: 2, last_seq: 101, newest_seq: 102 })
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
      sql.includes("COALESCE(payload,body_header)->>'agent_id' = $2") && params.includes('agent-a')
    )).toBe(true)
  })

  test('explicit subagent forward replay keeps the agent scope and newest metadata', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    pool._setReplayRows([
      { id: 31, payload: { type: 'agent_text', session_id: 'sess-1', agent_id: 'agent-a', text: 'one' } },
      { id: 32, payload: { type: 'agent_text', session_id: 'sess-1', agent_id: 'agent-a', text: 'two' } },
    ])

    await router.handleClientMessage(clientWs, {
      type: 'replay_subagent', session_id: 'sess-1', agent_id: 'agent-a', direction: 'forward', last_seq: 30, limit: 1, req_id: 81,
    })
    await new Promise(r => setTimeout(r, 50))

    const batch = clientWs._sent.find((message: any) => message.type === 'replay_batch')
    const end = clientWs._sent.find((message: any) => message.type === 'replay_end')
    expect(batch).toMatchObject({ agent_id: 'agent-a', direction: 'forward', req_id: 81 })
    expect(end).toMatchObject({ agent_id: 'agent-a', req_id: 81, last_seq: 31, newest_seq: 31, has_more: true })
    expect(pool.query.mock.calls.some(([sql, params]: [string, any[]]) =>
      sql.includes("COALESCE(payload,body_header)->>'agent_id'") && sql.includes('id >') && params.includes('agent-a')
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

  test('backward full page uses the older-row lookup instead of count heuristic', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    const events = Array.from({ length: 50 }, (_, i) => ({ id: 100 - i, payload: {} }))
    pool._setReplayRows(events)
    router.handleClientMessage(clientWs, { type: 'replay', session_id: 'sess-1', direction: 'backward', last_seq: 200, limit: 50 })
    await new Promise(r => setTimeout(r, 50))
    const end = clientWs._sent.find((m: any) => m.type === 'replay_end')
    expect(end.has_more).toBe(false)
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

  test('session replay batches stay within the UTF-8 byte budget', async () => {
    const byteLimitedRouter = new Router(pool, {
      transport: {
        maxEventBytes: 1_048_576,
        maxChunkBytes: 131_072,
        replayBatchMaxEvents: 50,
        replayBatchMaxBytes: 512,
      },
    })
    const clientWs = createMockWs()
    byteLimitedRouter.registerClient(clientWs, 1)
    pool._setReplayRows(Array.from({ length: 4 }, (_, i) => ({
      id: i + 1,
      payload: {
        type: 'agent_text',
        session_id: 'sess-1',
        text: '你'.repeat(60),
      },
    })))

    await byteLimitedRouter.handleClientMessage(clientWs, {
      type: 'replay', session_id: 'sess-1', last_seq: 0,
    })
    await new Promise(r => setTimeout(r, 50))

    const batches = clientWs._sent.filter((message: any) => message.type === 'replay_batch')
    expect(batches.length).toBeGreaterThan(1)
    expect(batches.every((batch: any) =>
      Buffer.byteLength(JSON.stringify(batch), 'utf8') <= 512
    )).toBe(true)
    expect(batches.flatMap((batch: any) => batch.events).map((event: any) => event.text))
      .toEqual(Array(4).fill('你'.repeat(60)))
  })

  test('session replay preserves the configured event-count ceiling', async () => {
    const countLimitedRouter = new Router(pool, {
      transport: {
        maxEventBytes: 1_048_576,
        maxChunkBytes: 131_072,
        replayBatchMaxEvents: 2,
        replayBatchMaxBytes: 10_000,
      },
    })
    const clientWs = createMockWs()
    countLimitedRouter.registerClient(clientWs, 1)
    pool._setReplayRows(Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      payload: { type: 'agent_text', text: `m${i}` },
    })))

    await countLimitedRouter.handleClientMessage(clientWs, {
      type: 'replay', session_id: 'sess-1', last_seq: 0,
    })
    await new Promise(r => setTimeout(r, 50))

    const batches = clientWs._sent.filter((message: any) => message.type === 'replay_batch')
    expect(batches.map((batch: any) => batch.events.length)).toEqual([2, 2, 1])
  })

  test('subagent replay uses the same UTF-8 byte budget', async () => {
    const byteLimitedRouter = new Router(pool, {
      transport: {
        maxEventBytes: 1_048_576,
        maxChunkBytes: 131_072,
        replayBatchMaxEvents: 50,
        replayBatchMaxBytes: 512,
      },
    })
    const clientWs = createMockWs()
    byteLimitedRouter.registerClient(clientWs, 1)
    pool._setReplayRows(Array.from({ length: 4 }, (_, i) => ({
      id: 20 - i,
      payload: {
        type: 'agent_text',
        session_id: 'sess-1',
        agent_id: 'agent-a',
        text: '你'.repeat(50),
      },
    })))

    await byteLimitedRouter.handleClientMessage(clientWs, {
      type: 'replay_subagent',
      session_id: 'sess-1',
      agent_id: 'agent-a',
      limit: 20,
    })
    await new Promise(r => setTimeout(r, 50))

    const batches = clientWs._sent.filter((message: any) => message.type === 'replay_batch')
    expect(batches.length).toBeGreaterThan(1)
    expect(batches.every((batch: any) =>
      Buffer.byteLength(JSON.stringify(batch), 'utf8') <= 512
    )).toBe(true)
    expect(batches.flatMap((batch: any) => batch.events)).toHaveLength(4)
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

  test('replay_end carries the authoritative current session status', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    pool.query.mockImplementation((sql: string, params:any[]=[]) => {
      const native=nativeAliasUnitResult(sql,params);if(native)return Promise.resolve(native)
      if (sql.includes('SELECT 1 FROM sessions')) return Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 })
      if (sql.includes('SELECT status, turn_started_at, last_activity_at FROM sessions')) {
        return Promise.resolve({
          rows: [{ status: 'completed', turn_started_at: null, last_activity_at: null }],
          rowCount: 1,
        })
      }
      if (sql.includes('FROM events')) return Promise.resolve({ rows: [{ id: 1, payload: { type: 'agent_text', text: 'done' } }] })
      return Promise.resolve({ rows: [], rowCount: 0 })
    })

    await router.handleClientMessage(clientWs, {
      type: 'replay', session_id: 'sess-1', direction: 'backward', limit: 20,
    })
    await new Promise(r => setTimeout(r, 50))

    const end = clientWs._sent.find((m: any) => m.type === 'replay_end')
    expect(end.status).toBe('completed')
  })

  test('backward replay emits a multi-batch stream from chunk zero through final', async () => {
    const streamRows = (fromSequence: number, toSequence: number) =>
      Array.from({ length: fromSequence - toSequence + 1 }, (_, index) => {
        const chunkSeq = fromSequence - index
        return {
          id: chunkSeq + 923,
          payload: {
            type: 'agent_text',
            session_id: 'sess-1',
            stream_id: 'stream-a',
            chunk_seq: chunkSeq,
            byte_offset: chunkSeq,
            final: chunkSeq === 177,
            text: String(chunkSeq),
          },
        }
      })
    const scans = [streamRows(177, 78), streamRows(77, 0)]
    const completePagePool = {
      query: vi.fn((sql: string, params:any[]=[]) => {
        const native=nativeAliasUnitResult(sql,params);if(native)return Promise.resolve(native)
        if (sql.includes('SELECT 1 FROM sessions')) return Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 })
        if (sql.includes('SELECT status, turn_started_at, last_activity_at FROM sessions')) {
          return Promise.resolve({ rows: [{ status: 'completed', turn_started_at: null, last_activity_at: null }] })
        }
        if (sql.includes('SELECT 1 FROM events')) return Promise.resolve({ rows: [] })
        if (sql.includes('FROM events')) return Promise.resolve({ rows: scans.shift() ?? [] })
        return Promise.resolve({ rows: [] })
      }),
    } as any
    const orderedRouter = new Router(completePagePool, {
      transport: {
        maxEventBytes: 1_048_576,
        maxChunkBytes: 131_072,
        replayBatchMaxEvents: 50,
        replayBatchMaxBytes: 10_000,
      },
    })
    const clientWs = createMockWs()
    orderedRouter.registerClient(clientWs, 1)

    orderedRouter.handleClientMessage(clientWs, {
      type: 'replay', session_id: 'sess-1', direction: 'backward', limit: 1, req_id: 9,
    })
    await new Promise(resolve => setTimeout(resolve, 50))

    const batches = clientWs._sent.filter((message: any) => message.type === 'replay_batch')
    expect(batches.map((batch: any) => batch.events.length)).toEqual([50, 50, 50, 28])
    expect(batches.flatMap((batch: any) => batch.events).map((event: any) => event.chunk_seq))
      .toEqual(Array.from({ length: 178 }, (_, index) => index))
    const end = clientWs._sent.find((message: any) => message.type === 'replay_end')
    expect(end).toMatchObject({ count: 178, logical_count: 1, last_seq: 923, has_more: false, req_id: 9 })
  })

  test('observes an oversized initial page without splitting its logical stream', async () => {
    const chunks = Array.from({ length: 220 }, (_, index) => {
      const chunkSeq = 219 - index
      return {
        id: chunkSeq + 1,
        payload: {
          type: 'agent_text', session_id: 'sess-1', stream_id: 'oversized-stream',
          chunk_seq: chunkSeq, byte_offset: chunkSeq * 6_000,
          final: chunkSeq === 219, text: 'x'.repeat(6_000),
        },
      }
    })
    const scans = [chunks.slice(0, 100), chunks.slice(100, 200), chunks.slice(200)]
    const completePagePool = {
      query: vi.fn((sql: string, params:any[]=[]) => {
        const native=nativeAliasUnitResult(sql,params);if(native)return Promise.resolve(native)
        if (sql.includes('SELECT 1 FROM sessions')) return Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 })
        if (sql.includes('SELECT status, turn_started_at, last_activity_at FROM sessions')) {
          return Promise.resolve({ rows: [{ status: 'completed', turn_started_at: null, last_activity_at: null }] })
        }
        if (sql.includes('SELECT 1 FROM events')) return Promise.resolve({ rows: [] })
        if (sql.includes('FROM events')) return Promise.resolve({ rows: scans.shift() ?? [] })
        return Promise.resolve({ rows: [] })
      }),
    } as any
    const observedRouter = new Router(completePagePool)
    const clientWs = createMockWs()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    observedRouter.registerClient(clientWs, 1)

    observedRouter.handleClientMessage(clientWs, {
      type: 'replay', session_id: 'sess-1', direction: 'backward', limit: 1, req_id: 10,
    })
    await new Promise(resolve => setTimeout(resolve, 50))

    const events = clientWs._sent
      .filter((message: any) => message.type === 'replay_batch')
      .flatMap((message: any) => message.events)
    expect(events).toHaveLength(220)
    expect(events[0].chunk_seq).toBe(0)
    expect(events.at(-1).chunk_seq).toBe(219)
    expect(warn).toHaveBeenCalledWith(
      '[history-replay] initial page threshold exceeded',
      expect.objectContaining({ sessionId: 'sess-1', eventCount: 220, logicalCount: 1 }),
    )
    expect(warn.mock.calls[0][1].payloadBytes).toBeGreaterThanOrEqual(1_048_576)
    expect(warn.mock.calls[0][1].durationMs).toEqual(expect.any(Number))
    warn.mockRestore()
  })
})


// --- zcode independent child-session model: replay_subagent fallback ---
describe('replay_subagent independent child sessions (zcode model)', () => {
  let pool: any
  let router: Router
  beforeEach(() => { pool = createMockPool(); router = new Router(pool) })

  test('falls back to the child session events when agent_id is an independent session', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    pool._setChildSession(true)
    pool._setReplayRows([
      { id: 12, event_type: 'agent_text', payload: { type: 'agent_text', session_id: 'zcode-child', text: 'work' } },
      { id: 11, event_type: 'session_discovered', payload: { type: 'session_discovered', session_id: 'zcode-child' } },
      { id: 10, event_type: 'tool_call', payload: { type: 'tool_call', session_id: 'zcode-child', tool: 'Bash' } },
      { id: 9, event_type: 'user_text', payload: { type: 'user_text', session_id: 'zcode-child', text: 'go' } },
    ])

    await router.handleClientMessage(clientWs, { type: 'replay_subagent', session_id: 'zcode-parent', agent_id: 'zcode-child', limit: 20 })
    await new Promise(r => setTimeout(r, 50))

    const batch = clientWs._sent.find((m: any) => m.type === 'replay_batch')
    const end = clientWs._sent.find((m: any) => m.type === 'replay_end')
    expect(batch).toBeDefined()
    // Lifecycle noise (session_discovered) is filtered; content events carry
    // the injected agent_id so the web routes them into the subagent bucket.
    expect(batch.events.map((e: any) => e.type)).toEqual(['user_text', 'tool_call', 'agent_text'])
    for (const ev of batch.events) expect(ev.agent_id).toBe('zcode-child')
    expect(batch.agent_id).toBe('zcode-child')
    expect(end).toMatchObject({ agent_id: 'zcode-child', count: 3, has_more: false })
    // The events query ran against the child session without the agent filter.
    const agentFilterCalls = pool.query.mock.calls.filter(([sql]: [string]) => sql.includes("COALESCE(payload,body_header)->>'agent_id'"))
    expect(agentFilterCalls).toHaveLength(0)
    expect(pool.query.mock.calls.some(([sql, params]: [string, any[]]) =>
      sql.includes('FROM events') && params && params[0] === 'zcode-child'
    )).toBe(true)
  })

  test('keeps the parent-bucket path when agent_id is not an independent session', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    pool._setChildSession(false)
    pool._setReplayRows([
      { id: 5, payload: { type: 'agent_text', session_id: 'sess-1', agent_id: 'agent-a', text: 'bucketed' } },
    ])

    await router.handleClientMessage(clientWs, { type: 'replay_subagent', session_id: 'sess-1', agent_id: 'agent-a', limit: 20 })
    await new Promise(r => setTimeout(r, 50))

    const batch = clientWs._sent.find((m: any) => m.type === 'replay_batch')
    expect(batch).toBeDefined()
    expect(batch.events).toHaveLength(1)
    expect(batch.events[0].agent_id).toBe('agent-a')
    expect(pool.query.mock.calls.some(([sql, params]: [string, any[]]) =>
      sql.includes("COALESCE(payload,body_header)->>'agent_id' = $2") && params.includes('agent-a')
    )).toBe(true)
  })
})


test('restores independent task sources and retains empty snapshots', async () => {
  const rows = [
    { id: 1, event_type: 'agent_plan', payload: { type: 'agent_plan', part_id: 'plan:s', revision: 3 } },
    { id: 2, event_type: 'agent_plan', payload: { type: 'agent_plan', part_id: 'openspec:s:f', revision: 10 } },
    { id: 3, event_type: 'agent_todo', payload: { type: 'agent_todo', todos: [] } },
  ]
  const pool = { query: vi.fn().mockResolvedValue({ rows }) } as any
  expect(await getLatestAgentTaskLists(pool, 's')).toEqual(rows)
  const sql = pool.query.mock.calls[0][0]
  expect(sql).toContain('DISTINCT ON')
  expect(sql).toContain("event_type IN ('agent_plan','agent_todo')")
  expect(sql).toContain("->>'part_id'")
  expect(sql).toContain("->>'agent_id', '') = ''")
})

test('task source selection materializes winning IDs before loading any body', async () => {
  const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any
  await getLatestAgentTaskLists(pool, 's')
  const sql = pool.query.mock.calls[0][0]
  expect(sql).toContain('AS MATERIALIZED')
  expect(sql).toContain('JOIN latest_task_ids')
})
