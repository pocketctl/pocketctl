import { describe, expect, test, vi } from 'vitest'
import { cleanStaleEvents } from '../db.js'
import { InboxRetention } from '../inbox-retention.js'

function retentionPool(blockedUndelivered: number, deletedCompleted: number) {
  const calls: Array<{ sql: string; params?: unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params })
      if (sql.includes('blocked_undelivered')) {
        return { rows: [{ blocked_undelivered: blockedUndelivered }], rowCount: 1 }
      }
      if (sql.includes('DELETE FROM event_inbox')) {
        return { rows: [], rowCount: deletedCompleted }
      }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
  return {
    calls,
    client,
    pool: { connect: vi.fn().mockResolvedValue(client) } as any,
  }
}

describe('InboxRetention', () => {
  test('deletes only old completed rows whose outbox is fully delivered', async () => {
    const { calls, client, pool } = retentionPool(1, 1)

    await expect(new InboxRetention(pool).runOnce()).resolves.toEqual({
      deletedCompleted: 1,
      blockedUndelivered: 1,
    })

    const sql = calls.map(({ sql }) => sql.replace(/\s+/g, ' ').trim()).join('\n')
    expect(sql).toContain('i.status = 2')
    expect(sql).toContain("i.completed_at < NOW() - INTERVAL '6 hours'")
    expect(sql).toContain('o.delivered_at IS NULL')
    expect(sql).toContain('FOR UPDATE OF i SKIP LOCKED')
    expect(sql).toContain('r.inbox_id IS NULL')
    expect(sql).toContain('c.ack_seq >= r.seq')
    expect(sql).not.toContain('resetStaleClaims')
    expect(client.release).toHaveBeenCalledOnce()
  })

  test('uses the fixed 1000-row batch and rolls back failures', async () => {
    const failure = new Error('delete failed')
    const { calls, client, pool } = retentionPool(0, 0)
    client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params })
      if (sql.includes('blocked_undelivered')) return { rows: [{ blocked_undelivered: 0 }], rowCount: 1 }
      if (sql.includes('DELETE FROM event_inbox')) throw failure
      return { rows: [], rowCount: 0 }
    })

    await expect(new InboxRetention(pool).runOnce()).rejects.toBe(failure)

    const deleteCall = calls.find(({ sql }) => sql.includes('DELETE FROM event_inbox'))
    expect(deleteCall?.params).toEqual([1_000])
    expect(calls.at(-1)?.sql).toBe('ROLLBACK')
    expect(client.release).toHaveBeenCalledOnce()
  })

  test('event retention cannot cascade-delete an undelivered realtime row', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 4 }),
    } as any

    await expect(cleanStaleEvents(pool, 90)).resolves.toBe(4)

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/DELETE FROM events e.*NOT EXISTS.*realtime_outbox.*delivered_at IS NULL/is),
      [90],
    )
  })
})
