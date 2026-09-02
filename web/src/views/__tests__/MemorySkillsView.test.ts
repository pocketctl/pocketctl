import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ref } from 'vue'
import type { MemorySkillCandidate, MemorySkillDetail, MemorySkillPolicyState } from '../../types/memorySkills'

vi.mock('../../composables/useLocale', () => ({ useLocale: () => ({ t: (key: string) => key, locale: ref('en') }) }))
const api = vi.hoisted(() => ({ list: vi.fn(), candidates: vi.fn(), detail: vi.fn(), draft: vi.fn(), edit: vi.fn(),
  review: vi.fn(), revoke: vi.fn(), diff: vi.fn(), replayCases: vi.fn(), replay: vi.fn(), publish: vi.fn(),
  rollback: vi.fn(), policy: vi.fn(), updatePolicy: vi.fn() }))
vi.mock('../../services/memorySkills', () => ({ memorySkills: api }))
const View = (await import('../MemorySkillsView.vue')).default
const modes = { mode: 'shadow', auto_publish_mode: 'off', canary_mode: 'off' }
function skill(overrides: Partial<MemorySkillDetail> = {}): MemorySkillDetail {
  const counts = { total: 1, pending: 0, passed: 1, failed: 0, cancelled: 0 }
  return { skill_id: 'skill-1', version_id: 'version-2', version_number: 2, revision: 4, state: 'draft',
    title: 'Inspect source safely', risk: 'high', repository_id: 'repo-1', created_at: '',
    mode: 'shadow', auto_publish_mode: 'off', canary_mode: 'off',
    document: { schema_version: 'skill-candidate.v1', title: 'Inspect source safely', trigger: 'When investigating an incident',
      preconditions: ['Repository access'], steps: [{ instruction: '<script>alert(1)</script> Read src/main.ts', tool: 'read_file', permissions: ['repository:read'], operation: 'read' }],
      validation: ['Check evidence'], failure_handling: ['Stop'], rollback: ['No changes'], source_tokens: ['src_1'] },
    document_hash: 'content-hash', source_digest: 'source-hash', archive_id: 'archive-1', policy_hash: 'policy-hash',
    risk_reasons: ['risk_requires_review'], sources: [{ token: 'src_1', handle: 'src/main.ts', excerpt_hash: 'source-hash', event_id: 'event-1', artifact_id: null, evidence_id: null }],
    versions: [{ version_id: 'version-2', version_number: 2, document_hash: 'content-hash', policy_hash: 'policy-hash', risk: 'high', created_at: '' },
      { version_id: 'version-1', version_number: 1, document_hash: 'old-hash', policy_hash: 'policy-hash', risk: 'low', created_at: '' }],
    replay: { run_id: 'replay-1', state: 'passed', eligible: true, error_code: null, natural_execution_count: 0,
      provenance: { fixture: 2, recorded: 0 }, kinds: { historical_session: { ...counts }, golden_task: { ...counts } } },
    publication: null, executions: [{ execution_id: 'exec-1', outcome: 'failed', provenance: 'fixture' }],
    eligibility: { eligible: false, manual_eligible: false, reason_codes: ['product_gate_closed'], independent_successes: 0,
      required_independent_successes: 2, product_gate: 'closed', policy_hash: 'policy-hash', replay_run_id: 'replay-1' },
    permissions: { can_edit: true, can_review: true, can_replay: true, can_publish: false, can_revoke: true, can_rollback: false, can_manage_policy: true },
    ...overrides }
}
function candidate(): MemorySkillCandidate {
  return { candidate_id: 'candidate-1', task_id: 'task-1', generation: 3, archive_id: 'archive-1', document: skill().document,
    risk: 'high', risk_reasons: ['manual_review'], repository_id: 'repo-1', created_at: '', expected_revision: 4, can_draft: true }
}
function policy(): MemorySkillPolicyState { return { revision: 2, version_id: 'policy-2', hash: 'policy-hash',
  policy: { minimum_independent_successes: 2, auto_mode: 'off', canary_mode: 'off' }, can_manage_policy: true } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
async function open() { const view = mount(View, { props: { scopeId: 'scope-a' } }); await flushPromises(); await view.get('[data-testid="skill-select-skill-1"]').trigger('click'); await flushPromises(); return view }
beforeEach(() => {
  vi.resetAllMocks()
  api.list.mockResolvedValue({ items: [skill()], next_cursor: null, ...modes })
  api.candidates.mockResolvedValue({ items: [candidate()], next_cursor: null, ...modes })
  api.detail.mockResolvedValue(skill()); api.policy.mockResolvedValue(policy())
  api.replayCases.mockResolvedValue({ items: [{ case_id: 'trusted-history', kind: 'historical_session', provenance: 'fixture' }, { case_id: 'trusted-golden', kind: 'golden_task', provenance: 'fixture' }] })
  api.review.mockResolvedValue({ skill_id: 'skill-1' }); api.edit.mockResolvedValue({ skill_id: 'skill-1' }); api.draft.mockResolvedValue({ skill_id: 'skill-1' })
})

describe('Skill governance workspace', () => {
  test('shows server risk, bound evidence, both Replay denominators, real result and closed gates without executing content', async () => {
    const view = await open()
    expect(view.get('[data-testid="skill-modes"]').text()).toContain('off')
    expect(view.find('[data-testid="skill-manual-review"]').exists()).toBe(true)
    expect(view.get('[data-testid="skill-evidence"]').text()).toContain('src/main.ts')
    expect(view.get('[data-testid="skill-replay-summary"]').text()).toContain('memory.skills.historical_session')
    expect(view.get('[data-testid="skill-replay-summary"]').text()).toContain('memory.skills.golden_task')
    expect(view.get('[data-testid="skill-execution"]').text()).toContain('failed')
    expect(view.get('[data-testid="skill-document"]').text()).toContain('<script>alert(1)</script>')
    expect(view.find('script').exists()).toBe(false)
    expect(view.find('[data-testid="skill-publish"]').exists()).toBe(false)
    expect(view.get('[data-testid="skill-rollback-target"]').attributes('disabled')).toBeDefined()
    expect(api.publish).not.toHaveBeenCalled(); expect(api.replay).not.toHaveBeenCalled()
  })
  test('drafts from selected candidate using its server revision then edits an immutable new version', async () => {
    const view = await open()
    await view.get('[data-testid="skill-candidate-candidate-1"]').trigger('click')
    await view.get('[data-testid="skill-draft"]').trigger('click'); await flushPromises()
    expect(api.draft).toHaveBeenCalledWith('scope-a', 'candidate-1', 4, expect.any(AbortSignal))
    await view.get('[data-testid="skill-edit"]').trigger('click')
    await view.get('[data-testid="skill-edit-title"]').setValue('Revised source check')
    await view.get('[data-testid="skill-editor"]').trigger('submit'); await flushPromises()
    expect(api.edit).toHaveBeenCalledWith('scope-a', 'skill-1', 4, expect.objectContaining({ title: 'Revised source check', source_tokens: ['src_1'] }), expect.any(AbortSignal))
    expect(skill().document.title).toBe('Inspect source safely')
  })
  test('compares immutable version IDs and runs only selected trusted case IDs', async () => {
    api.diff.mockResolvedValue({ from_version_id: 'version-1', to_version_id: 'version-2', changes: [{ field: 'title', before: 'Original', after: 'Revised' }] })
    api.replay.mockResolvedValue(skill().replay)
    const view = await open()
    await view.get('[data-testid="skill-diff"]').trigger('click'); await flushPromises()
    expect(api.diff).toHaveBeenCalledWith('scope-a', 'skill-1', 'version-1', 'version-2', expect.any(AbortSignal))
    expect(view.get('[data-testid="skill-diff-result"]').text()).toContain('Original')
    await view.get('[data-testid="skill-case-trusted-history"]').setValue(true)
    await view.get('[data-testid="skill-case-trusted-golden"]').setValue(true)
    await view.get('[data-testid="skill-replay"]').trigger('click'); await flushPromises()
    expect(api.replay).toHaveBeenCalledWith('scope-a', 'skill-1', { version_id: 'version-2', expected_revision: 4,
      case_ids: ['trusted-history', 'trusted-golden'], idempotency_key: expect.any(String) }, expect.any(AbortSignal))
  })
  test.each(['approve', 'request_changes', 'reject'] as const)('submits %s as a server review decision', async action => {
    const view = await open(); await view.get('[data-testid="skill-review-outcome"]').setValue('accepted_as_is')
    await view.get(`[data-testid="skill-${action}"]`).trigger('click'); await flushPromises()
    expect(api.review).toHaveBeenCalledWith('scope-a', 'skill-1', 4, action, expect.any(AbortSignal), action === 'approve' ? 'accepted_as_is' : undefined)
  })
  test.each([403, 409, 503])('keeps %s action errors visible and does not turn them into empty state', async status => {
    api.review.mockRejectedValue(Object.assign(new Error('source_or_permission_changed'), { status }))
    const view = await open(); await view.get('[data-testid="skill-review-outcome"]').setValue('accepted_as_is')
    await view.get('[data-testid="skill-approve"]').trigger('click'); await flushPromises()
    expect(view.get('[data-testid="skill-action-error"]').text()).toContain(status === 403 ? 'forbidden' : status === 409 ? 'conflict' : 'off')
    expect(view.find('[data-testid="skill-detail"]').exists()).toBe(true)
    expect(view.find('[data-testid="skill-empty"]').exists()).toBe(false)
  })
  test('hides mutation actions for read-only permissions and accepts null eligibility', async () => {
    api.detail.mockResolvedValue(skill({ eligibility: null, permissions: { can_edit: false, can_review: false, can_replay: false, can_publish: false, can_revoke: false, can_rollback: false, can_manage_policy: false } }))
    api.policy.mockResolvedValue({ ...policy(), can_manage_policy: false })
    const view = await open()
    for (const action of ['edit', 'approve', 'replay', 'revoke', 'publish', 'policy-save']) expect(view.find(`[data-testid="skill-${action}"]`).exists()).toBe(false)
    expect(api.replayCases).not.toHaveBeenCalled()
  })
  test('loads more skills and keeps failed list reads distinct from empty responses', async () => {
    api.list.mockResolvedValueOnce({ items: [skill()], next_cursor: 'cursor-2', ...modes })
      .mockResolvedValueOnce({ items: [skill({ skill_id: 'skill-2', title: 'Second skill' })], next_cursor: null, ...modes })
    const view = mount(View, { props: { scopeId: 'scope-a' } }); await flushPromises()
    await view.get('[data-testid="skill-more"]').trigger('click'); await flushPromises()
    expect(api.list).toHaveBeenLastCalledWith('scope-a', expect.objectContaining({ cursor: 'cursor-2' }), expect.any(AbortSignal))
    expect(view.find('[data-testid="skill-select-skill-2"]').exists()).toBe(true)
    api.list.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status: 503 }))
    await view.get('form').trigger('submit'); await flushPromises()
    expect(view.get('[data-testid="skill-list-error"]').text()).toContain('memory.skills.off')
    expect(view.find('[data-testid="skill-empty"]').exists()).toBe(false)
    api.list.mockResolvedValueOnce({ items: [], next_cursor: null, ...modes })
    await view.get('[data-testid="skill-list-error"] button').trigger('click'); await flushPromises()
    expect(view.find('[data-testid="skill-empty"]').exists()).toBe(true)
  })
  test('aborts and isolates late list, detail, policy and mutation responses when the scope changes', async () => {
    const oldList = deferred<unknown>(), oldDetail = deferred<unknown>(), oldPolicy = deferred<unknown>(), oldReview = deferred<unknown>()
    api.list.mockReturnValueOnce(oldList.promise); api.policy.mockReturnValueOnce(oldPolicy.promise)
    const view = mount(View, { props: { scopeId: 'scope-a' } }); await flushPromises()
    const oldSignal = api.list.mock.calls[0]![2] as AbortSignal
    await view.setProps({ scopeId: 'scope-b' }); await flushPromises()
    expect(oldSignal.aborted).toBe(true)
    oldList.resolve({ items: [skill({ skill_id: 'secret-old-skill' })], next_cursor: null, ...modes }); oldPolicy.resolve({ ...policy(), hash: 'old-private-policy' }); await flushPromises()
    expect(view.text()).not.toContain('old-private-policy'); expect(view.find('[data-testid="skill-select-secret-old-skill"]').exists()).toBe(false)
    api.detail.mockReturnValueOnce(oldDetail.promise)
    await view.get('[data-testid="skill-select-skill-1"]').trigger('click'); await view.setProps({ scopeId: 'scope-c' }); await flushPromises()
    oldDetail.resolve(skill({ title: 'Old private detail' })); await flushPromises(); expect(view.text()).not.toContain('Old private detail')
    await view.get('[data-testid="skill-select-skill-1"]').trigger('click'); await flushPromises()
    api.review.mockReturnValueOnce(oldReview.promise)
    await view.get('[data-testid="skill-review-outcome"]').setValue('accepted_as_is')
    await view.get('[data-testid="skill-approve"]').trigger('click'); await view.setProps({ scopeId: 'scope-d' }); await flushPromises()
    oldReview.resolve({ skill_id: 'old-mutated-skill' }); await flushPromises()
    expect(view.find('[data-testid="skill-detail"]').exists()).toBe(false)
    expect(api.detail).not.toHaveBeenCalledWith('scope-d', 'old-mutated-skill', expect.anything())
  })
  test('saves a versioned policy with CAS and shows a policy conflict', async () => {
    api.updatePolicy.mockRejectedValue(Object.assign(new Error('policy_changed'), { status: 409 }))
    const view = await open(); await view.get('[data-testid="skill-policy-minimum"]').setValue(3)
    await view.get('.memory-skill-policy form').trigger('submit'); await flushPromises()
    expect(api.updatePolicy).toHaveBeenCalledWith('scope-a', 2, { minimum_independent_successes: 3, auto_mode: 'off', canary_mode: 'off' }, expect.any(AbortSignal))
    expect(view.get('[data-testid="skill-policy-error"]').text()).toContain('conflict')
  })
  test('requires an explicit confirmation for revoke and manual publication when server permissions allow it', async () => {
    // Engineering-only fixture: this does not assert that the live product gate is open.
    const allowed = skill(); allowed.permissions.can_publish = true; allowed.eligibility!.manual_eligible = true; allowed.eligibility!.product_gate = 'open'
    api.detail.mockResolvedValue(allowed); api.publish.mockResolvedValue({ revision: 1 }); api.revoke.mockResolvedValue({ skill_id: 'skill-1' })
    const view = await open(); await view.get('[data-testid="skill-publish"]').trigger('click')
    expect(api.publish).not.toHaveBeenCalled()
    await view.get('[data-testid="skill-confirm"]').trigger('click'); await flushPromises()
    expect(api.publish).toHaveBeenCalledWith('scope-a', 'skill-1', { version_id: 'version-2', expected_revision: 4, expected_publication_revision: 0, mode: 'manual' }, expect.any(AbortSignal))
    await view.get('[data-testid="skill-revoke"]').trigger('click'); expect(api.revoke).not.toHaveBeenCalled()
    await view.get('[data-testid="skill-confirm"]').trigger('click'); await flushPromises()
    expect(api.revoke).toHaveBeenCalledWith('scope-a', 'skill-1', 4, expect.any(AbortSignal))
  })
  test('confirms the selected rollback target with both head revisions', async () => {
    const allowed = skill({ publication: { revision: 3 } }); allowed.permissions.can_rollback = true
    api.detail.mockResolvedValue(allowed); api.rollback.mockResolvedValue({ revision: 4 })
    const view = await open(); await view.get('[data-testid="skill-rollback-target"]').setValue('version-1')
    await view.get('[data-testid="skill-rollback"]').trigger('click'); expect(api.rollback).not.toHaveBeenCalled()
    await view.get('[data-testid="skill-confirm"]').trigger('click'); await flushPromises()
    expect(api.rollback).toHaveBeenCalledWith('scope-a', 'skill-1', { target_version_id: 'version-1', expected_revision: 4, expected_publication_revision: 3 }, expect.any(AbortSignal))
  })
  test.each(['accepted_as_is', 'light_edit', 'major_edit'])('requires an explicit %s review outcome before approval', async outcome => {
    const view = await open()
    expect(view.get('[data-testid="skill-review-outcome"]').element).toHaveProperty('value', '')
    expect(view.get('[data-testid="skill-approve"]').attributes('disabled')).toBeDefined()
    await view.get('[data-testid="skill-approve"]').trigger('click'); expect(api.review).not.toHaveBeenCalled()
    await view.get('[data-testid="skill-review-outcome"]').setValue(outcome)
    await view.get('[data-testid="skill-approve"]').trigger('click'); await flushPromises()
    expect(api.review).toHaveBeenCalledWith('scope-a', 'skill-1', 4, 'approve', expect.any(AbortSignal), outcome)
  })
  test('keeps unsaved edits visible and blocks old-version mutations until saved or explicitly discarded', async () => {
    const allowed = skill(); allowed.permissions.can_publish = true; allowed.permissions.can_rollback = true
    allowed.eligibility!.manual_eligible = true; allowed.eligibility!.product_gate = 'open'
    api.detail.mockResolvedValue(allowed)
    const view = await open()
    await view.get('[data-testid="skill-review-outcome"]').setValue('accepted_as_is')
    await view.get('[data-testid="skill-case-trusted-history"]').setValue(true)
    await view.get('[data-testid="skill-rollback-target"]').setValue('version-1')
    await view.get('[data-testid="skill-edit"]').trigger('click')
    await view.get('[data-testid="skill-edit-title"]').setValue('Unsaved critical change')
    for (const action of ['approve', 'request_changes', 'reject', 'replay', 'publish', 'rollback', 'revoke', 'policy-save']) {
      const button = view.get(`[data-testid="skill-${action}"]`)
      expect(button.attributes('disabled'), action).toBeDefined()
      // Even a stale/programmatic click must honor the handler's editor guard.
      ;(button.element as HTMLButtonElement).disabled = false
      await button.trigger('click')
    }
    await flushPromises()
    expect(api.review).not.toHaveBeenCalled(); expect(api.replay).not.toHaveBeenCalled(); expect(api.publish).not.toHaveBeenCalled()
    expect(api.rollback).not.toHaveBeenCalled(); expect(api.revoke).not.toHaveBeenCalled(); expect(api.updatePolicy).not.toHaveBeenCalled()
    expect(view.get('[data-testid="skill-edit-title"]').element).toHaveProperty('value', 'Unsaved critical change')
    await view.get('[data-testid="skill-editor"] footer button:last-child').trigger('click')
    await view.get('[data-testid="skill-review-outcome"]').setValue('accepted_as_is')
    await view.get('[data-testid="skill-approve"]').trigger('click'); await flushPromises()
    expect(api.review).toHaveBeenCalledTimes(1)
  })
  test('binds diffs to the exact selected versions and ignores an older same-Skill response', async () => {
    const value = skill(); value.versions.push({ ...value.versions[1]!, version_id: 'version-0', version_number: 0 })
    api.detail.mockResolvedValue(value)
    const first = deferred<unknown>(), second = deferred<unknown>()
    api.diff.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const view = await open(); await view.get('[data-testid="skill-diff"]').trigger('click')
    await view.get('[data-testid="skill-diff-from"]').setValue('version-0')
    await view.get('[data-testid="skill-diff"]').trigger('click')
    second.resolve({ from_version_id: 'version-0', to_version_id: 'version-2', changes: [{ field: 'title', before: 'Selected comparison', after: 'Current' }] })
    await flushPromises(); expect(view.get('[data-testid="skill-diff-result"]').text()).toContain('Selected comparison')
    first.resolve({ from_version_id: 'version-1', to_version_id: 'version-2', changes: [{ field: 'title', before: 'Stale comparison', after: 'Current' }] })
    await flushPromises(); expect(view.get('[data-testid="skill-diff-result"]').text()).not.toContain('Stale comparison')
    expect(view.get('[data-testid="skill-diff-result"]').text()).toContain('version-0')
    await view.get('[data-testid="skill-diff-from"]').setValue('version-1')
    expect(view.find('[data-testid="skill-diff-result"]').exists()).toBe(false)
  })
})
