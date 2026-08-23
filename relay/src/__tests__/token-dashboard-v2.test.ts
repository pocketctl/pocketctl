import { describe, expect, test, vi } from 'vitest'
import {
  getSessionTokenTrendV2,
  getTodayTokenUsageByAgentV2,
  getTokenDashboardV2,
  getUserDailyTokensV2,
  getUserWeeklyTokensV2,
} from '../token-usage/dashboard-v2.js'

describe('token dashboard V2', () => {
  test('returns sealed history plus live facts from one event-free query', async () => {
    const pool: any = {
      query: vi.fn(async () => ({ rows: [{
        summary: { total: '120', today: '20', this_week: '70', this_month: '100' },
        daily_series: [{ date: '2026-08-08', input: '60', output: '20', cache_read: '10', requests: '2' }],
        by_model: [
          { model: 'gpt-5', input: '30', output: '10', cache_read: '5', requests: '1' },
          { model: 'claude', input: '20', output: '10', cache_read: '2', requests: '1' },
        ],
        by_daemon: [{ daemon_id: 'daemon-a', hostname: 'Mac', alias: null, input: '50', output: '20', cache_read: '7', requests: '2' }],
      }] })),
    }

    await expect(getTokenDashboardV2(pool, 42, 'all', 150)).resolves.toEqual({
      summary: { total: 120, today: 20, thisWeek: 70, thisMonth: 100 },
      dailySeries: [{ date: '2026-08-08', input: 60, output: 20, cache_read: 10, requests: 2 }],
      byModel: [
        { model: 'gpt-5', input: 30, output: 10, cache_read: 5, requests: 1, total: 40, pct: 57.1 },
        { model: 'claude', input: 20, output: 10, cache_read: 2, requests: 1, total: 30, pct: 42.9 },
      ],
      byDaemon: [{ daemon_id: 'daemon-a', hostname: 'Mac', alias: '', input: 50, output: 20, cache_read: 7, requests: 2, total: 70 }],
    })

    expect(pool.query).toHaveBeenCalledOnce()
    const [sql, params] = pool.query.mock.calls[0]
    expect(sql).toContain("c.status = 'sealed'")
    expect(sql).toContain('FROM token_usage_facts')
    expect(sql).toContain('SUM(f.requests) AS requests')
    expect(sql).not.toContain('FROM events')
    expect(params).toEqual([42, null, 150])
  })

  test('reads per-session trend and per-agent live usage from facts without events', async () => {
    const trendPool: any = {
      query: vi.fn(async () => ({ rows: [{
        date: '2026-08-09', input: '5', output: '4', cache_read: '3', requests: '2',
      }] })),
    }
    await expect(getSessionTokenTrendV2(trendPool, 42, 'session-a', 90)).resolves.toEqual([{
      date: '2026-08-09', input: 5, output: 4, cache_read: 3, requests: 2,
    }])
    expect(trendPool.query.mock.calls[0][1]).toEqual([42, 'session-a', 90])
    expect(trendPool.query.mock.calls[0][0]).toContain('s.user_id = $1')
    expect(trendPool.query.mock.calls[0][0]).toContain('f.user_id = $1')

    const agentPool: any = {
      query: vi.fn(async () => ({ rows: [{ agent_type: 'claude-code', today: '15' }] })),
    }
    await expect(getTodayTokenUsageByAgentV2(agentPool, 42, 'daemon-a')).resolves.toEqual([
      { agent_type: 'claude-code', today: 15 },
    ])

    for (const pool of [trendPool, agentPool]) {
      const sql = pool.query.mock.calls[0][0]
      expect(sql).toContain('FROM token_usage_facts')
      if (pool === trendPool) {
        expect(sql).toContain('SUM(requests) AS requests')
        expect(sql).toContain('token_session_daily_stats')
        expect(sql).toContain("c.status = 'sealed'")
        expect(sql).toContain('f.usage_date = utc.today')
        expect(sql).toContain('f.session_attribution_revoked = false')
      }
      expect(sql).not.toContain('FROM events')
    }
  })

  test('serves historical reports only from sealed rollups', async () => {
    const pool: any = {
      query: vi.fn(async () => ({ rows: [{ total: '25', requests: '3' }] })),
    }

    await expect(getUserDailyTokensV2(pool, 42, '2026-08-08')).resolves.toEqual({ total: 25, requests: 3 })
    await expect(getUserWeeklyTokensV2(pool, 42, '2026-08-08')).resolves.toEqual({ total: 25, requests: 3 })

    for (const [sql] of pool.query.mock.calls) {
      expect(sql).toContain("status = 'sealed'")
      expect(sql).not.toContain('FROM events')
    }
    expect(pool.query.mock.calls[1][0]).toContain('token_usage_facts')
  })
})
