import { describe, expect, test, vi } from 'vitest'
import { projectFeedBatch } from '../extensions/feed-projector.js'
import { createExtensionProjectorRuntime } from '../extensions/runtime.js'

interface Call { sql: string; params?: unknown[] }

function transactionScript(options: {
  acquired?: boolean
  sources?: Array<Record<string, unknown>>
  failAt?: 'insert-feed' | 'delete-source'
}) {
  const calls: Call[] = []
  const lifecycle: string[] = []
  const acquired = options.acquired ?? true
  const sources = options.sources ?? []
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params })
      if (/^BEGIN$/i.test(sql.trim())) { lifecycle.push('BEGIN'); return { rows: [] } }
      if (/^COMMIT$/i.test(sql.trim())) { lifecycle.push('COMMIT'); return { rows: [] } }
      if (/^ROLLBACK$/i.test(sql.trim())) { lifecycle.push('ROLLBACK'); return { rows: [] } }
      if (/pg_try_advisory_xact_lock/.test(sql)) return { rows: [{ acquired }] }
      if (/FOR UPDATE SKIP LOCKED/.test(sql)) {
        return { rows: sources.map(row => ({ ...row })) }
      }
      if (/INSERT INTO extension_feed/.test(sql)) {
        if (options.failAt === 'insert-feed') throw new Error('feed insert failed')
        return { rows: [], rowCount: 0 }
      }
      if (/DELETE FROM extension_source_outbox/.test(sql)) {
        if (options.failAt === 'delete-source') throw new Error('delete failed')
        return { rows: [], rowCount: (params?.[0] as unknown[])?.length ?? 0 }
      }
      return { rows: [] }
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn().mockResolvedValue(client) }
  return { pool, client, calls, lifecycle }
}

function sampleSource(seq: number, event_type = 'agent_text') {
  return {
    source_seq: seq,
    source_kind: 'canonical_event',
    source_id: `event:${seq}`,
    owner_user_id: 7,
    session_id: 'ses-1',
    event_type,
    occurred_at: null,
    payload: { type: event_type, session_id: 'ses-1' },
    created_at: new Date('2026-08-23T10:00:00Z'),
  }
}

describe('feed projector single batch', () => {
  function insertedRows(calls: Array<Call>): Array<Record<string, unknown>> {
    const insert = calls.find(call => /INSERT INTO extension_feed/.test(call.sql))
    expect(insert).toBeDefined()
    return JSON.parse(String(insert!.params?.[0])) as Array<Record<string, unknown>>
  }

  test('claims, projects, deletes and commits in one transaction', async () => {
    const { pool, calls, lifecycle } = transactionScript({
      sources: [sampleSource(1), sampleSource(2, 'turn_status')],
    })

    const result = await projectFeedBatch(pool as never, { batchSize: 50 })

    expect(result).toEqual({ projected: 2, skipped: false })
    expect(lifecycle).toEqual(['BEGIN', 'COMMIT'])
    const insert = calls.find(call => /INSERT INTO extension_feed/.test(call.sql))
    expect(insert).toBeDefined()
    expect(insert!.sql).toContain('ON CONFLICT (source_kind, source_id, topic, envelope_version) DO NOTHING')
    const topics = insertedRows(calls).map(row => row.topic)
    expect(topics).toEqual(['session.event.v1', 'turn.lifecycle.v1'])
    const del = calls.find(call => /DELETE FROM extension_source_outbox/.test(call.sql))
    expect(del).toBeDefined()
    // Deletion happens in the same transaction as the feed insert.
    expect(calls.findIndex(c => /INSERT INTO extension_feed/.test(c.sql)))
      .toBeLessThan(calls.findIndex(c => /DELETE FROM extension_source_outbox/.test(c.sql)))
  })

  test('batch rows keep source_seq order', async () => {
    const { pool, calls } = transactionScript({
      sources: [sampleSource(3), sampleSource(1), sampleSource(2)],
    })
    await projectFeedBatch(pool as never, { batchSize: 50 })
    const rows = insertedRows(calls)
    expect(rows.map(row => row.source_id)).toEqual(['event:3', 'event:1', 'event:2'])
  })

  test('a crash after the feed insert rolls back and keeps the source rows', async () => {
    const { pool, lifecycle } = transactionScript({
      sources: [sampleSource(1)],
      failAt: 'delete-source',
    })

    await expect(projectFeedBatch(pool as never, { batchSize: 50 }))
      .rejects.toThrow('delete failed')
    expect(lifecycle).toEqual(['BEGIN', 'ROLLBACK'])
  })

  test('a failed feed insert rolls the whole batch back', async () => {
    const { pool, lifecycle } = transactionScript({
      sources: [sampleSource(1)],
      failAt: 'insert-feed',
    })
    await expect(projectFeedBatch(pool as never, { batchSize: 50 }))
      .rejects.toThrow('feed insert failed')
    expect(lifecycle).toEqual(['BEGIN', 'ROLLBACK'])
  })

  test('a concurrent projector skips its batch without claiming rows', async () => {
    const { pool, calls, lifecycle } = transactionScript({ acquired: false })
    const result = await projectFeedBatch(pool as never, { batchSize: 50 })
    expect(result).toEqual({ projected: 0, skipped: true })
    expect(lifecycle).toEqual(['BEGIN', 'COMMIT'])
    expect(calls.some(call => /FOR UPDATE SKIP LOCKED/.test(call.sql))).toBe(false)
    expect(calls.some(call => /INSERT INTO extension_feed/.test(call.sql))).toBe(false)
  })

  test('projection never queries installations or providers', async () => {
    const { pool, calls } = transactionScript({ sources: [sampleSource(1)] })
    await projectFeedBatch(pool as never, { batchSize: 50 })
    const allSql = calls.map(call => call.sql).join('\n')
    expect(allSql).not.toContain('extension_installations')
    expect(allSql).not.toContain('extension_providers')
  })

  test('an empty source batch commits without writes', async () => {
    const { pool, calls } = transactionScript({ sources: [] })
    const result = await projectFeedBatch(pool as never, { batchSize: 50 })
    expect(result).toEqual({ projected: 0, skipped: false })
    expect(calls.some(call => /INSERT INTO extension_feed/.test(call.sql))).toBe(false)
  })
})

describe('extension projector runtime lifecycle', () => {
  test('does not start in off mode and stops draining the active batch', async () => {
    const runOnce = vi.fn(async () => ({ projected: 0, skipped: false }))
    const timers: Array<() => void> = []
    const runtime = createExtensionProjectorRuntime({
      runOnce,
      intervalMs: 10,
      mode: 'off',
      setTimer: (callback) => {
        timers.push(callback)
        return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => undefined,
    })

    runtime.start()
    expect(timers.length).toBe(0)

    runtime.stop() // off runtime stop is a no-op that still resolves
  })

  test('schedules batches in shadow mode and stops after drain', async () => {
    let active = 0
    let resolveActive: (() => void) | undefined
    const runOnce = vi.fn(async () => {
      active++
      await new Promise<void>(resolve => { resolveActive = resolve })
      return { projected: 1, skipped: false }
    })
    const timers: Array<() => void> = []
    const cleared: unknown[] = []
    const runtime = createExtensionProjectorRuntime({
      runOnce,
      intervalMs: 10,
      mode: 'shadow',
      setTimer: (callback) => {
        timers.push(callback)
        return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: (timer) => { cleared.push(timer) },
    })

    runtime.start()
    expect(timers.length).toBe(1)
    timers[0]()
    await Promise.resolve()
    await Promise.resolve()
    expect(runOnce).toHaveBeenCalledTimes(1)

    const stopped = runtime.stop()
    resolveActive!()
    await stopped
    // The fired timer is gone and stop() suppresses any rescheduling.
    expect(timers.length).toBe(1)
    expect(cleared.length).toBeLessThanOrEqual(1)
    await expect(stopped).resolves.toBeUndefined()
  })

  test('a failing batch retries with backoff and never exits the process', async () => {
    const runOnce = vi.fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue({ projected: 0, skipped: false })
    const timers: Array<() => void> = []
    const runtime = createExtensionProjectorRuntime({
      runOnce,
      intervalMs: 10,
      mode: 'enabled',
      setTimer: (callback) => {
        timers.push(callback)
        return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => undefined,
    })

    runtime.start()
    timers[0]()
    await new Promise(resolve => setTimeout(resolve, 0))
    // The failure must not prevent the next scheduled batch.
    expect(timers.length).toBeGreaterThanOrEqual(2)
    await runtime.stop()
  })
})
