import { describe, test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ToolCallCard from '../ToolCallCard.vue'

describe('ToolCallCard', () => {
  test('styles a Codex shell command without altering its text or interpreting markup', async () => {
    const args = "rg  -n '<em>重点</em>'  path/file.swift"
    const message = { tool: 'commandExecution', inputDesc: args, expanded: true }
    const wrapper = mount(ToolCallCard, { props: { message } })
    const header = wrapper.get('.tool-args')
    expect(header.element.textContent).toBe(args)
    expect(header.get('.command-name').text()).toBe('rg')
    expect(header.get('.command-string').text()).toBe("'<em>重点</em>'")
    expect(header.find('em').exists()).toBe(false)
    await wrapper.setProps({ message: { ...message, inputDesc: 'cat a | sort' } })
    expect(header.find('.command-name').exists()).toBe(false)
    expect(header.element.textContent).toBe('cat a | sort')
  })

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
