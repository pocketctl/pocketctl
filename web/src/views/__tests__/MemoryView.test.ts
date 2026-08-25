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
  listMemoryCandidates: vi.fn(async () => ({ candidates: [] as any[] })),
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
  listVersionEvidence: vi.fn(async () => []),
  currentMemoryInstallation: () => memoryInstallation.value,
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
    enabled_services: ['memory.search', 'memory.recall', 'memory.manage'],
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
      expect.arrayContaining(['memory.search', 'memory.recall', 'memory.manage']),
    )
  })

  test('an active, enabled installation shows the four tabs', async () => {
    memoryInstallation.value = activeInstallation()
    const view = mountView()
    await flushPromises()
    for (const tab of ['search', 'review', 'claims', 'settings']) {
      expect(view.find(`[data-testid="memory-tab-${tab}"]`).exists()).toBe(true)
    }
    expect(view.find('[data-testid="memory-search-panel"]').exists()).toBe(true)
  })

  test('settings cannot leave off without an explicit confirmation', async () => {
    memoryInstallation.value = activeInstallation()
    const view = mountView()
    await flushPromises()
    await view.find('[data-testid="memory-tab-settings"]').trigger('click')
    await flushPromises()
    const mode = view.find('[data-testid="memory-extraction-mode"]').element as HTMLSelectElement
    mode.value = 'shadow'
    await view.find('[data-testid="memory-extraction-mode"]').trigger('change')
    expect(view.find('[data-testid="memory-mode-confirm"]').exists()).toBe(true)
    expect(view.find('[data-testid="memory-extraction-confirm-copy"]').text()).toContain('Episode Packet')
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

  test('a search result opens the selected claim instead of leaving a stale search panel', async () => {
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
    expect(view.find('[data-testid="memory-claim-detail"]').exists()).toBe(true)
    expect(memoryClient.getMemoryClaim).toHaveBeenCalledWith('claim-1')
    expect(view.find('[data-testid="memory-search-panel"]').exists()).toBe(false)
    expect(view.get('[data-testid="memory-claim-scope"]').text()).toContain('installation · global')
    expect(view.get('[data-testid="memory-claim-versions"]').text()).toContain('2026-08-25T00:00:00Z')
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
    expect(view.find('[data-testid="memory-candidate-evidence-candidate-1"]').text()).toContain('npm test passed')
    expect(view.text()).toContain('branch · main')
  })
})
