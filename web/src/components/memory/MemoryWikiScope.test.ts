import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../composables/useLocale', () => ({
  useLocale: () => ({ t: (key: string) => key }),
}))

const memoryClient = vi.hoisted(() => ({
  getMemoryWiki: vi.fn(),
  listMemoryWikiBuilds: vi.fn(async () => ({ builds: [], next_cursor: null })),
  getMemoryWikiCandidate: vi.fn(),
  scheduleMemoryWikiBuild: vi.fn(),
  publishMemoryWikiCandidate: vi.fn(),
  editMemoryWikiSection: vi.fn(),
  setMemoryWikiSectionLock: vi.fn(),
}))

vi.mock('../../services/memoryClient', () => memoryClient)

const MemoryWikiPanel = (await import('./MemoryWikiPanel.vue')).default

const repositoryId = '22222222-2222-4222-8222-222222222222'
const personalId = '11111111-1111-4111-8111-111111111111'
const teamId = '33333333-3333-4333-8333-333333333333'
const scopes = [
  {
    installation_id: personalId, owner_scope_kind: 'personal' as const,
    owner_scope_id: personalId, authorization_epoch: '1', permissions: ['read', 'contribute', 'publish'],
    state: 'active',
  },
  {
    installation_id: teamId, owner_scope_kind: 'team' as const,
    owner_scope_id: '44444444-4444-4444-8444-444444444444', authorization_epoch: '2',
    permissions: ['read'], state: 'active',
  },
]

function activeWiki(installationId: string, version: string, commit: string) {
  return {
    repository_id: repositoryId,
    owner_scope_kind: installationId === teamId ? 'team' : 'personal',
    owner_scope_id: installationId,
    wiki_id: `${installationId.slice(0, 8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    wiki_version_id: version,
    generation: 1,
    revision: 1,
    snapshot_id: '55555555-5555-4555-8555-555555555555',
    graph_version_id: '66666666-6666-4666-8666-666666666666',
    commit_sha: commit,
    coverage: 'complete' as const,
    content_hash: 'a'.repeat(64),
    stale: false,
    pages: [],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('Memory Wiki scope isolation', () => {
  beforeEach(() => vi.clearAllMocks())

  test('emits an explicit scope selection and exposes no mutation controls for a read-only scope', async () => {
    memoryClient.getMemoryWiki.mockResolvedValue(activeWiki(personalId, 'version-personal', 'personal-commit'))
    const wrapper = mount(MemoryWikiPanel, {
      props: {
        repositoryId, installationId: personalId, scopes,
        canContribute: true, canPublish: true,
      },
    })
    await flushPromises()
    await wrapper.findAll('.memory-scope-chip')[1]!.trigger('click')
    expect(wrapper.emitted('update:installationId')?.[0]).toEqual([teamId])
    await wrapper.setProps({ installationId: teamId, canContribute: false, canPublish: false })
    await flushPromises()
    expect(wrapper.find('[data-testid="memory-wiki-build"]').exists()).toBe(false)
  })

  test('keys results by installation, repository, and version so an old scope cannot refill the panel', async () => {
    const personal = deferred<ReturnType<typeof activeWiki>>()
    const team = deferred<ReturnType<typeof activeWiki>>()
    memoryClient.getMemoryWiki
      .mockImplementationOnce(() => personal.promise)
      .mockImplementationOnce(() => team.promise)
    const wrapper = mount(MemoryWikiPanel, {
      props: {
        repositoryId, installationId: personalId, scopes,
        canContribute: true, canPublish: true,
      },
    })
    await wrapper.setProps({ installationId: teamId, canContribute: false, canPublish: false })
    team.resolve(activeWiki(teamId, '77777777-7777-4777-8777-777777777777', 'team-commit'))
    await flushPromises()
    expect(wrapper.get('[data-testid="memory-wiki-provenance"]').text()).toContain('team-commit')

    personal.resolve(activeWiki(personalId, '88888888-8888-4888-8888-888888888888', 'personal-commit'))
    await flushPromises()
    expect(wrapper.get('[data-testid="memory-wiki-provenance"]').text()).toContain('team-commit')
    expect(wrapper.text()).not.toContain('personal-commit')
    expect(memoryClient.getMemoryWiki).toHaveBeenNthCalledWith(2, repositoryId, expect.objectContaining({
      installationId: teamId,
      repositoryId,
      wikiVersionId: null,
    }))
    expect(memoryClient.listMemoryWikiBuilds).toHaveBeenCalledWith(
      expect.any(String), null, 20, expect.objectContaining({
        installationId: teamId,
        repositoryId,
        wikiVersionId: '77777777-7777-4777-8777-777777777777',
      }),
    )
  })

  test('clears content and shows a current-scope error when the selected scope disappears', async () => {
    memoryClient.getMemoryWiki.mockResolvedValue(activeWiki(personalId, 'version-personal', 'personal-commit'))
    const wrapper = mount(MemoryWikiPanel, {
      props: {
        repositoryId, installationId: personalId, scopes,
        canContribute: true, canPublish: true,
      },
    })
    await flushPromises()
    await wrapper.setProps({ scopes: scopes.slice(1) })
    await flushPromises()
    expect(wrapper.find('[data-testid="memory-wiki-provenance"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="memory-wiki-scope-error"]').exists()).toBe(true)
  })
})
