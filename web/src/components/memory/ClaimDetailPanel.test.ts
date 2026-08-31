import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../composables/useLocale', () => ({
  useLocale: () => ({ t: (key: string) => key }),
}))

const memoryClient = vi.hoisted(() => ({
  getMemoryClaim: vi.fn(),
  listMemoryClaims: vi.fn(),
  listVersionEvidence: vi.fn(),
  correctMemoryClaim: vi.fn(),
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

  test('refreshes both the active summary list and detail after a correction', async () => {
    const wrapper = mount(ClaimDetailPanel, { props: { claimId: 'claim-12345678' } })
    await flushPromises()

    await wrapper.get('[data-testid="memory-claim-correct"]').trigger('click')
    await wrapper.get('[data-testid="memory-correct-statement"]').setValue('Corrected deployment rule')
    await wrapper.get('[data-testid="memory-correct-save"]').trigger('click')
    await flushPromises()

    expect(memoryClient.correctMemoryClaim).toHaveBeenCalled()
    expect(memoryClient.listMemoryClaims).toHaveBeenCalledTimes(2)
    expect(memoryClient.getMemoryClaim).toHaveBeenCalledTimes(2)
  })
})
