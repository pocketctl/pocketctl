import { describe, expect, test, vi } from 'vitest'
import { runTokenUsagePreflight } from '../token-usage-preflight-main.js'

const report = {
  generatedAt: '2026-08-10T09:00:00.000Z',
  todayUtc: '2026-08-10',
  baseline: { status: 'absent' as const, completedAt: null },
  historicalInbox: { pending: 0, claimed: 0, deadLetter: 0 },
  facts: { postBaselineCompletedUsageMissing: 0 },
  scanEstimate: {
    retainedUsageEvents: 1, retainedUsageDays: 1, legacyDailyRows: 1,
    legacyDays: 1, eventsBytes: 100, inboxBytes: 50,
  },
  legacyComparison: { comparableDays: 1, mismatchedDays: 0, accepted: true, samples: [] },
  blockers: [],
  warnings: [],
  ready: true,
}

describe('token usage preflight command', () => {
  test('prints the read-only report and returns success when the migration gate is ready', async () => {
    const output: string[] = []
    const inspect = vi.fn(async () => report)
    const end = vi.fn(async () => undefined)

    const exitCode = await runTokenUsagePreflight({
      args: ['--accept-legacy-history'],
      env: { DATABASE_URL: 'postgresql://local.test/pocketctl_test' },
      inspect,
      createPool: () => ({ end } as any),
      write: (line) => output.push(line),
    })

    expect(exitCode).toBe(0)
    expect(inspect).toHaveBeenCalledWith(expect.anything(), { acceptLegacyHistory: true })
    expect(JSON.parse(output.join(''))).toEqual(report)
    expect(end).toHaveBeenCalledOnce()
  })

  test('returns a distinct blocked exit code while still printing the audit report', async () => {
    const output: string[] = []
    const blocked = { ...report, ready: false, blockers: ['historical_dead_letter'] }

    const exitCode = await runTokenUsagePreflight({
      args: [],
      env: { DATABASE_URL: 'postgresql://local.test/pocketctl_test' },
      inspect: vi.fn(async () => blocked),
      createPool: () => ({ end: vi.fn(async () => undefined) } as any),
      write: (line) => output.push(line),
    })

    expect(exitCode).toBe(2)
    expect(JSON.parse(output.join('')).blockers).toEqual(['historical_dead_letter'])
  })

  test('rejects unknown options before opening a database connection', async () => {
    const createPool = vi.fn()
    await expect(runTokenUsagePreflight({
      args: ['--force-write'],
      env: { DATABASE_URL: 'postgresql://local.test/pocketctl_test' },
      inspect: vi.fn(),
      createPool,
      write: vi.fn(),
    })).rejects.toThrow('unknown token usage preflight option')
    expect(createPool).not.toHaveBeenCalled()
  })
})
