import { useLocale } from '../../composables/useLocale'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, test, vi } from 'vitest'
import TeamSessionParticipants from './TeamSessionParticipants.vue'

const api = vi.hoisted(() => ({ getTeamSession: vi.fn(), setTeamSessionAgentBinding: vi.fn(), setTeamSessionParticipant: vi.fn(), getTeamAgentCapabilities: vi.fn() }))
vi.mock('../../services/teamClient', () => api)
const session: any = { id: 'css_1', creator_user_id: 7, state: 'active', revision: 2, participants: [], agent_bindings: [] }
const offers: any[] = [
  { id: 'mine', owner_user_id: 7, state: 'active', provider: 'codex', daemon_id: 'docker', managed_callable: true },
  { id: 'other', owner_user_id: 8, state: 'active', provider: 'claude-code', daemon_id: 'other-host', managed_callable: true },
]
beforeEach(() => {
  useLocale().setLocale('zh'); vi.clearAllMocks() })

test('only offers the current owner Agent and uses the refreshed session revision', async () => {
  const fresh = { ...session, revision: 5 }
  api.getTeamSession.mockResolvedValue(fresh)
  api.setTeamSessionAgentBinding.mockResolvedValue({ ...fresh, revision: 6 })
  const wrapper = mount(TeamSessionParticipants, { global: { stubs: { Teleport: true } }, props: { session, members: [], currentUserId: 7, offers, writesEnabled: true } })
  expect(wrapper.text()).not.toContain('other-host')
  await wrapper.findAll('button').find(button => button.text() === '加入会话')!.trigger('click')
  await flushPromises()
  expect(api.setTeamSessionAgentBinding).toHaveBeenCalledWith(fresh, 'mine', true)
  expect(wrapper.emitted('updated')?.[0]?.[0]).toMatchObject({ revision: 6 })
  wrapper.unmount()
})

test('prevents new bindings after write access is revoked', async () => {
  const wrapper = mount(TeamSessionParticipants, { global: { stubs: { Teleport: true } }, props: { session, members: [], currentUserId: 7, offers, writesEnabled: false } })
  const button = wrapper.findAll('button').find(button => button.text() === '加入会话')!
  expect(button.attributes()).toHaveProperty('disabled')
  await button.trigger('click')
  expect(api.getTeamSession).not.toHaveBeenCalled()
  wrapper.unmount()
})

test('opens configuration without the parent popover dismissing it on focus, then returns to participants', async () => {
  api.getTeamAgentCapabilities.mockResolvedValue({ default_source: 'test', default_config: { model: 'model', reasoning_effort: null, permission_profile: 'read_only' }, models: [{ id: 'model', reasoning_efforts: [] }], permission_profiles: ['read_only'], overridable_fields: [], revision: 'cap-1' })
  const wrapper = mount(TeamSessionParticipants, { attachTo: document.body, props: { session: { ...session, team_id: 'ctm_1', agent_bindings: [{ id: 'binding', offer_id: 'mine', owner_user_id: 7, provider: 'codex', daemon_id: 'docker' }] }, members: [], currentUserId: 7, agentConfigEnabled: true } })
  await flushPromises()
  const config = Array.from(document.querySelectorAll<HTMLButtonElement>('.agent-row button')).find(button => button.textContent === '配置详情')!
  config.click()
  await flushPromises()
  expect(document.querySelector('.agent-config')).not.toBeNull()
  expect(document.querySelectorAll('.workspace-action-list')).toHaveLength(1)
  expect(wrapper.emitted('close')).toBeUndefined()
  document.querySelector<HTMLButtonElement>('.workspace-action-list header button[aria-label="返回"]')!.click()
  await flushPromises()
  expect(document.querySelector('.participants-body')).not.toBeNull()
  expect(document.querySelector('.agent-config')).toBeNull()
  expect(wrapper.emitted('close')).toBeUndefined()
  wrapper.unmount()
})

test('keeps a large participant list in a searchable secondary view', async () => {
  const members = Array.from({ length: 9 }, (_, index) => ({ id: `m${index}`, user_id: index + 7, state: 'active', display_label: `Member ${index + 7}` }))
  const participants = members.map(member => ({ id: `p${member.user_id}`, user_id: member.user_id, state: 'active' }))
  const wrapper = mount(TeamSessionParticipants, { global: { stubs: { Teleport: true } }, props: { session: { ...session, participants }, members: members as any, currentUserId: 7, writesEnabled: true } })
  expect(wrapper.findAll('.person-row')).toHaveLength(5)
  await wrapper.get('button.action-item').trigger('click')
  expect(wrapper.findAll('.person-row')).toHaveLength(9)
  await wrapper.get('input[type="search"]').setValue('Member 14')
  expect(wrapper.findAll('.person-row')).toHaveLength(1)
  expect(wrapper.get('.person-row').text()).toContain('Member 14')
  wrapper.unmount()
})

test('adds selected members sequentially using each returned revision', async () => {
  const members = [8,9].map(user_id => ({id:`m${user_id}`,user_id,state:'active',display_label:`Member ${user_id}`}))
  const fresh = { ...session, revision: 8 }
  api.getTeamSession.mockResolvedValue(fresh)
  api.setTeamSessionParticipant.mockImplementation(async (current, userID) => ({ ...current, revision: current.revision + 1, participants: [...current.participants,{id:`p${userID}`,user_id:userID,state:'active'}] }))
  const wrapper = mount(TeamSessionParticipants, { global: { stubs: { Teleport: true } }, props: { session, members:members as any, currentUserId:7, writesEnabled:true } })
  await wrapper.get('.add-members').trigger('click')
  await wrapper.findAll('input[type="checkbox"]')[0]!.setValue(true)
  await flushPromises()
  await wrapper.findAll('input[type="checkbox"]')[1]!.setValue(true)
  await flushPromises()
  expect(wrapper.get('.member-selection').text()).toContain('2')
  await wrapper.get('.member-confirm').trigger('click')
  await flushPromises()
  expect(api.setTeamSessionParticipant.mock.calls.map(([current,userID,active])=>[current.revision,userID,active])).toEqual([[8,8,true],[9,9,true]])
  expect(wrapper.emitted('updated')?.map(([current]:any[])=>current.revision)).toEqual([9,10])
  wrapper.unmount()
})
