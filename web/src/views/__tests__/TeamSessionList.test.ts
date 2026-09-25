import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const api = vi.hoisted(() => ({ listTeams: vi.fn(), listTeamAgentOffers: vi.fn(), listTeamSessions: vi.fn(), createTeamSession: vi.fn() }))
vi.mock('../../services/teamClient', () => api)

const session = {
  id: 'css_1', team_id: 'ctm_1', creator_user_id: 7, task_id: null, title: 'Joint review', state: 'active', revision: 1,
  latest_event_seq: 3, current_context_version: 1, created_at: '', updated_at: '2026-09-25T00:00:00Z',
  participants: [{ id: 'p1', user_id: 7, state: 'active', revision: 1 }],
  agent_bindings: [{ id: 'b1', offer_id: 'offer-1', owner_user_id: 7, daemon_id: 'd1', provider: 'codex', state: 'active', revision: 1, native_session_id: null, availability: 'online' }],
}

async function render() {
  const View = (await import('../TeamSessionListView.vue')).default
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/team/:teamId/sessions', name: 'team-sessions', component: View },
    { path: '/team/:teamId/session/:id', name: 'team-session', component: { template: '<div />' } },
    { path: '/sessions', component: { template: '<div />' } },
  ] })
  await router.push('/team/ctm_1/sessions'); await router.isReady()
  const wrapper = mount(View, { global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, router }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.listTeams.mockResolvedValue([{ id: 'ctm_1', name: 'Alpha' }, { id: 'ctm_2', name: 'Beta' }])
  api.listTeamAgentOffers.mockResolvedValue([{ id: 'offer-1', daemon_id: 'd1', provider: 'codex', managed_callable: true, availability: 'online' }])
  api.listTeamSessions.mockResolvedValue([session])
  api.createTeamSession.mockResolvedValue(session)
})

describe('team session list', () => {
  test('uses the same server request for combined daemon and provider filters', async () => {
    const { wrapper } = await render()
    await wrapper.get('select[aria-label="按主机筛选"]').setValue('d1')
    await wrapper.get('select[aria-label="按 Agent 筛选"]').setValue('codex')
    await flushPromises()
    expect(api.listTeamSessions).toHaveBeenCalledWith('ctm_1', { daemonID: 'd1', provider: 'codex' })
    expect(wrapper.text()).toContain('1 / 1 个会话')
  })

  test('creates with selected callable offers and opens the independent route', async () => {
    const { wrapper, router } = await render()
    await wrapper.get('.page-header button').trigger('click')
    await wrapper.get('[data-testid="team-session-title"]').setValue('Joint review')
    await wrapper.get('.offer-options input').setValue(true)
    await wrapper.get('.create-card').trigger('submit')
    await flushPromises()
    expect(api.createTeamSession).toHaveBeenCalledWith('ctm_1', { title: 'Joint review', offerIDs: ['offer-1'] })
    expect(router.currentRoute.value.name).toBe('team-session')
  })
})
