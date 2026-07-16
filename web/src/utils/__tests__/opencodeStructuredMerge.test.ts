import { describe, expect, test } from 'vitest'
import { mergeStructuredPart } from '../opencodeStructuredMerge'

describe('mergeStructuredPart', () => {
  test('deduplicates an unsequenced legacy Part by type and Part ID', () => {
    const messages: any[] = []
  expect(mergeStructuredPart(messages, {
    type: 'agent_patch', part_id: 'prt_1', event_id: 'opencode:part:prt_1:final:first', hash: 'h1', files: ['a.go'],
  })).toBe('inserted')
  expect(mergeStructuredPart(messages, {
    type: 'agent_patch', part_id: 'prt_1', event_id: 'opencode:part:prt_1:final:changed', hash: 'h2', files: ['b.go'],
  })).toBe('ignored')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ partKey: 'agent_patch:prt_1', hash: 'h1' })
  })

  test('replaces a session Todo snapshot including an empty clear', () => {
    const messages: any[] = []
    expect(mergeStructuredPart(messages, {
      type: 'agent_todo', session_id: 'ses_1', event_id: 'opencode:todo:ses_1:first',
      todos: [{ content: 'Build', status: 'in_progress', priority: 'high' }],
    })).toBe('inserted')
  expect(mergeStructuredPart(messages, {
    type: 'agent_todo', session_id: 'ses_1', event_id: 'opencode:todo:ses_1:empty',
    previous_event_id: 'opencode:todo:ses_1:first', todos: [],
  })).toBe('updated')
    expect(messages).toHaveLength(1)
    expect(messages[0].todos).toEqual([])
  })

  test('rejects an older root Todo replay after a causal successor', () => {
  const messages: any[] = []
  const root = { type: 'agent_todo' as const, session_id: 'ses_1', event_id: 'todo-root', todos: [{ content: 'one' }] }
  expect(mergeStructuredPart(messages, root)).toBe('inserted')
  expect(mergeStructuredPart(messages, {
    type: 'agent_todo', session_id: 'ses_1', event_id: 'todo-next', previous_event_id: 'todo-root', todos: [{ content: 'two' }],
  })).toBe('updated')
  expect(mergeStructuredPart(messages, root)).toBe('ignored')
  expect(messages[0].todos).toEqual([{ content: 'two' }])
  })

  test('keeps Subtask and Agent Parts separate from PocketCtl subagent messages', () => {
    const messages: any[] = []
    mergeStructuredPart(messages, { type: 'agent_subtask', part_id: 'prt_sub', description: 'Inspect', agent: 'explore' })
    mergeStructuredPart(messages, { type: 'agent_profile', part_id: 'prt_agent', profile_name: 'build' })
    expect(messages.map(message => message.type)).toEqual(['agent_subtask', 'agent_profile'])
    expect(messages.some(message => message.type === 'subagent')).toBe(false)
  })

  test.each([
    ['agent_file', { filename: 'a.txt' }, { filename: 'b.txt' }],
    ['agent_patch', { hash: 'h1', files: ['a.go'] }, { hash: 'h2', files: ['b.go'] }],
    ['agent_subtask', { prompt: 'one' }, { prompt: 'two' }],
    ['agent_profile', { profile_name: 'build' }, { profile_name: 'review' }],
  ] as const)('updates a causally newer %s snapshot and rejects an older replay', (type, firstFields, laterFields) => {
    const messages: any[] = []
    const first: any = { type, part_id: 'prt_1', event_id: `${type}-one`, ...firstFields }
    expect(mergeStructuredPart(messages, first)).toBe('inserted')
    expect(mergeStructuredPart(messages, {
    type, part_id: 'prt_1', event_id: `${type}-two`, previous_event_id: `${type}-one`, ...laterFields,
    })).toBe('updated')
    expect(messages[0]).toMatchObject({ ...laterFields, eventId: `${type}-two` })
    expect(mergeStructuredPart(messages, first)).toBe('ignored')
    expect(messages[0]).toMatchObject(laterFields)
  })

  test('defers and drains a structured causal gap', () => {
    const messages: any[] = []
    expect(mergeStructuredPart(messages, {
      type: 'agent_patch', part_id: 'prt_1', event_id: 'B', hash: 'b',
    })).toBe('inserted')
    expect(mergeStructuredPart(messages, {
      type: 'agent_patch', part_id: 'prt_1', event_id: 'D', previous_event_id: 'C', hash: 'd',
    })).toBe('deferred')
    expect(mergeStructuredPart(messages, {
      type: 'agent_patch', part_id: 'prt_1', event_id: 'C', previous_event_id: 'B', hash: 'c',
    })).toBe('updated')
    expect(messages[0]).toMatchObject({ hash: 'd', eventId: 'D' })
  })

  test('lets a causal structured snapshot take over a legacy record', () => {
    const messages: any[] = [{ type: 'agent_file', partKey: 'agent_file:prt_1', filename: 'old' }]
    expect(mergeStructuredPart(messages, {
      type: 'agent_file', part_id: 'prt_1', event_id: 'new', previous_event_id: 'unknown', filename: 'new',
    })).toBe('updated')
    expect(messages[0]).toMatchObject({ filename: 'new', eventId: 'new' })
  })

  test('compacts an over-limit gap toward the newest structured snapshot', () => {
    const messages: any[] = []
    mergeStructuredPart(messages, { type: 'agent_patch', part_id: 'prt_1', event_id: 'B', hash: 'B' })
    for (let index = 2; index <= 34; index++) {
      expect(mergeStructuredPart(messages, {
        type: 'agent_patch', part_id: 'prt_1', event_id: `C${index}`,
        previous_event_id: `C${index - 1}`, hash: `C${index}`,
      })).toBe('deferred')
    }
    mergeStructuredPart(messages, {
      type: 'agent_patch', part_id: 'prt_1', event_id: 'C1', previous_event_id: 'B', hash: 'C1',
    })
    expect(messages[0]).toMatchObject({ hash: 'C34', eventId: 'C34' })
  })

  test('keeps an oldest disconnected structured snapshot when overflow has no proven successor', () => {
    const messages: any[] = []
    mergeStructuredPart(messages, { type: 'agent_patch', part_id: 'prt_1', event_id: 'B', hash: 'B' })
    for (let index = 1; index <= 33; index++) {
      expect(mergeStructuredPart(messages, {
        type: 'agent_patch', part_id: 'prt_1', event_id: `E${index}`,
        previous_event_id: `P${index}`, hash: `latest-${index}`,
      })).toBe('deferred')
    }
    mergeStructuredPart(messages, {
      type: 'agent_patch', part_id: 'prt_1', event_id: 'P1', previous_event_id: 'B', hash: 'predecessor',
    })
    expect(messages[0]).toMatchObject({ hash: 'latest-1', eventId: 'E1' })
  })

  test('compacts an appended structured overflow item when an earlier snapshot succeeds it', () => {
    const messages: any[] = []
    mergeStructuredPart(messages, { type: 'agent_patch', part_id: 'prt_1', event_id: 'B', hash: 'B' })
    mergeStructuredPart(messages, {
      type: 'agent_patch', part_id: 'prt_1', event_id: 'E1', previous_event_id: 'P1', hash: 'E1',
    })
    for (let index = 2; index <= 32; index++) {
      mergeStructuredPart(messages, {
        type: 'agent_patch', part_id: 'prt_1', event_id: `E${index}`,
        previous_event_id: `P${index}`, hash: `gap-${index}`,
      })
    }
    mergeStructuredPart(messages, {
      type: 'agent_patch', part_id: 'prt_1', event_id: 'P1', previous_event_id: 'X', hash: 'P1',
    })
    mergeStructuredPart(messages, {
      type: 'agent_patch', part_id: 'prt_1', event_id: 'X', previous_event_id: 'B', hash: 'X',
    })
    expect(messages[0]).toMatchObject({ hash: 'E1', eventId: 'E1' })
  })
})
