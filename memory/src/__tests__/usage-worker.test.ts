import { describe, expect, test, vi } from 'vitest'
import { createUsageWorker } from '../reporting/usage-worker.js'

const FACT = {
  usage_id: 'u1', operation: 'candidate_extract', model: 'm',
  input_tokens: '1', output_tokens: '2', embedding_tokens: '0', cached_tokens: '0',
  cost_micros: '3', occurred_at: new Date('2026-08-25T00:00:00Z'), attempts: 0,
}

describe('usage worker isolation and retry accounting', () => {
  test('a failed installation records attempts and does not starve the next installation', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT installation_id')) return { rows: [
        { ...FACT, installation_id: '11111111-1111-4111-8111-111111111111' },
        { ...FACT, usage_id: 'u2', installation_id: '22222222-2222-4222-8222-222222222222' },
      ] }
      if (sql.includes('RETURNING attempts')) return { rows: [{ attempts: 1 }] }
      return { rows: [] }
    })
    const reportUsage = vi.fn(async (installationId: string) => {
      if (installationId.startsWith('1')) throw Object.assign(new Error('no'), { code: 'relay_unavailable' })
      return 1
    })
    const worker = createUsageWorker({ pool: { query } as never, reportUsage })
    expect(await worker.runOnce()).toBe(1)
    expect(reportUsage).toHaveBeenCalledTimes(2)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('last_error_code'))).toBe(true)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('reported_at = NOW()'))).toBe(true)
  })

  test('the tenth failed attempt moves a fact to the content-free dead letter state', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT installation_id')) return { rows: [
        { ...FACT, attempts: 9, installation_id: '11111111-1111-4111-8111-111111111111' },
      ] }
      if (sql.includes('RETURNING attempts')) return { rows: [{ attempts: 10 }] }
      return { rows: [] }
    })
    const worker = createUsageWorker({
      pool: { query } as never,
      reportUsage: vi.fn(async () => { throw new Error('still failing') }),
    })
    expect(await worker.runOnce()).toBe(0)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('dead_lettered_at = NOW()'))).toBe(true)
  })
})
