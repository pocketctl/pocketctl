import { describe, test, expect, vi } from 'vitest'
import { persistEvent } from '../db.js'

// persistEvent wraps insertEvent with bounded retries so a transient DB blip
// (e.g. a Postgres restart on deploy) no longer silently drops a daemon event.

describe('db.persistEvent - retry on transient failure', () => {
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

  test('gives up after the attempt budget and returns 0 (never throws)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pool: any = {
      query: vi.fn((sql: string) => {
        if (sql.includes('INSERT INTO events')) return Promise.reject(new Error('db down'))
        return Promise.resolve({ rows: [] })
      }),
    }
    const id = await persistEvent(pool, 'sess-1', 'agent_text', {}, 2) // 2 attempts → ~100ms
    expect(id).toBe(0)
    errSpy.mockRestore()
  })
})
