import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../composables/useLocale', () => ({
  useLocale: () => ({ t: (key: string) => key }),
}))

const memoryClient = vi.hoisted(() => ({
  searchMemory: vi.fn(),
  listMemoryScenes: vi.fn(),
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
    memoryClient.listMemoryScenes.mockResolvedValue({scenes:[],has_more:false})
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

  test('search stays full width until a result opens the detail, then restores result focus on close', async () => {
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
    const wrapper = mount(MemorySearchPanel, { attachTo: document.body })
    await wrapper.get('[data-testid="memory-search-input"]').setValue('phase gate')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[data-testid="memory-search-workspace"]').classes()).toContain('memory-search-workspace')
    expect(wrapper.get('[data-testid="memory-search-workspace"]').classes()).not.toContain('has-preview')
    expect(wrapper.get('[data-testid="memory-search-detail"]').text()).toContain('Detail claim-1')
    expect(wrapper.get('[data-testid="memory-search-detail"]').text()).toContain('Verified source evidence')
    expect(wrapper.get('[data-testid="memory-hit-claim-1"]').attributes('aria-current')).toBe('true')

    await wrapper.get('[data-testid="memory-hit-claim-2"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="memory-search-workspace"]').classes()).toContain('has-preview')
    expect(wrapper.get('[data-testid="memory-search-detail"]').attributes('aria-hidden')).toBe('false')
    expect(wrapper.get('[data-testid="memory-search-detail"]').text()).toContain('Detail claim-2')
    expect(wrapper.emitted('select-claim')).toBeUndefined()
    await wrapper.get('.memory-search-detail-close').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="memory-search-workspace"]').classes()).not.toContain('has-preview')
    expect(document.activeElement).toBe(wrapper.get('[data-testid="memory-hit-claim-2"]').element)

    await wrapper.get('[data-testid="memory-hit-claim-2"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="memory-open-claim-claim-2"]').trigger('click')
    expect(wrapper.emitted('select-claim')?.[0]?.[0]).toBe('claim-2')
    wrapper.unmount()
  })
  test('scene and allowed destination are required and restrict search to the chosen owner',async()=>{
    memoryClient.listMemoryScenes.mockResolvedValue({scenes:[{id:'scene-a',name:'Work project',domain:'work',destinations:['work']}],has_more:false})
    memoryClient.searchMemory.mockResolvedValue({hits:[],degradedComponents:[]})
    const wrapper=mount(MemorySearchPanel,{props:{installationId:'owner-a'}});await flushPromises()
    await wrapper.get('[data-testid="memory-search-input"]').setValue('timeout')
    await wrapper.get('form').trigger('submit');expect(memoryClient.searchMemory).not.toHaveBeenCalled()
    await wrapper.get('[data-testid="memory-scene-select"]').setValue('owner-a:scene-a')
    expect(wrapper.get('[data-testid="memory-destination-select"]').findAll('option').map(o=>o.attributes('value'))).toEqual(['','work'])
    await wrapper.get('[data-testid="memory-destination-select"]').setValue('work')
    await wrapper.get('form').trigger('submit');await flushPromises()
    expect(memoryClient.searchMemory).toHaveBeenCalledWith('timeout',{scopeInstallationIds:['owner-a'],sceneId:'scene-a',destination:'work'},expect.any(AbortSignal))
    wrapper.unmount()
  })
  test('an owner change rejects late scenes and old search results',async()=>{
    const late=deferred<any>(),search=deferred<any>()
    memoryClient.listMemoryScenes.mockImplementationOnce(()=>late.promise).mockResolvedValue({scenes:[{id:'scene-b',name:'New owner scene',domain:'life',destinations:['personal']}],has_more:false})
    const wrapper=mount(MemorySearchPanel,{props:{installationId:'owner-a'}})
    await wrapper.setProps({installationId:'owner-b'});await flushPromises()
    late.resolve({scenes:[{id:'scene-a',name:'Private stale scene',domain:'work',destinations:['work']}],has_more:false});await flushPromises()
    expect(wrapper.text()).not.toContain('Private stale scene')
    await wrapper.get('[data-testid="memory-scene-select"]').setValue('owner-b:scene-b')
    await wrapper.get('[data-testid="memory-destination-select"]').setValue('personal')
    await wrapper.get('[data-testid="memory-search-input"]').setValue('old query')
    memoryClient.searchMemory.mockImplementationOnce(()=>search.promise)
    await wrapper.get('form').trigger('submit')
    await wrapper.setProps({installationId:'owner-c'});await flushPromises()
    search.resolve({hits:[{claimId:'old',versionId:'old',statement:'Private stale result'}],degradedComponents:[]});await flushPromises()
    expect(wrapper.text()).not.toContain('Private stale result')
    expect((wrapper.get('[data-testid="memory-scene-select"]').element as HTMLSelectElement).value).toBe('')
    wrapper.unmount()
  })
  test('scene metadata failure stays visible and retry does not report empty search results',async()=>{
    memoryClient.listMemoryScenes.mockRejectedValueOnce(new Error('offline'))
    const wrapper=mount(MemorySearchPanel,{props:{installationId:'owner'}});await flushPromises()
    expect(wrapper.find('[data-testid="memory-scene-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="memory-search-empty"]').exists()).toBe(false)
    await wrapper.get('[data-testid="memory-search-input"]').setValue('query')
    await wrapper.get('form').trigger('submit');expect(memoryClient.searchMemory).not.toHaveBeenCalled()
    await wrapper.get('[data-testid="memory-scene-error"] button').trigger('click');await flushPromises()
    expect(wrapper.find('[data-testid="memory-scene-error"]').exists()).toBe(false)
    wrapper.unmount()
  })

  test('a scene selected from multiple scopes never searches a second owner',async()=>{
    memoryClient.listMemoryScenes.mockImplementation(async(owner:string)=>({scenes:[{id:`scene-${owner}`,name:owner,domain:'work',destinations:['work']}],has_more:false}))
    memoryClient.searchMemory.mockResolvedValue({hits:[],degradedComponents:[]})
    const wrapper=mount(MemorySearchPanel,{props:{installationId:'owner-a',scopes:[{installation_id:'owner-a',owner_scope_kind:'personal',owner_scope_id:'owner-a',permissions:['read'],state:'active'},{installation_id:'owner-b',name:'Other owner',owner_scope_kind:'organization',owner_scope_id:'owner-b',permissions:['read'],state:'active'}] as any}})
    await flushPromises()
    await wrapper.findAll('input[type="checkbox"]')[1]!.setValue(true);await flushPromises()
    await wrapper.get('[data-testid="memory-scene-select"]').setValue('owner-b:scene-owner-b')
    await wrapper.get('[data-testid="memory-destination-select"]').setValue('work')
    await wrapper.get('[data-testid="memory-search-input"]').setValue('scoped')
    await wrapper.get('form').trigger('submit');await flushPromises()
    expect(memoryClient.searchMemory).toHaveBeenCalledWith('scoped',{scopeInstallationIds:['owner-b'],sceneId:'scene-owner-b',destination:'work'},expect.any(AbortSignal))
    wrapper.unmount()
  })

})
