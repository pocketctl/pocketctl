import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, test, vi } from 'vitest'
import TeamSessionParticipants from './TeamSessionParticipants.vue'

const api = vi.hoisted(() => ({ getTeamSession: vi.fn(), setTeamSessionAgentBinding: vi.fn(), setTeamSessionParticipant: vi.fn() }))
vi.mock('../../services/teamClient', () => api)
const session: any = { id: 'css_1', creator_user_id: 7, state: 'active', revision: 2, participants: [], agent_bindings: [] }
const offers: any[] = [
  { id: 'mine', owner_user_id: 7, state: 'active', provider: 'codex', daemon_id: 'docker', managed_callable: true },
  { id: 'other', owner_user_id: 8, state: 'active', provider: 'claude-code', daemon_id: 'other-host', managed_callable: true },
]
beforeEach(() => { vi.clearAllMocks() })

test('only offers the current owner Agent and uses the refreshed session revision', async () => {
  const fresh = { ...session, revision: 5 }
  api.getTeamSession.mockResolvedValue(fresh)
  api.setTeamSessionAgentBinding.mockResolvedValue({ ...fresh, revision: 6 })
  const wrapper = mount(TeamSessionParticipants, { props: { session, members: [], currentUserId: 7, offers, writesEnabled: true } })
  expect(wrapper.text()).not.toContain('other-host')
  await wrapper.findAll('button').find(button => button.text() === '加入会话')!.trigger('click')
  await flushPromises()
  expect(api.setTeamSessionAgentBinding).toHaveBeenCalledWith(fresh, 'mine', true)
  expect(wrapper.emitted('updated')?.[0]?.[0]).toMatchObject({ revision: 6 })
  wrapper.unmount()
})

test('prevents new bindings after write access is revoked', async () => {
  const wrapper = mount(TeamSessionParticipants, { props: { session, members: [], currentUserId: 7, offers, writesEnabled: false } })
  const button = wrapper.findAll('button').find(button => button.text() === '加入会话')!
  expect(button.attributes()).toHaveProperty('disabled')
  await button.trigger('click')
  expect(api.getTeamSession).not.toHaveBeenCalled()
  wrapper.unmount()
})
