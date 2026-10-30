import { describe, expect, test, vi } from 'vitest'
import { finishDatabaseStartup } from '../startup-readiness.js'

describe('database startup readiness', () => {
  test('slow optional metadata repair never holds readiness or startup completion', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const markReady = vi.fn(), reportMetadataError = vi.fn()
    const repairMetadata = vi.fn(() => pending)
    let completed = false
    const startup = finishDatabaseStartup({ isShuttingDown: () => false, markReady, repairMetadata, reportMetadataError }).then(() => { completed = true })
    await new Promise(resolve => setImmediate(resolve))
    try { expect(markReady).toHaveBeenCalledOnce(); expect(completed).toBe(true) }
    finally { release(); await startup }
  })
  test('optional repair failure is reported without revoking readiness', async () => {
    const error = new Error('statement timeout'), markReady = vi.fn(), reportMetadataError = vi.fn()
    await finishDatabaseStartup({ isShuttingDown: () => false, markReady, repairMetadata: async () => { throw error }, reportMetadataError })
    await new Promise(resolve => setImmediate(resolve))
    expect(markReady).toHaveBeenCalledOnce(); expect(reportMetadataError).toHaveBeenCalledWith(error)
  })
  test('shutdown neither marks ready nor starts historical repair', async () => {
    const markReady = vi.fn(), repairMetadata = vi.fn()
    await finishDatabaseStartup({ isShuttingDown: () => true, markReady, repairMetadata, reportMetadataError: vi.fn() })
    expect(markReady).not.toHaveBeenCalled(); expect(repairMetadata).not.toHaveBeenCalled()
  })
})
