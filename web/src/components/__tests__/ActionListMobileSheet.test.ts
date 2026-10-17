import { enableAutoUnmount, mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, test } from 'vitest'
import ActionList from '../ActionList.vue'

enableAutoUnmount(afterEach)
describe('mobile action sheet dismissal', () => {
  test('remeasures overflowing body content rather than feeding back a clamped panel height', async () => {
    // A nested form can leave its opener connected but hidden with a zero rect.
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    const wrapper = mount(ActionList, { props: { title: 'Configuration', width: 560, anchor }, slots: { default: '<div>Configuration fields</div>', footer: '<button>Save</button>' }, attachTo: document.body })
    await flushPromises()
    const panel = document.querySelector('.workspace-action-list') as HTMLElement
    const body = panel.querySelector('.action-list-content')!
    Object.defineProperty(panel, 'scrollHeight', { configurable: true, get: () => 62 })
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 420 })
    for (const tag of ['header', 'footer']) Object.defineProperty(panel.querySelector(tag)!, 'offsetHeight', { configurable: true, get: () => 44 })
    for (let n = 0; n < 4; n++) await wrapper.setProps({ title: `Configuration ${n}` })
    window.dispatchEvent(new Event('resize'))
    await flushPromises()
    expect(panel.style.maxHeight).toBe('510px')
    expect(panel.style.left).toBe(`${(window.innerWidth - 560) / 2}px`)
    anchor.remove()
  })
  test('short drag snaps back while a long downward drag closes', async () => {
    const wrapper = mount(ActionList, { props: { title: 'Choose host', mobileSheet: true }, global: { stubs: { Teleport: true } } })
    const grip = wrapper.get('.action-sheet-grip')
    await grip.trigger('pointerdown', { button: 0, clientY: 100 })
    await grip.trigger('pointermove', { clientY: 120 })
    await grip.trigger('pointerup')
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(wrapper.get('section').attributes('style')).not.toContain('translateY')
    await grip.trigger('pointerdown', { button: 0, clientY: 100 })
    await grip.trigger('pointermove', { clientY: 230 })
    await grip.trigger('pointerup')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
  test('cancelling a drag keeps the action list open and clears its translation', async () => {
    const wrapper = mount(ActionList, { props: { title: 'Actions', mobileSheet: true }, global: { stubs: { Teleport: true } } })
    const grip = wrapper.get('.action-sheet-grip')
    await grip.trigger('pointerdown', { button: 0, clientY: 100 })
    await grip.trigger('pointermove', { clientY: 240 })
    await grip.trigger('pointercancel')
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(wrapper.get('section').attributes('style')).not.toContain('translateY')
  })
})
