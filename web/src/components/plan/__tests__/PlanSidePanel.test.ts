import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import PlanSidePanel from '../PlanSidePanel.vue'

test('desktop plan panel exposes an accessible close control', async () => {
  const wrapper = mount(PlanSidePanel, {
    props: {
      plan: {
        sessionId: 's', partId: 'plan:s', eventId: 'p1', previousEventId: '', revision: 1, explanation: '',
        items: [{ step: 'Test panel', status: 'in_progress' }],
      },
      connected: true,
    },
  })

  await wrapper.get('.plan-panel-close').trigger('click')
  expect(wrapper.emitted('close')).toHaveLength(1)
  expect(wrapper.get('aside').attributes('aria-label')).toBeTruthy()
})
