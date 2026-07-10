import { describe, test, expect, vi } from 'vitest'
import { insertEvent, persistEvent } from '../db.js'

// persistEvent wraps insertEvent with bounded retries so a transient DB blip
// (e.g. a Postgres restart on deploy) no longer silently drops a daemon event.

describe('db.persistEvent - retry on transient failure', () => {
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
