import { describe, expect, test, vi } from 'vitest'
import { backfillSessionTokens, backfillSessionModel } from '../db.js'

describe('startup token compatibility backfills', () => {
  test('does not overwrite V2 session counters from retained legacy events after baseline activation', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('token_usage_accounting_state')) return { rows: [{ key: 'baseline-v1' }], rowCount: 1 }
      throw new Error('legacy event scan would time out or overwrite current counters')
    })
    await expect(backfillSessionTokens({ query } as any)).resolves.toBe(0)
    expect(query).toHaveBeenCalledTimes(1)
  })

  test('retains legacy bootstrap before the accounting baseline exists', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('token_usage_accounting_state')
      ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 3 })
    await expect(backfillSessionTokens({ query } as any)).resolves.toBe(3)
    expect(query.mock.calls.some(([sql]) => sql.includes('SUM('))).toBe(true)
  })

  test('fails closed if baseline status cannot be read', async () => {
    const query = vi.fn().mockRejectedValue(new Error('database unavailable'))
    await expect(backfillSessionTokens({ query } as any)).rejects.toThrow('database unavailable')
    expect(query).toHaveBeenCalledTimes(1)
  })

  test('does not scan events when no sessions need metadata repair', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM events')) throw new Error('unbounded metadata event scan')
      return { rows: [], rowCount: 0 }
    })
    await expect(backfillSessionModel({ query } as any)).resolves.toBe(0)
  })
})
