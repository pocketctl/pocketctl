import { describe, expect, test, vi } from 'vitest'
import { migrateTokenUsageAccounting } from '../token-usage/migration.js'

describe('token usage accounting migration', () => {
  test('adopts legacy history, backfills retained events, and preserves current deleted-session totals', async () => {
    const statements: Array<{ sql: string; params?: unknown[] }> = []
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        statements.push({ sql, params })
        if (sql.includes('SELECT key FROM token_usage_accounting_state')) return { rowCount: 0, rows: [] }
        if (sql.includes('status IN (0, 1, 3)')) return { rowCount: 1, rows: [{ count: '0' }] }
        if (sql.includes('MAX(id)') && sql.includes('events')) return { rowCount: 1, rows: [{ high_water: '3' }] }
        if (sql.includes('next_cursor') && sql.includes('MATERIALIZED')) {
          return { rowCount: 1, rows: [{ next_cursor: '3', inserted: '3' }] }
        }
        if (sql.includes('SELECT DISTINCT') && sql.includes('usage_date')) {
          return { rowCount: 1, rows: [{ usage_date: '2026-08-08' }] }
        }
        if (sql.includes('missing_event_facts')) {
          return { rowCount: 1, rows: [{ missing_event_facts: '0', missing_inbox_facts: '0' }] }
        }
        if (sql.includes('INSERT INTO token_usage_accounting_state')) return { rowCount: 1, rows: [{ key: 'baseline-v1' }] }
        if (sql.includes('INSERT INTO token_daily_closures')) return { rowCount: 2, rows: [] }
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

    expect(statements.some(({ sql }) => sql.includes('MATERIALIZED'))).toBe(true)
    expect(statements.some(({ sql }) => sql.includes('LOCK TABLE events IN SHARE MODE'))).toBe(true)
    expect(statements.some(({ sql }) => sql.includes('INSERT INTO token_session_daily_stats'))).toBe(true)
    expect(statements.some(({ sql }) => sql.includes("'legacy-daily:'"))).toBe(true)
    const baselinePublish = statements.findIndex(({ sql }) => sql.includes('INSERT INTO token_usage_accounting_state'))
    const coverage = statements.findIndex(({ sql }) => sql.includes('missing_event_facts'))
    expect(baselinePublish).toBeGreaterThan(coverage)
    expect(client.release).toHaveBeenCalledOnce()
  })

  test('rolls back a failed batch without publishing the baseline', async () => {
    const failure = new Error('backfill failed')
    const statements: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql)
        if (sql.includes('SELECT key FROM token_usage_accounting_state')) return { rowCount: 0, rows: [] }
        if (sql.includes('status IN (0, 1, 3)')) return { rowCount: 1, rows: [{ count: '0' }] }
        if (sql.includes('MAX(id)') && sql.includes('events')) return { rowCount: 1, rows: [{ high_water: '1' }] }
        if (sql.includes('next_cursor') && sql.includes('MATERIALIZED')) throw failure
        return { rowCount: 0, rows: [] }
      }),
      release: vi.fn(),
    }
    const pool: any = { connect: vi.fn(async () => client) }

    await expect(migrateTokenUsageAccounting(pool, new Date('2026-08-09T18:00:00Z'))).rejects.toBe(failure)
    expect(statements).toContain('ROLLBACK')
    expect(statements.some((sql) => sql.includes('INSERT INTO token_usage_accounting_state'))).toBe(false)
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
    expect(statements).toContain('ROLLBACK')
    expect(statements.at(-1)).toContain('pg_advisory_unlock')
  })

  test('returns immediately after the baseline exists even when an old inbox row is unresolved', async () => {
    const statements: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql)
        if (sql.includes("FROM token_usage_accounting_state") && sql.includes("baseline-v1")) {
          return { rowCount: 1, rows: [{ key: 'baseline-v1' }] }
        }
        if (sql.includes('status IN (0, 1, 3)')) return { rowCount: 1, rows: [{ count: '1' }] }
        return { rowCount: 0, rows: [] }
      }),
      release: vi.fn(),
    }

    await expect(migrateTokenUsageAccounting(
      { connect: vi.fn(async () => client) } as any,
      new Date('2026-08-09T18:00:00Z'),
    )).resolves.toEqual({
      adoptedHistoricalDays: 0,
      backfilledEventFacts: 0,
      syntheticCurrentFacts: 0,
      backfilledSessionRollups: 0,
    })
    expect(statements.some((sql) => sql.includes('status IN (0, 1, 3)'))).toBe(false)
    expect(statements.some((sql) => sql.includes('INSERT INTO token_usage_facts'))).toBe(false)
    expect(statements.some((sql) => sql.includes('INSERT INTO token_session_daily_stats'))).toBe(false)
    expect(statements).toEqual([
      expect.stringContaining('pg_advisory_lock'),
      expect.stringContaining("set_config('statement_timeout'"),
      'BEGIN',
      expect.stringContaining('token-usage-accounting-global'),
      expect.stringContaining('FROM token_usage_accounting_state'),
      'COMMIT',
      expect.stringContaining('pg_advisory_unlock'),
    ])
  })

  test('backfills retained events in committed keyset batches before the final baseline transaction', async () => {
    const statements: string[] = []
    let page = 0
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql)
        if (sql.includes('SELECT key FROM token_usage_accounting_state')) return { rowCount: 0, rows: [] }
        if (sql.includes('status IN (0, 1, 3)')) return { rowCount: 1, rows: [{ count: '0' }] }
        if (sql.includes('MAX(id)') && sql.includes('events')) return { rowCount: 1, rows: [{ high_water: '3' }] }
        if (sql.includes('next_cursor') && sql.includes('MATERIALIZED')) {
          page += 1
          return page === 1
            ? { rowCount: 1, rows: [{ next_cursor: '2', inserted: '2' }] }
            : { rowCount: 1, rows: [{ next_cursor: '3', inserted: '1' }] }
        }
        if (sql.includes('SELECT DISTINCT') && sql.includes('usage_date')) return { rowCount: 0, rows: [] }
        if (sql.includes('missing_event_facts')) return { rowCount: 1, rows: [{ missing_event_facts: '0', missing_inbox_facts: '0' }] }
        if (sql.includes('INSERT INTO token_daily_closures')) return { rowCount: 0, rows: [] }
        if (sql.includes("'legacy-daily:'")) return { rowCount: 0, rows: [] }
        if (sql.includes('INSERT INTO token_usage_accounting_state')) return { rowCount: 1, rows: [{ key: 'baseline-v1' }] }
        return { rowCount: 0, rows: [] }
      }),
      release: vi.fn(),
    }

    await expect(migrateTokenUsageAccounting(
      { connect: vi.fn(async () => client) } as any,
      new Date('2026-08-10T09:00:00Z'),
      { eventBatchSize: 2 },
    )).resolves.toMatchObject({ backfilledEventFacts: 3 })

    expect(statements.filter((sql) => sql === 'COMMIT').length).toBeGreaterThanOrEqual(4)
    expect(statements.filter((sql) => sql.includes('next_cursor'))).toHaveLength(2)
    expect(statements.some((sql) => sql.includes('LOCK TABLE events IN SHARE MODE'))).toBe(true)
    expect(statements.some((sql) => sql.includes('missing_event_facts'))).toBe(true)
    expect(statements.some((sql) => sql.includes('pg_advisory_unlock'))).toBe(true)
  })
})
