import { describe, expect, test, vi } from 'vitest'
import { migrateTokenUsageAccounting } from '../token-usage/migration.js'

describe('token usage accounting migration', () => {
  test('adopts legacy history, backfills retained events, and preserves current deleted-session totals', async () => {
    const statements: Array<{ sql: string; params?: unknown[] }> = []
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        statements.push({ sql, params })
        if (sql.includes('INSERT INTO token_usage_accounting_state')) return { rowCount: 1, rows: [{ key: 'baseline-v1' }] }
        if (sql.includes('INSERT INTO token_daily_closures')) return { rowCount: 2, rows: [] }
        if (sql.includes("'event:' || e.id")) return { rowCount: 3, rows: [] }
        if (sql.includes('INSERT INTO token_session_daily_stats')) return { rowCount: 4, rows: [] }
        if (sql.includes("'legacy-daily:'")) return { rowCount: 1, rows: [] }
        return { rowCount: 0, rows: [] }
      }),
      release: vi.fn(),
    }
    const pool: any = { connect: vi.fn(async () => client) }

    await expect(migrateTokenUsageAccounting(pool, new Date('2026-08-09T18:00:00Z'))).resolves.toEqual({
      adoptedHistoricalDays: 2,
      backfilledEventFacts: 3,
      syntheticCurrentFacts: 1,
      backfilledSessionRollups: 4,
    })

    expect(statements.map(({ sql }) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('token-usage-accounting-global'),
      expect.stringContaining('pg_advisory_xact_lock'),
      expect.stringContaining('status IN (0, 1, 3)'),
      expect.stringContaining('INSERT INTO token_usage_accounting_state'),
      expect.stringContaining('INSERT INTO token_daily_closures'),
      expect.stringContaining('INSERT INTO token_usage_facts'),
      expect.stringContaining('INSERT INTO token_usage_facts'),
      expect.stringContaining('INSERT INTO token_session_daily_stats'),
      'COMMIT',
    ])
    expect(statements[5].params).toEqual(['2026-08-09'])
    expect(statements[6].params).toEqual(['2026-08-09'])
    expect(statements[7].params).toEqual(['2026-08-09'])
    expect(statements[7].sql).toContain('reported_total, requests')
    expect(statements[1].sql).toContain('token-usage-accounting-global')
    expect(statements[8].sql).toContain('user_id, session_id')
    expect(client.release).toHaveBeenCalledOnce()
  })

  test('rolls back the migration as one unit when a phase fails', async () => {
    const failure = new Error('backfill failed')
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO token_usage_accounting_state')) return { rowCount: 1, rows: [{ key: 'baseline-v1' }] }
        if (sql.includes("'event:' || e.id")) throw failure
        return { rowCount: 0, rows: [] }
      }),
      release: vi.fn(),
    }
    const pool: any = { connect: vi.fn(async () => client) }

    await expect(migrateTokenUsageAccounting(pool, new Date('2026-08-09T18:00:00Z'))).rejects.toBe(failure)
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalledOnce()
  })

  test('refuses to seal the baseline while a historical inbox row is unresolved', async () => {
    const statements: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql)
        if (sql.includes('status IN (0, 1, 3)')) return { rows: [{ count: '1' }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }

    await expect(migrateTokenUsageAccounting(
      { connect: vi.fn(async () => client) } as any,
      new Date('2026-08-09T18:00:00Z'),
    )).rejects.toThrow('historical inbox')
    expect(statements.some((sql) => sql.includes('INSERT INTO token_daily_closures'))).toBe(false)
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK')
  })

  test('does not synthesize legacy compensation again after the baseline marker exists', async () => {
    const statements: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql)
        if (sql.includes('INSERT INTO token_usage_accounting_state')) return { rowCount: 0, rows: [] }
        if (sql.includes("'event:' || e.id")) return { rowCount: 2, rows: [] }
        return { rowCount: 0, rows: [] }
      }),
      release: vi.fn(),
    }

    await expect(migrateTokenUsageAccounting(
      { connect: vi.fn(async () => client) } as any,
      new Date('2026-08-09T18:00:00Z'),
    )).resolves.toEqual({
      adoptedHistoricalDays: 0,
      backfilledEventFacts: 2,
      syntheticCurrentFacts: 0,
      backfilledSessionRollups: 0,
    })
    expect(statements.some((sql) => sql.includes("'legacy-daily:'"))).toBe(false)
  })
})
