import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import Tabs from './MemorySectionTabs.vue'

const items = [{ id: 'content', label: 'Content' }, { id: 'blocked', label: 'Blocked', disabled: true }, { id: 'evidence', label: 'Evidence', badge: 2 }]

describe('Memory section navigation', () => {
  test('selects only an enabled section and keeps one keyboard entry', async () => {
    const view = mount(Tabs, { props: { modelValue: 'content', items, label: 'Details' } })
    expect(view.get('[role=tablist]').attributes('aria-label')).toBe('Details')
    expect(view.findAll('[tabindex="0"]')).toHaveLength(1)
    await view.get('[data-section-id=blocked]').trigger('click')
    expect(view.emitted('update:modelValue')).toBeUndefined()
    await view.get('[data-section-id=evidence]').trigger('click')
    expect(view.emitted('update:modelValue')).toEqual([['evidence']])
  })
  test('keyboard navigation skips disabled tabs and focuses the selected target', async () => {
    const view = mount(Tabs, { props: { modelValue: 'content', items, label: 'Details' }, attachTo: document.body })
    await view.get('[data-section-id=content]').trigger('keydown', { key: 'ArrowRight' })
    expect(view.emitted('update:modelValue')).toEqual([['evidence']])
    expect(document.activeElement).toBe(view.get('[data-section-id=evidence]').element)
    view.unmount()
  })
  test('Home and End follow enabled visual order and disabled-only tabs emit nothing', async () => {
    const view = mount(Tabs, { props: { modelValue: 'evidence', items, label: 'Details' } })
    await view.get('[data-section-id=evidence]').trigger('keydown', { key: 'Home' })
    await view.get('[data-section-id=content]').trigger('keydown', { key: 'End' })
    expect(view.emitted('update:modelValue')).toEqual([['content'], ['evidence']])
    await view.setProps({ items: [{ id: 'blocked', label: 'Blocked', disabled: true }], modelValue: 'blocked' })
    await view.get('[role=tab]').trigger('keydown', { key: 'ArrowRight' })
    expect(view.emitted('update:modelValue')).toHaveLength(2)
  })
})
