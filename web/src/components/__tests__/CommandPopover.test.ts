import { describe, test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CommandPopover from '../CommandPopover.vue'
import type { CommandItem } from '../../composables/useWebSocket'

const commands: CommandItem[] = [
  { name: 'clear', source: 'builtin', kind: 'command', description: '清空上下文' },
  { name: 'compact', source: 'builtin', kind: 'command', description: '压缩历史' },
  { name: 'pocket-release', source: 'project', kind: 'skill', description: '发布流程' },
  { name: 'codex:rescue', source: 'plugin', kind: 'skill', namespace: 'codex', description: '救援' },
  { name: 'my-skill', source: 'user', kind: 'skill', description: '我的' },
]

describe('CommandPopover', () => {
  test('renders each command with leading slash', () => {
    const wrapper = mount(CommandPopover, { props: { commands, activeIndex: 0 } })
    const items = wrapper.findAll('.cmd-item')
    expect(items.length).toBe(5)
    expect(wrapper.html()).toContain('/clear')
    expect(wrapper.html()).toContain('/pocket-release')
    expect(wrapper.html()).toContain('/codex:rescue')
  })

  test('marks the active item by index', () => {
    const wrapper = mount(CommandPopover, { props: { commands, activeIndex: 2 } })
    const items = wrapper.findAll('.cmd-item')
    expect(items[0].classes()).not.toContain('active')
    expect(items[2].classes()).toContain('active')
  })

  test('renders SVG icons by kind+source (Terminal/Sparkles/Folder/User/Package)', () => {
    const wrapper = mount(CommandPopover, { props: { commands, activeIndex: 0 } })
    const html = wrapper.html()
    // SVG icons present (no emoji)
    expect(html).not.toContain('🔧')
    expect(html).not.toContain('📘')
    expect(wrapper.findAll('.cmd-icon svg').length).toBe(5)
    // NOTE: command available-ness is runtime (claude PTY judges per-command:
    // /clear /loop /compact work, /help /model don't). No gray-out — let the user
    // try; isn't-available is surfaced via command_receipt (status unavailable).
  })

  test('emits select with the command on click', async () => {
    const wrapper = mount(CommandPopover, { props: { commands, activeIndex: 0 } })
    await wrapper.findAll('.cmd-item')[1].trigger('click')
    expect(wrapper.emitted('select')).toBeTruthy()
    expect((wrapper.emitted('select')![0] as any)[0]).toEqual(commands[1])
  })

  test('emits hover with index on mouseenter', async () => {
    const wrapper = mount(CommandPopover, { props: { commands, activeIndex: 0 } })
    await wrapper.findAll('.cmd-item')[3].trigger('mouseenter')
    expect(wrapper.emitted('hover')).toBeTruthy()
    expect(wrapper.emitted('hover')![0][0]).toBe(3)
  })

  test('renders no items when commands empty', () => {
    const wrapper = mount(CommandPopover, { props: { commands: [], activeIndex: 0 } })
    expect(wrapper.find('.cmd-item').exists()).toBe(false)
  })

  test('shows plugin namespace badge for plugin source', () => {
    const wrapper = mount(CommandPopover, { props: { commands, activeIndex: 0 } })
    expect(wrapper.html()).toContain('codex')
  })
})
