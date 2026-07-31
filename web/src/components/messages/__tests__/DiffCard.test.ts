import { describe, test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import DiffCard from '../DiffCard.vue'

// Helper: a completed tool_call message of the given tool with input.
function msg(tool: string, input: any) {
  return { tool, input, status: 'completed', expanded: true }
}

describe('DiffCard — header', () => {
  test('shows tool name + file path', () => {
    const wrapper = mount(DiffCard, {
      props: { message: msg('Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }) },
    })
    expect(wrapper.find('.tool-name').text()).toBe('Edit')
    expect(wrapper.find('.tool-args').text()).toContain('src/a.ts')
  })

  test('Write shows a "new file" badge when there are no deletions', () => {
    const wrapper = mount(DiffCard, {
      props: { message: msg('Write', { file_path: 'new.ts', content: 'a\nb' }) },
    })
    expect(wrapper.find('.diff-badge.new').exists()).toBe(true)
  })

  test('Edit does not show a "new file" badge', () => {
    const wrapper = mount(DiffCard, {
      props: { message: msg('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }) },
    })
    expect(wrapper.find('.diff-badge.new').exists()).toBe(false)
  })
})

describe('DiffCard — diff rows', () => {
  test('renders add/del/ctx rows with correct line classes', () => {
    const wrapper = mount(DiffCard, {
      props: {
        message: msg('Edit', { old_string: 'a\nb\nc', new_string: 'a\nB\nc' }),
      },
    })
    const addRows = wrapper.findAll('.diff-line.diff-add')
    const delRows = wrapper.findAll('.diff-line.diff-del')
    const ctxRows = wrapper.findAll('.diff-line.diff-ctx')
    expect(addRows).toHaveLength(1)
    expect(delRows).toHaveLength(1)
    expect(ctxRows).toHaveLength(2)
    // the added row carries the text 'B'
    expect(addRows[0].text()).toContain('B')
    expect(delRows[0].text()).toContain('b')
  })

  test('Write renders all-addition rows', () => {
    const wrapper = mount(DiffCard, {
      props: { message: msg('Write', { content: 'one\ntwo\nthree' }) },
    })
    expect(wrapper.findAll('.diff-line.diff-add')).toHaveLength(3)
    expect(wrapper.findAll('.diff-line.diff-del')).toHaveLength(0)
  })

  test('summary shows +N -M counts', () => {
    const wrapper = mount(DiffCard, {
      props: {
        message: msg('Edit', { old_string: 'p\nq', new_string: 'p\nQ\nR' }),
      },
    })
    const summary = wrapper.find('.diff-summary')
    // +2 (Q, R) -1 (q)
    expect(summary.find('.diff-add-count').text()).toBe('+2')
    expect(summary.find('.diff-del-count').text()).toBe('-1')
  })
})

describe('DiffCard — collapse behavior', () => {
  test('long diff is collapsed to 50 lines by default, with expand button', () => {
    const many = Array.from({ length: 60 }, (_, i) => `line${i}`).join('\n')
    const wrapper = mount(DiffCard, {
      props: { message: { ...msg('Write', { content: many }), outputExpanded: false } },
    })
    expect(wrapper.findAll('.diff-line')).toHaveLength(50)
    expect(wrapper.find('button.toggle-expand').exists()).toBe(true)
  })

  test('long diff expands fully when outputExpanded is true', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `line${i}`).join('\n')
    const wrapper = mount(DiffCard, {
      props: { message: { ...msg('Write', { content: many }), outputExpanded: true } },
    })
    expect(wrapper.findAll('.diff-line')).toHaveLength(60)
  })
})
