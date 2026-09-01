import { describe, expect, test, vi } from 'vitest'
import { createDiscoveryWorker } from '../installations/discovery-worker.js'
import { RelayRequestError } from '../relay/errors.js'

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

  test('uses the probed v2 first page instead of fetching it twice', async () => {
    const listInstallationsV2 = vi.fn(async () => ({
      installations: [], next_cursor: null, has_more: false,
    }))
    const applyDiscovery = vi.fn(async () => ({ applied: 0 }))
    const worker = createDiscoveryWorker({
      installations: { listInstallationsV2, listInstallations: vi.fn() } as never,
      registry: { currentGeneration: vi.fn(async () => 0), applyDiscovery } as never,
      signal: new AbortController().signal,
    })
    await expect(worker.discoverOnce()).resolves.toBe(0)
    expect(listInstallationsV2).toHaveBeenCalledTimes(1)
  })

  test('does not turn a transient v2 failure into a destructive v1-only generation', async () => {
    const listInstallations = vi.fn()
    const worker = createDiscoveryWorker({
      installations: {
        listInstallations,
        listInstallationsV2: vi.fn(async () => {
          throw new RelayRequestError({ operation: 'list_installations_v2', code: 'network' })
        }),
      } as never,
      registry: { currentGeneration: vi.fn(async () => 0), applyDiscovery: vi.fn() } as never,
      signal: new AbortController().signal,
    })
    await expect(worker.discoverOnce()).rejects.toMatchObject({ code: 'network' })
    expect(listInstallations).not.toHaveBeenCalled()
  })

  test('applies only explicitly allowlisted installations', async () => {
    const allowed = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const denied = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const applyDiscovery = vi.fn(async () => ({ applied: 0 }))
    const filtered = createDiscoveryWorker({
      installations: {
        listInstallations: vi.fn(async () => ({
          installations: [
            { installation_id: allowed },
            { installation_id: denied },
          ],
          next_cursor: null,
          has_more: false,
        })),
      } as never,
      registry: {
        currentGeneration: vi.fn(async () => 0),
        applyDiscovery,
      } as never,
      signal: new AbortController().signal,
      installationAllowlist: new Set([allowed]),
    })
    await expect(filtered.discoverOnce()).resolves.toBe(1)
    expect(applyDiscovery).toHaveBeenCalledWith(expect.objectContaining({
      items: [{ installation_id: allowed }],
    }))
  })
})
