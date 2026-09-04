import { describe, expect, test, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ToolCallGroup from '../ToolCallGroup.vue'

function completed(tool: string, callId: string, inputDesc: string, output = 'ok') {
  return {
    id: callId,
    type: 'tool_call',
    call_id: callId,
    tool,
    input: { path: inputDesc },
    inputDesc,
    output,
    status: 'completed',
  }
}

describe('ToolCallGroup', () => {
  test('collapses completed calls into one summary and reveals compact rows on demand', async () => {
    const messages = [
      completed('Read', 'read-1', 'src/App.vue', 'file contents'),
      completed('Grep', 'grep-1', 'tool-card', '4 matches'),
    ]
    const wrapper = mount(ToolCallGroup, { props: { messages } })

    expect(wrapper.get('.tool-group-trigger').attributes('aria-expanded')).toBe('false')
    expect(wrapper.get('.tool-group-title').text()).toContain('2')
    expect(wrapper.find('.tool-group-body').exists()).toBe(false)

    await wrapper.get('.tool-group-trigger').trigger('click')

    expect(wrapper.get('.tool-group-trigger').attributes('aria-expanded')).toBe('true')
    expect(wrapper.findAll('[data-tool-detail-toggle]')).toHaveLength(2)
  })

  test('shows one tool detail at a time and switches between input and output', async () => {
    const wrapper = mount(ToolCallGroup, {
      props: {
        messages: [
          completed('Read', 'read-1', 'src/App.vue', 'first output'),
          completed('Bash', 'bash-1', 'npm test', 'second output'),
        ],
      },
    })
    await wrapper.get('.tool-group-trigger').trigger('click')
    const rows = wrapper.findAll('[data-tool-detail-toggle]')

    await rows[0].trigger('click')
    expect(rows[0].attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('[data-tool-detail="read-1"]').isVisible()).toBe(true)

    await wrapper.get('[data-tool-detail="read-1"] [data-detail-tab="output"]').trigger('click')
    expect(wrapper.get('[data-tool-detail="read-1"] [data-detail-panel="output"]').text()).toContain('first output')
    expect(wrapper.get('[data-tool-detail="read-1"] [data-detail-panel="input"]').attributes()).toHaveProperty('hidden')

    await rows[1].trigger('click')
    expect(rows[0].attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('[data-tool-detail="read-1"]').exists()).toBe(false)
    expect(rows[1].attributes('aria-expanded')).toBe('true')
  })

  test('keeps a running group expanded and exposes its live status', () => {
    const running = { ...completed('Bash', 'bash-1', 'npm test', ''), status: 'running' }
    const wrapper = mount(ToolCallGroup, { props: { messages: [running] } })

    expect(wrapper.get('.tool-group-trigger').attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('.tool-group-status').classes()).toContain('running')
    expect(wrapper.find('.tool-group-spinner').exists()).toBe(true)
  })

  test('automatically collapses a running group after every call completes', async () => {
    const running = { ...completed('Bash', 'bash-1', 'npm test', ''), status: 'running' }
    const wrapper = mount(ToolCallGroup, { props: { messages: [running] } })
    expect(wrapper.get('.tool-group-trigger').attributes('aria-expanded')).toBe('true')

    await wrapper.setProps({ messages: [{ ...running, output: 'tests passed', status: 'completed' }] })

    expect(wrapper.get('.tool-group-trigger').attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('.tool-group-body').exists()).toBe(false)
  })

  test('expands long output and copies the complete value', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const output = Array.from({ length: 30 }, (_, index) => 'line ' + (index + 1)).join('\n')
    const wrapper = mount(ToolCallGroup, {
      props: { messages: [completed('Read', 'read-1', 'src/App.vue', output)] },
    })
    await wrapper.get('.tool-group-trigger').trigger('click')
    await wrapper.get('[data-tool-detail-toggle]').trigger('click')
    await wrapper.get('[data-detail-tab="output"]').trigger('click')

    const outputBlock = wrapper.get('.tool-detail-output')
    expect(outputBlock.classes()).toContain('collapsed')
    await wrapper.get('[data-output-expand]').trigger('click')
    expect(outputBlock.classes()).not.toContain('collapsed')

    await wrapper.get('[data-detail-copy]').trigger('click')
    expect(writeText).toHaveBeenCalledWith(output)
    expect(wrapper.get('[data-detail-copy]').text()).toMatch(/^(已复制|Copied)$/)
  })

  test('closes the open tool detail with Escape', async () => {
    const wrapper = mount(ToolCallGroup, {
      props: { messages: [completed('Read', 'read-1', 'src/App.vue', 'file contents')] },
    })
    await wrapper.get('.tool-group-trigger').trigger('click')
    await wrapper.get('[data-tool-detail-toggle]').trigger('click')
    expect(wrapper.find('[data-tool-detail="read-1"]').exists()).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-tool-detail="read-1"]').exists()).toBe(false)
  })

  test('returns focus to the tool row when the detail close button is used', async () => {
    const wrapper = mount(ToolCallGroup, {
      attachTo: document.body,
      props: { messages: [completed('Read', 'read-1', 'src/App.vue', 'file contents')] },
    })
    await wrapper.get('.tool-group-trigger').trigger('click')
    const row = wrapper.get('[data-tool-detail-toggle]')
    await row.trigger('click')

    await wrapper.get('.tool-detail-close').trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-tool-detail="read-1"]').exists()).toBe(false)
    expect(document.activeElement).toBe(row.element)
    wrapper.unmount()
  })

  test('copies the execution summary from the group footer', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const wrapper = mount(ToolCallGroup, {
      props: {
        messages: [
          completed('Read', 'read-1', 'src/App.vue', 'file contents'),
          completed('Bash', 'bash-1', 'npm test', 'tests passed'),
        ],
      },
    })
    await wrapper.get('.tool-group-trigger').trigger('click')
    await wrapper.get('[data-copy-summary]').trigger('click')

    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText.mock.calls[0][0]).toContain('src/App.vue')
    expect(writeText.mock.calls[0][0]).toContain('npm test')
  })
})
