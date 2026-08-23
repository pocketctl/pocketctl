import { describe, expect, test } from 'vitest'
import { resetAgentPlanProgressForTests, useAgentPlanProgress } from '../useAgentPlanProgress'

describe('useAgentPlanProgress', () => {
  test('shares the latest plan per session across consumers', () => {
    resetAgentPlanProgressForTests()
    const producer = useAgentPlanProgress()
    const consumer = useAgentPlanProgress()

    producer.acceptAgentPlan({
      type: 'agent_plan', session_id: 'session-1', event_id: 'plan-1', revision: 1,
      plan: [{ step: 'Web panel', status: 'in_progress' }],
    })

    expect(consumer.planForSession('session-1').value?.items[0].step).toBe('Web panel')
    expect(consumer.planForSession('other').value).toBeUndefined()
  })
})
