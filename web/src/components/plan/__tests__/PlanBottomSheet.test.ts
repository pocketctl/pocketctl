import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import PlanBottomSheet from '../PlanBottomSheet.vue'

const plan = {
  sessionId: 's', partId: 'plan:s', eventId: 'p1', previousEventId: '', revision: 1, explanation: '',
  items: [{ step: 'Mobile sheet', status: 'in_progress' as const }],
}

describe('PlanBottomSheet', () => {
  test('opens at the medium detent and can expand toward full screen', async () => {
    const wrapper = mount(PlanBottomSheet, { props: { plan, connected: true } })

    expect(wrapper.get('.plan-bottom-sheet').classes()).not.toContain('expanded')
    await wrapper.get('.plan-sheet-grabber').trigger('click')
    expect(wrapper.get('.plan-bottom-sheet').classes()).toContain('expanded')
  })

  test('an upward drag stays expanded when the pointer sequence emits a click', async () => {
    const wrapper = mount(PlanBottomSheet, { props: { plan, connected: true } })
    const grabber = wrapper.get('.plan-sheet-grabber')

    await grabber.trigger('pointerdown', { clientY: 600 })
    window.dispatchEvent(new PointerEvent('pointermove', { clientY: 500 }))
    await grabber.trigger('click')

    expect(wrapper.get('.plan-bottom-sheet').classes()).toContain('expanded')
  })

  test('closes from the backdrop and close button', async () => {
    const wrapper = mount(PlanBottomSheet, { props: { plan, connected: true } })
    await wrapper.get('.plan-sheet-backdrop').trigger('click')
    await wrapper.get('.plan-sheet-close').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(2)
  })
})
