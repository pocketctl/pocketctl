import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import PlanProgressContent from '../PlanProgressContent.vue'

const plan = {
  sessionId: 'session-1', partId: 'plan:session-1', eventId: 'plan-3', previousEventId: 'plan-2', revision: 3,
  explanation: 'Implementing the clients',
  items: [
    { step: 'Define protocol', status: 'completed' as const },
    { step: 'Build Web panel', status: 'in_progress' as const },
    { step: 'Build iOS sheet', status: 'pending' as const },
  ],
}

describe('PlanProgressContent', () => {
  test('renders ordered, non-color-only status and progress semantics', () => {
    const wrapper = mount(PlanProgressContent, { props: { plan, connected: true } })
    const steps = wrapper.findAll('[data-plan-status]')

    expect(steps.map(step => step.attributes('data-plan-status'))).toEqual(['completed', 'in_progress', 'pending'])
    expect(steps[0].classes()).toContain('completed')
    expect(steps[0].find('.plan-step-label').classes()).toContain('struck')
    expect(steps[1].classes()).toContain('in-progress')
    expect(steps.every(step => !!step.attributes('aria-label'))).toBe(true)
    expect(wrapper.get('[role="progressbar"]').attributes()).toMatchObject({
      'aria-valuemin': '0', 'aria-valuemax': '3', 'aria-valuenow': '1',
    })
  })

  test('keeps the last plan visible and labels it stale while disconnected', () => {
    const wrapper = mount(PlanProgressContent, { props: { plan, connected: false } })
    expect(wrapper.find('.plan-sync-state').exists()).toBe(true)
    expect(wrapper.findAll('[data-plan-status]')).toHaveLength(3)
  })
})
