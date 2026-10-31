import type pg from 'pg'
import { describe, expect, test, vi } from 'vitest'
import { createCandidateExpiryWorker } from '../claims/candidate-expiry.js'

describe('candidate expiry worker lifecycle', () => {
  test('overlapping ticks share one transaction and stop drains the active pass', async () => {
    let finish!: (result: { rowCount: number }) => void
    let notifyStarted!: () => void
    const started = new Promise<void>(resolve => { notifyStarted = resolve })
    const mutation = new Promise<{ rowCount: number }>(resolve => { finish = resolve })
    const release = vi.fn(), onExpired = vi.fn()
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('WITH due')) { notifyStarted(); return mutation }
      return { rowCount: 0 }
    })
    const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as pg.Pool
    const worker = createCandidateExpiryWorker({ pool, signal: new AbortController().signal, onExpired })
    const first = worker.runOnce()
    await started
    expect(worker.runOnce()).toBe(first)
    let stopped = false
    const draining = worker.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(release).not.toHaveBeenCalled()
    finish({ rowCount: 3 })
    await draining
    expect(onExpired).toHaveBeenCalledWith(3)
    expect(release).toHaveBeenCalledOnce()
    expect(query).toHaveBeenLastCalledWith('COMMIT')
    await worker.runOnce()
    expect(pool.connect).toHaveBeenCalledOnce()
  })

  test('an aborted runtime never starts an expiry transaction', async () => {
    const pool = { connect: vi.fn() } as unknown as pg.Pool
    const controller = new AbortController()
    controller.abort()
    const worker = createCandidateExpiryWorker({ pool, signal: controller.signal })
    worker.start()
    await worker.runOnce()
    await worker.stop()
    expect(pool.connect).not.toHaveBeenCalled()
  })
})
