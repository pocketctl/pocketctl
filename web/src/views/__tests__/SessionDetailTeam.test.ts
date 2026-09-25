import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { computed, ref } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const sendMessage = vi.hoisted(() => vi.fn())
const teamSession = {
  id: 'css_1', team_id: 'ctm_1', creator_user_id: 7, task_id: null, title: 'Review', state: 'active', revision: 2,
  latest_event_seq: 2, current_context_version: 1, created_at: '', updated_at: '',
  participants: [{ id: 'p1', user_id: 7, state: 'active', revision: 1 }],
  agent_bindings: [
    { id: 'b1', offer_id: 'offer-1', owner_user_id: 7, daemon_id: 'd1', provider: 'codex', state: 'active', revision: 1, native_session_id: 'native-1', availability: 'online' },
    { id: 'b2', offer_id: 'offer-2', owner_user_id: 8, daemon_id: 'd2', provider: 'claude-code', state: 'active', revision: 1, native_session_id: 'native-2', availability: 'online' },
  ],
} as const
const events = [
  { id: 'e1', team_session_id: 'css_1', event_seq: 1, kind: 'member_message', author_user_id: 7, author_offer_id: null, target_mode: 'all', target_offer_ids: ['offer-1'], reference: null, context_version: 1, call_id: null, content: 'Please review', created_at: '2026-09-25T00:00:00Z' },
  { id: 'e2', team_session_id: 'css_1', event_seq: 2, kind: 'agent_message', author_user_id: null, author_offer_id: 'offer-1', target_mode: null, target_offer_ids: [], reference: null, context_version: 1, call_id: 'call-1', content: 'Reviewed', created_at: '2026-09-25T00:01:00Z' },
] as const

vi.mock('../../composables/useAuth', () => ({ useAuth: () => ({ user: ref({ id: 7 }) }) }))
vi.mock('../../composables/useTeamSession', () => ({ useTeamSession: () => {
  const session = ref<any>({ ...teamSession, agent_bindings: teamSession.agent_bindings.map(item => ({ ...item })) })
  return {
    session, events: ref(events.map(event => ({ ...event }))), context: ref(null), draft: ref(''), loading: ref(false), sending: ref(false), error: ref(''),
    readOnlyReason: computed(() => ''), canSend: computed(() => true), sendMessage,
  }
} }))
const api = vi.hoisted(() => ({ listTeams: vi.fn(), listTeamMembers: vi.fn(), listTeamAgentOffers: vi.fn(), listTeamSessions: vi.fn(), updateTeamSession: vi.fn() }))
vi.mock('../../services/teamClient', () => api)

async function render() {
  const View = (await import('../TeamSessionDetail.vue')).default
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/team/:teamId/session/:id', name: 'team-session', component: View },
    { path: '/team/:teamId/sessions', name: 'team-sessions', component: { template: '<div />' } },
    { path: '/sessions', component: { template: '<div />' } },
    { path: '/session/:id', component: { template: '<div />' } },
  ] })
  await router.push('/team/ctm_1/session/css_1'); await router.isReady()
  const wrapper = mount(View, { global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, router }
}

beforeEach(() => {
  vi.clearAllMocks(); sendMessage.mockResolvedValue(true)
  api.listTeams.mockResolvedValue([{ id: 'ctm_1', name: 'Alpha' }])
  api.listTeamMembers.mockResolvedValue([{ id: 'm1', team_id: 'ctm_1', user_id: 7, display_label: 'Me', state: 'active', revision: 1, joined_at: '', ended_at: null }])
  api.listTeamAgentOffers.mockResolvedValue(teamSession.agent_bindings.map(binding => ({ id: binding.offer_id, provider: binding.provider, daemon_id: binding.daemon_id, managed_callable: true })))
  api.listTeamSessions.mockResolvedValue([teamSession])
})

describe('team session detail', () => {
  test('sends a targeted reply through the shared-session event path', async () => {
    const { wrapper } = await render()
    await wrapper.get('[data-offer-id="offer-1"]').trigger('click')
    await wrapper.findAll('.event-actions button')[0].trigger('click')
    await wrapper.get('[data-testid="team-session-composer"]').setValue('Follow up')
    await wrapper.get('[data-testid="team-session-send"]').trigger('click')
    expect(sendMessage).toHaveBeenCalledWith({ targetMode: 'offers', targetOfferIDs: ['offer-1'], referenceEventID: 'e1' })
  })

  test('only exposes native sessions owned by the current user', async () => {
    const { wrapper } = await render()
    await wrapper.findAll('.header-actions button').find(button => button.text() === '成员')!.trigger('click')
    const links = wrapper.findAll('[data-testid="team-session-participants"] a')
    expect(links).toHaveLength(1)
    expect(links[0].attributes('href')).toContain('/session/native-1')
    expect(wrapper.text()).not.toContain('native-2')
  })
})
