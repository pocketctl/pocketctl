import { describe, expect, test, vi } from 'vitest'
import { createStatusWorker } from '../reporting/status-worker.js'

describe('status worker', () => {
  test('reports only installations whose Relay status still accepts heartbeats', async () => {
    const reportStatus = vi.fn(async () => undefined)
    const query = vi.fn(async (sql: string) => {
      expect(sql).toContain("i.relay_status IN ('pending', 'active', 'paused')")
      return {
        rows: [{
          installation_id: 'active-installation',
          local_status: 'ready',
          last_feed_id: '42',
          last_error_code: null,
          feed_lag_seconds: 0,
          pending_jobs: '0',
          failed_jobs_24h: '0',
        }],
      }
    })
    const worker = createStatusWorker({
      pool: { query } as never,
      reportStatus,
      providerVersion: 'test',
    })

    await expect(worker.runOnce()).resolves.toBe(1)
    expect(reportStatus).toHaveBeenCalledWith(expect.objectContaining({
      installation_id: 'active-installation',
      state: 'ready',
    }))
  })
})
