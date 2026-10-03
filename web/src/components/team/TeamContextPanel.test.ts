import { useLocale } from '../../composables/useLocale'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useAuth } from '../../composables/useAuth'
import { resetMemoryClient } from '../../services/memoryClient'
import type { MemorySearchResult } from '../../types/memory'
import type { TeamContextReference, TeamContextSnapshot, TeamMemoryBinding, TeamSession } from '../../types/team'
import TeamContextPanel from './TeamContextPanel.vue'

const claim: TeamContextReference = {
  source_kind: 'memory_claim', source_id: 'claim-revoked-1', source_version: 'version-published-1',
  owner_scope_id: 'scope-team-1', installation_id: 'installation-team-1',
}
const event: TeamContextReference = {
  source_kind: 'team_event', source_id: 'event-discussion-1', source_version: '4',
  owner_scope_id: null, installation_id: null,
}
const snapshot: TeamContextSnapshot = {
  id: 'context-1', team_session_id: 'session-1', version: 1, revision: 1, goal: '评估发布条件',
  consensus: ['保留回滚路径'], open_questions: ['是否继续发布'], references: [claim, event],
  content_hash: 'context-hash-1', created_by_user_id: 7, created_at: '2026-09-28T00:00:00Z',
}
const session: TeamSession = {
  id: 'session-1', team_id: 'team-1', creator_user_id: 7, task_id: null, title: '发布评估', state: 'active',
  revision: 1, latest_event_seq: 4, current_context_version: 1, participants: [
    { id: 'participant-1', user_id: 7, state: 'active', revision: 1 },
    { id: 'participant-2', user_id: 8, state: 'active', revision: 1 },
  ], agent_bindings: [], created_at: '2026-09-28T00:00:00Z', updated_at: '2026-09-28T00:00:00Z',
}
const binding: TeamMemoryBinding = {
  id: 'binding-1', team_id: 'team-1', owner_scope_kind: 'team', owner_scope_id: 'scope-team-1',
  installation_id: 'installation-team-1', revision: 1, created_by_user_id: 7, access_state: 'available',
  permissions: ['read'], manageable: false, created_at: '2026-09-28T00:00:00Z', updated_at: '2026-09-28T00:00:00Z',
}
const searchResult: MemorySearchResult = {
  hits: [{
    claimId: 'claim-new-1', versionId: 'version-new-1', claimType: 'architecture_decision',
    statement: '部署前必须保留回滚路径', scopeKind: 'team', scopeKey: 'scope-team-1', freshnessAt: null,
    authority: 'published', repositoryId: null, branch: null, score: 1, sources: ['evidence-1'],
    installationId: 'installation-team-1', ownerScopeKind: 'team', ownerScopeId: 'scope-team-1',
  }], nextCursor: null, degradedComponents: [], poolSizes: { claims: 1 },
}

type ContextWrite = { expected_revision: number; goal: string; consensus: string[]; open_questions: string[]; references: TeamContextReference[] }
const wrappers: VueWrapper[] = []
let writes: ContextWrite[]
let requests: string[]
let bindingResponse: TeamMemoryBinding | null
let bindingStatus: number
let rejectRevokedClaim: boolean

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function render(context: TeamContextSnapshot | null = snapshot, props: Partial<{ session: TeamSession; currentUserId: number }> = {}): VueWrapper {
  const wrapper = mount(TeamContextPanel, { global: { stubs: { Teleport: true } }, props: { context, session, currentUserId: 7, ...props } })
  wrappers.push(wrapper)
  return wrapper
}

async function selectSearchResult(wrapper: VueWrapper): Promise<void> {
  await flushPromises()
  await wrapper.get('input[type="search"]').setValue('回滚')
  await vi.advanceTimersByTimeAsync(250)
  await flushPromises()
  await wrapper.get('.memory-option').trigger('click')
}

describe('TeamContextPanel selected references', () => {
  beforeEach(() => {
  useLocale().setLocale('zh')
    vi.useFakeTimers()
    resetMemoryClient()
    useAuth().accessToken.value = 'test-user-token'
    localStorage.setItem('pocketctl_relay_url', 'wss://relay.test/ws')
    writes = []; requests = []; bindingResponse = binding; bindingStatus = 200; rejectRevokedClaim = false
    // Keep the real component and both clients; only replace external HTTP responses.
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push(url)
      if (url === 'https://relay.test/api/team/teams/team-1/memory-binding') {
        return bindingStatus === 200 ? json({ binding: bindingResponse }) : json({ error: { code: 'team_feature_disabled' } }, bindingStatus)
      }
      if (url === 'https://relay.test/api/extensions/v2/grants') {
        return json({ grant: 'test-memory-grant', expires_in: 300, provider_public_origin: 'https://memory.test' })
      }
      if (url === 'https://memory.test/api/v1/memory/search') return json(searchResult)
      if (url === 'https://relay.test/api/team/sessions/session-1/context' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as ContextWrite
        writes.push(body)
        if (rejectRevokedClaim && body.references.some(reference => reference.source_id === 'claim-revoked-1')) {
          return json({ error: { code: 'invalid_state', message: 'Memory reference source is missing or no longer published' } }, 409)
        }
        return json({ context: { ...snapshot, version: 2, revision: 2, ...body } }, 201)
      }
      throw new Error(`Unexpected request: ${url}`)
    })
  })

  afterEach(() => {
    wrappers.splice(0).forEach(wrapper => wrapper.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
    resetMemoryClient()
    useAuth().accessToken.value = ''
    localStorage.removeItem('pocketctl_relay_url')
  })

  test('previews a newly chosen Claim and its exact version before publishing', async () => {
    const wrapper = render(null)
    await selectSearchResult(wrapper)

    const preview = wrapper.find('[data-testid="selected-context-references"]')
    expect(preview.exists()).toBe(true)
    expect(preview.text()).toContain('部署前必须保留回滚路径')
    expect(preview.text()).toContain('claim-new-1')
    expect(preview.text()).toContain('version-new-1')
    expect(writes).toEqual([])

    await wrapper.get('textarea').setValue('确认发布条件')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(writes[0]?.references).toEqual([{
      source_kind: 'memory_claim', source_id: 'claim-new-1', source_version: 'version-new-1',
      owner_scope_id: 'scope-team-1', installation_id: 'installation-team-1',
    }])
    expect(wrapper.emitted('saved')).toHaveLength(1)
  })

  test('removes one selected historical reference from the submitted version while retaining the others', async () => {
    const wrapper = render()
    await flushPromises()

    const selected = wrapper.findAll('[data-testid="selected-context-reference"]')
    expect(selected).toHaveLength(2)
    expect(selected[0].text()).toContain('claim-revoked-1')
    await selected[0].get('button').trigger('click')
    expect(wrapper.findAll('[data-testid="selected-context-reference"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="selected-context-reference"]').text()).toContain('event-discussion-1')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(writes[0]?.references).toEqual([event])
    expect(writes[0]?.expected_revision).toBe(1)
    expect(snapshot.references).toEqual([claim, event])
  })

  test('recovers from a revoked Claim save error by removing it and publishing an empty references array', async () => {
    rejectRevokedClaim = true
    const wrapper = render({ ...snapshot, references: [claim] })
    await flushPromises()
    await wrapper.get('textarea').setValue('更新发布目标')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toContain('Memory reference source is missing')
    expect(wrapper.emitted('saved')).toBeUndefined()

    const selected = wrapper.find('[data-testid="selected-context-reference"]')
    expect(selected.exists()).toBe(true)
    await selected.get('button').trigger('click')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(writes).toHaveLength(2)
    expect(writes[1]).toMatchObject({ expected_revision: 1, goal: '更新发布目标', references: [] })
    expect(wrapper.emitted('saved')?.[0]?.[0]).toMatchObject({ version: 2, references: [] })
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
  })

  test.each(['forbidden', 'unbound', 'binding-error'] as const)('allows clearing historical references when Memory is %s', async unavailable => {
    if (unavailable === 'forbidden') bindingResponse = { ...binding, access_state: 'forbidden', permissions: [] }
    if (unavailable === 'unbound') bindingResponse = null
    if (unavailable === 'binding-error') bindingStatus = 503
    rejectRevokedClaim = true
    const wrapper = render({ ...snapshot, references: [claim] })
    await flushPromises()
    expect(wrapper.find('input[type="search"]').exists()).toBe(false)

    const selected = wrapper.find('[data-testid="selected-context-reference"]')
    expect(selected.exists()).toBe(true)
    await selected.get('button').trigger('click')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(writes[0]?.references).toEqual([])
    expect(wrapper.emitted('saved')).toHaveLength(1)
  })

  test.each([
    { currentUserId: 8 },
    { session: { ...session, state: 'ended' as const } },
  ])('keeps historical references read-only when editing is not permitted: %o', async props => {
    const wrapper = render(snapshot, props)
    await flushPromises()
    expect(wrapper.get('.context-body').text()).toContain('团队 Claim')
    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.find('[data-testid="selected-context-reference"]').exists()).toBe(false)
    expect(writes).toEqual([])
    expect(requests).toEqual([])
  })
})
