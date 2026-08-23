import { describe, expect, test, vi } from 'vitest'
import { inspectTokenUsageMigration } from '../token-usage/preflight.js'

describe('token usage migration preflight', () => {
  test('blocks an initial migration until inbox errors and legacy history conflicts are reviewed', async () => {
    const statements: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql)
        if (sql.includes('FROM token_usage_accounting_state')) return { rows: [], rowCount: 0 }
        if (sql.includes('historical_pending')) return { rows: [{
          historical_pending: '2', historical_claimed: '1', historical_dead_letter: '3',
          missing_usage_facts: '0',
        }], rowCount: 1 }
        if (sql.includes('retained_usage_events')) return { rows: [{
          retained_usage_events: '120000', retained_usage_days: '25',
          legacy_daily_rows: '44', legacy_days: '20',
          events_bytes: '1048576', inbox_bytes: '524288',
        }], rowCount: 1 }
        if (sql.includes('stats_requests')) return { rows: [{
          date: '2026-08-01', stats_requests: '10', stats_total: '100',
          event_requests: '8', event_total: '80',
        }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }

    const report = await inspectTokenUsageMigration(
      { connect: vi.fn(async () => client) } as any,
      { now: new Date('2026-08-10T09:00:00Z') },
    )

    expect(report).toMatchObject({
      todayUtc: '2026-08-10',
      baseline: { status: 'absent', completedAt: null },
      historicalInbox: { pending: 2, claimed: 1, deadLetter: 3 },
      facts: { postBaselineCompletedUsageMissing: 0 },
      scanEstimate: {
        retainedUsageEvents: 120000, retainedUsageDays: 25,
        legacyDailyRows: 44, legacyDays: 20,
        eventsBytes: 1048576, inboxBytes: 524288,
      },
      legacyComparison: {
        comparableDays: 1,
        mismatchedDays: 1,
        accepted: false,
        samples: [{
          date: '2026-08-01', statsRequests: 10, statsTotal: 100,
          eventRequests: 8, eventTotal: 80,
        }],
      },
      ready: false,
      blockers: [
        'historical_pending_inbox',
        'historical_claimed_inbox',
        'historical_dead_letter',
        'legacy_history_review_required',
      ],
    })
    expect(statements[0]).toContain('REPEATABLE READ READ ONLY')
    expect(statements.at(-1)).toBe('COMMIT')
    expect(client.release).toHaveBeenCalledOnce()
  })

  test('allows an explicit legacy-history acknowledgement without hiding mismatch evidence', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM token_usage_accounting_state')) return { rows: [], rowCount: 0 }
        if (sql.includes('historical_pending')) return { rows: [{
          historical_pending: '0', historical_claimed: '0', historical_dead_letter: '0',
          missing_usage_facts: '0',
        }], rowCount: 1 }
        if (sql.includes('retained_usage_events')) return { rows: [{
          retained_usage_events: '9', retained_usage_days: '1',
          legacy_daily_rows: '1', legacy_days: '1', events_bytes: '100', inbox_bytes: '50',
        }], rowCount: 1 }
        if (sql.includes('stats_requests')) return { rows: [{
          date: '2026-08-01', stats_requests: '10', stats_total: '100',
          event_requests: '8', event_total: '80',
        }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }

    const report = await inspectTokenUsageMigration(
      { connect: vi.fn(async () => client) } as any,
      { now: new Date('2026-08-10T09:00:00Z'), acceptLegacyHistory: true },
    )

    expect(report.ready).toBe(true)
    expect(report.blockers).toEqual([])
    expect(report.legacyComparison).toMatchObject({ mismatchedDays: 1, accepted: true })
    expect(report.warnings).toContain('legacy_history_differs_from_retained_events')
  })

  test('rolls back the read-only snapshot when inspection fails', async () => {
    const failure = new Error('inspection failed')
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM token_usage_accounting_state')) throw failure
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }

    await expect(inspectTokenUsageMigration(
      { connect: vi.fn(async () => client) } as any,
    )).rejects.toBe(failure)
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalledOnce()
  })
})
