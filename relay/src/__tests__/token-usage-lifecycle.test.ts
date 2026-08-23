import { describe, expect, test, vi } from 'vitest'
import {
  assertTokenUsageWriteContinuity,
  initializeTokenUsageAccounting,
  runTokenUsageCloseSweep,
} from '../token-usage/lifecycle.js'

describe('token usage accounting lifecycle', () => {
  test('refuses to disable fact writing after the accounting baseline exists', async () => {
    const pool: any = { query: vi.fn(async () => ({ rowCount: 1, rows: [{ '?column?': 1 }] })) }
    await expect(assertTokenUsageWriteContinuity(
      pool,
      { writeFacts: false, shadowRead: false, dashboardV2: false },
    )).rejects.toThrow('cannot be disabled')
  })

  test('allows legacy mode before the accounting baseline has ever been activated', async () => {
    const pool: any = { query: vi.fn(async () => ({ rowCount: 0, rows: [] })) }
    await expect(assertTokenUsageWriteContinuity(
      pool,
      { writeFacts: false, shadowRead: false, dashboardV2: false },
    )).resolves.toBeUndefined()
  })

  test('keeps migration and closer dormant while fact writing is disabled', async () => {
    const migrate = vi.fn()
    const close = vi.fn()
    await expect(initializeTokenUsageAccounting(
      {} as any,
      { writeFacts: false, shadowRead: false, dashboardV2: false },
      new Date('2026-08-09T00:05:00Z'),
      { migrate, close },
    )).resolves.toBeNull()
    expect(migrate).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  test('migrates the baseline before attempting closure', async () => {
    const order: string[] = []
    const migrate = vi.fn(async () => {
      order.push('migrate')
      return {
        adoptedHistoricalDays: 2,
        backfilledEventFacts: 3,
        syntheticCurrentFacts: 1,
        backfilledSessionRollups: 4,
      }
    })
    const close = vi.fn(async () => {
      order.push('close')
      return [{ date: '2026-08-08', status: 'sealed' as const, factCount: 3, total: 20 }]
    })
    const now = new Date('2026-08-09T00:05:00Z')

    const result = await initializeTokenUsageAccounting(
      {} as any,
      { writeFacts: true, shadowRead: true, dashboardV2: false },
      now,
      { migrate, close },
    )

    expect(order).toEqual(['migrate', 'close'])
    expect(result?.migration.backfilledEventFacts).toBe(3)
    expect(result?.closures).toHaveLength(1)
  })

  test('reports only bounded close result categories', async () => {
    const observe = vi.fn()
    const close = vi.fn(async () => [
      { date: '2026-08-07', status: 'waiting' as const, pendingRows: 1 },
      { date: '2026-08-08', status: 'failed' as const, deadLetterRows: 1 },
    ])

    await runTokenUsageCloseSweep({} as any, new Date('2026-08-09T00:05:00Z'), observe, close)

    expect(observe.mock.calls.map(([status]) => status)).toEqual(['waiting', 'failed'])
  })
})
