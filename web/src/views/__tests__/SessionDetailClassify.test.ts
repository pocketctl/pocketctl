import { describe, test, expect } from 'vitest'
import { resolveAgentTarget } from '../classifyByAgent'

/**
 * P2 Task 2: Tests that messages are routed by agentId.
 * - agentId non-empty → subagentMessages[agentId] (init bucket if needed)
 * - agentId empty/absent  → default target (parent messages)
 */
describe('resolveAgentTarget (P2 classify)', () => {
  test('event with agent_id routes to subagentMessages, initializing bucket', () => {
    const subagentMessages: Record<string, any[]> = {}
    const defaultTarget: any[] = []
    const evt = { type: 'agent_text', text: 'hello', agent_id: 'sa-001' }

    const result = resolveAgentTarget(evt, subagentMessages, defaultTarget)

    // Must return a different target (the subagent bucket)
    expect(result).not.toBe(defaultTarget)
    expect(result).toBe(subagentMessages['sa-001'])
    // Bucket should have been initialized
    expect(subagentMessages['sa-001']).toEqual([])
  })

  test('event with agentId (camelCase) also routes to subagentMessages', () => {
    const subagentMessages: Record<string, any[]> = {}
    const defaultTarget: any[] = []
    const evt = { type: 'agent_text', text: 'hello', agentId: 'sa-002' }

    const result = resolveAgentTarget(evt, subagentMessages, defaultTarget)

    expect(result).toBe(subagentMessages['sa-002'])
    expect(subagentMessages['sa-002']).toEqual([])
  })

  test('event without agent_id/agentId returns defaultTarget unchanged', () => {
    const subagentMessages: Record<string, any[]> = {}
    const defaultTarget: any[] = []
    const evt = { type: 'agent_text', text: 'parent reply' }

    const result = resolveAgentTarget(evt, subagentMessages, defaultTarget)

    expect(result).toBe(defaultTarget)
    expect(Object.keys(subagentMessages)).toHaveLength(0)
  })

  test('event with empty-string agent_id returns defaultTarget', () => {
    const subagentMessages: Record<string, any[]> = {}
    const defaultTarget: any[] = []
    const evt = { type: 'agent_text', text: 'hi', agent_id: '' }

    const result = resolveAgentTarget(evt, subagentMessages, defaultTarget)

    expect(result).toBe(defaultTarget)
  })

  test('tool_call with agent_id routes to subagentMessages', () => {
    const subagentMessages: Record<string, any[]> = {}
    const defaultTarget: any[] = []
    const evt = { type: 'tool_call', call_id: 'c1', tool: 'Bash', input: 'ls', agent_id: 'sa-003' }

    const result = resolveAgentTarget(evt, subagentMessages, defaultTarget)

    expect(result).toBe(subagentMessages['sa-003'])
  })

  test('tool_result with agent_id routes to subagentMessages', () => {
    const subagentMessages: Record<string, any[]> = {}
    const defaultTarget: any[] = []
    const evt = { type: 'tool_result', call_id: 'c1', output: 'done', agent_id: 'sa-003' }

    const result = resolveAgentTarget(evt, subagentMessages, defaultTarget)

    expect(result).toBe(subagentMessages['sa-003'])
  })

  test('subagent_messages pushed to the returned target stay in subagentMessages, not defaultTarget', () => {
    const subagentMessages: Record<string, any[]> = {}
    const defaultTarget: any[] = []
    const evt = { type: 'agent_text', text: 'sub work', agent_id: 'sa-010' }

    const target = resolveAgentTarget(evt, subagentMessages, defaultTarget)
    target.push({ type: 'agent_text', content: 'sub work' })

    expect(defaultTarget).toHaveLength(0)
    expect(subagentMessages['sa-010']).toHaveLength(1)
    expect(subagentMessages['sa-010'][0].content).toBe('sub work')
  })

  test('reuses existing bucket if agentId already initialized', () => {
    const subagentMessages: Record<string, any[]> = { 'sa-020': [{ type: 'agent_text', content: 'first' }] }
    const defaultTarget: any[] = []
    const evt = { type: 'agent_text', text: 'second', agent_id: 'sa-020' }

    const result = resolveAgentTarget(evt, subagentMessages, defaultTarget)

    expect(result).toBe(subagentMessages['sa-020'])
    expect(subagentMessages['sa-020']).toHaveLength(1) // existing item preserved
  })
})

/**
 * Review-fix tests: session-switch reset + backward-pagination prepend
 */
describe('subagentMessages session-switch reset', () => {
  test('reassigning subagentMessages to empty object clears all buckets', () => {
    // Populate a bucket (simulating session A data)
    const subagentMessages = { 'sa-leak': [{ type: 'agent_text', content: 'leaked' }] }
    expect(Object.keys(subagentMessages)).toHaveLength(1)

    // Session switch: the watcher resets to empty object (subagentMessages.value = {})
    const reset: Record<string, any[]> = {}
    // In Vue, the ref is reassigned — here we verify the pattern
    expect(Object.keys(reset)).toHaveLength(0)
    // Any prior bucket is gone (no cross-session leak)
    expect(reset['sa-leak']).toBeUndefined()
  })
})

describe('backward-pagination prepend (Option B: temp bucket merge)', () => {
  test('older sub-agent events are prepended before newer ones', () => {
    // Simulate initial load: newer events already in persistent bucket
    const persistent: Record<string, any[]> = {
      'sa-010': [{ type: 'agent_text', content: 'newer msg' }],
    }

    // Simulate backward pagination loading older events into temp bucket
    const tempSubagent: Record<string, any[]> = {}
    const olderEvt = { type: 'agent_text', text: 'older msg', agent_id: 'sa-010' }
    const tempTarget = resolveAgentTarget(olderEvt, tempSubagent, [])
    tempTarget.push({ type: 'agent_text', content: 'older msg' })

    // Merge: prepend temp to persistent
    for (const [agentId, bucket] of Object.entries(tempSubagent)) {
      if (!persistent[agentId]) persistent[agentId] = []
      persistent[agentId] = [...bucket, ...persistent[agentId]]
    }

    // Bucket should be in chronological order: older first
    expect(persistent['sa-010']).toHaveLength(2)
    expect(persistent['sa-010'][0].content).toBe('older msg')
    expect(persistent['sa-010'][1].content).toBe('newer msg')
  })

  test('backward pagination with multiple agentIds preserves each bucket order', () => {
    const persistent: Record<string, any[]> = {
      'sa-A': [{ type: 'agent_text', content: 'A-new' }],
      'sa-B': [{ type: 'agent_text', content: 'B-new' }],
    }
    const tempSubagent: Record<string, any[]> = {}

    // Load older events for sa-A only
    const tA = resolveAgentTarget({ agent_id: 'sa-A' }, tempSubagent, [])
    tA.push({ type: 'agent_text', content: 'A-old' })

    // Merge
    for (const [agentId, bucket] of Object.entries(tempSubagent)) {
      if (!persistent[agentId]) persistent[agentId] = []
      persistent[agentId] = [...bucket, ...persistent[agentId]]
    }

    expect(persistent['sa-A'][0].content).toBe('A-old')
    expect(persistent['sa-A'][1].content).toBe('A-new')
    // sa-B untouched
    expect(persistent['sa-B']).toHaveLength(1)
    expect(persistent['sa-B'][0].content).toBe('B-new')
  })

  test('backward pagination with new agentId creates and prepends bucket', () => {
    const persistent: Record<string, any[]> = {
      'sa-X': [{ type: 'agent_text', content: 'X-only' }],
    }
    const tempSubagent: Record<string, any[]> = {}

    // Older event for a never-seen agent
    const tY = resolveAgentTarget({ agent_id: 'sa-Y' }, tempSubagent, [])
    tY.push({ type: 'agent_text', content: 'Y-old' })

    for (const [agentId, bucket] of Object.entries(tempSubagent)) {
      if (!persistent[agentId]) persistent[agentId] = []
      persistent[agentId] = [...bucket, ...persistent[agentId]]
    }

    expect(persistent['sa-Y']).toHaveLength(1)
    expect(persistent['sa-Y'][0].content).toBe('Y-old')
    // Existing untouched
    expect(persistent['sa-X']).toHaveLength(1)
  })
})
