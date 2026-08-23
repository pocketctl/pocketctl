import { describe, expect, test, vi } from 'vitest'
import { deleteUserAccount, userExists } from '../db.js'

function transactionPool(handler?: (sql: string, params?: any[]) => any) {
  const calls: Array<{ sql: string; params?: any[] }> = []
  const client = {
    query: vi.fn(async (sql: string, params?: any[]) => {
      calls.push({ sql, params })
      if (handler) return handler(sql, params)
      if (/SELECT id FROM users WHERE id = \$1 FOR UPDATE/i.test(sql)) {
        return { rows: [{ id: 7 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn().mockResolvedValue(client) } as any
  return { calls, client, pool }
}

describe('account deletion persistence', () => {
  test('deletes all user-owned records in one committed transaction', async () => {
    const { calls, client, pool } = transactionPool()

    await expect(deleteUserAccount(pool, 7)).resolves.toBe(true)

    expect(calls[0].sql).toBe('BEGIN')
    expect(calls[1]).toEqual(expect.objectContaining({ params: [7] }))
    expect(calls[1].sql).toMatch(/SELECT id FROM users WHERE id = \$1 FOR UPDATE/i)

    const joinedSQL = calls.map(({ sql }) => sql.replace(/\s+/g, ' ').trim()).join('\n')
    for (const required of [
      'DELETE FROM events',
      'DELETE FROM subagents',
      'DELETE FROM subagent_usage_seen',
      'DELETE FROM deleted_sessions',
      'DELETE FROM token_session_daily_stats WHERE user_id = $1',
      'DELETE FROM token_daily_stats WHERE user_id = $1',
      'DELETE FROM audit_log WHERE user_id = $1',
      'DELETE FROM revoked_tokens WHERE user_id = $1',
      'DELETE FROM realtime_outbox',
      'DELETE FROM event_inbox',
      'DELETE FROM sessions WHERE user_id = $1',
      'DELETE FROM daemons WHERE user_id = $1',
      'DELETE FROM users WHERE id = $1',
    ]) {
      expect(joinedSQL).toContain(required)
    }
    expect(calls.at(-1)?.sql).toBe('COMMIT')
    expect(client.release).toHaveBeenCalledOnce()
  })

  test('returns false without mutating data when the user is absent', async () => {
    const { calls, client, pool } = transactionPool(sql => {
      if (/SELECT id FROM users WHERE id = \$1 FOR UPDATE/i.test(sql)) {
        return { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: 0 }
    })

    await expect(deleteUserAccount(pool, 404)).resolves.toBe(false)

    expect(calls.map(({ sql }) => sql)).toEqual([
      'BEGIN',
      expect.stringMatching(/SELECT id FROM users WHERE id = \$1 FOR UPDATE/i),
      'COMMIT',
    ])
    expect(client.release).toHaveBeenCalledOnce()
  })

  test('rolls back and releases the client when any deletion fails', async () => {
    const failure = new Error('delete failed')
    const { calls, client, pool } = transactionPool(sql => {
      if (/SELECT id FROM users WHERE id = \$1 FOR UPDATE/i.test(sql)) {
        return { rows: [{ id: 7 }], rowCount: 1 }
      }
      if (/DELETE FROM token_daily_stats/i.test(sql)) throw failure
      return { rows: [], rowCount: 1 }
    })

    await expect(deleteUserAccount(pool, 7)).rejects.toBe(failure)

    expect(calls.at(-1)?.sql).toBe('ROLLBACK')
    expect(client.release).toHaveBeenCalledOnce()
  })

  test('checks user existence with the authenticated numeric id', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ exists: true }] })
        .mockResolvedValueOnce({ rows: [{ exists: false }] }),
    } as any

    await expect(userExists(pool, 7)).resolves.toBe(true)
    await expect(userExists(pool, 8)).resolves.toBe(false)
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/SELECT EXISTS.*users.*id = \$1/is),
      [7],
    )
  })
})
