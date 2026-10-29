import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../composables/useLocale', () => ({
  useLocale: () => ({ t: (key: string) => key }),
}))

const memoryClient = vi.hoisted(() => ({
  listMemoryCandidates: vi.fn(),
  acceptMemoryCandidate: vi.fn(),
  rejectMemoryCandidate: vi.fn(),
}))

vi.mock('../../services/memoryClient', async () => {
  const actual = await vi.importActual<typeof import('../../services/memoryClient')>('../../services/memoryClient')
  return { ...actual, ...memoryClient }
})

const CandidateReviewList = (await import('./CandidateReviewList.vue')).default
const { MemoryClientError } = await import('../../services/memoryClient')

const candidates = [
  {
    candidate_id: 'candidate-1', episode_id: 'episode-1', claim_type: 'repository_convention',
    statement: 'Use serial phase branches', structured_content: { branch_order: 'develop → phase' },
    scope_kind: 'repository', scope_key: 'pocketctl', repository_id: 'pocketctl',
    repo_snapshot_id: null, branch: 'develop', confidence: '0.88', freshness_at: '',
    status: 'validated', revision: '2', duplicate_of_claim_id: null,
    created_at: '2026-08-28T00:00:00Z', evidence: [{ handle: 'event-1', excerpt: 'Verified branch order' }],
  },
  {
    candidate_id: 'candidate-2', episode_id: 'episode-2', claim_type: 'bug_root_cause',
    statement: 'A removed worktree can mimic a baseline failure',
    scope_kind: 'branch', scope_key: 'feature/memory', repository_id: 'pocketctl',
    repo_snapshot_id: null, branch: 'feature/memory', confidence: '0.81', freshness_at: '',
    status: 'validated', revision: '1', duplicate_of_claim_id: null,
    created_at: '2026-08-27T00:00:00Z', evidence: [{ handle: 'event-2', excerpt: 'Observed missing cwd' }],
  },
]

describe('CandidateReviewList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    memoryClient.listMemoryCandidates.mockResolvedValue({ candidates })
    memoryClient.acceptMemoryCandidate.mockResolvedValue({ claim_id: 'claim-1', version_id: 'version-1' })
    memoryClient.rejectMemoryCandidate.mockResolvedValue({ candidate_id: 'candidate-1' })
  })

  test('personal bulk preserves per-item conflict and sends exact hash',async()=>{
    const hashed=candidates.map(c=>({...c,content_hash:'a'.repeat(64)}))
    memoryClient.listMemoryCandidates.mockResolvedValue({candidates:hashed})
    memoryClient.acceptMemoryCandidate.mockRejectedValueOnce(new MemoryClientError(409,'revision_conflict','changed')).mockResolvedValueOnce({claim_id:'claim-2',version_id:'version-2'})
    const wrapper=mount(CandidateReviewList);await flushPromises()
    const selections=wrapper.findAll('.memory-candidate-list input[type=checkbox]')
    await selections[0].setValue(true);await selections[1].setValue(true)
    await wrapper.findAll('button').find(b=>b.text().includes('bulkAccept'))!.trigger('click');await flushPromises()
    expect(memoryClient.acceptMemoryCandidate).toHaveBeenCalledTimes(2)
    expect(memoryClient.acceptMemoryCandidate.mock.calls[0][4]).toMatchObject({expectedHash:'a'.repeat(64)})
    expect(wrapper.text()).toContain('result.conflict');expect(wrapper.text()).toContain('result.success')
  })

  test('shows immutable delivery identity and blocks individual and bulk acceptance after withdrawal', async () => {
    const delivery = { task_id: 'task-one', spec_revision: 4, submission_id: 'submission-one',
      submission_version: 2, decision_id: 'decision-one', accepted_at: '', state: 'withdrawn' }
    memoryClient.listMemoryCandidates.mockResolvedValue({ candidates: [{ ...candidates[0], content_hash: 'a'.repeat(64), delivery_source: delivery }] })
    const wrapper = mount(CandidateReviewList); await flushPromises()
    const source = wrapper.get('[data-testid="memory-delivery-source"]')
    expect(source.text()).toContain('task-one'); expect(source.text()).toContain('v4')
    expect(source.text()).toContain('v2'); expect(source.text()).toContain('decision-one')
    expect(source.text()).toContain('memory.delivery_withdrawn')
    for (const action of ['accept', 'edit-start']) {
      const button = wrapper.get(`[data-testid="memory-${action}-candidate-1"]`)
      expect(button.attributes('disabled')).toBeDefined(); await button.trigger('click')
    }
    await wrapper.get('.memory-candidate-list input[type=checkbox]').setValue(true)
    const bulk = wrapper.findAll('button').find(b => b.text().includes('bulkAccept'))!
    expect(bulk.attributes('disabled')).toBeDefined(); await bulk.trigger('click')
    expect(memoryClient.acceptMemoryCandidate).not.toHaveBeenCalled()
    await wrapper.get('[data-testid="memory-reject-candidate-1"]').trigger('click'); await flushPromises()
    expect(memoryClient.rejectMemoryCandidate).toHaveBeenCalledTimes(1)
  })

  test('available delivery candidates enter the existing personal review flow', async () => {
    memoryClient.listMemoryCandidates.mockResolvedValue({ candidates: [{ ...candidates[0], delivery_source: {
      task_id: 'task', spec_revision: 1, submission_id: 'submission', submission_version: 3,
      decision_id: 'decision', accepted_at: '', state: 'available',
    } }] })
    const wrapper = mount(CandidateReviewList); await flushPromises()
    expect(wrapper.get('[data-testid="memory-delivery-source"]').text()).toContain('memory.delivery_personal_only')
    await wrapper.get('[data-testid="memory-accept-candidate-1"]').trigger('click'); await flushPromises()
    expect(wrapper.emitted('accepted')).toEqual([['claim-1']])
  })

  test('filters the design queue by text and candidate type', async () => {
    const wrapper = mount(CandidateReviewList)
    await flushPromises()

    const query = wrapper.get('[data-testid="memory-review-filter-query"]')
    await query.setValue('baseline failure')
    expect(wrapper.find('[data-testid="memory-candidate-row-candidate-1"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="memory-candidate-row-candidate-2"]').exists()).toBe(true)

    await query.setValue('')
    await wrapper.get('[data-testid="memory-review-filter-type"]').setValue('repository_convention')
    expect(wrapper.find('[data-testid="memory-candidate-row-candidate-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="memory-candidate-row-candidate-2"]').exists()).toBe(false)
  })

  test('uses the design text actions and publishes the edited statement from the sticky action bar', async () => {
    const wrapper = mount(CandidateReviewList)
    await flushPromises()

    expect(wrapper.get('[data-testid="memory-candidate-repository-candidate-1"]').text()).toBe('pocketctl')
    const reject = wrapper.get('[data-testid="memory-reject-candidate-1"]')
    const edit = wrapper.get('[data-testid="memory-edit-start-candidate-1"]')
    const accept = wrapper.get('[data-testid="memory-accept-candidate-1"]')
    expect(reject.find('svg').exists()).toBe(false)
    expect(edit.find('svg').exists()).toBe(false)
    expect(accept.find('svg').exists()).toBe(false)

    await edit.trigger('click')
    await wrapper.get('[data-testid="memory-edit-candidate-1"]').setValue('Use gated serial phase branches')
    await accept.trigger('click')
    await flushPromises()

    expect(memoryClient.acceptMemoryCandidate).toHaveBeenCalledWith(
      'candidate-1', 2, 'Use gated serial phase branches', expect.stringMatching(/^web-accept-candidate-1-/),
    )
    expect(wrapper.emitted('accepted')).toEqual([['claim-1']])
    expect(wrapper.emitted('changed')).toHaveLength(1)
  })

  test('labels conflict candidates and replaces raw accept errors with the compact localized notice', async () => {
    memoryClient.listMemoryCandidates.mockResolvedValue({
      candidates: [{ ...candidates[1], status: 'conflict' }],
    })
    memoryClient.acceptMemoryCandidate.mockRejectedValueOnce(new MemoryClientError(
      409, 'revision_conflict', 'resource is not in a reviewable state',
    ))
    const wrapper = mount(CandidateReviewList)
    await flushPromises()

    const status = wrapper.get('[data-testid="memory-candidate-status-candidate-2"]')
    expect(status.text()).toBe('memory.status_conflict')
    expect(status.classes()).toContain('is-conflict')

    await wrapper.get('[data-testid="memory-accept-candidate-2"]').trigger('click')
    await flushPromises()

    const notice = wrapper.get('[data-testid="memory-review-action-error-candidate-2"]')
    expect(notice.attributes('role')).toBe('alert')
    expect(notice.classes()).toContain('memory-review-inline-error')
    expect(notice.text()).toBe('memory.candidate_state_changed')
    expect(notice.text()).not.toContain('resource is not in a reviewable state')
  })
})

test('changing delivery identity clears the old queue and ignores its late response', async () => {
  let resolveOld!: (result: unknown) => void
  memoryClient.listMemoryCandidates.mockReset().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    .mockResolvedValueOnce({ candidates: [candidates[1]] })
  const wrapper = mount(CandidateReviewList, { props: { delivery: { submissionId: 'old', decisionId: 'decision-old' } } })
  await wrapper.setProps({ delivery: { submissionId: 'new', decisionId: 'decision-new' } }); await flushPromises()
  resolveOld({ candidates: [candidates[0]] }); await flushPromises()
  expect(memoryClient.listMemoryCandidates.mock.calls.map(c => c[0])).toEqual([
    { submissionId: 'old', decisionId: 'decision-old' }, { submissionId: 'new', decisionId: 'decision-new' },
  ])
  expect(wrapper.find('[data-testid="memory-candidate-row-candidate-1"]').exists()).toBe(false)
  expect(wrapper.find('[data-testid="memory-candidate-row-candidate-2"]').exists()).toBe(true)
  wrapper.unmount()
})
