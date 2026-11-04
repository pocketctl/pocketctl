import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../composables/useLocale', () => ({
  useLocale: () => ({ t: (key: string) => key }),
}))

const memoryClient = vi.hoisted(() => ({
  getMemoryClaimLifecycle: vi.fn(async()=>({managed:false,source_status:'unknown'})),
  protectMemoryClaim: vi.fn(),
  listMemoryLifecycleClaims: vi.fn(),
  getMemoryClaim: vi.fn(),
  listMemoryClaims: vi.fn(),
  listVersionEvidence: vi.fn(),
  correctMemoryClaim: vi.fn(),
  reviseManualMemoryClaim: vi.fn(),
  reviseAcceptedMemoryClaim: vi.fn(),
  revokeMemoryClaim: vi.fn(),
  deleteMemoryClaim: vi.fn(),
}))

vi.mock('../../services/memoryClient', async () => {
  const actual = await vi.importActual<typeof import('../../services/memoryClient')>('../../services/memoryClient')
  return { ...actual, ...memoryClient }
})

const ClaimDetailPanel = (await import('./ClaimDetailPanel.vue')).default

const detail = {
  claim: {
    claim_id: 'claim-12345678', claim_type: 'operational_runbook', scope_kind: 'repository',
    scope_key: 'pocketctl', state: 'active', revision: '2', current_version_id: 'version-2',
  },
  versions: [
    {
      version_id: 'version-1', version_number: '1', statement: 'Initial deployment rule',
      structured_content: {}, authority: 'user_accepted', confidence: '0.8', repository_id: 'repo-1',
      repo_snapshot_id: null, branch: 'develop', freshness_at: '2026-08-24T08:00:00Z', created_at: '2026-08-24T08:00:00Z',
    },
    {
      version_id: 'version-2', version_number: '2', statement: 'Verify API, Worker, PostgreSQL and Provider separately',
      structured_content: {}, authority: 'user_corrected', confidence: '0.9', repository_id: 'repo-1',
      repo_snapshot_id: null, branch: 'develop', freshness_at: '2026-08-28T08:00:00Z', created_at: '2026-08-28T08:00:00Z',
    },
  ],
  next_version_cursor: null,
}

const claimSummaries = [
  {
    claim_id: 'claim-12345678', claim_type: 'operational_runbook', scope_kind: 'repository',
    scope_key: 'pocketctl', state: 'active', revision: '2', current_version_id: 'version-2',
    statement: 'Verify API, Worker, PostgreSQL and Provider separately', authority: 'user_corrected',
    repository_id: 'repo-1', repo_snapshot_id: null, branch: 'develop',
    freshness_at: '2026-08-28T08:00:00Z', created_at: '2026-08-24T08:00:00Z',
    updated_at: '2026-08-28T08:00:00Z', version_created_at: '2026-08-28T08:00:00Z',
  },
  {
    claim_id: 'claim-87654321', claim_type: 'work_method', scope_kind: 'installation',
    scope_key: 'global', state: 'active', revision: '1', current_version_id: 'version-3',
    statement: 'Keep provider errors visible', authority: 'user_accepted',
    repository_id: null, repo_snapshot_id: null, branch: null,
    freshness_at: '2026-08-27T08:00:00Z', created_at: '2026-08-27T08:00:00Z',
    updated_at: '2026-08-27T08:00:00Z', version_created_at: '2026-08-27T08:00:00Z',
  },
]

const pagedClaimSummaries = [
  ...claimSummaries,
  ...[3, 4, 5, 6].map(index => ({
    ...claimSummaries[1],
    claim_id: `claim-page-${index}`,
    current_version_id: `version-page-${index}`,
    statement: `Paged knowledge ${index}`,
    updated_at: `2026-08-${String(27 - index).padStart(2, '0')}T08:00:00Z`,
  })),
]

describe('ClaimDetailPanel design restoration', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    memoryClient.getMemoryClaim.mockResolvedValue(detail)
    memoryClient.listMemoryClaims.mockResolvedValue({
      claims: claimSummaries, next_cursor: null, total_count: 2,
    })
    memoryClient.listVersionEvidence.mockResolvedValue([{
      evidence_id: 'evidence-1', evidence_kind: 'episode', episode_id: 'episode-1',
      excerpt: 'Health alone does not prove provider synchronization.', truncated: false,
      occurred_at: '2026-08-28T08:00:00Z',
    }])
  })

  test('manual knowledge correction writes a new personal assertion without recycling external evidence', async () => {
    const manual=structuredClone(detail)
    manual.versions[1]!.structured_content={manual_entry:{source_kind:'manual_entry'}}
    memoryClient.getMemoryClaim.mockResolvedValue(manual)
    const wrapper=mount(ClaimDetailPanel,{props:{claimId:detail.claim.claim_id}})
    await flushPromises()
    expect(wrapper.get('[data-testid="memory-manual-source"]').text()).toBe('memory.manual.source')
    await wrapper.get('[data-testid="memory-claim-correct"]').trigger('click')
    expect(wrapper.get('.memory-correction-panel label').text()).toBe('memory.manual.revision_hint')
    expect(wrapper.get('[data-testid="memory-correct-save"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="memory-correct-statement"]').setValue('Revised manual assertion')
    await wrapper.get('[data-testid="memory-correct-save"]').trigger('click')
    await flushPromises()
    expect(memoryClient.reviseManualMemoryClaim).toHaveBeenCalledWith(detail.claim.claim_id,'Revised manual assertion',2,expect.stringMatching(/^web-correct-/))
    expect(memoryClient.correctMemoryClaim).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  test('renders the design claim list and selected claim detail from real data', async () => {
    const wrapper = mount(ClaimDetailPanel, { props: { claimId: 'claim-12345678' } })
    await flushPromises()

    expect(wrapper.get('[data-testid="memory-claim-table-head"]').text()).toContain('memory.claim_column_knowledge')
    expect(wrapper.get('[data-testid="memory-claim-row-claim-12345678"]').text()).toContain('Verify API, Worker, PostgreSQL and Provider separately')
    expect(wrapper.get('[data-testid="memory-claim-row-claim-12345678"]').text()).toContain('operational runbook')
    expect(wrapper.get('[data-testid="memory-claim-row-claim-12345678"]').text()).toContain('pocketctl')
    expect(wrapper.get('[data-testid="memory-claim-library-detail"]').text()).toContain('claim-12345678')
    expect(wrapper.get('[data-testid="memory-claim-versions"]').findAll('li')).toHaveLength(2)
    expect(wrapper.get('[data-testid="memory-claim-actions"]').text()).toContain('memory.correct')
  })

  test('keeps a shared claim bound to its source installation when proposing upward', async () => {
    const sourceInstallationId = '22222222-2222-4222-8222-222222222222'
    const wrapper = mount(ClaimDetailPanel, {
      props: { claimId: 'claim-12345678', installationId: sourceInstallationId },
    })
    await flushPromises()

    expect(memoryClient.getMemoryClaim).toHaveBeenCalledWith(
      'claim-12345678', null, sourceInstallationId,
    )
    expect(wrapper.find('[data-testid="memory-claim-correct"]').exists()).toBe(false)
    await wrapper.get('[data-testid="memory-claim-propose"]').trigger('click')
    await flushPromises()
    expect(memoryClient.listVersionEvidence).toHaveBeenCalledWith('version-2', sourceInstallationId)
    expect(wrapper.emitted('propose')?.[0]).toEqual([
      detail,
      expect.any(Array),
      sourceInstallationId,
    ])
  })

  test('loads active claims and selects the first detail without an incoming claim id', async () => {
    const wrapper = mount(ClaimDetailPanel, { props: { claimId: null } })
    await flushPromises()

    expect(memoryClient.listMemoryClaims).toHaveBeenCalledWith()
    expect(wrapper.findAll('.memory-claim-row')).toHaveLength(2)
    expect(wrapper.get('[data-testid="memory-claim-row-claim-12345678"]').attributes('aria-current')).toBe('true')
    expect(wrapper.get('[data-testid="memory-claim-row-claim-87654321"]').text()).toContain('Keep provider errors visible')
    expect(memoryClient.getMemoryClaim).toHaveBeenCalledWith('claim-12345678')
    expect(wrapper.get('[data-testid="memory-claim-current"]').text()).toContain('Verify API')
  })

  test('pages five claims at a time and selects the first claim on the next page', async () => {
    memoryClient.listMemoryClaims.mockResolvedValueOnce({
      claims: pagedClaimSummaries, next_cursor: null, total_count: 6,
    })
    const wrapper = mount(ClaimDetailPanel, { props: { claimId: null } })
    await flushPromises()

    expect(wrapper.findAll('.memory-claim-row')).toHaveLength(5)
    expect(wrapper.find('[data-testid="memory-claim-row-claim-page-6"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="memory-claim-page-status"]').text()).toContain('1 / 2')
    expect(wrapper.get('[data-testid="memory-claim-previous-page"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-testid="memory-claim-next-page"]').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.memory-claim-row')).toHaveLength(1)
    expect(wrapper.get('[data-testid="memory-claim-row-claim-page-6"]').attributes('aria-current')).toBe('true')
    expect(wrapper.get('[data-testid="memory-claim-page-status"]').text()).toContain('2 / 2')
    expect(memoryClient.getMemoryClaim).toHaveBeenLastCalledWith('claim-page-6')

    await wrapper.get('[data-testid="memory-claim-previous-page"]').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.memory-claim-row')).toHaveLength(5)
    expect(wrapper.get('[data-testid="memory-claim-page-status"]').text()).toContain('1 / 2')
  })

  test('fetches the next server cursor only when a requested page is not loaded yet', async () => {
    memoryClient.listMemoryClaims
      .mockResolvedValueOnce({ claims: pagedClaimSummaries.slice(0, 5), next_cursor: 'next-page', total_count: 6 })
      .mockResolvedValueOnce({ claims: pagedClaimSummaries.slice(5), next_cursor: null, total_count: 6 })
    const wrapper = mount(ClaimDetailPanel, { props: { claimId: null } })
    await flushPromises()

    await wrapper.get('[data-testid="memory-claim-next-page"]').trigger('click')
    await flushPromises()

    expect(memoryClient.listMemoryClaims).toHaveBeenLastCalledWith('next-page')
    expect(wrapper.findAll('.memory-claim-row')).toHaveLength(1)
    expect(wrapper.get('[data-testid="memory-claim-row-claim-page-6"]').attributes('aria-current')).toBe('true')
  })

  test('returns to the first page when the claim filter changes', async () => {
    memoryClient.listMemoryClaims.mockResolvedValueOnce({
      claims: pagedClaimSummaries, next_cursor: null, total_count: 6,
    })
    const wrapper = mount(ClaimDetailPanel, { props: { claimId: null } })
    await flushPromises()
    await wrapper.get('[data-testid="memory-claim-next-page"]').trigger('click')
    await flushPromises()

    await wrapper.get('[data-testid="memory-claim-filter"]').setValue('Verify API')
    await flushPromises()

    expect(wrapper.find('[data-testid="memory-claim-page-status"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="memory-claim-row-claim-12345678"]').exists()).toBe(true)
  })

  test('shows a list request failure instead of a false empty knowledge base', async () => {
    memoryClient.listMemoryClaims.mockRejectedValueOnce(new Error('grant rejected'))
    const wrapper = mount(ClaimDetailPanel, { props: { claimId: null } })
    await flushPromises()

    expect(wrapper.get('[data-testid="memory-claim-list-error"]').text()).toContain('grant rejected')
    expect(wrapper.find('.memory-claim-list-empty').exists()).toBe(false)
  })

  test('filters visible claim rows by statement, type, or scope', async () => {
    const wrapper = mount(ClaimDetailPanel, { props: { claimId: 'claim-12345678' } })
    await flushPromises()

    await wrapper.get('[data-testid="memory-claim-filter"]').setValue('missing claim')

    expect(wrapper.find('[data-testid="memory-claim-row-claim-12345678"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="memory-claim-row-claim-87654321"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="memory-claim-filter-empty"]').text()).toContain('memory.no_filtered_claims')
  })

  test('opens and closes the design detail surface for mobile navigation', async () => {
    const wrapper = mount(ClaimDetailPanel, { props: { claimId: 'claim-12345678' } })
    await flushPromises()

    const detailPanel = wrapper.get('[data-testid="memory-claim-library-detail"]')
    expect(detailPanel.classes()).toContain('mobile-open')

    await wrapper.get('[data-testid="memory-claim-detail-close"]').trigger('click')
    expect(detailPanel.classes()).not.toContain('mobile-open')

    await wrapper.get('[data-testid="memory-claim-row-claim-12345678"]').trigger('click')
    expect(detailPanel.classes()).toContain('mobile-open')
  })

  test('opens details immediately and keeps the last clicked knowledge when reads finish out of order', async () => {
    const wrapper=mount(ClaimDetailPanel,{props:{claimId:null}})
    await flushPromises()
    let finishFirst!:(value:typeof detail)=>void
    let finishSecond!:(value:typeof detail)=>void
    memoryClient.getMemoryClaim.mockImplementationOnce(()=>new Promise(resolve=>{finishSecond=resolve}))
    await wrapper.get('[data-testid="memory-claim-row-claim-87654321"]').trigger('click')
    const panel=wrapper.get('[data-testid="memory-claim-library-detail"]')
    expect(panel.attributes('aria-hidden')).toBe('false')
    expect(panel.attributes('aria-busy')).toBe('true')
    expect(wrapper.find('[data-testid="memory-claim-current"]').exists()).toBe(false)
    memoryClient.getMemoryClaim.mockImplementationOnce(()=>new Promise(resolve=>{finishFirst=resolve}))
    await wrapper.get('[data-testid="memory-claim-row-claim-12345678"]').trigger('click')
    finishFirst(detail);await flushPromises()
    const second=structuredClone(detail);second.claim.claim_id='claim-87654321';second.versions[1]!.statement='Late stale detail'
    finishSecond(second);await flushPromises()
    expect(wrapper.get('[data-testid="memory-claim-current"]').text()).toBe(detail.versions[1]!.statement)
    expect(panel.attributes('aria-busy')).toBe('false')
    wrapper.unmount()
  })

  test('keeps failed details open for retry and lets loading details close without reopening', async () => {
    const wrapper=mount(ClaimDetailPanel,{props:{claimId:null}});await flushPromises()
    memoryClient.getMemoryClaim.mockRejectedValueOnce(Error('detail temporarily unavailable'))
    await wrapper.get('[data-testid="memory-claim-row-claim-87654321"]').trigger('click');await flushPromises()
    expect(wrapper.get('[data-testid="memory-claim-library-detail"]').attributes('aria-hidden')).toBe('false')
    expect(wrapper.get('[data-testid="memory-claim-error"]').text()).toContain('detail temporarily unavailable')
    let finish!:(value:typeof detail)=>void
    memoryClient.getMemoryClaim.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
    await wrapper.get('[data-testid="memory-claim-detail-retry"]').trigger('click')
    await wrapper.get('[data-testid="memory-claim-detail-close"]').trigger('click')
    finish(detail);await flushPromises()
    expect(wrapper.get('[data-testid="memory-claim-library-detail"]').attributes('aria-hidden')).toBe('true')
    wrapper.unmount()
  })

  test('refreshes both the active summary list and detail after a correction', async () => {
    const wrapper = mount(ClaimDetailPanel, { props: { claimId: 'claim-12345678' } })
    await flushPromises()

    await wrapper.get('[data-testid="memory-claim-correct"]').trigger('click')
    await wrapper.get('[data-testid="memory-correct-statement"]').setValue('Corrected deployment rule')
    await wrapper.get('[data-testid="memory-correct-save"]').trigger('click')
    await flushPromises()

    expect(memoryClient.reviseAcceptedMemoryClaim).toHaveBeenCalledWith(detail.claim.claim_id,'Corrected deployment rule',2,expect.stringMatching(/^web-correct-/))
    expect(memoryClient.listMemoryClaims).toHaveBeenCalledTimes(2)
    expect(memoryClient.getMemoryClaim).toHaveBeenCalledTimes(2)
  })
  test('unknown correction retries the original request and prevents overlapping lifecycle changes',async()=>{
    memoryClient.reviseAcceptedMemoryClaim.mockRejectedValueOnce(Error('connection lost')).mockResolvedValueOnce({version_id:'v3'})
    const wrapper=mount(ClaimDetailPanel,{props:{claimId:detail.claim.claim_id}});await flushPromises()
    await wrapper.get('[data-testid="memory-claim-correct"]').trigger('click')
    await wrapper.get('[data-testid="memory-correct-statement"]').setValue('Retry this exact assertion')
    await wrapper.get('[data-testid="memory-correct-save"]').trigger('click');await flushPromises()
    expect(wrapper.get('[data-testid="memory-correct-statement"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="memory-claim-revoke"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="memory-correct-save"]').trigger('click');await flushPromises()
    expect(memoryClient.reviseAcceptedMemoryClaim.mock.calls[1]).toEqual(memoryClient.reviseAcceptedMemoryClaim.mock.calls[0])
    expect(wrapper.get('[data-testid="memory-claim-library-detail"]').attributes('aria-hidden')).toBe('false')
    wrapper.unmount()
  })
  test('completed writes retry only the failed refresh instead of repeating the mutation',async()=>{
    const wrapper=mount(ClaimDetailPanel,{props:{claimId:detail.claim.claim_id}});await flushPromises()
    memoryClient.listMemoryClaims.mockRejectedValueOnce(Error('refresh unavailable'))
    await wrapper.get('[data-testid="memory-claim-correct"]').trigger('click')
    await wrapper.get('[data-testid="memory-correct-statement"]').setValue('Saved once')
    await wrapper.get('[data-testid="memory-correct-save"]').trigger('click');await flushPromises()
    expect(wrapper.get('[data-testid="memory-claim-error"]').text()).toContain('memory.claim_saved_refresh_failed')
    await wrapper.get('[data-testid="memory-claim-refresh"]').trigger('click');await flushPromises()
    expect(memoryClient.reviseAcceptedMemoryClaim).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
  test('version pagination ignores old knowledge after a different row is selected',async()=>{
    memoryClient.getMemoryClaim.mockResolvedValueOnce({...detail,next_version_cursor:'older'})
    const wrapper=mount(ClaimDetailPanel,{props:{claimId:detail.claim.claim_id}});await flushPromises()
    let finish!:(v:unknown)=>void
    memoryClient.getMemoryClaim.mockImplementationOnce(()=>new Promise(r=>{finish=r}))
    await wrapper.get('[data-testid="memory-claim-load-older"]').trigger('click')
    const second=structuredClone(detail);second.claim.claim_id='claim-87654321';second.versions[1]!.statement='Other selected knowledge'
    memoryClient.getMemoryClaim.mockResolvedValueOnce(second)
    await wrapper.get('[data-testid="memory-claim-row-claim-87654321"]').trigger('click');await flushPromises()
    finish({...detail,versions:[{...detail.versions[0],version_id:'stale-older',version_number:'0'}]});await flushPromises()
    expect(wrapper.get('[data-testid="memory-claim-current"]').text()).toBe('Other selected knowledge')
    expect(wrapper.get('[data-testid="memory-claim-versions"]').text()).not.toContain('v0')
    wrapper.unmount()
  })

  test('confirmed deletion is sent once with CAS and refreshes the remaining active knowledge',async()=>{
    const wrapper=mount(ClaimDetailPanel,{props:{claimId:detail.claim.claim_id}});await flushPromises()
    let finish!:(v:unknown)=>void;memoryClient.deleteMemoryClaim.mockImplementation(()=>new Promise(r=>{finish=r}))
    await wrapper.get('[data-testid="memory-claim-delete"]').trigger('click')
    await wrapper.get('[data-testid="memory-delete-confirm-yes"]').trigger('click')
    await wrapper.get('[data-testid="memory-delete-confirm-yes"]').trigger('click')
    expect(memoryClient.deleteMemoryClaim).toHaveBeenCalledTimes(1)
    expect(memoryClient.deleteMemoryClaim).toHaveBeenCalledWith(detail.claim.claim_id,2,expect.stringMatching(/^web-delete-/))
    memoryClient.listMemoryClaims.mockResolvedValueOnce({claims:[claimSummaries[1]],next_cursor:null,total_count:1})
    const remaining=structuredClone(detail);remaining.claim.claim_id='claim-87654321';remaining.versions[1]!.statement='Remaining knowledge';memoryClient.getMemoryClaim.mockResolvedValueOnce(remaining)
    finish({claim_id:detail.claim.claim_id,state:'deleted'});await flushPromises()
    expect(wrapper.find('[data-testid="memory-delete-confirm"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="memory-claim-row-claim-12345678"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="memory-claim-current"]').text()).toBe('Remaining knowledge')
    wrapper.unmount()
  })

  test('changing knowledge cancels stale proposal preparation and enables the new source',async()=>{
    const wrapper=mount(ClaimDetailPanel,{props:{claimId:detail.claim.claim_id}});await flushPromises()
    let finish!:(v:unknown)=>void;memoryClient.listVersionEvidence.mockImplementationOnce(()=>new Promise(r=>{finish=r}))
    await wrapper.get('[data-testid="memory-claim-propose"]').trigger('click')
    const second=structuredClone(detail);second.claim.claim_id='claim-87654321';memoryClient.getMemoryClaim.mockResolvedValueOnce(second)
    await wrapper.get('[data-testid="memory-claim-row-claim-87654321"]').trigger('click');await flushPromises()
    expect(wrapper.get('[data-testid="memory-claim-propose"]').attributes('disabled')).toBeUndefined()
    finish([{evidence_id:'stale',excerpt:'old proof'}]);await flushPromises()
    expect(wrapper.emitted('propose')).toBeUndefined();wrapper.unmount()
  })
  test('an in-flight personal list page cannot populate a newly selected shared installation',async()=>{
    memoryClient.listMemoryClaims.mockResolvedValueOnce({claims:pagedClaimSummaries.slice(0,5),next_cursor:'next',total_count:6})
    const wrapper=mount(ClaimDetailPanel,{props:{claimId:null}});await flushPromises()
    let finish!:(v:unknown)=>void;memoryClient.listMemoryClaims.mockImplementationOnce(()=>new Promise(r=>{finish=r}))
    await wrapper.get('[data-testid="memory-claim-next-page"]').trigger('click')
    const shared=structuredClone(detail);shared.claim.claim_id='shared-claim';memoryClient.getMemoryClaim.mockResolvedValueOnce(shared)
    await wrapper.setProps({claimId:'shared-claim',installationId:'shared-installation'});await flushPromises()
    finish({claims:pagedClaimSummaries.slice(5),next_cursor:null,total_count:6});await flushPromises()
    expect(wrapper.find('[data-testid="memory-claim-row-claim-page-6"]').exists()).toBe(false)
    expect(memoryClient.getMemoryClaim).toHaveBeenLastCalledWith('shared-claim',null,'shared-installation')
    wrapper.unmount()
  })

})

test('AC-42 machine authority is explicit and reclaimed current body never falls back to historical text',async()=>{
 memoryClient.listMemoryClaims.mockResolvedValue({claims:claimSummaries,next_cursor:null,total_count:2})
 memoryClient.getMemoryClaim.mockResolvedValue({...detail,versions:detail.versions.map(v=>v.version_id==='version-2'?{...v,statement:'[content reclaimed]',body_state:'reclaimed',authority:'machine_concluded'}:v)})
 memoryClient.getMemoryClaimLifecycle.mockResolvedValue({managed:true,authority:'machine_concluded',source_status:'unknown',storage_tier:'cold',body_state:'reclaimed',protection:'none',observation_state:'unknown'} as any)
 const wrapper=mount(ClaimDetailPanel,{props:{claimId:detail.claim.claim_id}});await flushPromises()
 expect(wrapper.get('[data-testid="memory-claim-current"]').text()).toBe('memory.lifecycle.body_unavailable')
 expect(wrapper.get('[data-testid="memory-claim-lifecycle"]').text()).toContain('memory.lifecycle.authority_machine_concluded')
 expect(wrapper.get('[data-testid="memory-claim-correct"]').attributes('disabled')).toBeDefined()
 expect(wrapper.text()).not.toContain('[content reclaimed]');wrapper.unmount()
})
test('AC-43 protection shares revision conflict and uncertain retry boundaries',async()=>{
 const {MemoryClientError}=await import('../../services/memoryClient')
 memoryClient.listMemoryClaims.mockResolvedValue({claims:claimSummaries,next_cursor:null,total_count:2})
 memoryClient.getMemoryClaim.mockResolvedValue(detail)
 memoryClient.getMemoryClaimLifecycle.mockResolvedValue({managed:true,authority:'user_accepted',source_status:'unknown',storage_tier:'hot',body_state:'present',protection:'none'} as any)
 memoryClient.protectMemoryClaim.mockRejectedValueOnce(new MemoryClientError(0,'request_unknown','unknown')).mockRejectedValueOnce(new MemoryClientError(409,'revision_conflict','changed'))
 const wrapper=mount(ClaimDetailPanel,{props:{claimId:detail.claim.claim_id}});await flushPromises()
 await wrapper.get('[data-testid="memory-claim-protect"]').trigger('click');await flushPromises()
 expect(wrapper.get('[data-testid="memory-claim-correct"]').attributes('disabled')).toBeDefined()
 await wrapper.get('[data-testid="memory-claim-protect"]').trigger('click');await flushPromises()
 expect(memoryClient.protectMemoryClaim.mock.calls[0]).toEqual(memoryClient.protectMemoryClaim.mock.calls[1])
 expect(memoryClient.protectMemoryClaim.mock.calls[0]?.slice(0,3)).toEqual([detail.claim.claim_id,2,'pinned'])
 expect(wrapper.find('[data-testid="memory-claim-refresh"]').exists()).toBe(true);wrapper.unmount()
})

test('AC-42 cold catalog remains inspectable without active retrieval',async()=>{
 memoryClient.listMemoryClaims.mockResolvedValue({claims:[],next_cursor:null,total_count:0})
 memoryClient.listMemoryLifecycleClaims.mockResolvedValue({claims:[{...claimSummaries[0],storage_tier:'cold'}],next_cursor:null,total_count:1})
 memoryClient.getMemoryClaim.mockResolvedValue(detail)
 const wrapper=mount(ClaimDetailPanel,{props:{claimId:null}});await flushPromises()
 await wrapper.get('[data-testid="memory-claim-collection"]').setValue('cold');await flushPromises()
 expect(memoryClient.listMemoryLifecycleClaims).toHaveBeenCalledWith('cold')
 expect(wrapper.find(`[data-testid="memory-claim-row-${detail.claim.claim_id}"]`).exists()).toBe(true);wrapper.unmount()
})
