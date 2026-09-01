import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ref } from 'vue'
import type { MemoryActiveWiki } from '../../types/memory'

vi.mock('../../composables/useLocale', () => ({
  useLocale: () => ({ t: (key: string) => key, locale: ref('en'), setLocale: () => undefined }),
}))

const memoryClient = vi.hoisted(() => ({
  getMemoryCodeGraph: vi.fn(),
  analyzeMemoryChangeImpact: vi.fn(),
  getMemoryWiki: vi.fn(),
  listMemoryWikiBuilds: vi.fn(),
  getMemoryWikiCandidate: vi.fn(),
  scheduleMemoryWikiBuild: vi.fn(),
  publishMemoryWikiCandidate: vi.fn(),
  editMemoryWikiSection: vi.fn(),
  setMemoryWikiSectionLock: vi.fn(),
}))
vi.mock('../../services/memoryClient', () => memoryClient)

const MemoryCodeGraphPanel = (await import('./MemoryCodeGraphPanel.vue')).default
const MemoryWikiPanel = (await import('./MemoryWikiPanel.vue')).default
const MemoryWikiCandidate = (await import('./MemoryWikiCandidate.vue')).default
const MemoryWikiEditor = (await import('./MemoryWikiEditor.vue')).default

const repositoryId = '11111111-1111-4111-8111-111111111111'

function graphResult(nodes: unknown[] = [{
  node_id: 'node-1', kind: 'file', stable_key: 'file:src/index.ts',
  path: 'src/index.ts', name: 'src/index.ts', metadata: {},
}]) {
  return {
    repository_id: repositoryId, owner_scope_kind: 'personal', owner_scope_id: 'owner-1',
    snapshot_id: 'snapshot-1', commit_sha: 'abc123def456', graph_version_id: 'graph-1',
    parser_version: 'typescript-5.7-phase4-v1', coverage: 'partial', content_hash: 'a'.repeat(64),
    nodes, edges: [{ edge_id: 'edge-1', kind: 'import', from_stable_key: 'file:src/index.ts',
      to_stable_key: 'file:src/lib.ts', source_path: 'src/index.ts', resolution: 'resolved' }],
    next_cursor: null,
  }
}

function activeWiki(): MemoryActiveWiki {
  return {
    repository_id: repositoryId, owner_scope_kind: 'personal', owner_scope_id: 'owner-1',
    wiki_id: 'wiki-1', wiki_version_id: 'wiki-version-1', generation: 2, revision: 3,
    snapshot_id: 'snapshot-1', graph_version_id: 'graph-1', commit_sha: 'abc123def456',
    coverage: 'partial', content_hash: 'b'.repeat(64), stale: true,
    pages: [{ page_id: 'page-1', page_key: 'overview', title: 'Repository overview', position: 0,
      sections: [{ section_id: 'section-1', page_id: 'page-1', section_key: 'generated-overview',
        heading: 'Generated overview', markdown: 'Source-backed architecture.', authority: 'generated',
        coverage: 'partial', position: 0, stale: true, stale_reason: 'source_file_changed',
        locked: false, lock_version: 0, citations: [{ source_kind: 'file', source_token: 'src_1',
          source_snapshot_id: 'snapshot-1', commit_sha: 'abc123def456', stable_key: 'file:src/index.ts',
          path: 'src/index.ts', content_hash: 'c'.repeat(64) }] }],
    }],
  }
}

describe('MemoryCodeGraphPanel', () => {
  beforeEach(() => vi.clearAllMocks())

  test('does not request on every repository-id keystroke', async () => {
    memoryClient.getMemoryCodeGraph.mockResolvedValue(graphResult())
    const wrapper = mount(MemoryCodeGraphPanel, { props: { repositoryId: '' } })
    const input = wrapper.get('[data-testid="memory-codegraph-repository"]')
    ;(input.element as HTMLInputElement).value = repositoryId
    await input.trigger('input')
    expect(memoryClient.getMemoryCodeGraph).not.toHaveBeenCalled()
    await input.trigger('change')
    await wrapper.setProps({ repositoryId })
    await flushPromises()
    expect(memoryClient.getMemoryCodeGraph).toHaveBeenCalledTimes(1)
  })

  test('keeps the loading state visible until the bounded graph request settles', async () => {
    let resolveGraph!: (value: ReturnType<typeof graphResult>) => void
    memoryClient.getMemoryCodeGraph.mockReturnValue(new Promise(resolve => { resolveGraph = resolve }))
    const wrapper = mount(MemoryCodeGraphPanel, { props: { repositoryId } })
    await flushPromises()
    expect(wrapper.find('[data-testid="memory-codegraph-loading"]').exists()).toBe(true)
    resolveGraph(graphResult())
    await flushPromises()
    expect(wrapper.find('[data-testid="memory-codegraph-loading"]').exists()).toBe(false)
  })

  test('shows exact provenance, bounded nodes, relationships, and partial impact honestly', async () => {
    memoryClient.getMemoryCodeGraph.mockResolvedValue(graphResult())
    memoryClient.analyzeMemoryChangeImpact.mockResolvedValue({
      repository_id: repositoryId, snapshot_id: 'snapshot-1', commit_sha: 'abc123def456',
      graph_version_id: 'graph-1', paths: ['src/index.ts'], nodeKeys: ['file:src/index.ts'],
      edgeCount: 1, coverage: 'partial', reasons: ['node_limit'],
    })
    const wrapper = mount(MemoryCodeGraphPanel, { props: { repositoryId } })
    await flushPromises()
    expect(wrapper.get('[data-testid="memory-codegraph-provenance"]').text()).toContain('abc123def456')
    expect(wrapper.get('[data-testid="memory-codegraph-coverage"]').text()).toContain('partial')
    expect(wrapper.get('[data-testid="memory-codegraph-node-node-1"]').text()).toContain('src/index.ts')
    expect(wrapper.find('svg.memory-codegraph-force-layout').exists()).toBe(false)
    await wrapper.get('[data-testid="memory-codegraph-node-node-1"]').trigger('click')
    expect(wrapper.get('[data-testid="memory-codegraph-relations"]').text()).toContain('src/lib.ts')
    await wrapper.get('[data-testid="memory-impact-paths"]').setValue('src/index.ts')
    await wrapper.get('[data-testid="memory-impact-run"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="memory-impact-result"]').text()).toContain('partial')
    expect(wrapper.get('[data-testid="memory-impact-result"]').text()).toContain('node_limit')
  })

  test('distinguishes a successful empty graph from a retryable request error', async () => {
    memoryClient.getMemoryCodeGraph.mockResolvedValueOnce(graphResult([]))
      .mockRejectedValueOnce(new Error('graph unavailable'))
      .mockResolvedValueOnce(graphResult())
    const wrapper = mount(MemoryCodeGraphPanel, { props: { repositoryId } })
    await flushPromises()
    expect(wrapper.find('[data-testid="memory-codegraph-empty"]').exists()).toBe(true)
    await wrapper.get('[data-testid="memory-codegraph-retry"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="memory-codegraph-error"]').text()).toContain('graph unavailable')
    await wrapper.get('[data-testid="memory-codegraph-retry"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="memory-codegraph-error"]').exists()).toBe(false)
  })
})

describe('Memory Wiki workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    memoryClient.getMemoryWiki.mockResolvedValue(activeWiki())
    memoryClient.listMemoryWikiBuilds.mockResolvedValue({ builds: [], next_cursor: null })
  })

  test('renders stale active content and exact citations without turning status into empty', async () => {
    const wrapper = mount(MemoryWikiPanel, {
      props: { repositoryId, canContribute: false, canPublish: false },
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="memory-wiki-stale"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="memory-wiki-provenance"]').text()).toContain('abc123def456')
    expect(wrapper.get('[data-testid="memory-wiki-section-generated-overview"]').text())
      .toContain('Source-backed architecture.')
    const citation = wrapper.get('[data-testid="memory-wiki-citation-src_1"]')
    expect(citation.text()).toContain('src/index.ts')
    expect(citation.text()).toContain('abc123def456')
    expect(wrapper.find('[data-testid="memory-wiki-build"]').exists()).toBe(false)
  })

  test('keeps errors retryable and reveals a candidate only after an explicit choice', async () => {
    memoryClient.getMemoryWiki.mockRejectedValueOnce(new Error('wiki unavailable'))
      .mockResolvedValueOnce(activeWiki())
    memoryClient.listMemoryWikiBuilds.mockResolvedValueOnce({
      builds: [{ run_id: 'build-1', generation: '2', source_snapshot_id: 'snapshot-1',
        graph_version_id: 'graph-1', state: 'candidate', input_digest: 'd'.repeat(64) },
      { run_id: 'build-failed', generation: '1', source_snapshot_id: 'snapshot-1',
        graph_version_id: 'graph-1', state: 'failed', error_code: 'provider_timeout', input_digest: 'e'.repeat(64) }],
      next_cursor: null,
    })
    memoryClient.getMemoryWikiCandidate.mockResolvedValue({
      generation: '2', commit_sha: 'abc123def456', content_hash: 'e'.repeat(64),
      document: { schema_version: 'wiki-candidate.v1', pages: [{ page_key: 'overview',
        title: 'Repository overview', sections: [{ section_key: 'generated-overview',
          heading: 'Generated overview', markdown: 'Candidate architecture.',
          source_tokens: ['src_1'], coverage: 'complete' }] }] },
    })
    const wrapper = mount(MemoryWikiPanel, {
      props: { repositoryId, canContribute: true, canPublish: true },
    })
    await flushPromises()
    expect(wrapper.get('[data-testid="memory-wiki-error"]').text()).toContain('wiki unavailable')
    await wrapper.get('[data-testid="memory-wiki-retry"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="memory-wiki-open-candidate-build-1"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="memory-wiki-candidate"]').text()).toContain('Candidate architecture.')
    expect(wrapper.text()).toContain('provider_timeout')
    expect(memoryClient.publishMemoryWikiCandidate).not.toHaveBeenCalled()
  })

  test('candidate publication always requires a second explicit confirmation', async () => {
    const wrapper = mount(MemoryWikiCandidate, {
      props: {
        activeSections: activeWiki().pages[0]!.sections,
        candidate: { generation: '2', commit_sha: 'abc123def456', content_hash: 'e'.repeat(64),
          document: { schema_version: 'wiki-candidate.v1', pages: [{ page_key: 'overview', title: 'Overview',
            sections: [{ section_key: 'generated-overview', heading: 'Overview',
              markdown: 'Candidate architecture.', source_tokens: ['src_1'], coverage: 'complete' }] }] } },
        canPublish: true,
      },
    })
    await wrapper.get('[data-testid="memory-wiki-publish-request"]').trigger('click')
    expect(wrapper.emitted('publish')).toBeUndefined()
    expect(wrapper.find('[data-testid="memory-wiki-publish-confirmation"]').exists()).toBe(true)
    await wrapper.get('[data-testid="memory-wiki-publish-confirm"]').trigger('click')
    expect(wrapper.emitted('publish')).toHaveLength(1)
  })

  test('manual editor honors permissions and emits CAS edit/lock actions', async () => {
    const denied = mount(MemoryWikiEditor, {
      props: { sectionKey: 'operations', markdown: 'Runbook', lockVersion: 2, locked: false, canEdit: false },
    })
    expect(denied.find('textarea').attributes('disabled')).toBeDefined()
    expect(denied.find('[data-testid="memory-wiki-editor-save"]').exists()).toBe(false)

    const allowed = mount(MemoryWikiEditor, {
      props: { sectionKey: 'operations', markdown: 'Runbook', lockVersion: 2, locked: false, canEdit: true },
    })
    await allowed.get('textarea').setValue('Updated runbook')
    await allowed.get('[data-testid="memory-wiki-editor-save"]').trigger('click')
    await allowed.get('[data-testid="memory-wiki-editor-lock"]').trigger('click')
    expect(allowed.emitted('save')?.[0]).toEqual(['Updated runbook'])
    expect(allowed.emitted('lock')).toHaveLength(1)
  })
})
