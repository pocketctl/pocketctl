import { describe, expect, test, vi } from 'vitest'
import { createDiscoveryWorker } from '../installations/discovery-worker.js'

function workerFor(page: Record<string, unknown>, maxPages = 1) {
  const applyDiscovery = vi.fn(async () => ({ applied: 0 }))
  const worker = createDiscoveryWorker({
    installations: {
      listInstallations: vi.fn(async () => page),
    } as never,
    registry: {
      currentGeneration: vi.fn(async () => 0),
      applyDiscovery,
    } as never,
    signal: new AbortController().signal,
    maxPages,
  })
  return { worker, applyDiscovery }
}

describe('installation discovery pagination', () => {
  test('rejects has_more without a continuation cursor', async () => {
    const { worker, applyDiscovery } = workerFor({
      installations: [], next_cursor: null, has_more: true,
    })
    await expect(worker.discoverOnce()).rejects.toThrow(/pagination incomplete/)
    expect(applyDiscovery).not.toHaveBeenCalled()
  })

  test('rejects a generation that reaches the page safety cap', async () => {
    const { worker, applyDiscovery } = workerFor({
      installations: [], next_cursor: 'still-more', has_more: true,
    })
    await expect(worker.discoverOnce()).rejects.toThrow(/pagination incomplete/)
    expect(applyDiscovery).not.toHaveBeenCalled()
  })
})
