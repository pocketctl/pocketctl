import { describe, expect, test, vi } from 'vitest'
import { initDB } from '../db.js'

describe('schema bootstrap retries', () => {
  const fixture = (codes: string[]) => {
    let acquisitions = 0
    const clients: Array<{ query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }> = []
    const pool = { connect: vi.fn(async () => {
      const code = codes[acquisitions++]
      const client = { query: vi.fn(async (sql: string) => {
        if (sql.includes('pg_advisory_xact_lock')) throw Object.assign(new Error('schema lock fixture'), { code })
        return { rows: [] }
      }), release: vi.fn() }
      clients.push(client); return client
    }) }
    return { pool, clients }
  }

  test('releases each aborted transaction and bounds deadlock retries at three', async () => {
    const { pool, clients } = fixture(['40P01', '40P01', '40P01'])
    await expect(initDB(pool as never)).rejects.toMatchObject({ code: '40P01' })
    expect(pool.connect).toHaveBeenCalledTimes(3)
    for (const client of clients) {
      expect(client.query).toHaveBeenLastCalledWith('ROLLBACK')
      expect(client.release).toHaveBeenCalledOnce()
    }
  })

  test('does not retry non-deadlock failures, including after a retryable transaction', async () => {
    const first = fixture(['42501'])
    await expect(initDB(first.pool as never)).rejects.toMatchObject({ code: '42501' })
    expect(first.pool.connect).toHaveBeenCalledTimes(1)
    const second = fixture(['40P01', '42601'])
    await expect(initDB(second.pool as never)).rejects.toMatchObject({ code: '42601' })
    expect(second.pool.connect).toHaveBeenCalledTimes(2)
  })
})
