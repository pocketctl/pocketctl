import { mount } from '@vue/test-utils'
import { expect, test } from 'vitest'
import TeamAgentTargetPicker from './TeamAgentTargetPicker.vue'

test('allows choosing human discussion with no available Agent', async () => {
  const wrapper = mount(TeamAgentTargetPicker, { props: { modelValue: { mode: 'all', offerIDs: [] }, bindings: [] } })
  await wrapper.get('.target-trigger').trigger('click')
  const buttons = wrapper.findAll('.target-menu button')
  expect(buttons[0].attributes('disabled')).toBeDefined()
  expect(buttons[1].attributes('disabled')).toBeUndefined()
  await buttons[1].trigger('click')
  expect(wrapper.emitted('update:modelValue')).toEqual([[{ mode: 'discussion', offerIDs: [] }]])
})
