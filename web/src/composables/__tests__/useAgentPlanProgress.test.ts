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

test('keeps native and OpenSpec sources independent, including empty todo snapshots', () => {
  resetAgentPlanProgressForTests()
  const state = useAgentPlanProgress()
  state.acceptAgentPlan({ type: 'agent_todo', session_id: 's', event_id: 't1', todos: [{ content: 'Native work', status: 'in_progress' }] })
  state.acceptAgentPlan({ type: 'agent_plan', session_id: 's', part_id: 'openspec:s:f', task_list_title: 'OpenSpec · feature', event_id: 'o1', revision: 1, plan: [{ step: 'Project work', status: 'pending' }] })
  expect(state.planForSession('s').value?.items.map(i => i.step).sort()).toEqual(['Native work', 'Project work'])
  state.acceptAgentPlan({ type: 'agent_todo', session_id: 's', event_id: 't2', previous_event_id: 't1' })
  expect(state.planForSession('s').value?.items.map(i => i.step)).toEqual(['Project work'])
  state.acceptAgentPlan({ type: 'agent_todo', session_id: 's', event_id: 't1', todos: [{ content: 'Native work', status: 'in_progress' }] })
  expect(state.planForSession('s').value?.items).toHaveLength(1)
})
