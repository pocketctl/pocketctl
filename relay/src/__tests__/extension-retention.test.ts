import { describe, expect, test, vi } from 'vitest'
import { runFeedRetentionOnce } from '../extensions/retention.js'
import { computeBackfillWindow } from '../extensions/backfill.js'

describe('feed retention passes', () => {
  test('soft pass only deletes below every relevant active ack', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = []
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params })
        if (/DELETE FROM extension_feed/.test(sql)) return { rows: [], rowCount: 3 }
        if (/UPDATE extension_checkpoints/.test(sql)) return { rows: [], rowCount: 0 }
        return { rows: [] }
      }),
    }
    const result = await runFeedRetentionOnce(pool as never, { retentionDays: 7 })
    expect(result).toEqual({ deleted: 6, markedInstallations: 0 })

    const soft = queries.find(query => /DELETE FROM extension_feed/.test(query.sql) && query.sql.includes('NOT EXISTS'))
    expect(soft).toBeDefined()
    expect(soft!.sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(soft!.sql).toContain('LIMIT $2')
    expect(soft!.params?.[0]).toBe(7)
    // The guard only counts active-ish installations with a live checkpoint.
    expect(soft!.sql).toContain("i.status IN ('pending', 'active', 'paused')")
    expect(soft!.sql).toContain('COALESCE(c.ack_feed_id, i.start_feed_id) < f.feed_id')
    expect(soft!.sql).toContain('f.topic = ANY(i.subscriptions)')
    expect(soft!.sql).toContain("'session:events:read' = ANY(i.granted_scopes)")
    expect(soft!.sql).toContain("'session:deletion:read' = ANY(i.granted_scopes)")
    expect(soft!.sql).toContain("i.event_filter->'daemon_ids'")
    expect(soft!.sql).toContain("i.event_filter->'agent_types'")
    // Purge evidence is never touched.
    for (const query of queries) {
      expect(query.sql).not.toContain('extension_purge_requests')
    }
  })

  test('hard max defaults to twice retention and marks lagging installations', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = []
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params })
        if (/DELETE FROM extension_feed/.test(sql)) return { rows: [], rowCount: 1 }
        if (/INSERT INTO extension_checkpoints/.test(sql)) return { rows: [], rowCount: 2 }
        return { rows: [] }
      }),
    }
    const result = await runFeedRetentionOnce(pool as never, { retentionDays: 7 })
    const mark = queries.find(query => /INSERT INTO extension_checkpoints/.test(query.sql)
      && query.sql.includes('ON CONFLICT (installation_id)'))
    expect(mark).toBeDefined()
    expect(mark!.sql).toContain('snapshot_required_at = NOW()')
    expect(mark!.sql).toContain('f.topic = ANY(i.subscriptions)')
    expect(mark!.sql).toContain("'session:events:read' = ANY(i.granted_scopes)")
    expect(mark!.sql).toContain("'session:deletion:read' = ANY(i.granted_scopes)")
    expect(mark!.sql).toContain("i.event_filter->'daemon_ids'")
    expect(mark!.sql).toContain("i.event_filter->'agent_types'")
    // The hard cutoff parameter is 2 x retention by default.
    expect(mark!.params?.[0]).toBe(14)
    expect(result.markedInstallations).toBe(2)
  })

  test('source outbox rows are never age-deleted', async () => {
    const pool = { query: vi.fn(async (_sql: string) => ({ rows: [], rowCount: 0 })) }
    await runFeedRetentionOnce(pool as never, { retentionDays: 7 })
    const sql = pool.query.mock.calls.map(call => String(call[0])).join('\n')
    expect(sql).not.toContain('DELETE FROM extension_source_outbox')
  })
})

describe('backfill policy', () => {
  test('from_now never backfills', () => {
    expect(computeBackfillWindow({
      startPolicy: 'from_now', startFeedId: 100, oldestRetainedFeedId: 5,
    })).toEqual({ strategy: 'none', fromFeedId: null, snapshotRequired: false })
  })

  test('retained_history replays only within the existing feed window', () => {
    expect(computeBackfillWindow({
      startPolicy: 'retained_history', startFeedId: 0, oldestRetainedFeedId: 42,
    })).toEqual({ strategy: 'feed_window', fromFeedId: 42, snapshotRequired: false })
    expect(computeBackfillWindow({
      startPolicy: 'retained_history', startFeedId: 0, oldestRetainedFeedId: null,
    })).toEqual({ strategy: 'snapshot_required', fromFeedId: null, snapshotRequired: true })
  })
})
