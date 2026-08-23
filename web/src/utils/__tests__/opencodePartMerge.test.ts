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

  test('merges presentation metadata from stale and equal revisions without replacing canonical content', () => {
    const target: any[] = []
    mergeRevisionedPart(target, { type: 'agent_text', part_id: 'p-meta', revision: 2, text: 'canonical', turn_id: 'old' })

    expect(mergeRevisionedPart(target, { type: 'agent_text', part_id: 'p-meta', revision: 2, text: 'equal rewrite', turn_id: 'equal', flow_scope: 'main' })).toBe('ignored')
    expect(mergeRevisionedPart(target, { type: 'agent_text', part_id: 'p-meta', revision: 1, text: 'stale rewrite', content_class: 'dialogue' })).toBe('ignored')
    expect(target[0]).toMatchObject({ content: 'canonical', revision: 2, turn_id: 'equal', flow_scope: 'main', content_class: 'dialogue' })
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

  test('accepts a restarted causal chain immediately despite reset revisions', () => {
  const messages: any[] = [{
    id: 'part:prt_1', type: 'agent_text', content: 'Hel', partId: 'prt_1', revision: 3,
    streaming: true, eventId: 'hel',
  }]
  expect(mergeRevisionedPart(messages, {
    type: 'agent_text', text: 'Hel', part_id: 'prt_1', revision: 1, streaming: true, event_id: 'hel',
  })).toBe('ignored')
  expect(mergeRevisionedPart(messages, {
    type: 'agent_text', text: 'l', part_id: 'prt_1', revision: 2, streaming: true,
    event_id: 'hell-stream', previous_event_id: 'hel',
  })).toBe('updated')
  expect(messages[0].content).toBe('Hell')
  expect(mergeRevisionedPart(messages, {
    type: 'agent_text', text: 'Hell', part_id: 'prt_1', revision: 3, replace: true, streaming: false,
    event_id: 'hell-final', previous_event_id: 'hell-stream',
  })).toBe('updated')
  expect(messages[0]).toMatchObject({ content: 'Hell', streaming: false, eventId: 'hell-final' })
  })

  test('reconstructs a successor that replays before its predecessor', () => {
  const messages: any[] = []
  expect(mergeRevisionedPart(messages, {
    type: 'agent_text', text: 'l', snapshot: 'Hell', part_id: 'prt_1', revision: 2,
    streaming: true, event_id: 'hell', previous_event_id: 'hel',
  })).toBe('inserted')
  expect(mergeRevisionedPart(messages, {
    type: 'agent_text', text: 'Hel', snapshot: 'Hel', part_id: 'prt_1', revision: 1,
    streaming: true, event_id: 'hel',
  })).toBe('ignored')
  expect(messages[0].content).toBe('Hell')
  })

  test('accepts causal same-length and shorter replacements but rejects an older replay', () => {
  const messages: any[] = [{
    id: 'part:prt_1', type: 'agent_text', content: 'Hello', partId: 'prt_1', revision: 8,
    streaming: true, eventId: 'hello',
  }]
  expect(mergeRevisionedPart(messages, {
    type: 'agent_text', text: 'Hallo', part_id: 'prt_1', revision: 2, replace: true, streaming: true,
    event_id: 'hallo', previous_event_id: 'hello',
  })).toBe('updated')
  expect(mergeRevisionedPart(messages, {
    type: 'agent_text', text: 'Hi', part_id: 'prt_1', revision: 3, replace: true, streaming: true,
    event_id: 'hi', previous_event_id: 'hallo',
  })).toBe('updated')
  expect(mergeRevisionedPart(messages, {
    type: 'agent_text', text: 'Hello', part_id: 'prt_1', revision: 8, replace: true, streaming: true,
    event_id: 'hello', previous_event_id: 'before-hello',
  })).toBe('ignored')
  expect(mergeRevisionedPart(messages, {
    type: 'agent_text', text: 'stale root', part_id: 'prt_1', revision: 99, replace: true, streaming: false,
    event_id: 'stale-root',
  })).toBe('ignored')
  expect(messages[0].content).toBe('Hi')
  })

  test('defers a causal gap and drains successors when the predecessor arrives', () => {
    const messages: any[] = []
    expect(mergeRevisionedPart(messages, {
      type: 'agent_text', text: 'B', snapshot: 'B', part_id: 'prt_1', revision: 1, event_id: 'B',
    })).toBe('inserted')
    expect(mergeRevisionedPart(messages, {
      type: 'agent_text', text: 'D', snapshot: 'BCD', part_id: 'prt_1', revision: 3,
      event_id: 'D', previous_event_id: 'C',
    })).toBe('deferred')
    expect(messages[0].content).toBe('B')
    expect(mergeRevisionedPart(messages, {
      type: 'agent_text', text: 'C', snapshot: 'BC', part_id: 'prt_1', revision: 2,
      event_id: 'C', previous_event_id: 'B',
    })).toBe('updated')
    expect(messages[0]).toMatchObject({ content: 'BCD', eventId: 'D', revision: 3 })
  })

  test('lets a full causal snapshot take over a legacy high revision', () => {
    const messages: any[] = [{
      id: 'part:prt_1', type: 'agent_reasoning', content: 'legacy', partId: 'prt_1', revision: 99,
    }]
    expect(mergeRevisionedPart(messages, {
      type: 'agent_reasoning', text: 'new', snapshot: 'new', part_id: 'prt_1', revision: 1,
      event_id: 'causal-root', previous_event_id: 'unknown',
    })).toBe('updated')
    expect(messages[0]).toMatchObject({ content: 'new', eventId: 'causal-root', revision: 1 })
  })

  test('compacts an over-limit causal gap toward the newest full snapshot', () => {
    const messages: any[] = []
    mergeRevisionedPart(messages, {
      type: 'agent_text', snapshot: 'B', part_id: 'prt_1', revision: 1, event_id: 'B',
    })
    for (let index = 2; index <= 34; index++) {
      expect(mergeRevisionedPart(messages, {
        type: 'agent_text', snapshot: `C${index}`, part_id: 'prt_1', revision: index,
        event_id: `C${index}`, previous_event_id: `C${index - 1}`,
      })).toBe('deferred')
    }
    mergeRevisionedPart(messages, {
      type: 'agent_text', snapshot: 'C1', part_id: 'prt_1', revision: 2,
      event_id: 'C1', previous_event_id: 'B',
    })
    expect(messages[0]).toMatchObject({ content: 'C34', eventId: 'C34' })
  })

  test('keeps an oldest disconnected snapshot when overflow has no proven successor', () => {
    const messages: any[] = []
    mergeRevisionedPart(messages, {
      type: 'agent_text', snapshot: 'B', part_id: 'prt_1', revision: 1, event_id: 'B',
    })
    for (let index = 1; index <= 33; index++) {
      expect(mergeRevisionedPart(messages, {
        type: 'agent_text', snapshot: `latest-${index}`, part_id: 'prt_1', revision: index + 2,
        event_id: `E${index}`, previous_event_id: `P${index}`,
      })).toBe('deferred')
    }
    mergeRevisionedPart(messages, {
      type: 'agent_text', snapshot: 'predecessor', part_id: 'prt_1', revision: 2,
      event_id: 'P1', previous_event_id: 'B',
    })
    expect(messages[0]).toMatchObject({ content: 'latest-1', eventId: 'E1' })
  })

  test('compacts the appended overflow item when an earlier snapshot is its successor', () => {
    const messages: any[] = []
    mergeRevisionedPart(messages, {
      type: 'agent_text', snapshot: 'B', part_id: 'prt_1', revision: 1, event_id: 'B',
    })
    mergeRevisionedPart(messages, {
      type: 'agent_text', snapshot: 'E1', part_id: 'prt_1', revision: 34,
      event_id: 'E1', previous_event_id: 'P1',
    })
    for (let index = 2; index <= 32; index++) {
      mergeRevisionedPart(messages, {
        type: 'agent_text', snapshot: `gap-${index}`, part_id: 'prt_1', revision: index,
        event_id: `E${index}`, previous_event_id: `P${index}`,
      })
    }
    mergeRevisionedPart(messages, {
      type: 'agent_text', snapshot: 'P1', part_id: 'prt_1', revision: 33,
      event_id: 'P1', previous_event_id: 'X',
    })
    mergeRevisionedPart(messages, {
      type: 'agent_text', snapshot: 'X', part_id: 'prt_1', revision: 2,
      event_id: 'X', previous_event_id: 'B',
    })
    expect(messages[0]).toMatchObject({ content: 'E1', eventId: 'E1' })
  })
})
