import { describe, test, expect } from 'vitest'
import { dailyReportPush, weeklyReportPush } from '../push.js'

// dailyReportPush / weeklyReportPush build the Pro-only token-usage digest push
// payloads. These are pure builders — verify the title/body formatting and the
// data.type that iOS uses to route (insights) and the subtype for daily vs weekly.

describe('dailyReportPush', () => {
  test('formats token counts compactly (k/M) and includes request count', () => {
    const p = dailyReportPush('7月1日', 1234, 8)
    expect(p.title).toBe('昨日 Token 用量')
    expect(p.body).toBe('7月1日：1.2k tokens · 8 次请求')
    expect(p.data).toEqual({ type: 'insights', subtype: 'daily_report' })
  })

  test('large token counts format to M', () => {
    const p = dailyReportPush('7月1日', 1_500_000, 42)
    expect(p.body).toBe('7月1日：1.5M tokens · 42 次请求')
  })

  test('small token counts stay as integers', () => {
    const p = dailyReportPush('7月1日', 500, 1)
    expect(p.body).toBe('7月1日：500 tokens · 1 次请求')
  })

  test('round thousands drop the .0 suffix', () => {
    const p = dailyReportPush('7月1日', 10_000, 3)
    expect(p.body).toBe('7月1日：10k tokens · 3 次请求')
  })
})

describe('weeklyReportPush', () => {
  test('uses weekly title and a date range label', () => {
    const p = weeklyReportPush('6/24–6/30', 45_000, 120)
    expect(p.title).toBe('本周 Token 用量')
    expect(p.body).toBe('6/24–6/30：45k tokens · 120 次请求')
    expect(p.data).toEqual({ type: 'insights', subtype: 'weekly_report' })
  })

  test('subtype distinguishes weekly from daily', () => {
    const daily = dailyReportPush('7月1日', 100, 1)
    const weekly = weeklyReportPush('6/24–6/30', 100, 1)
    expect(daily.data?.subtype).toBe('daily_report')
    expect(weekly.data?.subtype).toBe('weekly_report')
    // Both share the top-level "insights" type so iOS routes them the same way.
    expect(daily.data?.type).toBe('insights')
    expect(weekly.data?.type).toBe('insights')
  })
})
