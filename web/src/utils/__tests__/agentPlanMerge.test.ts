import { describe, expect, test } from 'vitest'
import { mergeAgentPlan, normalizeAgentPlanEvent } from '../agentPlanMerge'

const first = {
  type: 'agent_plan', session_id: 'session-1', part_id: 'plan:session-1',
  event_id: 'plan-1', revision: 1,
  explanation: 'Start here',
  plan: [
    { step: 'Inspect', status: 'in_progress' },
    { step: 'Implement', status: 'pending' },
  ],
}

describe('agent plan snapshots', () => {
  test('normalizes a full valid snapshot without changing step order', () => {
    expect(normalizeAgentPlanEvent(first)).toEqual({
      sessionId: 'session-1', partId: 'plan:session-1', eventId: 'plan-1',
      previousEventId: '', revision: 1, explanation: 'Start here',
      items: [
        { step: 'Inspect', status: 'in_progress' },
        { step: 'Implement', status: 'pending' },
      ],
    })
  })

  test('accepts a causal successor and replaces the whole snapshot', () => {
    const current = mergeAgentPlan(undefined, first)
    const next = mergeAgentPlan(current, {
      ...first, event_id: 'plan-2', previous_event_id: 'plan-1', revision: 2,
      explanation: '',
      plan: [{ step: 'Implement', status: 'completed' }],
    })

    expect(next).not.toBe(current)
    expect(next?.eventId).toBe('plan-2')
    expect(next?.items).toEqual([{ step: 'Implement', status: 'completed' }])
  })

  test('does not regress for duplicate replay or a delayed predecessor', () => {
    const current = mergeAgentPlan(undefined, {
      ...first, event_id: 'plan-2', previous_event_id: 'plan-1', revision: 2,
    })

    expect(mergeAgentPlan(current, current)).toBe(current)
    expect(mergeAgentPlan(current, first)).toBe(current)
  })

  test('uses revision to converge when an intermediate causal event is missing', () => {
    const current = mergeAgentPlan(undefined, first)
    const recovered = mergeAgentPlan(current, {
      ...first, event_id: 'plan-4', previous_event_id: 'plan-3', revision: 4,
      plan: [{ step: 'Recovered', status: 'in_progress' }],
    })

    expect(recovered?.revision).toBe(4)
    expect(recovered?.items[0].step).toBe('Recovered')
  })

  test.each([
    { ...first, plan: [] },
    { ...first, session_id: '' },
    { ...first, event_id: '' },
    { ...first, plan: [{ step: 'Unknown', status: 'blocked' }] },
    { ...first, plan: [{ step: '   ', status: 'pending' }] },
  ])('rejects invalid or empty snapshots', (event) => {
    expect(normalizeAgentPlanEvent(event)).toBeNull()
  })
})
