import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, describe, expect, test } from 'vitest'
import ActionList from '../ActionList.vue'

enableAutoUnmount(afterEach)
describe('mobile action sheet dismissal', () => {
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
