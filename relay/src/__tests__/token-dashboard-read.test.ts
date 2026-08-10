import { describe, expect, test, vi } from 'vitest'
import { readTokenDashboard } from '../token-usage/read-service.js'

const legacy = { summary: { total: 10, today: 2, thisWeek: 4, thisMonth: 8 } }
const candidate = { summary: { total: 10, today: 2, thisWeek: 4, thisMonth: 8 } }

describe('token dashboard read rollout', () => {
  test('serves V2 directly after the read switch is enabled', async () => {
    const loadLegacy = vi.fn(async () => legacy)
    const loadV2 = vi.fn(async () => candidate)

    await expect(readTokenDashboard(
      { writeFacts: true, shadowRead: false, dashboardV2: true },
      loadLegacy,
      loadV2,
    )).resolves.toBe(candidate)
    expect(loadLegacy).not.toHaveBeenCalled()
    expect(loadV2).toHaveBeenCalledOnce()
  })

  test('returns legacy without waiting for shadow comparison and reports aggregate drift only', async () => {
    let resolveCandidate!: (value: typeof candidate) => void
    const pendingCandidate = new Promise<typeof candidate>((resolve) => { resolveCandidate = resolve })
    const observe = vi.fn()

    await expect(readTokenDashboard(
      { writeFacts: true, shadowRead: true, dashboardV2: false },
      async () => legacy,
      async () => pendingCandidate,
      observe,
    )).resolves.toBe(legacy)
    expect(observe).not.toHaveBeenCalled()

    resolveCandidate(candidate)
    await vi.waitFor(() => expect(observe).toHaveBeenCalledWith({
      status: 'match', differingValues: 0, maxAbsoluteDelta: 0,
    }))
  })

  test('contains shadow failures and never changes the legacy response', async () => {
    const observe = vi.fn()
    await expect(readTokenDashboard(
      { writeFacts: true, shadowRead: true, dashboardV2: false },
      async () => legacy,
      async () => { throw new Error('database unavailable') },
      observe,
    )).resolves.toBe(legacy)
    await vi.waitFor(() => expect(observe).toHaveBeenCalledWith({ status: 'error' }))
  })
})
