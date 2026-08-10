import { describe, expect, test, vi } from 'vitest'
import { closeEligibleTokenUsageDays, closeTokenUsageDay } from '../token-usage/day-closer.js'

function closerPool(options: {
  closureStatus?: 'pending' | 'sealed' | 'failed'
  activeInbox?: number
  deadInbox?: number
  missingUsageFacts?: number
  factCount?: number
  sourceRequests?: number
  rollupRequests?: number
  sessionSourceRequests?: number
  sessionRollupRequests?: number
  factTotal?: number | string
  rollupTotal?: number | string
  sessionSourceTotal?: number | string
  sessionRollupTotal?: number | string
} = {}) {
  const statements: string[] = []
  const client = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql)
      if (sql.includes('RETURNING status')) return { rows: [{ status: options.closureStatus ?? 'pending' }], rowCount: 1 }
      if (sql.includes('status IN (0, 1)')) return { rows: [{ count: String(options.activeInbox ?? 0) }], rowCount: 1 }
      if (sql.includes('status = 3')) return { rows: [{ count: String(options.deadInbox ?? 0) }], rowCount: 1 }
      if (sql.includes('fact.fact_key IS NULL')) return { rows: [{ count: String(options.missingUsageFacts ?? 0) }], rowCount: 1 }
      if (sql.includes('source_fact_count')) return { rows: [{
        source_fact_count: String(options.factCount ?? 2),
        source_request_count: String(options.sourceRequests ?? options.factCount ?? 2),
        rollup_request_count: String(options.rollupRequests ?? options.sourceRequests ?? options.factCount ?? 2),
        session_source_request_count: String(options.sessionSourceRequests ?? options.sourceRequests ?? options.factCount ?? 2),
        session_rollup_request_count: String(options.sessionRollupRequests ?? options.sessionSourceRequests ?? options.sourceRequests ?? options.factCount ?? 2),
        source_total: String(options.factTotal ?? 30),
        rollup_total: String(options.rollupTotal ?? 30),
        session_source_total: String(options.sessionSourceTotal ?? options.factTotal ?? 30),
        session_rollup_total: String(options.sessionRollupTotal ?? options.sessionSourceTotal ?? options.factTotal ?? 30),
      }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn(async () => client) } as any, client, statements }
}

describe('UTC token day closer', () => {
  test('waits without rebuilding rollups while pre-cutoff inbox work remains', async () => {
    const { pool, statements } = closerPool({ activeInbox: 3 })

    await expect(closeTokenUsageDay(pool, '2026-08-08', new Date('2026-08-09T00:05:00Z'))).resolves.toEqual({
      date: '2026-08-08', status: 'waiting', pendingRows: 3,
    })
    const inboxGate = statements.find((sql) => sql.includes('status IN (0, 1)')) ?? ''
    expect(inboxGate).toContain("received_at >= ($1::date::timestamp AT TIME ZONE 'UTC')")
    expect(statements.some((sql) => sql.includes('DELETE FROM token_daily_stats'))).toBe(false)
  })

  test('marks the day failed when a pre-cutoff inbox row is dead-lettered', async () => {
    const { pool, statements } = closerPool({ deadInbox: 1 })

    await expect(closeTokenUsageDay(pool, '2026-08-08', new Date('2026-08-09T00:05:00Z'))).resolves.toEqual({
      date: '2026-08-08', status: 'failed', deadLetterRows: 1,
    })
    expect(statements.some((sql) => sql.includes("status = 'failed'"))).toBe(true)
    expect(statements.some((sql) => sql.includes('DELETE FROM token_daily_stats'))).toBe(false)
  })

  test('fails closed when a post-baseline completed usage inbox has no fact', async () => {
    const { pool, statements } = closerPool({ missingUsageFacts: 1 })

    await expect(closeTokenUsageDay(pool, '2026-08-08', new Date('2026-08-09T00:05:00Z'))).resolves.toEqual({
      date: '2026-08-08', status: 'failed', reason: 'missing_usage_facts',
    })
    expect(statements.some((sql) => sql.includes("last_error = 'missing_usage_facts'"))).toBe(true)
    expect(statements.some((sql) => sql.includes('DELETE FROM token_daily_stats'))).toBe(false)
  })

  test('replaces the rollup from facts, reconciles totals, then seals the day', async () => {
    const { pool, statements } = closerPool({ factCount: 4, factTotal: 55, rollupTotal: 55 })

    await expect(closeTokenUsageDay(pool, '2026-08-08', new Date('2026-08-09T00:05:00Z'))).resolves.toEqual({
      date: '2026-08-08', status: 'sealed', factCount: 4, total: 55,
    })
    expect(statements.some((sql) => sql.includes('DELETE FROM token_daily_stats'))).toBe(true)
    expect(statements.some((sql) => sql.includes('DELETE FROM token_session_daily_stats'))).toBe(true)
    expect(statements.some((sql) => sql.includes('INSERT INTO token_session_daily_stats'))).toBe(true)
    expect(statements.some((sql) => sql.includes('session_attribution_revoked = false'))).toBe(true)
    expect(statements.some((sql) => sql.includes('FROM token_usage_facts'))).toBe(true)
    expect(statements.some((sql) => sql.includes("status = 'sealed'"))).toBe(true)
    const globalLock = statements.findIndex((sql) => sql.includes('pg_advisory_xact_lock_shared'))
    const dayLock = statements.findIndex((sql) => sql.includes('token-day-close:'))
    expect(globalLock).toBeGreaterThan(0)
    expect(globalLock).toBeLessThan(dayLock)
  })

  test('rejects today because only completed UTC dates may be historical', async () => {
    const { pool } = closerPool()
    await expect(closeTokenUsageDay(pool, '2026-08-09', new Date('2026-08-09T18:00:00Z')))
      .rejects.toThrow('completed UTC date')
  })

  test('does not seal when rollup request count differs from source request count', async () => {
    const { pool, statements } = closerPool({ factCount: 2, sourceRequests: 3, rollupRequests: 2, factTotal: 30, rollupTotal: 30 })

    await expect(closeTokenUsageDay(pool, '2026-08-08', new Date('2026-08-09T00:05:00Z'))).resolves.toEqual({
      date: '2026-08-08', status: 'failed', reason: 'reconciliation_mismatch',
    })
    expect(statements.some((sql) => sql.includes("status = 'sealed'"))).toBe(false)
  })

  test('does not seal when the session rollup differs from immutable facts', async () => {
    const { pool } = closerPool({
      factCount: 2,
      sourceRequests: 2,
      rollupRequests: 2,
      sessionRollupRequests: 1,
      factTotal: 30,
      rollupTotal: 30,
      sessionRollupTotal: 29,
    })

    await expect(closeTokenUsageDay(pool, '2026-08-08', new Date('2026-08-09T00:05:00Z'))).resolves.toEqual({
      date: '2026-08-08', status: 'failed', reason: 'reconciliation_mismatch',
    })
  })

  test('compares BIGINT totals exactly above JavaScript safe integer range', async () => {
    const { pool } = closerPool({
      factTotal: '9007199254740992',
      rollupTotal: '9007199254740993',
    })

    await expect(closeTokenUsageDay(pool, '2026-08-08', new Date('2026-08-09T00:05:00Z'))).resolves.toEqual({
      date: '2026-08-08', status: 'failed', reason: 'reconciliation_mismatch',
    })
  })

  test('does not select yesterday for closing until the 00:05 UTC grace period has elapsed', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 }))
    const pool = { query } as any

    await closeEligibleTokenUsageDays(pool, new Date('2026-08-09T00:04:59Z'))
    expect(query.mock.calls[0]?.[1]).toEqual(['2026-08-08', 31])

    query.mockClear()
    await closeEligibleTokenUsageDays(pool, new Date('2026-08-09T00:05:00Z'))
    expect(query.mock.calls[0]?.[1]).toEqual(['2026-08-09', 31])
  })

  test('excludes sealed fact dates and includes inbox-only dates in the candidate scan', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 }))
    const pool = { query } as any

    await closeEligibleTokenUsageDays(pool, new Date('2026-08-09T01:00:00Z'))

    const sql = String(query.mock.calls[0]?.[0] ?? '')
    expect(sql).toContain('FROM event_inbox')
    expect(sql).toContain("status IS DISTINCT FROM 'sealed'")
  })
})
