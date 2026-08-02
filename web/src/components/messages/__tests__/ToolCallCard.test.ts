import { describe, test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ToolCallCard from '../ToolCallCard.vue'

describe('ToolCallCard', () => {
  test('shows an unknown-result status without a running spinner', () => {
    const wrapper = mount(ToolCallCard, {
      props: {
        message: {
          tool: 'Wait',
          input: {},
          status: 'unknown',
          expanded: true,
        },
      },
    })
    expect(wrapper.find('.status-unknown').exists()).toBe(true)
    expect(wrapper.find('.tool-running.unknown').exists()).toBe(true)
    expect(wrapper.find('.spinner').exists()).toBe(false)
  })
})
