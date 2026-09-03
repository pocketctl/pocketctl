import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ref } from 'vue'

vi.mock('../../composables/useResponsiveLayout', () => ({
  useResponsiveLayout: () => ({ isMobile: ref(false) }),
}))

vi.mock('../../composables/useLocale', async () => {
  const module = await import('../../i18n/zh.json')
  const table = (module as unknown as { default: Record<string, string> }).default
  return {
    useLocale: () => ({
      t: (key: string, ...args: unknown[]) => {
        const value = table[key]
        if (typeof value !== 'string') return key
        return value.replace(/\{(\d+)\}/g, (_m, index) => String(args[Number(index)] ?? ''))
      },
      locale: ref('zh'),
      setLocale: () => undefined,
    }),
  }
})

const memoryInstallation = ref<any>(null)

const memoryClient = vi.hoisted(() => ({
  discoverMemoryInstallation: vi.fn(async () => memoryInstallation.value),
  enableMemoryServices: vi.fn(async (_id: string, _version: number, services: string[]) => ({
    ...memoryInstallation.value,
    enabled_services: services,
  })),
  searchMemory: vi.fn(async () => ({ hits: [] as any[], nextCursor: null, degradedComponents: [] as string[], poolSizes: {} })),
  listMemoryClaims: vi.fn(async () => ({
    claims: [{
      claim_id: 'claim-listed', claim_type: 'work_method', scope_kind: 'installation',
      scope_key: 'global', state: 'active', revision: '1', current_version_id: 'version-1',
      statement: 'Listed active knowledge', authority: 'user_accepted', repository_id: null,
      repo_snapshot_id: null, branch: null, freshness_at: '2026-08-25T00:00:00Z',
      created_at: '', updated_at: '2026-08-25T00:00:00Z', version_created_at: '',
    }],
    next_cursor: null,
    total_count: 1,
  })),
  listMemoryCandidates: vi.fn(async () => ({ candidates: [] as any[] })),
  acceptMemoryCandidate: vi.fn(async () => ({ claim_id: 'claim-accepted', version_id: 'version-accepted' })),
  rejectMemoryCandidate: vi.fn(async () => ({ candidate_id: 'candidate-1' })),
  getMemorySettings: vi.fn(async () => ({
    extraction_mode: 'off', embedding_mode: 'off', revision: 1,
    extraction_ready: true, embedding_ready: false,
  })),
  patchMemorySettings: vi.fn(async () => ({
    extraction_mode: 'shadow', embedding_mode: 'off', revision: 2,
  })),
  getMemoryClaim: vi.fn(async (claimId: string) => ({
    claim: {
      claim_id: claimId, claim_type: 'work_method', scope_kind: 'installation', scope_key: 'global',
      normalized_key: 'key', state: 'active', current_version_id: 'version-1', revision: '1',
      created_at: '', updated_at: '',
    },
    versions: [{
      version_id: 'version-1', version_number: '1', statement: 'Selected claim',
      authority: 'user_accepted', confidence: '0.9', repository_id: null,
      repo_snapshot_id: null, branch: null, valid_from: null, valid_until: null,
      freshness_at: '2026-08-25T00:00:00Z', source_candidate_id: null, created_at: '',
    }],
    next_version_cursor: null,
  })),
  listVersionEvidence: vi.fn(async () => [] as any[]),
  currentMemoryInstallation: () => memoryInstallation.value,
	listContextSettings: vi.fn(async () => ({ settings: [] })),
	putContextSetting: vi.fn(async () => ({ revision: 1 })),
	listContextPacks: vi.fn(async () => ({ packs: [] as any[] })),
	submitContextFeedback: vi.fn(async () => ({ feedback_id: 'feedback-1' })),
	getEffectivePolicy: vi.fn(async () => ({ document: {}, policy_version_ids: [], effective_policy_hash: '00' })),
	listPolicyVersions: vi.fn(async () => ({ versions: [] })),
	previewPolicyDiff: vi.fn(async () => ({ diff: [] })),
	createPolicyVersion: vi.fn(async () => ({ policy_version_id: 'pv-1', version_number: 1 })),
	activatePolicy: vi.fn(async () => undefined),
	getContextLoadout: vi.fn(async () => ({ revision: 1, items: [] })),
	replaceContextLoadout: vi.fn(async () => ({ revision: 2 })),
  listGovernanceScopes: vi.fn(async () => ({ scopes: [] as any[] })),
  listGovernanceQueue: vi.fn(async () => ({ queue: [] as any[] })),
  listScopeMembers: vi.fn(async () => ({ members: [] as any[] })),
  getReviewPolicy: vi.fn(async () => ({ versions: [], head: null })),
  publishGovernanceCandidate: vi.fn(async () => undefined),
  decideGovernanceCandidate: vi.fn(async () => undefined),
  saveReviewPolicy: vi.fn(async () => undefined),
  updateScopeMember: vi.fn(async () => undefined),
  updateScopeLifecycle: vi.fn(async () => undefined),
  startScopeTransfer: vi.fn(async () => undefined),
  proposeGovernanceClaim: vi.fn(async () => ({ candidate: { candidate_id: 'proposal-1' } })),
  getMemoryCodeGraph: vi.fn(async () => null),
  analyzeMemoryChangeImpact: vi.fn(async () => null),
  getMemoryWiki: vi.fn(async () => null),
  listMemoryWikiBuilds: vi.fn(async () => ({ builds: [], next_cursor: null })),
  getMemoryWikiCandidate: vi.fn(async () => null),
  scheduleMemoryWikiBuild: vi.fn(async () => null),
  publishMemoryWikiCandidate: vi.fn(async () => null),
  editMemoryWikiSection: vi.fn(async () => null),
  setMemoryWikiSectionLock: vi.fn(async () => null),
}))

vi.mock('../../services/memoryClient', () => memoryClient)

const MemoryView = (await import('../MemoryView.vue')).default

function activeInstallation(overrides: Record<string, unknown> = {}) {
  return {
    installation_id: 'inst-1',
    provider_id: 'pocketctl-memory',
    status: 'active',
    granted_scopes: [],
    subscriptions: [],
		enabled_services: ['memory.search', 'memory.recall', 'memory.manage', 'memory.context'],
    config_version: '3',
    ...overrides,
  }
}

function mountView() {
  return mount(MemoryView)
}

describe('MemoryView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('without an installation the first-run gate explains the requirement', async () => {
    memoryInstallation.value = null
    const view = mountView()
    await flushPromises()
    expect(view.find('[data-testid="memory-first-run"]').exists()).toBe(true)
    expect(view.find('[data-testid="memory-tab-search"]').exists()).toBe(false)
  })

  test('services must be enabled explicitly before the surface appears', async () => {
    memoryInstallation.value = activeInstallation({ enabled_services: ['memory.search'] })
    const view = mountView()
    await flushPromises()
    const gate = view.find('[data-testid="memory-service-gate"]')
    expect(gate.exists()).toBe(true)
    await view.find('[data-testid="memory-enable-services"]').trigger('click')
    await flushPromises()
    expect(memoryClient.enableMemoryServices).toHaveBeenCalledWith(
      'inst-1',
      3,
	  expect.arrayContaining(['memory.search', 'memory.recall', 'memory.manage', 'memory.context']),
    )
  })

  test('an active installation uses the latest full-width horizontal workspace', async () => {
    memoryInstallation.value = activeInstallation({
	  enabled_services: ['memory.search', 'memory.recall', 'memory.manage', 'memory.context', 'memory.mcp'],
    })
    const view = mountView()
    await flushPromises()
    expect(view.find('[data-testid="memory-workspace"]').exists()).toBe(true)
    expect(view.get('[data-testid="memory-workspace-toolbar"]').attributes('aria-label')).toBeTruthy()
    expect(view.get('[data-testid="memory-tabs"]').attributes('aria-orientation')).toBe('horizontal')
    expect(view.find('[data-testid="memory-workbench-frame"]').exists()).toBe(false)
    expect(view.find('[data-testid="memory-module-rail"]').exists()).toBe(false)
    for (const tab of ['search', 'review', 'claims', 'wiki', 'codegraph', 'skills', 'context', 'persona', 'policies', 'loadouts', 'settings']) {
      expect(view.find(`[data-testid="memory-tab-${tab}"]`).exists()).toBe(true)
    }
    expect(view.get('[data-testid="memory-tab-search"]').attributes('aria-selected')).toBe('true')
		expect(view.get('[data-testid="memory-summary-services"]').text()).toContain('5')
    expect(view.get('[data-testid="memory-workspace-health"]').text()).toContain('记忆服务正常')
    expect(view.get('[data-testid="memory-filter-scope"]').attributes('disabled')).toBeDefined()
    expect(view.find('[data-testid="memory-search-panel"]').exists()).toBe(true)
  })

  test('Wiki and CodeGraph tabs share a repository selector without removing existing modules', async () => {
    memoryInstallation.value = activeInstallation()
    const view = mountView()
    await flushPromises()
    await view.get('[data-testid="memory-tab-wiki"]').trigger('click')
    expect(view.find('[data-testid="memory-wiki-panel"]').exists()).toBe(true)
    await view.get('[data-testid="memory-wiki-repository"]').setValue(
      '11111111-1111-4111-8111-111111111111',
    )
    await view.get('[data-testid="memory-tab-codegraph"]').trigger('click')
    expect(view.find('[data-testid="memory-codegraph-panel"]').exists()).toBe(true)
    expect(view.get('[data-testid="memory-codegraph-repository"]').element).toHaveProperty(
      'value', '11111111-1111-4111-8111-111111111111',
    )
    expect(view.find('[data-testid="memory-tab-search"]').exists()).toBe(true)
    expect(view.find('[data-testid="memory-tab-settings"]').exists()).toBe(true)
  })

  test('Skills navigation renders the scope-aware governance workspace', async () => {
    memoryInstallation.value = activeInstallation()
    const view = mountView()
    await flushPromises()
    await view.get('[data-testid="memory-tab-skills"]').trigger('click')
    expect(view.find('[data-testid="memory-skills-panel"]').exists()).toBe(true)
    expect(view.get('[data-testid="memory-module-stage"]').get('[role="tabpanel"]').attributes('aria-labelledby')).toBe('memory-tab-skills')
  })
  test('Git requires a current shared scope and never substitutes personal scope on discovery failure',async()=>{
    memoryInstallation.value=activeInstallation()
    memoryClient.listGovernanceScopes.mockRejectedValueOnce(Object.assign(new Error('scope unavailable'),{status:403}))
      .mockResolvedValueOnce({scopes:[{installation_id:'personal',owner_scope_kind:'personal',state:'active',permissions:['read'],owner_scope_id:'personal',authorization_epoch:'1'},
        {installation_id:'team-authorized',owner_scope_kind:'team',state:'active',permissions:['read'],owner_scope_id:'team',authorization_epoch:'1'}]})
    const view=mount(MemoryView,{global:{stubs:{MemoryGitPanel:{props:['scopeId'],template:'<div data-testid="git-selected-scope">{{ scopeId }}</div>'}}}})
    await flushPromises();await view.get('[data-testid="memory-tab-git"]').trigger('click')
    expect(view.get('[data-testid="git-scope-error"]').text()).toContain('scope unavailable')
    expect(view.find('[data-testid="git-selected-scope"]').exists()).toBe(false)
    await view.get('[data-testid="git-scope-error"] button').trigger('click');await flushPromises()
    expect(view.get('[data-testid="git-selected-scope"]').text()).toBe('team-authorized')
    view.unmount()
  })

  test.each([403, 503])('Skills shows failed scope discovery (%s) and can retry into a usable scope', async status => {
    memoryInstallation.value = activeInstallation()
    memoryClient.listGovernanceScopes.mockRejectedValueOnce(Object.assign(new Error('scope lookup failed'), { status }))
      .mockResolvedValueOnce({ scopes: [{ installation_id: 'scope-recovered', owner_scope_kind: 'personal',
        owner_scope_id: 'owner-1', state: 'active', permissions: ['read'], authorization_epoch: '1' }] })
    const view = mount(MemoryView, { global: { stubs: { MemorySkillsView: {
      props: ['scopeId'], template: '<div data-testid="recovered-skills">{{ scopeId }}</div>',
    } } } })
    await flushPromises(); await view.get('[data-testid="memory-tab-skills"]').trigger('click')
    expect(view.get('[data-testid="skill-scope-error"]').text()).toContain(String(status))
    expect(view.get('[data-testid="skill-scope-error"]').text()).toContain('scope lookup failed')
    expect(view.find('[data-testid="recovered-skills"]').exists()).toBe(false)
    await view.get('[data-testid="skill-scope-retry"]').trigger('click'); await flushPromises()
    expect(view.find('[data-testid="skill-scope-error"]').exists()).toBe(false)
    expect(view.get('[data-testid="recovered-skills"]').text()).toBe('scope-recovered')
  })

  test('claims header keeps the design create action visible but disabled without an API', async () => {
    memoryInstallation.value = activeInstallation()
    const view = mountView()
    await flushPromises()

    await view.get('[data-testid="memory-tab-claims"]').trigger('click')
    await flushPromises()

    const create = view.get('[data-testid="memory-claim-create"]')
    expect(create.attributes('disabled')).toBeDefined()
    expect(create.text()).toContain('新建知识')
    expect(view.get('[data-testid="memory-workspace-description"]').text()).toContain('版本历史')
    expect(view.get('[data-testid="memory-module-stage"]').get('[role="tabpanel"]').attributes('aria-labelledby')).toBe('memory-tab-claims')
  })

  test('knowledge tab loads active claims after a fresh view without search or acceptance', async () => {
    memoryInstallation.value = activeInstallation()
    const view = mountView()
    await flushPromises()

    await view.get('[data-testid="memory-tab-claims"]').trigger('click')
    await flushPromises()

    expect(memoryClient.listMemoryClaims).toHaveBeenCalledWith()
    expect(view.get('[data-testid="memory-claim-row-claim-listed"]').text()).toContain('Listed active knowledge')
    expect(memoryClient.getMemoryClaim).toHaveBeenCalledWith('claim-listed')
  })

  test('settings cannot leave off without an explicit confirmation', async () => {
    memoryInstallation.value = activeInstallation()
    const view = mountView()
    await flushPromises()
    await view.find('[data-testid="memory-tab-settings"]').trigger('click')
    await flushPromises()
    expect(view.get('[data-testid="memory-settings-card"]').classes()).toContain('memory-settings-workspace')
    expect(view.get('[data-testid="memory-extraction-segments"]').attributes('role')).toBe('radiogroup')
    const mode = view.find('[data-testid="memory-extraction-mode"]').element as HTMLSelectElement
    mode.value = 'shadow'
    await view.find('[data-testid="memory-extraction-mode"]').trigger('change')
    expect(view.find('[data-testid="memory-mode-confirm"]').exists()).toBe(true)
    expect(view.find('[data-testid="memory-extraction-confirm-copy"]').text()).toContain('Episode Packet')
    expect(view.get('[data-testid="memory-confirm-cost"]').text()).toContain('尚未配置')
    await view.find('[data-testid="memory-mode-confirm-yes"]').trigger('click')
    await flushPromises()
    expect(memoryClient.patchMemorySettings).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ extraction_mode: 'shadow' }),
      expect.any(String),
    )
  })

  test('embedding consent identifies Claim/query export separately from Episode extraction', async () => {
    memoryClient.getMemorySettings.mockResolvedValueOnce({
      extraction_mode: 'off', embedding_mode: 'off', revision: 1,
      extraction_ready: true, embedding_ready: true,
      extraction_adapter: {
        provider: 'openai-compatible', origin: 'https://text.example', model: 'text-v1', fingerprint: 'a'.repeat(64), pricing_configured: false,
      },
      embedding_adapter: {
        provider: 'openai-compatible', origin: 'https://embed.example', model: 'embed-v1', fingerprint: 'b'.repeat(64), pricing_configured: true,
      },
    } as never)
    memoryInstallation.value = activeInstallation()
    const view = mountView()
    await flushPromises()
    await view.find('[data-testid="memory-tab-settings"]').trigger('click')
    await flushPromises()
    await view.find('[data-testid="memory-embedding-mode"]').setValue('shadow')
    expect(view.find('[data-testid="memory-embedding-confirm-copy"]').text()).toContain('Active Claim')
    expect(view.find('[data-testid="memory-extraction-confirm-copy"]').exists()).toBe(false)
    expect(view.find('[data-testid="memory-mode-confirm"]').text()).toContain('留存')
    expect(view.get('[data-testid="memory-confirm-cost"]').text()).toContain('显式配置')
  })

  test('an enabled installation can explicitly turn extraction off', async () => {
    memoryClient.getMemorySettings.mockResolvedValueOnce({
      extraction_mode: 'enabled', embedding_mode: 'off', revision: 4,
      extraction_ready: true, embedding_ready: false,
    })
    memoryClient.patchMemorySettings.mockResolvedValueOnce({
      extraction_mode: 'off', embedding_mode: 'off', revision: 5,
    })
    memoryInstallation.value = activeInstallation()
    const view = mountView()
    await flushPromises()
    await view.find('[data-testid="memory-tab-settings"]').trigger('click')
    await flushPromises()
    const select = view.find('[data-testid="memory-extraction-mode"]')
    await select.setValue('off')
    expect(view.find('[data-testid="memory-mode-actions"]').exists()).toBe(true)
    await view.find('[data-testid="memory-mode-save"]').trigger('click')
    await flushPromises()
    expect(memoryClient.patchMemorySettings).toHaveBeenCalledWith(
      4,
      expect.objectContaining({ extraction_mode: 'off' }),
      expect.any(String),
    )
  })

  test('a search result previews in the search workspace before explicitly opening the claim', async () => {
    memoryClient.searchMemory.mockResolvedValueOnce({
      hits: [{
        claimId: 'claim-1', versionId: 'version-1', claimType: 'work_method',
        statement: 'Selected claim', authority: 'user_accepted', confidence: 0.9,
        scopeKind: 'installation', scopeKey: 'global',
        freshnessAt: null, repositoryId: null, repoSnapshotId: null, branch: null,
        validFrom: null, validUntil: null, lexicalRank: 1, vectorScore: null,
        fusedScore: 1, evidenceCount: 1,
      }],
      nextCursor: null, degradedComponents: [], poolSizes: {},
    })
    memoryInstallation.value = activeInstallation()
    const view = mountView()
    await flushPromises()
    await view.find('[data-testid="memory-search-input"]').setValue('selected')
    await view.find('[data-testid="memory-search-submit"]').trigger('submit')
    await flushPromises()
    await view.find('[data-testid="memory-hit-claim-1"]').trigger('click')
    await flushPromises()
    expect(view.find('[data-testid="memory-search-panel"]').exists()).toBe(true)
    expect(view.get('[data-testid="memory-search-detail"]').text()).toContain('Selected claim')
    await view.find('[data-testid="memory-open-claim-claim-1"]').trigger('click')
    await flushPromises()
    expect(view.find('[data-testid="memory-claim-detail"]').exists()).toBe(true)
    expect(view.get('[data-testid="memory-claim-detail"]').classes()).toContain('memory-claim-workspace')
    expect(view.get('[data-testid="memory-claim-versions"]').classes()).toContain('memory-version-ledger')
    expect(memoryClient.getMemoryClaim).toHaveBeenCalledWith('claim-1')
    expect(view.find('[data-testid="memory-search-panel"]').exists()).toBe(false)
    expect(view.get('[data-testid="memory-claim-scope"]').text()).toContain('installation · global')
    expect(view.get('[data-testid="memory-claim-versions"]').text()).toContain('2026-08-25T00:00:00Z')
  })

  test('opens a Team search hit from its installation and offers only its parent Organization', async () => {
    const personalId = '11111111-1111-4111-8111-111111111111'
    const teamId = '22222222-2222-4222-8222-222222222222'
    const organizationId = '33333333-3333-4333-8333-333333333333'
    memoryClient.listGovernanceScopes.mockResolvedValueOnce({
      scopes: [
        { installation_id: personalId, owner_scope_kind: 'personal', owner_scope_id: personalId,
          authorization_epoch: '1', permissions: ['read'], state: 'active' },
        { installation_id: teamId, owner_scope_kind: 'team', owner_scope_id: 'team-scope',
          parent_organization_id: 'org-scope', authorization_epoch: '2',
          permissions: ['read', 'contribute'], state: 'active' },
        { installation_id: organizationId, owner_scope_kind: 'organization', owner_scope_id: 'org-scope',
          authorization_epoch: '3', permissions: ['read', 'contribute'], state: 'active' },
      ],
    })
    memoryClient.searchMemory.mockResolvedValueOnce({
      hits: [{
        claimId: 'team-claim', versionId: 'version-1', claimType: 'work_method',
        statement: 'Team-owned claim', authority: 'team_published', score: 1, sources: ['lexical'],
        scopeKind: 'installation', scopeKey: '', freshnessAt: null, repositoryId: null, branch: null,
        installationId: teamId, ownerScopeKind: 'team', ownerScopeId: 'team-scope',
      }],
      nextCursor: null, degradedComponents: [], poolSizes: {},
    })
    memoryClient.listVersionEvidence.mockResolvedValue([{ evidence_id: 'evidence-1', excerpt: 'shared excerpt' }])
    memoryInstallation.value = activeInstallation({ installation_id: personalId })
    const view = mountView()
    await flushPromises()
    await view.get('[data-testid="memory-search-input"]').setValue('team')
    await view.get('[data-testid="memory-search-submit"]').trigger('submit')
    await flushPromises()
    await view.get('[data-testid="memory-hit-team-claim"]').trigger('click')
    await flushPromises()
    await view.get('[data-testid="memory-open-claim-team-claim"]').trigger('click')
    await flushPromises()
    expect(memoryClient.getMemoryClaim).toHaveBeenCalledWith('team-claim', null, teamId)

    await view.get('[data-testid="memory-claim-propose"]').trigger('click')
    await flushPromises()
    const targets = view.get('.memory-promotion-target').findAll('option').map(option => option.attributes('value'))
    expect(targets).toEqual(['', organizationId])
  })

  test('candidate review renders exact scope and resolved evidence excerpts', async () => {
    memoryClient.listMemoryCandidates.mockResolvedValueOnce({
      candidates: [{
        candidate_id: 'candidate-1', episode_id: 'episode-1', claim_type: 'work_method',
        statement: 'Use exact evidence', scope_kind: 'branch', scope_key: 'main',
        repository_id: null, repo_snapshot_id: null, branch: 'main', confidence: '0.9',
        freshness_at: '', status: 'validated', revision: '1', duplicate_of_claim_id: null,
        evidence: [{ handle: 'h0-aaaaaaaa', excerpt: 'npm test passed' }],
      }],
    })
    memoryInstallation.value = activeInstallation()
    const view = mountView()
    await flushPromises()
    await view.find('[data-testid="memory-tab-review"]').trigger('click')
    await flushPromises()
    expect(view.get('[data-testid="memory-review-list"]').classes()).toContain('memory-review-workspace')
    expect(view.get('[data-testid="memory-review-detail-candidate-1"]').text()).toContain('Use exact evidence')
    expect(view.get('[data-testid="memory-summary-review"]').text()).toContain('1')
    expect(view.find('[data-testid="memory-candidate-evidence-candidate-1"]').text()).toContain('npm test passed')
    expect(view.get('[data-testid="memory-review-detail-candidate-1"]').text()).toContain('branch')
    expect(view.get('[data-testid="memory-candidate-repository-candidate-1"]').text()).toBe('main')
    expect(view.get('[data-testid="memory-reject-candidate-1"]').classes()).toContain('memory-review-action')
    expect(view.get('[data-testid="memory-reject-candidate-1"]').find('svg').exists()).toBe(false)
    expect(view.get('[data-testid="memory-edit-start-candidate-1"]').classes()).toContain('memory-review-action')
    expect(view.get('[data-testid="memory-accept-candidate-1"]').classes()).toContain('memory-review-action')
    expect(view.get('[data-testid="memory-accept-candidate-1"]').find('svg').exists()).toBe(false)
    expect(view.get('[data-testid="memory-accept-candidate-1"]').text()).toContain('接受并入库')
  })

  test('keeps reviewing after acceptance and opens the accepted claim from the claims tab', async () => {
    memoryClient.listMemoryCandidates.mockResolvedValue({
      candidates: [{
        candidate_id: 'candidate-1', episode_id: 'episode-1', claim_type: 'work_method',
        statement: 'Persist accepted claim selection', scope_kind: 'repository', scope_key: 'pocketctl',
        repository_id: 'pocketctl', repo_snapshot_id: null, branch: 'develop', confidence: '0.9',
        freshness_at: '', status: 'validated', revision: '1', duplicate_of_claim_id: null,
        evidence: [{ handle: 'h0-aaaaaaaa', excerpt: 'Acceptance evidence' }],
      }],
    })
    memoryInstallation.value = activeInstallation()
    const view = mountView()
    await flushPromises()

    await view.get('[data-testid="memory-tab-review"]').trigger('click')
    await flushPromises()
    await view.get('[data-testid="memory-accept-candidate-1"]').trigger('click')
    await flushPromises()

    expect(view.get('[data-testid="memory-tab-review"]').attributes('aria-selected')).toBe('true')
    expect(view.find('[data-testid="memory-review-list"]').exists()).toBe(true)

    await view.get('[data-testid="memory-tab-claims"]').trigger('click')
    await flushPromises()

    expect(memoryClient.getMemoryClaim).toHaveBeenCalledWith('claim-accepted')
    expect(view.get('[data-testid="memory-claim-current"]').text()).toContain('Selected claim')
  })

  test('candidate review pages the queue and selects the first candidate on the new page', async () => {
    const ids = ['candidate-1', 'candidate-2', 'candidate-3', 'candidate-4', 'candidate-5', 'candidate-6']
    memoryClient.listMemoryCandidates.mockResolvedValueOnce({
      candidates: ids.map((candidateId, index) => ({
        candidate_id: candidateId, episode_id: `episode-${index + 1}`, claim_type: 'work_method',
        statement: `Candidate ${index + 1}`, scope_kind: 'repository', scope_key: 'pocketctl',
        repository_id: 'pocketctl', repo_snapshot_id: null, branch: 'develop', confidence: '0.8',
        freshness_at: '', status: 'validated', revision: '1', duplicate_of_claim_id: null,
        created_at: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
        evidence: [{ handle: `h${index}`, excerpt: `Evidence ${index + 1}` }],
      })),
    })
    memoryInstallation.value = activeInstallation()
    const view = mountView()
    await flushPromises()
    await view.find('[data-testid="memory-tab-review"]').trigger('click')
    await flushPromises()

    expect(view.find('[data-testid="memory-candidate-row-candidate-1"]').exists()).toBe(true)
    expect(view.find('[data-testid="memory-candidate-row-candidate-5"]').exists()).toBe(true)
    expect(view.find('[data-testid="memory-candidate-row-candidate-6"]').exists()).toBe(false)
    expect(view.get('[data-testid="memory-review-page-status"]').text()).toContain('1 / 2')

    await view.get('[data-testid="memory-review-next-page"]').trigger('click')

    expect(view.find('[data-testid="memory-candidate-row-candidate-1"]').exists()).toBe(false)
    expect(view.find('[data-testid="memory-candidate-row-candidate-6"]').exists()).toBe(true)
    expect(view.find('[data-testid="memory-review-detail-candidate-6"]').exists()).toBe(true)
    expect(view.get('[data-testid="memory-review-next-page"]').attributes('disabled')).toBeDefined()
  })

  test('candidate review exposes a provider failure instead of a false empty queue', async () => {
    memoryClient.listMemoryCandidates.mockRejectedValueOnce(new Error('grant rejected'))
    memoryInstallation.value = activeInstallation()
    const view = mountView()
    await flushPromises()
    await view.find('[data-testid="memory-tab-review"]').trigger('click')
    await flushPromises()
    expect(view.get('[data-testid="memory-review-error"]').text()).toContain('grant rejected')
    expect(view.find('[data-testid="memory-review-empty"]').exists()).toBe(false)
  })
  test('phase two tabs expose context, persona, policies and loadouts panels', async () => {
    memoryInstallation.value = activeInstallation()
    const view = mountView()
    await flushPromises()

    await view.get('[data-testid="memory-tab-context"]').trigger('click')
    expect(view.find('[data-testid="memory-panel-context"]').exists()).toBe(true)
    expect(view.find('[data-testid="memory-context-settings"]').exists()).toBe(true)

    await view.get('[data-testid="memory-tab-persona"]').trigger('click')
    expect(view.find('[data-testid="memory-panel-persona"]').exists()).toBe(true)

    await view.get('[data-testid="memory-tab-policies"]').trigger('click')
    expect(view.find('[data-testid="memory-panel-policies"]').exists()).toBe(true)

    await view.get('[data-testid="memory-tab-loadouts"]').trigger('click')
    expect(view.find('[data-testid="memory-panel-loadouts"]').exists()).toBe(true)
    // Inert future assets are visible, never silently hidden (plan 13).
    expect(view.find('[data-testid="loadout-inert-note"]').exists()).toBe(true)
  })

  test('context pack detail explains hidden sections, evidence and dropped candidates', async () => {
    memoryClient.listContextPacks.mockResolvedValueOnce({
      packs: [{
        pack_id: '11111111-1111-4111-8111-111111111111', state: 'ready',
        client_request_id: 'cr-detail', created_at: '2026-08-28T00:00:00Z',
        delivery: { state: 'delivered', outcome_code: 'accepted' },
        mode: 'enabled', agent: 'codex', stable_text: 'stable persona text',
        dynamic_text: 'dynamic repository rule', stable_tokens: 12, dynamic_tokens: 18,
        error_code: null, policy_revision: 2, settings_revision: 3, loadout_revision: 4,
        items: [{
          item_id: 'item-1', claim_id: 'claim-1', version_id: 'version-1',
          claim_type: 'repository_convention', layer: 'L2', section: 'dynamic',
          representation: 'summary', reason_codes: ['ranked', 'loadout_pinned'],
          token_count: 18, ordinal: 0, evidence_ids: ['evidence-1'],
        }],
        trajectory: {
          result_state: 'completed', degraded_components: [],
          candidates: [{
            version_id: 'version-drop', decision: 'dropped',
            reason_code: 'beyond_limit', final_ordinal: null,
          }],
        },
      }],
    })
    memoryInstallation.value = activeInstallation()
    const view = mountView()
    await flushPromises()
    await view.get('[data-testid="memory-tab-context"]').trigger('click')
    await view.get('[data-testid="pack-session-input"]').setValue('ses-detail')
    await view.get('[data-testid="pack-refresh"]').trigger('click')
    await flushPromises()
    await view.get('[data-testid="pack-select-11111111-1111-4111-8111-111111111111"]').trigger('click')

    expect(view.get('[data-testid="detail-stable"]').text()).toContain('stable persona text')
    expect(view.get('[data-testid="detail-dynamic"]').text()).toContain('dynamic repository rule')
    expect(view.get('[data-testid="detail-tokens"]').text()).toContain('12 + 18')
    expect(view.get('[data-testid="detail-items"]').text()).toContain('evidence-1')
    expect(view.get('[data-testid="detail-items"]').text()).toContain('loadout_pinned')
    expect(view.get('[data-testid="detail-trajectory"]').text()).toContain('beyond_limit')
  })

})
