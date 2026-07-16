import { describe, test, expect, vi } from 'vitest'
import { completeEventEffect, incrementSessionTokensForEvent, insertEvent, persistEvent, persistEventWithEffect } from '../db.js'

// persistEvent wraps insertEvent with bounded retries so a transient DB blip
// (e.g. a Postgres restart on deploy) no longer silently drops a daemon event.

describe('db.persistEvent - retry on transient failure', () => {
	test('returns zero when a stable event conflicts with an existing row', async () => {
	  const pool: any = {
		query: vi.fn((sql: string) => Promise.resolve(
		  sql.includes('INSERT INTO events') ? { rows: [] } : { rows: [], rowCount: 1 },
		)),
	  }
	  await expect(persistEvent(pool, 'sess-1', 'agent_text', {
		type: 'agent_text', event_id: 'opencode:part:prt_1:final:abc',
	  })).resolves.toBe(0)
	})

  test('uses stable event_id instead of daemon seq without collapsing distinct records', async () => {
    const inserts: any[][] = []
    const pool: any = {
      query: vi.fn((sql: string, params?: any[]) => {
        if (sql.includes('INSERT INTO events')) {
          inserts.push(params ?? [])
          return Promise.resolve({ rows: [{ id: inserts.length }] })
        }
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
    }

    await insertEvent(pool, 'root', 'agent_text', { type: 'agent_text', agent_id: 'child', event_id: 'line-1', seq: 10, text: 'same' })
    await insertEvent(pool, 'root', 'agent_text', { type: 'agent_text', agent_id: 'child', event_id: 'line-1', seq: 99, text: 'same' })
    await insertEvent(pool, 'root', 'agent_text', { type: 'agent_text', agent_id: 'child', event_id: 'line-2', seq: 100, text: 'same' })

    expect(inserts[0][3]).toBe(inserts[1][3])
    expect(inserts[2][3]).not.toBe(inserts[0][3])
  })

  test('ignores transport seq when hashing events without event_id', async () => {
    const inserts: any[][] = []
    const pool: any = {
      query: vi.fn((sql: string, params?: any[]) => {
        if (sql.includes('INSERT INTO events')) {
          inserts.push(params ?? [])
          return Promise.resolve({ rows: [{ id: inserts.length }] })
        }
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
    }
    const request = { type: 'approval_request', request_id: 'per_1', tool: 'bash' }
    await insertEvent(pool, 'sess-1', 'approval_request', { ...request, seq: 10 })
    await insertEvent(pool, 'sess-1', 'approval_request', { ...request, seq: 99 })
    await insertEvent(pool, 'sess-1', 'approval_request', { ...request, seq: 100, request_id: 'per_2', tool: 'edit' })

    expect(inserts[0][3]).toBe(inserts[1][3])
    expect(inserts[2][3]).not.toBe(inserts[0][3])
  })

  test('keeps seq for repeated events without a stable business identity', async () => {
    const inserts: any[][] = []
    const pool: any = {
      query: vi.fn((sql: string, params?: any[]) => {
        if (sql.includes('INSERT INTO events')) {
          inserts.push(params ?? [])
          return Promise.resolve({ rows: [{ id: inserts.length }] })
        }
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
    }
    const text = { type: 'user_text', text: 'repeat me' }
    await insertEvent(pool, 'sess-1', 'user_text', { ...text, seq: 10 })
    await insertEvent(pool, 'sess-1', 'user_text', { ...text, seq: 11 })

    expect(inserts[0][3]).not.toBe(inserts[1][3])
  })

  test('retries a failing insert and returns the id once it succeeds', async () => {
    let insertCalls = 0
    const pool: any = {
      query: vi.fn((sql: string) => {
        if (sql.includes('INSERT INTO events')) {
          insertCalls++
          if (insertCalls === 1) return Promise.reject(new Error('db blip'))
          return Promise.resolve({ rows: [{ id: 42 }] })
        }
        return Promise.resolve({ rows: [], rowCount: 1 }) // post-insert activity update
      }),
    }
    const id = await persistEvent(pool, 'sess-1', 'agent_text', { type: 'agent_text' })
    expect(id).toBe(42)
    expect(insertCalls).toBe(2) // failed once, succeeded on retry
  })

  test('rejects after exhausting the attempt budget (so callers can withhold the ack)', async () => {
    const pool: any = {
      query: vi.fn((sql: string) => {
        if (sql.includes('INSERT INTO events')) return Promise.reject(new Error('db down'))
        return Promise.resolve({ rows: [] })
      }),
    }
    // 2 attempts → one ~100ms backoff, then reject.
    await expect(persistEvent(pool, 'sess-1', 'agent_text', {}, 2)).rejects.toThrow('db down')
  })
})

describe('durable event effect ledger', () => {
  test('atomically returns a pending effect and retries it after event conflict', async () => {
    const rows = [
      { id: 7, inserted: true, effect_status: 'pending', effect_step: 0 },
      { id: 7, inserted: false, effect_status: 'pending', effect_step: 1 },
      { id: 7, inserted: false, effect_status: 'completed', effect_step: 2 },
    ]
    const pool: any = { query: vi.fn(async (sql: string) => (
      sql.includes('INSERT INTO events') ? { rows: [rows.shift()] } : { rows: [], rowCount: 1 }
    )) }
    await expect(persistEventWithEffect(pool, 'sess-1', 'agent_text', { event_id: 'stable' }))
      .resolves.toEqual({ rowID: 7, inserted: true, completed: false, nextStep: 0 })
    await expect(persistEventWithEffect(pool, 'sess-1', 'agent_text', { event_id: 'stable' }))
      .resolves.toEqual({ rowID: 7, inserted: false, completed: false, nextStep: 1 })
    await expect(persistEventWithEffect(pool, 'sess-1', 'agent_text', { event_id: 'stable' }))
      .resolves.toEqual({ rowID: 7, inserted: false, completed: true, nextStep: 2 })
    expect(pool.query.mock.calls[0][0]).toContain('effect_status')
    expect(pool.query.mock.calls[0][0]).toContain('ON CONFLICT')
  })

  test('treats pre-ledger none rows as completed compatibility history', async () => {
    const pool: any = { query: vi.fn(async () => ({
      rows: [{ id: 5, inserted: false, effect_status: 'none', effect_step: 0 }],
    })) }
    await expect(persistEventWithEffect(pool, 'sess-1', 'agent_text', { event_id: 'historical' }))
      .resolves.toEqual({ rowID: 5, inserted: false, completed: true, nextStep: 0 })
  })

  test('marks an event effect completed only after the callback succeeds', async () => {
    const pool: any = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) }
    await completeEventEffect(pool, 9)
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("effect_status = 'completed'"), [9])
  })

  test('checkpoints token accumulation in the same SQL statement', async () => {
    const pool: any = { query: vi.fn(async () => ({ rows: [{ session_exists: true, claimed: true, applied: true }], rowCount: 1 })) }
    await incrementSessionTokensForEvent(pool, 9, 2, 'sess-1', { input_tokens: 3, output_tokens: 4 })
    const [sql, params] = pool.query.mock.calls[0]
    expect(sql).toContain('session_target AS')
    expect(sql).toContain('checkpoint AS')
    expect(sql).toContain('UPDATE events SET effect_step')
    expect(sql).toContain('total_tokens = COALESCE')
    expect(params).toEqual([9, 2, 7, 3, 4, 0, 0, 'sess-1'])
  })

  test('does not checkpoint token usage until its session exists and only one concurrent caller claims it', async () => {
    let sessionExists = false
    let effectStep = 0
    let totalTokens = 0
    const pool: any = {
      query: vi.fn(async (_sql: string, params: any[]) => {
        const requestedStep = params[1]
        if (!sessionExists) {
          return { rows: [{ session_exists: false, claimed: false, applied: false }], rowCount: 1 }
        }
        if (effectStep >= requestedStep) {
          return { rows: [{ session_exists: true, claimed: false, applied: false }], rowCount: 1 }
        }
        effectStep = requestedStep
        totalTokens += params[2]
        return { rows: [{ session_exists: true, claimed: true, applied: true }], rowCount: 1 }
      }),
    }

    await expect(incrementSessionTokensForEvent(pool, 9, 1, 'missing', { input_tokens: 3, output_tokens: 4 }))
      .rejects.toThrow('session missing')
    expect(effectStep).toBe(0)
    expect(totalTokens).toBe(0)

    sessionExists = true
    await Promise.all([
      incrementSessionTokensForEvent(pool, 9, 1, 'missing', { input_tokens: 3, output_tokens: 4 }),
      incrementSessionTokensForEvent(pool, 9, 1, 'missing', { input_tokens: 3, output_tokens: 4 }),
    ])
    expect(effectStep).toBe(1)
    expect(totalTokens).toBe(7)
  })
})
