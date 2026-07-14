import { describe, expect, test } from 'vitest'
import { mergeStructuredPart } from '../opencodeStructuredMerge'

describe('mergeStructuredPart', () => {
  test('deduplicates immutable Parts by type and Part ID', () => {
    const messages: any[] = []
    expect(mergeStructuredPart(messages, { type: 'agent_patch', part_id: 'prt_1', hash: 'h1', files: ['a.go'] })).toBe('inserted')
    expect(mergeStructuredPart(messages, { type: 'agent_patch', part_id: 'prt_1', hash: 'h2', files: ['b.go'] })).toBe('ignored')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ partKey: 'agent_patch:prt_1', hash: 'h1' })
  })

  test('replaces a session Todo snapshot including an empty clear', () => {
    const messages: any[] = []
    expect(mergeStructuredPart(messages, {
      type: 'agent_todo', session_id: 'ses_1', todos: [{ content: 'Build', status: 'in_progress', priority: 'high' }],
    })).toBe('inserted')
    expect(mergeStructuredPart(messages, { type: 'agent_todo', session_id: 'ses_1', todos: [] })).toBe('updated')
    expect(messages).toHaveLength(1)
    expect(messages[0].todos).toEqual([])
  })

  test('keeps Subtask and Agent Parts separate from PocketCtl subagent messages', () => {
    const messages: any[] = []
    mergeStructuredPart(messages, { type: 'agent_subtask', part_id: 'prt_sub', description: 'Inspect', agent: 'explore' })
    mergeStructuredPart(messages, { type: 'agent_profile', part_id: 'prt_agent', profile_name: 'build' })
    expect(messages.map(message => message.type)).toEqual(['agent_subtask', 'agent_profile'])
    expect(messages.some(message => message.type === 'subagent')).toBe(false)
  })
})
