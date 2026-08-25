import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, test, vi } from 'vitest'

vi.mock('../../composables/useLocale', () => ({
  useLocale: () => ({ t: (key: string) => key }),
}))

const searchMemory = vi.hoisted(() => vi.fn())
vi.mock('../../services/memoryClient', async () => {
  const actual = await vi.importActual<typeof import('../../services/memoryClient')>('../../services/memoryClient')
  return { ...actual, searchMemory }
})

const MemorySearchPanel = (await import('./MemorySearchPanel.vue')).default

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('MemorySearchPanel', () => {
  test('an aborted older search cannot clear the active search state', async () => {
    const newer = deferred<{
      hits: Array<Record<string, unknown>>
      nextCursor: null
      degradedComponents: string[]
      poolSizes: Record<string, number>
    }>()
    searchMemory.mockImplementationOnce((_query: string, _options: unknown, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      }))
    searchMemory.mockImplementationOnce(() => newer.promise)

    const wrapper = mount(MemorySearchPanel)
    const input = wrapper.get('[data-testid="memory-search-input"]')
    await input.setValue('older')
    await wrapper.get('form').trigger('submit')
    ;(input.element as HTMLInputElement).value = 'newer'
    await input.trigger('input')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(searchMemory).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-testid="memory-search-input"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="memory-search-error"]').exists()).toBe(false)

    newer.resolve({
      hits: [{
        claimId: 'claim-new', versionId: 'version-new', claimType: 'work_method',
        statement: 'Newest result', scopeKind: 'branch', scopeKey: 'main', branch: 'main',
        freshnessAt: '2026-08-25T00:00:00Z', authority: 'user_accepted',
      }],
      nextCursor: null, degradedComponents: [], poolSizes: {},
    })
    await flushPromises()

    expect(wrapper.get('[data-testid="memory-hit-claim-new"]').text()).toContain('Newest result')
    expect(wrapper.get('[data-testid="memory-hit-scope-claim-new"]').text()).toContain('branch · main · main')
    expect(wrapper.get('[data-testid="memory-search-input"]').attributes('disabled')).toBeUndefined()
  })
})
