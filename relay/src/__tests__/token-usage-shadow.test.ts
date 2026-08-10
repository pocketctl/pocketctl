import { describe, expect, test } from 'vitest'
import { compareTokenDashboards } from '../token-usage/shadow.js'

const baseline = {
  summary: { total: 100, today: 20, thisWeek: 70, thisMonth: 90 },
  dailySeries: [{ date: '2026-08-09', input: 10, output: 5, cache_read: 3, requests: 1 }],
  byModel: [{ model: 'gpt-5', input: 10, output: 5, cache_read: 3, requests: 1, total: 15, pct: 100 }],
  byDaemon: [{ daemon_id: 'd1', hostname: 'Mac', alias: '', input: 10, output: 5, cache_read: 3, requests: 1, total: 15 }],
}

describe('token dashboard shadow comparison', () => {
  test('is ordering-insensitive but reports numeric drift without identifiers', () => {
    const reordered = {
      ...baseline,
      byModel: [...baseline.byModel].reverse(),
      byDaemon: [...baseline.byDaemon].reverse(),
    }
    expect(compareTokenDashboards(baseline, reordered)).toEqual({ matches: true, differingValues: 0, maxAbsoluteDelta: 0 })

    const drifted = {
      ...baseline,
      summary: { ...baseline.summary, today: 23 },
      dailySeries: [{ ...baseline.dailySeries[0], output: 7 }],
    }
    expect(compareTokenDashboards(baseline, drifted)).toEqual({ matches: false, differingValues: 2, maxAbsoluteDelta: 3 })
  })
})
