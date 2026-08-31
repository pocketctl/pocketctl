import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../composables/useLocale', () => ({
  useLocale: () => ({ t: (key: string) => key }),
}))

const memoryClient = vi.hoisted(() => ({
  searchMemory: vi.fn(),
  getMemoryClaim: vi.fn(),
  listVersionEvidence: vi.fn(),
}))
vi.mock('../../services/memoryClient', async () => {
  const actual = await vi.importActual<typeof import('../../services/memoryClient')>('../../services/memoryClient')
  return { ...actual, ...memoryClient }
})

const MemorySearchPanel = (await import('./MemorySearchPanel.vue')).default

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('MemorySearchPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    memoryClient.getMemoryClaim.mockImplementation(async (claimId: string) => ({
      claim: {
        claim_id: claimId, claim_type: 'work_method', scope_kind: 'branch', scope_key: 'main',
        state: 'active', revision: '1', current_version_id: `version-${claimId}`,
      },
      versions: [{
        version_id: `version-${claimId}`, version_number: '2', statement: `Detail ${claimId}`,
        authority: 'user_accepted', confidence: '0.9', repository_id: 'pocketctl',
        repo_snapshot_id: null, branch: 'main', freshness_at: '2026-08-25T00:00:00Z',
        created_at: '2026-08-25T00:00:00Z',
      }],
      next_version_cursor: null,
    }))
    memoryClient.listVersionEvidence.mockResolvedValue([{
      evidence_id: 'evidence-1', evidence_kind: 'event', episode_id: 'episode-1',
      excerpt: 'Verified source evidence', truncated: false, occurred_at: '2026-08-25T00:00:00Z',
    }])
  })

  test('search submit uses the design plain-text label without a decorative glyph', () => {
    const wrapper = mount(MemorySearchPanel)
    const submit = wrapper.get('[data-testid="memory-search-submit"]')

    expect(submit.classes()).not.toContain('memory-search-action')
    expect(submit.find('svg').exists()).toBe(false)
    expect(submit.get('[data-testid="memory-search-submit-label"]').text()).toBe('memory.search')
    expect(submit.attributes('disabled')).toBeDefined()
  })

  test('an aborted older search cannot clear the active search state', async () => {
    const newer = deferred<{
      hits: Array<Record<string, unknown>>
      nextCursor: null
      degradedComponents: string[]
      poolSizes: Record<string, number>
    }>()
    memoryClient.searchMemory.mockImplementationOnce((_query: string, _options: unknown, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      }))
    memoryClient.searchMemory.mockImplementationOnce(() => newer.promise)

    const wrapper = mount(MemorySearchPanel)
    const input = wrapper.get('[data-testid="memory-search-input"]')
    await input.setValue('older')
    await wrapper.get('form').trigger('submit')
    ;(input.element as HTMLInputElement).value = 'newer'
    await input.trigger('input')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(memoryClient.searchMemory).toHaveBeenCalledTimes(2)
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
    expect(wrapper.get('[data-testid="memory-search-hits"]').classes()).toContain('memory-result-list')
    expect(wrapper.get('[data-testid="memory-search-input"]').attributes('disabled')).toBeUndefined()
  })

  test('search results use the design split layout and open a claim only from the preview action', async () => {
    memoryClient.searchMemory.mockResolvedValueOnce({
      hits: [
        {
          claimId: 'claim-1', versionId: 'version-1', claimType: 'operational_runbook',
          statement: 'First result', scopeKind: 'repository', scopeKey: 'pocketctl', branch: 'develop',
          freshnessAt: '2026-08-24T00:00:00Z', authority: 'user_accepted', repositoryId: 'pocketctl',
          score: 0.94, sources: ['event'],
        },
        {
          claimId: 'claim-2', versionId: 'version-2', claimType: 'work_method',
          statement: 'Second result', scopeKind: 'branch', scopeKey: 'main', branch: 'main',
          freshnessAt: '2026-08-25T00:00:00Z', authority: 'user_accepted', repositoryId: 'pocketctl',
          score: 0.88, sources: ['artifact'],
        },
      ],
      nextCursor: null, degradedComponents: [], poolSizes: {},
    })
    const wrapper = mount(MemorySearchPanel)
    await wrapper.get('[data-testid="memory-search-input"]').setValue('phase gate')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[data-testid="memory-search-workspace"]').classes()).toContain('memory-search-workspace')
    expect(wrapper.get('[data-testid="memory-search-detail"]').text()).toContain('Detail claim-1')
    expect(wrapper.get('[data-testid="memory-search-detail"]').text()).toContain('Verified source evidence')
    expect(wrapper.get('[data-testid="memory-hit-claim-1"]').attributes('aria-current')).toBe('true')

    await wrapper.get('[data-testid="memory-hit-claim-2"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="memory-search-detail"]').text()).toContain('Detail claim-2')
    expect(wrapper.emitted('select-claim')).toBeUndefined()
    await wrapper.get('[data-testid="memory-open-claim-claim-2"]').trigger('click')
    expect(wrapper.emitted('select-claim')?.[0]?.[0]).toBe('claim-2')
  })
})
