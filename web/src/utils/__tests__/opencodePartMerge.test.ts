import { describe, expect, test } from 'vitest'
import { mergeRevisionedPart } from '../opencodePartMerge'

describe('mergeRevisionedPart', () => {
  test('inserts a Part then appends a newer delta', () => {
    const messages: any[] = []
    expect(mergeRevisionedPart(messages, {
      type: 'agent_text', text: 'Hel', part_id: 'prt_1', message_id: 'msg_1', revision: 1, streaming: true,
    })).toBe('inserted')
    expect(mergeRevisionedPart(messages, {
      type: 'agent_text', text: 'lo', part_id: 'prt_1', message_id: 'msg_1', revision: 2, streaming: true,
    })).toBe('updated')
    expect(messages[0]).toMatchObject({ content: 'Hello', partId: 'prt_1', messageId: 'msg_1', revision: 2, streaming: true })
  })

  test('replaces revised content and closes on the final snapshot', () => {
    const messages: any[] = [{ id: 'part:prt_1', type: 'agent_text', content: 'Hello', partId: 'prt_1', revision: 2, streaming: true }]
    expect(mergeRevisionedPart(messages, {
      type: 'agent_text', text: 'Hallo', part_id: 'prt_1', revision: 3, replace: true, streaming: true,
    })).toBe('updated')
    expect(mergeRevisionedPart(messages, {
      type: 'agent_text', text: 'Hallo!', part_id: 'prt_1', revision: 4, replace: true, streaming: false,
    })).toBe('updated')
    expect(messages[0]).toMatchObject({ content: 'Hallo!', revision: 4, streaming: false })
  })

  test('ignores stale or duplicate revisions', () => {
    const messages: any[] = [{ id: 'part:prt_1', type: 'agent_text', content: 'current', partId: 'prt_1', revision: 3, streaming: true }]
    expect(mergeRevisionedPart(messages, {
      type: 'agent_text', text: 'old', part_id: 'prt_1', revision: 2, replace: true, streaming: false,
    })).toBe('ignored')
    expect(messages[0].content).toBe('current')
  })

  test('finds the target Part when a tool card follows it', () => {
    const messages: any[] = [
      { id: 'part:prt_1', type: 'agent_reasoning', content: 'think', partId: 'prt_1', revision: 1, streaming: true },
      { id: 'tool', type: 'tool_call', call_id: 'call_1' },
    ]
    expect(mergeRevisionedPart(messages, {
      type: 'agent_reasoning', text: 'ing', part_id: 'prt_1', revision: 2, streaming: true,
    })).toBe('updated')
    expect(messages[0].content).toBe('thinking')
    expect(messages).toHaveLength(2)
  })

  test('returns legacy when the daemon did not provide a Part ID', () => {
    expect(mergeRevisionedPart([], { type: 'agent_text', text: 'legacy' })).toBe('legacy')
  })
})
