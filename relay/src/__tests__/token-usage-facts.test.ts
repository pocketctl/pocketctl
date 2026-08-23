import { describe, expect, test, vi } from 'vitest'
import { getTokenUsageFactDailySeries, initDB } from '../db.js'

describe('token usage fact read helpers', () => {
  test('initDB upgrades an earlier fact ledger shape without losing event identity', async () => {
    const queries: string[] = []
    const pool: any = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql)
        return { rows: [], rowCount: 0 }
      }),
    }

    await initDB(pool)

    expect(queries.some((sql) => /ALTER TABLE token_usage_facts ADD COLUMN IF NOT EXISTS fact_key/i.test(sql))).toBe(true)
    expect(queries.some((sql) => /UPDATE\s+token_usage_facts\s+SET fact_key = 'event:' \|\| source_event_id/i.test(sql))).toBe(true)
    expect(queries.some((sql) => /ALTER TABLE token_usage_facts ADD COLUMN IF NOT EXISTS requests/i.test(sql))).toBe(true)
    expect(queries.some((sql) => /ADD COLUMN IF NOT EXISTS session_attribution_revoked/i.test(sql))).toBe(true)
    expect(queries.some((sql) => /ALTER TABLE token_daily_closures ADD COLUMN IF NOT EXISTS source_request_count/i.test(sql))).toBe(true)
    expect(queries.some((sql) => /CREATE TABLE IF NOT EXISTS token_usage_accounting_state/i.test(sql))).toBe(true)
    expect(queries.some((sql) => /CREATE TABLE IF NOT EXISTS token_session_daily_stats/i.test(sql))).toBe(true)
    expect(queries.some((sql) => /idx_token_usage_facts_session_date/i.test(sql))).toBe(true)
    expect(queries.some((sql) => sql.includes('LOCK TABLE token_session_daily_stats'))).toBe(true)
    const primaryKeyMigration = queries.findIndex((sql) => sql.includes('primary_has_fact_key'))
    const dropSourceNotNull = queries.findIndex((sql) => /source_event_id DROP NOT NULL/i.test(sql))
    expect(primaryKeyMigration).toBeGreaterThan(0)
    expect(queries[primaryKeyMigration]).toContain('LOCK TABLE token_usage_facts')
    expect(queries.some((sql) => sql.includes('LOCK TABLE token_session_daily_stats'))).toBe(true)
    expect(dropSourceNotNull).toBeGreaterThan(primaryKeyMigration)
  })

  test('reads a current day from immutable facts without scanning events', async () => {
    const pool: any = {
      query: vi.fn(async () => ({ rows: [{
        date: '2026-08-09', input: '12', output: '8', cache_read: '3', requests: '2',
      }] })),
    }

    await expect(getTokenUsageFactDailySeries(pool, 42, '2026-08-09', 'daemon-a')).resolves.toEqual([{
      date: '2026-08-09', input: 12, output: 8, cache_read: 3, requests: 2,
    }])

    const [sql, params] = pool.query.mock.calls[0]
    expect(sql).toContain('FROM token_usage_facts')
    expect(sql).not.toContain('FROM events')
    expect(sql).toContain('daemon_id = $3')
    expect(params).toEqual([42, '2026-08-09', 'daemon-a'])
  })
})
