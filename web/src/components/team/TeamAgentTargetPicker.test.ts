import { mount } from '@vue/test-utils'
import { expect, test } from 'vitest'
import TeamAgentTargetPicker from './TeamAgentTargetPicker.vue'
import type { TeamSessionAgentBinding } from '../../types/team'

test('distinguishes same-provider recipients and preserves the selected offer', async () => {
  const bindings: TeamSessionAgentBinding[] = [1, 2].map(id => ({
    id: `binding-${id}`, offer_id: `offer-${id}`, owner_user_id: id,
    daemon_id: `daemon-${id}`, provider: 'claude-code', state: 'active', revision: 1,
    native_session_id: null, availability: 'online',
  }))
  const wrapper = mount(TeamAgentTargetPicker, { props: {
    modelValue: { mode: 'all', offerIDs: [] }, bindings,
    members: [1, 2].map(id => ({ id: `member-${id}`, team_id: 'team', user_id: id,
      display_label: `glm-${id}`, state: 'active' as const, revision: 1,
      joined_at: '2026-10-01T00:00:00Z', ended_at: null })),
  } })
  await wrapper.get('.target-trigger').trigger('click')
  const recipient = wrapper.get('[data-offer-id="offer-2"]')
  expect(recipient.text()).toContain('Claude Code · glm-2 · daemon-2')
  expect(wrapper.get('[data-offer-id="offer-1"]').text()).toContain('Claude Code · glm-1 · daemon-1')
  await recipient.trigger('click')
  expect(wrapper.emitted('update:modelValue')).toEqual([[{ mode: 'offers', offerIDs: ['offer-2'] }]])
  await wrapper.setProps({ modelValue: { mode: 'offers', offerIDs: ['offer-2'] } })
  expect(wrapper.get('.target-trigger').text()).toContain('Claude Code · glm-2 · daemon-2')
})

test('allows choosing human discussion with no available Agent', async () => {
  const wrapper = mount(TeamAgentTargetPicker, { props: { modelValue: { mode: 'all', offerIDs: [] }, bindings: [] } })
  await wrapper.get('.target-trigger').trigger('click')
  const buttons = wrapper.findAll('.target-menu button')
  expect(buttons[0].attributes('disabled')).toBeDefined()
  expect(buttons[1].attributes('disabled')).toBeUndefined()
  await buttons[1].trigger('click')
  expect(wrapper.emitted('update:modelValue')).toEqual([[{ mode: 'discussion', offerIDs: [] }]])
})
